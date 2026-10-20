#!/usr/bin/env bun

import { type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

interface SnapshotOptions {
  host: string;
  user: string;
  out?: string;
  localDir: string;
  noLocal: boolean;
  noRemote: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated?: boolean;
  timedOut?: boolean;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

function expandUser(path: string): string {
  const home = process.env.HOME ?? "";
  return path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function decode(value: Uint8Array | undefined): string {
  return value === undefined ? "" : new TextDecoder().decode(value);
}

function runSync(args: string[]): CommandResult {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

export const MAX_REMOTE_OUTPUT_BYTES = 256 * 1024;
export const REMOTE_COMMAND_TIMEOUT_MS = 30_000;

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, onLimit: () => void): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value ?? new Uint8Array();
      if (chunk.byteLength > remaining) {
        text += decoder.decode(chunk.slice(0, remaining), { stream: true });
        truncated = true;
        onLimit();
        await reader.cancel();
        break;
      }
      text += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
    }
    return { text: text + decoder.decode(), truncated };
  } finally {
    reader.releaseLock();
  }
}

async function runWithStdin(args: string[], input: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
  child.stdin.end();
  let timedOut = false;
  let outputTruncated = false;
  const stopForLimit = () => {
    outputTruncated = true;
    child.kill();
  };
  const stdoutPromise = readBounded(child.stdout, MAX_REMOTE_OUTPUT_BYTES, stopForLimit);
  const stderrPromise = readBounded(child.stderr, MAX_REMOTE_OUTPUT_BYTES, stopForLimit);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  clearTimeout(timeout);
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    outputTruncated: outputTruncated || stdout.truncated || stderr.truncated,
    timedOut,
  };
}

function isoTimestamp(): string {
  return new Date().toISOString();
}

function fileTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const millis = String(now.getMilliseconds()).padStart(3, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${millis}-${randomUUID().slice(0, 8)}`;
}

const SENSITIVE_NAME = "(?:password|passwd|secret|token|credential|private[_ -]?key|api[_ -]?key|access[_ -]?key|authorization|bearer)";
const SENSITIVE_MARKER = new RegExp(SENSITIVE_NAME, "i");
const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^\\s,;]+|[^\\s,;]+)`,
  "gi",
);

export function redactSensitiveText(text: string): string {
  return text.split(/\r?\n/).map((line) => {
    const redacted = line.replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]");
    return redacted === line && SENSITIVE_MARKER.test(line) ? "[REDACTED]" : redacted;
  }).join("\n");
}

export async function safeTail(file: string, lines: number): Promise<string> {
  if (lines <= 0) return "";
  try {
    const result = runSync(["tail", "-n", String(lines), file]);
    return result.exitCode === 0 ? redactSensitiveText(result.stdout) : "";
  } catch {
    return "";
  }
}

async function commandFirstLines(args: string[], lines: number): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const selected: string[] = [];
  let remainder = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const parts = `${remainder}${decoder.decode(value ?? new Uint8Array(), { stream: true })}`.split(/\r?\n/);
      remainder = parts.pop() ?? "";
      if (selected.length < lines) selected.push(...parts.slice(0, lines - selected.length));
    }
    const finalText = `${remainder}${decoder.decode()}`;
    if (selected.length < lines && finalText.length > 0) selected.push(finalText);
  } finally {
    reader.releaseLock();
  }
  await child.exited;
  await new Response(child.stderr).text();
  return selected.slice(0, lines).join("\n").trimEnd();
}

async function localCollect(options: SnapshotOptions): Promise<string> {
  const displayDir = options.localDir || "<unset>";
  const localDir = expandUser(options.localDir);
  const lines: string[] = [
    "## Local",
    "",
    `- Host: ${hostname()}`,
    `- Collected at: ${isoTimestamp()}`,
    `- Client data dir: \`${displayDir}\``,
    "",
  ];
  let directory;
  try {
    directory = await stat(localDir);
  } catch {
    directory = undefined;
  }
  if (options.localDir.length === 0 || directory?.isDirectory() !== true) {
    lines.push("> Local dir not found. Skipping local collection.", "");
    return lines.join("\n");
  }

  lines.push("### Directory overview", "", await commandFirstLines(["ls", "-la", localDir], 200), "");
  const entries = await readdir(localDir, { withFileTypes: true });
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.includes("log") && entry.name.endsWith(".txt"))
    .map((entry) => join(localDir, entry.name))
    .sort();
  lines.push("### Known log files (first 200 lines of listing)", "");
  if (logFiles.length > 0) lines.push(await commandFirstLines(["ls", "-la", ...logFiles], 200));
  lines.push("");

  const clientLog = join(localDir, "client_log.txt");
  try {
    if ((await stat(clientLog)).isFile()) {
      lines.push("### client_log.txt (tail 80)", "", (await safeTail(clientLog, 80)).trimEnd(), "");
    }
  } catch {
    // The file is optional.
  }

  const clusters: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("Cluster_")) {
      clusters.push(join(localDir, entry.name));
      continue;
    }
    let profileEntries: Dirent[];
    try {
      profileEntries = await readdir(join(localDir, entry.name), { withFileTypes: true });
    } catch {
      profileEntries = [];
    }
    for (const profileEntry of profileEntries) {
      if (profileEntry.isDirectory() && profileEntry.name.startsWith("Cluster_")) {
        clusters.push(join(localDir, entry.name, profileEntry.name));
      }
    }
  }
  if (clusters.length > 0) {
    lines.push("### Local clusters (paths only; secrets redacted)", "");
    for (const cluster of clusters.sort()) {
      lines.push(`- ${cluster}`);
      try {
        if ((await stat(join(cluster, "cluster_token.txt"))).isFile()) lines.push("  - cluster_token.txt: present (redacted)");
      } catch {
        // Optional secret marker.
      }
      try {
        if ((await stat(join(cluster, "cluster.ini"))).isFile()) lines.push("  - cluster.ini: present (contains cluster_password; do not paste)");
      } catch {
        // Optional secret marker.
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function remoteCollect(options: SnapshotOptions, script: string): Promise<{ text: string; failed: boolean }> {
  const lines = ["## Remote", "", `- Target: \`${options.user}@${options.host}\``, ""];
  const target = `${options.user}@${options.host}`;
  let connectivity: CommandResult;
  try {
    connectivity = await runWithStdin(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "echo", "ok"], "", 5_000);
  } catch {
    lines.push("> ssh not found on this machine. Skipping remote collection.", "");
    return { text: lines.join("\n"), failed: false };
  }
  if (connectivity.timedOut) {
    lines.push("> Remote SSH connectivity check timed out after 5s. Verify reachability and run the command interactively, then re-run this script.", "");
    return { text: lines.join("\n"), failed: false };
  }
  if (connectivity.exitCode !== 0) {
    lines.push("> Remote SSH failed (host down, wrong IP/port, or missing SSH key).");
    const detail = redactSensitiveText(connectivity.stderr.trim());
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push(`> Next step: verify reachability and run \`ssh ${target}\` interactively, then re-run this script.`, "");
    return { text: lines.join("\n"), failed: false };
  }

  const result = await runWithStdin(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "bash", "-s"], script);
  if (result.timedOut) {
    lines.push(`> Remote collection timed out after ${REMOTE_COMMAND_TIMEOUT_MS / 1000}s.`, "");
    return { text: lines.join("\n"), failed: true };
  }
  if (result.outputTruncated) {
    lines.push(`> Remote collection exceeded the ${MAX_REMOTE_OUTPUT_BYTES}-byte output limit.`, "");
    return { text: lines.join("\n"), failed: true };
  }
  if (result.exitCode !== 0) {
    lines.push("> Remote collection command failed.");
    const detail = redactSensitiveText(result.stderr.trim());
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  lines.push(redactSensitiveText(result.stdout.trimEnd()), "");
  return { text: lines.join("\n"), failed: false };
}

function usage(): void {
  console.log(`Collect a non-sensitive DST troubleshooting snapshot (local client dir + remote dedicated server).

Usage:
  dst_snapshot.ts [--host <ip>] [--user <ssh-user>] [--out <path>] [--local-dir <path>] [--no-local] [--no-remote]

Defaults:
  --host      value from DST_HOST
  --user      value from DST_USER
  --local-dir value from DST_LOCAL_DIR
  --out       /tmp/dst-snapshot-<timestamp>.md

Notes:
  - Remote collection uses non-interactive SSH (BatchMode=yes) to avoid hanging.
  - Secrets are never printed; only existence/path is reported.`);
}

function optionValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${option} requires a value`);
  return [value, index + 2];
}

export function parseArgs(args: string[], env: Record<string, string | undefined> = process.env): SnapshotOptions | "help" {
  let host = env.DST_HOST ?? "";
  let user = env.DST_USER ?? "";
  let out: string | undefined;
  let localDir = env.DST_LOCAL_DIR ?? "";
  let noLocal = false;
  let noRemote = false;
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--no-local") {
      noLocal = true;
      index += 1;
      continue;
    }
    if (arg === "--no-remote") {
      noRemote = true;
      index += 1;
      continue;
    }
    if (arg === "--host" || arg === "--user" || arg === "--out" || arg === "--local-dir") {
      const [value, next] = optionValue(args, index, arg);
      if (arg === "--host") host = value;
      else if (arg === "--user") user = value;
      else if (arg === "--out") out = value;
      else localDir = value;
      index = next;
      continue;
    }
    throw new CliError(`Unknown arg: ${arg}`);
  }
  if (!noRemote && host.length === 0) throw new CliError("error: --host or DST_HOST is required unless --no-remote is used");
  return { host, user, out, localDir, noLocal, noRemote };
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  let parsed: SnapshotOptions | "help";
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof CliError ? error.exitCode : 2;
  }
  if (parsed === "help") {
    usage();
    return 0;
  }

  const outputPath = expandUser(parsed.out ?? `/tmp/dst-snapshot-${fileTimestamp()}.md`);
  const remoteScript = await Bun.file(join(import.meta.dir, "dst_snapshot_remote.sh")).text();
  const report: string[] = [
    "# DST snapshot",
    "",
    `- Generated: ${isoTimestamp()}`,
    `- Remote: ${parsed.user}@${parsed.host}`,
    `- Local dir: ${parsed.localDir || "<unset>"}`,
    "",
  ];
  if (parsed.noLocal) report.push("## Local", "", "> Skipped (--no-local).", "");
  else report.push(await localCollect(parsed), "");
  let failed = false;
  if (parsed.noRemote) report.push("## Remote", "", "> Skipped (--no-remote).", "");
  else {
    const remote = await remoteCollect(parsed, remoteScript);
    report.push(remote.text, "");
    failed = remote.failed;
  }
  try {
    const parent = dirname(outputPath);
    const tempDir = await mkdtemp(join(parent, ".dst-snapshot-tmp-"));
    const tempPath = join(tempDir, basename(outputPath));
    try {
      const handle = await open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(report.join("\n"), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(tempPath, outputPath);
    } finally {
      await unlink(tempPath).catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`error: cannot publish snapshot at ${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(outputPath);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
