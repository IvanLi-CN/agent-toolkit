#!/usr/bin/env bun

import { constants, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
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
  const home = process.env.HOME ?? homedir();
  return path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function killProcessTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); } catch { /* The process may already be gone. */ }
  }
  try { child.kill(signal); } catch { /* The process may already be gone. */ }
}

export const MAX_REMOTE_OUTPUT_BYTES = 256 * 1024;
export const REMOTE_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const LOCAL_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_LOCAL_DIRECTORY_ENTRIES = 4_096;
export const MAX_LOCAL_CLUSTER_PATHS = 4_096;

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

async function runWithStdin(
  args: string[],
  input: string,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
  maxOutputBytes = MAX_REMOTE_OUTPUT_BYTES,
): Promise<CommandResult> {
  const child = Bun.spawn(args, { detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const exitPromise = child.exited;
  let timedOut = false;
  let outputTruncated = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const requestStop = () => {
    killProcessTree(child, "SIGTERM");
    if (forceKillTimer === undefined) forceKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 1_000);
  };
  const stopForLimit = () => {
    outputTruncated = true;
    requestStop();
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.write(input);
    child.stdin.end();
    const stdoutPromise = readBounded(child.stdout, maxOutputBytes, stopForLimit);
    const stderrPromise = readBounded(child.stderr, maxOutputBytes, stopForLimit);
    timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);
    const exitCode = await exitPromise;
    // The leader can exit while a descendant still owns stdout or stderr. Stop the
    // process group before awaiting those streams so cleanup cannot hang forever.
    requestStop();
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated: outputTruncated || stdout.truncated || stderr.truncated,
      timedOut,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    requestStop();
    await Promise.race([exitPromise.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    killProcessTree(child, "SIGKILL");
    await Promise.race([exitPromise.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
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

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every supported platform.
  }
}

const SENSITIVE_NAME = "(?:password|passwd|passphrase|pwd|secret|token|credential|private[_ -]?key|api[_ -]?key|access[_ -]?key|authorization|bearer)";
const SENSITIVE_KEY = `(?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*|"[^"\\r\\n]*${SENSITIVE_NAME}[^"\\r\\n]*"|'[^'\\r\\n]*${SENSITIVE_NAME}[^'\\r\\n]*')`;
const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^\\s;]+|[^\\s;]+)`,
  "gi",
);
const SENSITIVE_QUOTED_ASSIGNMENT = new RegExp(
  `(${SENSITIVE_KEY}\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^\\s;]+|[^\\s;]+)`,
  "gi",
);
const SENSITIVE_BARE_VALUE = new RegExp(`\\b(${SENSITIVE_NAME})\\s+(?!\\[REDACTED\\])([^\\s;]+)`, "gi");
const UNREDACTED_SENSITIVE_ASSIGNMENT = new RegExp(`(?:\\b${SENSITIVE_NAME}|${SENSITIVE_KEY})\\s*[:=](?!\\s*\\[REDACTED\\])`, "i");

export function redactSensitiveText(text: string): string {
  const redacted = text
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_QUOTED_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_BARE_VALUE, "$1 [REDACTED]");
  return redacted.split(/\r?\n/).map((line) => UNREDACTED_SENSITIVE_ASSIGNMENT.test(line) ? "[REDACTED]" : line).join("\n");
}

function redactOperationalText(text: string, values: string[] = []): string {
  let redacted = text;
  for (const value of values.filter((candidate) => candidate.length > 0).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(value).join("<redacted-path>");
  }
  return redactSensitiveText(redacted);
}

export function validateSshToken(value: string, label: string): void {
  if (value.length === 0 || value.startsWith("-") || /[\u0000\r\n\t\s@/\\]/.test(value)) {
    throw new CliError(`error: --${label} contains an invalid SSH token`);
  }
}

export async function safeTail(file: string, lines: number): Promise<string> {
  if (lines <= 0) return "";
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return "";
      const bytesToRead = Math.min(metadata.size, 256 * 1024);
      const buffer = new Uint8Array(bytesToRead);
      const result = await handle.read(buffer, 0, bytesToRead, metadata.size - bytesToRead);
      const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead));
      const partialLine = metadata.size > bytesToRead;
      const firstLineEnd = text.search(/\r?\n/);
      if (partialLine && firstLineEnd < 0) return "";
      const completeText = partialLine ? text.slice(firstLineEnd + 1) : text;
      return redactSensitiveText(completeText.split(/\r?\n/).slice(-lines).join("\n"));
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function commandFirstLines(args: string[], lines: number, redactions: string[] = []): Promise<string> {
  try {
    const result = await runWithStdin(args, "", LOCAL_COMMAND_TIMEOUT_MS, MAX_LOCAL_COMMAND_OUTPUT_BYTES);
    const selected = result.stdout.split(/\r?\n/).slice(0, lines).join("\n").trimEnd();
    const marker = result.timedOut ? "[command timed out]" : result.outputTruncated ? "[output truncated]" : "";
    return redactOperationalText([selected, marker].filter(Boolean).join("\n"), redactions);
  } catch {
    return "[command unavailable]";
  }
}

async function boundedDirectoryEntries(path: string): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const directory = await opendir(path);
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    for await (const entry of directory) {
      if (entries.length >= MAX_LOCAL_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, truncated };
}

async function localCollect(options: SnapshotOptions): Promise<string> {
  const localDir = expandUser(options.localDir);
  const lines: string[] = [
    "## Local",
    "",
    "- Host: <local-host>",
    `- Collected at: ${isoTimestamp()}`,
    `- Client data dir: \`${options.localDir.length > 0 ? "<configured-local-dir>" : "<unset>"}\``,
    "",
  ];
  let directory;
  try {
    directory = await lstat(localDir);
  } catch {
    directory = undefined;
  }
  if (options.localDir.length === 0 || directory?.isDirectory() !== true) {
    lines.push("> Local dir not found. Skipping local collection.", "");
    return lines.join("\n");
  }

  const pathRedactions = [localDir, process.env.HOME ?? homedir(), homedir()];
  lines.push("### Directory overview", "", await commandFirstLines(["ls", "-la", localDir], 200, pathRedactions), "");
  let entryListing: { entries: Dirent[]; truncated: boolean };
  try {
    entryListing = await boundedDirectoryEntries(localDir);
  } catch {
    lines.push("> Directory entries unavailable; skipping filesystem-derived details.", "");
    return lines.join("\n");
  }
  const entries = entryListing.entries;
  if (entryListing.truncated) lines.push(`> Directory entry scan truncated at ${MAX_LOCAL_DIRECTORY_ENTRIES} entries.`, "");
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.includes("log") && entry.name.endsWith(".txt"))
    .map((entry) => join(localDir, entry.name))
    .sort();
  lines.push("### Known log files (first 200 lines of listing)", "");
  if (logFiles.length > 0) lines.push(await commandFirstLines(["ls", "-la", ...logFiles], 200, pathRedactions));
  lines.push("");

  const clientLog = join(localDir, "client_log.txt");
  try {
    if ((await lstat(clientLog)).isFile()) {
      lines.push("### client_log.txt (tail 80)", "", redactOperationalText((await safeTail(clientLog, 80)).trimEnd(), pathRedactions), "");
    }
  } catch {
    // The file is optional.
  }

  const clusters: string[] = [];
  let clusterScanTruncated = false;
  for (const entry of entries) {
    if (clusters.length >= MAX_LOCAL_CLUSTER_PATHS) {
      clusterScanTruncated = true;
      break;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("Cluster_")) {
      clusters.push(join(localDir, entry.name));
      continue;
    }
    let profileEntries: Dirent[];
    try {
      profileEntries = (await boundedDirectoryEntries(join(localDir, entry.name))).entries;
    } catch {
      profileEntries = [];
    }
    for (const profileEntry of profileEntries) {
      if (clusters.length >= MAX_LOCAL_CLUSTER_PATHS) {
        clusterScanTruncated = true;
        break;
      }
      if (profileEntry.isDirectory() && profileEntry.name.startsWith("Cluster_")) {
        clusters.push(join(localDir, entry.name, profileEntry.name));
      }
    }
  }
  if (clusterScanTruncated) lines.push(`> Cluster path scan truncated at ${MAX_LOCAL_CLUSTER_PATHS} entries.`, "");
  if (clusters.length > 0) {
    lines.push("### Local clusters (paths only; secrets redacted)", "");
    for (const [index, cluster] of clusters.sort().entries()) {
      lines.push(`- <cluster-${index + 1}>`);
      try {
        if ((await lstat(join(cluster, "cluster_token.txt"))).isFile()) lines.push("  - cluster_token.txt: present (redacted)");
      } catch {
        // Optional secret marker.
      }
      try {
        if ((await lstat(join(cluster, "cluster.ini"))).isFile()) lines.push("  - cluster.ini: present (contains cluster_password; do not paste)");
      } catch {
        // Optional secret marker.
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function remoteCollect(options: SnapshotOptions, script: string): Promise<{ text: string; failed: boolean }> {
  const lines = ["## Remote", "", "- Target: `<configured-remote>`", ""];
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
    const detail = redactOperationalText(connectivity.stderr.trim(), [options.host, options.user]);
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("> Next step: verify reachability and run the configured SSH target interactively, then re-run this script.", "");
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
    const detail = redactOperationalText(result.stderr.trim(), [options.host, options.user]);
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  lines.push(redactOperationalText(result.stdout.trimEnd(), [options.host, options.user, homedir()]), "");
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
  if (!noRemote) {
    if (host.length === 0) throw new CliError("error: --host or DST_HOST is required unless --no-remote is used");
    if (user.length === 0) throw new CliError("error: --user or DST_USER is required unless --no-remote is used");
    validateSshToken(host, "host");
    validateSshToken(user, "user");
  }
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
    "- Remote: <configured-remote>",
    `- Local dir: ${parsed.localDir ? "<configured-local-dir>" : "<unset>"}`,
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
      await rename(tempPath, outputPath);
    } finally {
      await unlink(tempPath).catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
    await syncDirectory(parent);
  } catch (error) {
    console.error(`error: cannot publish snapshot at <configured-output>: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log("<configured-output>");
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
