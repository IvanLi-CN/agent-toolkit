import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPERVISOR_SCRIPT = `
set +e
status_path="$1"
shift
"$@" &
target_pid=$!
wait "$target_pid"
target_status=$?
printf '%s\\n' "$target_status" > "$status_path"
exec 0<&- 1>&- 2>&-
while :; do
  sleep 3600 &
  wait $!
done
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
      { detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
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
