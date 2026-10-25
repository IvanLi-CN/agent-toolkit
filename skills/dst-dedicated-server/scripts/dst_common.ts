import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { parseArgs } from "node:util";

export const MAX_BYTES = 3 * 1_048_576;
export function options(args: string[], mods: boolean) {
  const { values } = parseArgs({ args, options: {
    host: { type: "string", default: process.env.DST_HOST }, user: { type: "string", default: process.env.DST_USER },
    cluster: { type: "string", default: process.env.DST_CLUSTER }, shard: { type: "string", default: "both" },
    out: { type: "string" }, "local-dir": { type: "string", default: process.env.DST_LOCAL_DIR },
    "cluster-dir": { type: "string" }, "no-local": { type: "boolean" }, "no-remote": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) return values;
  const allowed = mods ? ["host", "user", "cluster", "shard", "cluster-dir", "help"] : ["host", "user", "out", "local-dir", "no-local", "no-remote", "help"];
  // parseArgs defaults do not imply a user request for an irrelevant option.
  for (const arg of args) if (arg.startsWith("--") && !allowed.includes(arg.slice(2).split("=")[0])) throw new Error(`unsupported option for this command: ${arg.split("=")[0]}`);
  if (mods && !["Master", "master", "Caves", "caves", "both"].includes(values.shard!)) throw new Error("--shard must be Master|Caves|both");
  if (mods && !values["cluster-dir"] && (!values.cluster || !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(values.cluster))) throw new Error("--cluster or DST_CLUSTER must be a safe cluster name");
  if (!(mods ? values["cluster-dir"] : values["no-remote"])) {
    if (!values.host || !/^[A-Za-z0-9_[\]][A-Za-z0-9_.:\[\]-]*$/.test(values.host)) throw new Error("--host or DST_HOST is required and must be an SSH host/alias");
    if (values.user && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(values.user)) throw new Error("invalid --user / DST_USER");
    if (mods && !values.user) throw new Error("--user or DST_USER is required");
  }
  return values;
}
export function readBounded(path: string, limit = 1_048_576): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("expected a regular modoverrides.lua file");
    if (stat.size > limit) throw new Error(`file exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0, size: number;
    while (offset < buffer.length && (size = readSync(fd, buffer, offset, buffer.length - offset, null)) > 0) offset += size;
    if (offset > limit) throw new Error(`file exceeds ${limit} bytes`);
    return buffer.toString("utf8", 0, offset);
  } finally { closeSync(fd); }
}
export async function sshCollect(host: string, user: string | undefined, mode: string, cluster = "", shard = "both"): Promise<Buffer> {
  const shell = readFileSync(new URL("./dst_collect_remote.sh", import.meta.url));
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const target = user ? `${user}@${host}` : host;
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", target, `sh -s -- ${[mode, cluster, shard].map(quote).join(" ")}`], { stdin: shell, stdout: "pipe", stderr: "pipe" });
  const stdoutReader = proc.stdout.getReader(), stderrReader = proc.stderr.getReader();
  const stop = () => {
    proc.kill(9);
    // Close our pipe ends too: a ProxyCommand/descendant may still hold a writer.
    void stdoutReader.cancel().catch(() => {}); void stderrReader.cancel().catch(() => {});
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, 15_000);
  async function collect(reader: ReadableStreamDefaultReader<Uint8Array>, keep: boolean): Promise<Buffer> {
    const chunks: Buffer[] = []; let bytes = 0;
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { stop(); throw new Error("SSH output exceeds 3145728 bytes"); }
      if (keep) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  try {
    const results = await Promise.allSettled([collect(stdoutReader, true), collect(stderrReader, false), proc.exited]);
    if (timedOut) throw new Error("SSH collection timed out");
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (proc.exitCode !== 0) throw new Error(`Remote SSH failed (exit ${proc.exitCode}); verify host, host key and SSH access manually`);
    const stdout = results[0];
    if (stdout.status !== "fulfilled") throw new Error("SSH stdout unavailable");
    return stdout.value;
  } finally { clearTimeout(timer); }
}
export function diagnostic(error: unknown): string {
  // Filesystem errors contain paths only; never relay raw SSH stderr or Lua source.
  return error instanceof Error ? error.message : "collection failed";
}
