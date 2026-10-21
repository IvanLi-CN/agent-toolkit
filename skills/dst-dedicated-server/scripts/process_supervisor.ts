import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPERVISOR_SCRIPT = `
set +e
status_path="$1"
shift
status_dir="$(dirname -- "$status_path")"
cleanup() { rm -rf -- "$status_dir"; }
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
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  candidate_target_pid="$(cat "$target_anchor_path" 2>/dev/null || true)"
  case "$candidate_target_pid" in
    ''|*[!0-9]*) sleep 0.01 ;;
    *) target_pid="$candidate_target_pid"; break ;;
  esac
done
if [ -z "$target_pid" ]; then target_pid="$target_launcher_pid"; fi
target_launcher_pid="$target_pid"
for _ in 1 2 3 4 5; do
  observed_target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  case "$observed_target_pgid" in
    ''|*[!0-9]*) sleep 0.01 ;;
    *) target_pgid="$observed_target_pgid"; break ;;
  esac
done
target_identity_mode="unknown"
target_starttime=""
target_ps_start=""
if [ -r "/proc/$target_pid/stat" ]; then
  target_starttime="$(awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
  if [ -n "$target_starttime" ]; then target_identity_mode="proc"; fi
fi
if [ "$target_identity_mode" != "proc" ]; then
  target_ps_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | awk 'NR == 1 { sub(/^[ \\t]*/, ""); sub(/[ \\t]*$/, ""); print; exit }')"
  if [ -n "$target_ps_start" ]; then target_identity_mode="ps"; fi
fi
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
  if [ -r "/proc/$target_pid/stat" ]; then
    target_state="$(awk '{ sub(/.*\) /, ""); print $1 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    [ -n "$target_state" ] && [ "$target_state" != "Z" ] && kill -0 "$target_pid" 2>/dev/null
    return
  fi
  kill -0 "$target_pid" 2>/dev/null
}
stop_anchor() {
  if target_identity_matches; then
    anchor_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
    wrapper_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
    case "$anchor_pgid" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$anchor_pgid" != "$wrapper_pgid" ]; then
          kill TERM "-$anchor_pgid" 2>/dev/null || true
          sleep 0.1
          kill KILL "-$anchor_pgid" 2>/dev/null || true
        fi
        ;;
    esac
    kill TERM "$target_pid" 2>/dev/null || true
    sleep 0.1
    kill KILL "$target_pid" 2>/dev/null || true
  fi
}
descendants() {
  ps -eo pid=,ppid= 2>/dev/null | awk -v root="$target_pid" '
    { parent[$1] = $2 }
    function is_descendant(pid, current, depth) {
      current = parent[pid]
      for (depth = 0; depth < 64 && current != ""; depth++) {
        if (current == root) return 1
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
  if target_identity_matches; then
    current_target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  fi
  case "$current_target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$current_target_pgid" = "$target_pgid" ] && [ "$current_target_pgid" != "$wrapper_pgid" ]; then
        kill -"$signal" "-$current_target_pgid" 2>/dev/null || true
      fi
      ;;
  esac
  for pid in $(descendants); do
    [ "$pid" = "$$" ] && continue
    kill -"$signal" "$pid" 2>/dev/null || true
  done
}
watchdog_pid=""
stop_watchdog() {
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
trap 'stop_watchdog; signal_tree TERM; signal_tree KILL; cleanup; exit 143' HUP INT TERM
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
          signal_tree TERM
          sleep 1
          signal_tree KILL
          stop_anchor
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
  signal_tree TERM
  sleep 1
  signal_tree KILL
  stop_anchor
  cleanup
  exit 143
fi
printf '%s\\n' "$target_status" > "$status_path"
exec 0<&- 1>&- 2>&-
hold_seconds=5
if [ -d "/proc/$$/fd" ]; then hold_seconds=0.25; fi
hold_process() {
  hold_sleep_pid=""
  trap 'if [ -n "$hold_sleep_pid" ]; then kill "$hold_sleep_pid" 2>/dev/null || true; fi; exit 0' HUP INT TERM
  sleep "$hold_seconds" &
  hold_sleep_pid="$!"
  wait "$hold_sleep_pid" 2>/dev/null || exit 0
  hold_sleep_pid=""
  signal_tree TERM
  sleep 0.25 &
  hold_sleep_pid="$!"
  wait "$hold_sleep_pid" 2>/dev/null || exit 0
  hold_sleep_pid=""
  signal_tree KILL
}
hold_process </dev/null >/dev/null 2>&1 &
hold_pid=$!
while target_is_alive; do sleep 0.05; done
kill "$hold_pid" 2>/dev/null || true
wait "$hold_pid" 2>/dev/null || true
stop_watchdog
cleanup
`;

export interface SupervisedChild {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  exited: Promise<number>;
  wrapperExited: Promise<number>;
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

export async function spawnSupervised(args: string[]): Promise<SupervisedChild> {
  if (process.platform === "win32") {
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return {
      child,
      exited: child.exited,
      wrapperExited: child.exited,
      cleanup: async () => undefined,
    };
  }

  const directory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-"));
  const statusPath = join(directory, "status");
  try {
    const child = Bun.spawn(
      ["sh", "-c", SUPERVISOR_SCRIPT, "agent-toolkit-supervisor", statusPath, ...args],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_TOOLKIT_SUPERVISOR_PARENT_PID: String(process.pid) },
      },
    ) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    const wrapperExited = child.exited;
    return {
      child,
      exited: waitForTarget(statusPath, wrapperExited),
      wrapperExited,
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
