import { lstat, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SUPERVISOR_SCRIPT = `
set +e
status_path="$1"
shift
status_dir="$(dirname -- "$status_path")"
supervisor_pid="$$"
ready_path="$status_dir/ready"
cleanup_ack_path="\${AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH:-$status_dir/cleanup-done}"
cleanup_ack_enabled=1
captured_descendants_path="$status_dir/descendants"
pending_descendants_path="$status_dir/descendant-pids"
snapshot_started_path="$status_dir/snapshot-started"
parent_dead_path="$status_dir/parent-dead"
cleanup() {
  cleanup_ack_created=0
  if [ "$cleanup_ack_enabled" = "1" ] && [ ! -e "$parent_dead_path" ]; then
    if mkdir "$cleanup_ack_path" 2>/dev/null; then cleanup_ack_created=1; fi
  else
    rmdir "$(dirname -- "$cleanup_ack_path")" 2>/dev/null || true
  fi
  rm -rf -- "$status_dir"
  if [ "$cleanup_ack_created" = "1" ]; then
    cleanup_ack_wait=0
    while [ -d "$cleanup_ack_path" ] && [ "$cleanup_ack_wait" -lt 120 ]; do
      sleep 0.05
      cleanup_ack_wait=$((cleanup_ack_wait + 1))
    done
    rmdir "$cleanup_ack_path" 2>/dev/null || true
    rmdir "$(dirname -- "$cleanup_ack_path")" 2>/dev/null || true
  fi
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
if [ "$target_identity_mode" = "unknown" ]; then
  cleanup_ack_enabled=0
  case "$target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$target_pgid" = "$target_launcher_pid" ]; then
        kill -TERM "-$target_pgid" 2>/dev/null || true
        sleep 0.25
        kill -KILL "-$target_pgid" 2>/dev/null || true
      fi
      ;;
  esac
  kill -TERM "$target_launcher_pid" 2>/dev/null || true
  sleep 0.25
  kill -KILL "$target_launcher_pid" 2>/dev/null || true
  cleanup
  exit 143
fi
case "$target_pgid" in
  ''|*[!0-9]*)
    cleanup_ack_enabled=0
    kill -TERM "$target_launcher_pid" 2>/dev/null || true
    sleep 0.25
    kill -KILL "$target_launcher_pid" 2>/dev/null || true
    cleanup
    exit 143
    ;;
esac
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
          kill -TERM "-$anchor_pgid" 2>/dev/null || true
          if target_identity_matches; then kill -KILL "-$anchor_pgid" 2>/dev/null || true; fi
        fi
        ;;
    esac
    if target_identity_matches; then
      kill -TERM "$target_pid" 2>/dev/null || true
      if target_identity_matches; then kill -KILL "$target_pid" 2>/dev/null || true; fi
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
    $1 == root || is_descendant($1) {
      if (count < 1024) { print $1; count++ }
    }
  '
}
snapshot_descendants() {
  : > "$snapshot_started_path" 2>/dev/null || true
  descendants > "$pending_descendants_path" 2>/dev/null || true
}
start_snapshot() {
  snapshot_pid=""
  snapshot_descendants &
  snapshot_pid="$!"
  snapshot_wait=0
  while [ ! -e "$snapshot_started_path" ] && [ "$snapshot_wait" -lt 100 ]; do
    sleep 0.001
    snapshot_wait=$((snapshot_wait + 1))
  done
}
record_descendants() {
  if [ ! -e "$captured_descendants_path" ]; then : > "$captured_descendants_path" 2>/dev/null || true; fi
  captured_count="$(wc -l < "$captured_descendants_path" 2>/dev/null || printf '0')"
  while read -r captured_pid; do
    case "$captured_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_count" -ge 1024 ] && break
    captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    [ -n "$captured_identity" ] || continue
    captured_record="$captured_pid|$captured_identity"
    if ! grep -F -x -- "$captured_record" "$captured_descendants_path" >/dev/null 2>&1; then
      printf '%s\n' "$captured_record" >> "$captured_descendants_path"
      captured_count=$((captured_count + 1))
    fi
  done < "$pending_descendants_path"
}
signal_captured_descendants() {
  [ -f "$captured_descendants_path" ] || return 0
  while IFS='|' read -r captured_pid captured_identity; do
    case "$captured_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$captured_pid" = "$$" ] && continue
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    [ -n "$current_captured_identity" ] || continue
    [ "$current_captured_identity" = "$captured_identity" ] || continue
    kill -"$signal" "$captured_pid" 2>/dev/null || true
  done < "$captured_descendants_path"
}
signal_tree() {
  signal="$1"
  if [ "$signal" = "TERM" ]; then start_snapshot; fi
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
  if [ -n "$snapshot_pid" ]; then wait "$snapshot_pid" 2>/dev/null || true; snapshot_pid=""; fi
  if [ "$signal" = "TERM" ]; then record_descendants; fi
  signal_captured_descendants
  if [ "$group_signal_succeeded" = "1" ] || ! target_identity_matches; then return; fi
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
termination_started=0
stop_watchdog() {
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
terminate_supervised_tree() {
  if [ "$termination_started" = "1" ]; then return 0; fi
  termination_started=1
  signal_tree TERM
  sleep 0.25
  signal_tree KILL
  stop_anchor
  stop_watchdog
  cleanup
}
hold_pid=""
trap 'if [ "$termination_started" = "1" ]; then :; else if [ -n "$hold_pid" ]; then kill "$hold_pid" 2>/dev/null || true; fi; terminate_supervised_tree; exit 143; fi' HUP INT TERM
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
  cleanup_ack_enabled=0
  : > "$parent_dead_path" 2>/dev/null || true
  kill -TERM "$supervisor_pid" 2>/dev/null || true
  exit 0
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
          : > "$parent_dead_path" 2>/dev/null || true
          terminate_supervised_tree
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
  : > "$parent_dead_path" 2>/dev/null || true
  terminate_supervised_tree
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
terminate_supervised_tree
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
  const deadline = Date.now() + 7_500;
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

async function consumeCleanupAck(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return false;
    await rmdir(path);
    try { await rmdir(dirname(path)); } catch { /* The private acknowledgement root may already be gone. */ }
    return true;
  } catch {
    return false;
  }
}

async function removeCleanupAck(path: string): Promise<void> {
  let removed = false;
  try {
    await rmdir(path);
    removed = true;
  } catch {
    // The marker may be a file or a symlink left by an interrupted run.
  }
  if (!removed) {
    try {
      await rm(path, { force: true });
      removed = true;
    } catch {
      // Never recursively remove an unexpected marker path.
    }
  }
  if (removed) {
    try { await rmdir(dirname(path)); } catch { /* The private acknowledgement root may already be gone. */ }
  }
}

async function removeCleanupAckRoot(path: string): Promise<void> {
  try { await rmdir(path); } catch { /* The marker consumer may already have removed the private root. */ }
}

async function waitForCleanupAck(path: string, wrapperExited: Promise<number>): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await consumeCleanupAck(path)) return true;
    const wrapperDone = await Promise.race([
      wrapperExited.then(() => true, () => true),
      Bun.sleep(20).then(() => false),
    ]);
    if (wrapperDone) {
      return consumeCleanupAck(path);
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

  const cleanupAckDirectory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-ack-"));
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-"));
  } catch (error) {
    await rm(cleanupAckDirectory, { recursive: true, force: true });
    throw error;
  }
  const statusPath = join(directory, "status");
  const readyPath = join(directory, "ready");
  const cleanupAckPath = join(cleanupAckDirectory, "done");
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
    let cleanupAckPromise: Promise<boolean> | undefined;
    const waitForCleanupAcknowledged = (): Promise<boolean> => {
      cleanupAckPromise ??= waitForCleanupAck(cleanupAckPath, wrapperExited);
      return cleanupAckPromise;
    };
    const supervised: SupervisedChild = {
      child,
      exited: waitForTarget(statusPath, wrapperExited),
      wrapperExited,
      waitForCleanupAcknowledged,
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
        await removeCleanupAck(cleanupAckPath);
        await removeCleanupAckRoot(cleanupAckDirectory);
      },
    };
    const ready = await waitForReady(readyPath, wrapperExited);
    if (!ready) {
      try { child.kill("SIGTERM"); } catch { /* The wrapper may already be gone. */ }
      const cleanupReady = await waitForCleanupAcknowledged();
      if (!cleanupReady) {
        try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      }
      await wrapperExited;
      throw new Error("supervisor_not_ready");
    }
    return supervised;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await rm(cleanupAckDirectory, { recursive: true, force: true });
    throw error;
  }
}
