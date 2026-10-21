import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPERVISOR_SCRIPT = `
set +e
status_path="$1"
shift
status_dir="$(dirname -- "$status_path")"
ready_path="$status_dir/ready"
cleanup_ack_path="\${AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH:-$status_dir/cleanup-done}"
cleanup_ack_enabled=1
cleanup() {
  if [ "$cleanup_ack_enabled" = "1" ]; then
    printf '%s\\n' done > "$cleanup_ack_path" 2>/dev/null || true
  fi
  rm -rf -- "$status_dir"
}
parent_pid="\${AGENT_TOOLKIT_SUPERVISOR_PARENT_PID:-\$PPID}"
parent_starttime=""
parent_identity_mode="unknown"
parent_ps_start=""
if [ -r "/proc/$parent_pid/stat" ]; then
  parent_starttime="$(awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$parent_pid/stat" 2>/dev/null || true)"
  if [ -n "$parent_starttime" ]; then parent_identity_mode="proc"; fi
fi
if [ "$parent_identity_mode" != "proc" ]; then
  parent_ps_start="$(ps -o lstart= -p "$parent_pid" 2>/dev/null | awk 'NR == 1 { sub(/^[ \t]*/, ""); sub(/[ \t]*$/, ""); print; exit }')"
  if [ -n "$parent_ps_start" ]; then parent_identity_mode="ps"; fi
fi
target_status_path="$status_dir/target-status"
target_anchor_path="$status_dir/target"
target_pgid=""
target_pid=""
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c '
    anchor_path="$1"
    result_path="$2"
    shift 2
    trap ':' HUP INT TERM
    printf "%s\\n" "$$" > "$anchor_path"
    "$@" &
    target_pid=$!
    wait "$target_pid"
    target_status=$?
    printf "%s\\n" "$target_status" > "$result_path"
    exec 0<&- 1>&- 2>&-
    while :; do sleep 1; done
  ' agent-toolkit-target "$target_anchor_path" "$target_status_path" "$@" &
else
  set -m 2>/dev/null || true
  sh -c '
    anchor_path="$1"
    result_path="$2"
    shift 2
    trap ':' HUP INT TERM
    printf "%s\\n" "$$" > "$anchor_path"
    "$@" &
    target_pid=$!
    wait "$target_pid"
    target_status=$?
    printf "%s\\n" "$target_status" > "$result_path"
    exec 0<&- 1>&- 2>&-
    while :; do sleep 1; done
  ' agent-toolkit-target "$target_anchor_path" "$target_status_path" "$@" &
fi
target_launcher_pid=$!
target_pid="$target_launcher_pid"
target_anchor_attempt=0
while [ "$target_anchor_attempt" -lt 500 ]; do
  candidate_target_pid="$(cat "$target_anchor_path" 2>/dev/null || true)"
  case "$candidate_target_pid" in
    ''|*[!0-9]*) sleep 0.01; target_anchor_attempt=$((target_anchor_attempt + 1)) ;;
    *) target_pid="$candidate_target_pid"; break ;;
  esac
done
if [ -z "$target_pid" ]; then target_pid="$target_launcher_pid"; fi
target_launcher_pid="$target_pid"
target_pgid_attempt=0
while [ "$target_pgid_attempt" -lt 100 ]; do
  observed_target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  case "$observed_target_pgid" in
    ''|*[!0-9]*) sleep 0.01; target_pgid_attempt=$((target_pgid_attempt + 1)) ;;
    *) target_pgid="$observed_target_pgid"; break ;;
  esac
done
capture_target_identity() {
  target_identity_mode="unknown"
  target_starttime=""
  target_ps_start=""
  if [ -r "/proc/$target_pid/stat" ]; then
    target_starttime="$(awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    if [ -n "$target_starttime" ]; then
      target_identity_mode="proc"
      return 0
    fi
  fi
  target_ps_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | awk 'NR == 1 { sub(/^[ \\t]*/, ""); sub(/[ \\t]*$/, ""); print; exit }')"
  if [ -n "$target_ps_start" ]; then
    target_identity_mode="ps"
    return 0
  fi
  return 1
}
capture_target_identity || true
printf '%s\\n' ready > "$ready_path"
refresh_target_reference() {
  target_reference_attempt=0
  while [ "$target_reference_attempt" -lt 100 ]; do
    candidate_target_pid="$(cat "$target_anchor_path" 2>/dev/null || true)"
    case "$candidate_target_pid" in
      ''|*[!0-9]*)
        sleep 0.01
        target_reference_attempt=$((target_reference_attempt + 1))
        ;;
      *)
        if [ "$candidate_target_pid" != "$target_pid" ]; then
          target_pid="$candidate_target_pid"
          target_pgid=""
          capture_target_identity || true
        elif [ "$target_identity_mode" = "unknown" ]; then
          capture_target_identity || true
        fi
        break
        ;;
    esac
  done
  case "$target_pgid" in
    ''|*[!0-9]*)
      observed_target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
      case "$observed_target_pgid" in
        ''|*[!0-9]*) ;;
        *) target_pgid="$observed_target_pgid" ;;
      esac
      ;;
  esac
}
target_identity_matches() {
  if [ "$target_identity_mode" = "proc" ] && [ -r "/proc/$target_pid/stat" ]; then
    current_target_start="$(awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    [ -n "$current_target_start" ] && [ "$current_target_start" = "$target_starttime" ]
    return
  fi
  if [ "$target_identity_mode" = "ps" ]; then
    current_target_ps_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | awk 'NR == 1 { sub(/^[ \\t]*/, ""); sub(/[ \\t]*$/, ""); print; exit }')"
    [ -n "$current_target_ps_start" ] && [ "$current_target_ps_start" = "$target_ps_start" ]
    return
  fi
  return 1
}
target_is_alive() {
  if ! target_identity_matches; then return 1; fi
  if [ -r "/proc/$target_pid/stat" ]; then
    target_state="$(awk '{ sub(/.*\) /, ""); print $1 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    [ -n "$target_state" ] && [ "$target_state" != "Z" ] && kill -0 "$target_pid" 2>/dev/null
    return
  fi
  kill -0 "$target_pid" 2>/dev/null
}
stop_anchor() {
  refresh_target_reference
  if target_identity_matches; then
    anchor_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
    wrapper_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
    case "$anchor_pgid" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$anchor_pgid" != "$wrapper_pgid" ]; then
          kill TERM "-$anchor_pgid" 2>/dev/null || true
          if target_identity_matches; then kill KILL "-$anchor_pgid" 2>/dev/null || true; fi
        fi
        ;;
    esac
    if target_identity_matches; then
      kill TERM "$target_pid" 2>/dev/null || true
      if target_identity_matches; then kill KILL "$target_pid" 2>/dev/null || true; fi
    fi
  fi
}
process_identity() {
  process_id="$1"
  if [ -r "/proc/$process_id/stat" ]; then
    process_starttime="$(awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$process_id/stat" 2>/dev/null || true)"
    if [ -n "$process_starttime" ]; then
      printf 'proc:%s\n' "$process_starttime"
      return 0
    fi
  fi
  process_ps_start="$(ps -o lstart= -p "$process_id" 2>/dev/null | awk 'NR == 1 { sub(/^[ \t]*/, ""); sub(/[ \t]*$/, ""); print; exit }')"
  if [ -n "$process_ps_start" ]; then
    printf 'ps:%s\n' "$process_ps_start"
    return 0
  fi
  return 1
}
descendants() {
  ps -eo pid=,ppid= 2>/dev/null | awk -v root="$target_pid" '
    { parent[$1] = $2 }
    function is_descendant(pid, current) {
      current = parent[pid]
      delete seen
      while (current != "") {
        if (current == root) return 1
        if (seen[current]++) return 0
        current = parent[current]
      }
      return 0
    }
    $1 == root || is_descendant($1) { print $1 }
  '
}
signal_tree() {
  signal="$1"
  wrapper_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
  current_target_pgid=""
  group_signal_succeeded=0
  if target_identity_matches; then
    current_target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  fi
  case "$current_target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$current_target_pgid" = "$target_pgid" ] && [ "$current_target_pgid" != "$wrapper_pgid" ]; then
        if kill -"$signal" "-$current_target_pgid" 2>/dev/null; then
          group_signal_succeeded=1
        fi
      fi
      ;;
  esac
  if [ "$group_signal_succeeded" = "1" ]; then return; fi
  if ! target_identity_matches; then return; fi
  for pid in $(descendants); do
    [ "$pid" = "$$" ] && continue
    descendant_identity="$(process_identity "$pid" 2>/dev/null || true)"
    [ -n "$descendant_identity" ] || continue
    if target_identity_matches && [ "$(process_identity "$pid" 2>/dev/null || true)" = "$descendant_identity" ]; then
      kill -"$signal" "$pid" 2>/dev/null || true
    fi
  done
}
watchdog_pid=""
stop_watchdog() {
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
hold_pid=""
trap 'if [ -n "$hold_pid" ]; then kill "$hold_pid" 2>/dev/null || true; fi; signal_tree TERM; signal_tree KILL; stop_anchor; stop_watchdog; cleanup; exit 143' HUP INT TERM
parent_is_alive() {
  if [ "$parent_identity_mode" = "proc" ] && [ -r "/proc/$parent_pid/stat" ]; then
    parent_identity="$(awk '{ sub(/.*\\) /, ""); print $1 " " $20 }' "/proc/$parent_pid/stat" 2>/dev/null || true)"
    parent_state="\${parent_identity%% *}"
    current_starttime="\${parent_identity#* }"
    [ "$parent_state" != "Z" ] && [ -n "$parent_state" ] && {
      [ -z "$parent_starttime" ] || [ "$current_starttime" = "$parent_starttime" ]
    }
    return
  fi
  if [ "$parent_identity_mode" = "ps" ]; then
    current_ps_start="$(ps -o lstart= -p "$parent_pid" 2>/dev/null | awk 'NR == 1 { sub(/^[ \t]*/, ""); sub(/[ \t]*$/, ""); print; exit }')"
    current_ps_state="$(ps -o state= -p "$parent_pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); print; exit }')"
    [ -n "$current_ps_start" ] && [ "$current_ps_start" = "$parent_ps_start" ] && [ "$current_ps_state" != "Z" ]
    return
  fi
  return 1
}
watch_parent() {
  watch_sleep_pid=""
  trap 'if [ -n "$watch_sleep_pid" ]; then kill "$watch_sleep_pid" 2>/dev/null || true; fi; exit 0' HUP INT TERM
  while parent_is_alive; do
    sleep 1 &
    watch_sleep_pid="$!"
    wait "$watch_sleep_pid" 2>/dev/null || true
    watch_sleep_pid=""
  done
  signal_tree TERM
  sleep 1
  signal_tree KILL
  stop_anchor
}
watch_parent </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
target_status=""
while [ -z "$target_status" ]; do
  candidate_target_status="$(cat "$target_status_path" 2>/dev/null || true)"
  case "$candidate_target_status" in
    ''|*[!0-9]*)
      if ! target_is_alive; then
        target_status=143
      else
        if ! parent_is_alive; then
          cleanup_ack_enabled=0
          signal_tree TERM
          sleep 1
          signal_tree KILL
          stop_anchor
          stop_watchdog
          cleanup
          exit 143
        fi
        sleep 0.01
      fi
      ;;
    *) target_status="$candidate_target_status" ;;
  esac
done
if ! parent_is_alive; then
  cleanup_ack_enabled=0
  signal_tree TERM
  sleep 1
  signal_tree KILL
  stop_anchor
  stop_watchdog
  cleanup
  exit 143
fi
printf '%s\\n' "$target_status" > "$status_path"
exec 0<&- 1>&- 2>&-
hold_seconds=5
if [ -d "/proc/$$/fd" ]; then hold_seconds=0.25; fi
sleep "$hold_seconds" &
hold_pid="$!"
wait "$hold_pid" 2>/dev/null || true
hold_pid=""
signal_tree TERM
sleep 0.25
signal_tree KILL
stop_anchor
stop_watchdog
cleanup
`;

export interface SupervisedChild {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  exited: Promise<number>;
  wrapperExited: Promise<number>;
  waitForCleanupAcknowledged: () => Promise<boolean>;
  cleanup(): Promise<void>;
}

async function readStatus(path: string): Promise<number | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (/^-?\d+$/.test(value)) {
      const status = Number(value);
      if (Number.isInteger(status)) return status;
    }
  } catch {
    // The target may still be running or the status file may be between writes.
  }
  return undefined;
}

async function waitForTarget(path: string, wrapperExited: Promise<number>): Promise<number> {
  const wrapperResult = wrapperExited.then((code) => ({ code }));
  while (true) {
    const status = await readStatus(path);
    if (status !== undefined) return status;
    const event = await Promise.race([Bun.sleep(20).then(() => undefined), wrapperResult]);
    if (event !== undefined) return (await readStatus(path)) ?? event.code;
  }
}

async function waitForReady(path: string, wrapperExited: Promise<number>): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).trim() === "ready") return true;
    } catch {
      // The wrapper may have completed before the readiness marker was observed.
    }
    const wrapperDone = await Promise.race([
      wrapperExited.then(() => true, () => true),
      Bun.sleep(20).then(() => false),
    ]);
    if (wrapperDone) return false;
  }
  return false;
}

async function waitForCleanupAck(path: string, wrapperExited: Promise<number>): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).trim() === "done") {
        await rm(path, { force: true });
        return true;
      }
    } catch {
      // The wrapper may still be completing its process-group cleanup.
    }
    const wrapperDone = await Promise.race([
      wrapperExited.then(() => true, () => true),
      Bun.sleep(20).then(() => false),
    ]);
    if (wrapperDone) {
      try {
        if ((await readFile(path, "utf8")).trim() === "done") {
          await rm(path, { force: true });
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
  }
  return false;
}

export async function spawnSupervised(args: string[]): Promise<SupervisedChild> {
  if (process.platform === "win32") {
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return {
      child,
      exited: child.exited,
      wrapperExited: child.exited,
      waitForCleanupAcknowledged: () => Promise.resolve(true),
      cleanup: async () => undefined,
    };
  }

  const directory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-"));
  const statusPath = join(directory, "status");
  const readyPath = join(directory, "ready");
  const cleanupAckPath = `${directory}.done`;
  try {
    const child = Bun.spawn(
      ["sh", "-c", SUPERVISOR_SCRIPT, "agent-toolkit-supervisor", statusPath, ...args],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          AGENT_TOOLKIT_SUPERVISOR_PARENT_PID: String(process.pid),
          AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH: cleanupAckPath,
        },
      },
    ) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    const wrapperExited = child.exited;
    const supervised: SupervisedChild = {
      child,
      exited: waitForTarget(statusPath, wrapperExited),
      wrapperExited,
      waitForCleanupAcknowledged: () => waitForCleanupAck(cleanupAckPath, wrapperExited),
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
        await rm(cleanupAckPath, { force: true });
      },
    };
    const ready = await waitForReady(readyPath, wrapperExited);
    if (!ready) {
      try { child.kill("SIGTERM"); } catch { /* The wrapper may already be gone. */ }
      await Promise.race([wrapperExited, Bun.sleep(250)]);
      try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      await wrapperExited;
      throw new Error("supervisor_not_ready");
    }
    return supervised;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await rm(cleanupAckPath, { force: true });
    throw error;
  }
}
