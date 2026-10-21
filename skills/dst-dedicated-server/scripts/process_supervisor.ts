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
target_pgid=""
if command -v setsid >/dev/null 2>&1; then
  target_pgid="pending"
  setsid "$@" &
else
  set -m 2>/dev/null || true
  "$@" &
fi
target_pid=$!
if [ "$target_pgid" = "pending" ]; then target_pgid="$target_pid"; fi
for _ in 1 2 3 4 5; do
  observed_target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  case "$observed_target_pgid" in
    ''|*[!0-9]*) sleep 0.01 ;;
    *) target_pgid="$observed_target_pgid"; break ;;
  esac
done
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
  case "$target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$target_pgid" != "$wrapper_pgid" ]; then
        kill -"$signal" -- "-$target_pgid" 2>/dev/null || true
        return
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
  while parent_is_alive; do sleep 1; done
  signal_tree TERM
  sleep 1
  signal_tree KILL
}
watch_parent &
watchdog_pid=$!
wait "$target_pid"
target_status=$?
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
if ! parent_is_alive; then
  cleanup
  exit 143
fi
printf '%s\\n' "$target_status" > "$status_path"
exec 0<&- 1>&- 2>&-
sleep 5
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
        detached: true,
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
