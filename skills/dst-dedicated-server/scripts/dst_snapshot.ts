#!/usr/bin/env bun

import { constants, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, opendir, realpath, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSupervised, type SupervisedChild } from "./process_supervisor.ts";

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

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("error:") ? message : `error: ${message}`;
}

function expandUser(path: string): string {
  const home = process.env.HOME ?? homedir();
  return path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function killProcessTree(supervised: SupervisedChild, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32") {
    try { process.kill(-supervised.child.pid, signal); } catch { /* The supervisor may already be gone. */ }
  }
  try { supervised.child.kill(signal); } catch { /* The supervisor may already be gone. */ }
}

export const MAX_REMOTE_OUTPUT_BYTES = 256 * 1024;
export const REMOTE_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const LOCAL_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_LOCAL_DIRECTORY_ENTRIES = 4_096;
export const MAX_LOCAL_CLUSTER_PATHS = 4_096;
export const MAX_LOCAL_CLUSTER_SCAN_ENTRIES = 4_096;

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
  onTimeout: () => void,
  timeoutMs: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  let truncated = false;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    if (cancelPromise === undefined) cancelPromise = reader.cancel().catch(() => undefined);
    return cancelPromise;
  };
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        onTimeout();
        await cancelReader();
        break;
      }
      type ReadResult = Awaited<ReturnType<typeof reader.read>>;
      const result = await new Promise<{ kind: "data"; value: ReadResult } | { kind: "timeout" }>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
        reader.read().then(
          (value) => {
            clearTimeout(timer);
            resolve({ kind: "data", value });
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      if (result.kind === "timeout") {
        onTimeout();
        await cancelReader();
        break;
      }
      const { done, value } = result.value;
      if (done) break;
      const chunk = value ?? new Uint8Array();
      if (chunk.byteLength > remaining) {
        text += decoder.decode(chunk.slice(0, remaining), { stream: true });
        truncated = true;
        onLimit();
        await cancelReader();
        break;
      }
      text += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
    }
    return { text: text + decoder.decode(), truncated };
  } finally {
    if (cancelPromise !== undefined) await cancelPromise;
    reader.releaseLock();
  }
}

async function runWithStdin(
  args: string[],
  input: string,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
  maxOutputBytes = MAX_REMOTE_OUTPUT_BYTES,
): Promise<CommandResult> {
  const supervised = await spawnSupervised(args);
  const child = supervised.child;
  const exitPromise = supervised.exited;
  let timedOut = false;
  let outputTruncated = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const requestStop = () => {
    killProcessTree(supervised, "SIGTERM");
    if (forceKillTimer === undefined) forceKillTimer = setTimeout(() => killProcessTree(supervised, "SIGKILL"), 1_000);
  };
  const stopForLimit = () => {
    outputTruncated = true;
    requestStop();
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await child.stdin.write(input);
      await child.stdin.end();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
    }
    const stopForReadTimeout = () => {
      timedOut = true;
      requestStop();
    };
    const stdoutPromise = readBounded(child.stdout, maxOutputBytes, stopForLimit, stopForReadTimeout, timeoutMs);
    const stderrPromise = readBounded(child.stderr, maxOutputBytes, stopForLimit, stopForReadTimeout, timeoutMs);
    timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);
    const exitCode = await exitPromise;
    // The supervisor remains as the verified process-group anchor while descendants drain.
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
    await Promise.race([supervised.wrapperExited.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    killProcessTree(supervised, "SIGKILL");
    await Promise.race([supervised.wrapperExited.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    await supervised.cleanup();
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EBADF" && code !== "EISDIR") throw error;
  }
}

const SENSITIVE_NAME = "(?:password|passwd|pass[ _-]?phrase|pwd|secret|token|credential|private[_ -]?key|api[_ -]?key|access[_ -]?key|authorization|bearer|cookie|set[ _-]?cookie|session(?:[_ -]?id)?)";
const SENSITIVE_KEY = `(?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*|"[^"\\r\\n]*${SENSITIVE_NAME}[^"\\r\\n]*"|'[^'\\r\\n]*${SENSITIVE_NAME}[^'\\r\\n]*')`;
const SENSITIVE_KEY_TOKEN = `(?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*|\\[[^\\]\\r\\n]*${SENSITIVE_NAME}[^\\]\\r\\n]*\\])`;
const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)\\s*[:=]\\s*)(?!\\s*\\[REDACTED\\])("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^;\\r\\n]+?(?=[ \\t]+\\b${SENSITIVE_NAME}\\b(?:[ \\t]+|[:=])|\\r?\\n|$)|[^;\\r\\n]+?(?=[ \\t]+\\b${SENSITIVE_NAME}\\b(?:[ \\t]+|[:=])|\\r?\\n|$))`,
  "gi",
);
const SENSITIVE_QUOTED_ASSIGNMENT = new RegExp(
  `(${SENSITIVE_KEY}\\s*[:=]\\s*)(?!\\s*\\[REDACTED\\])("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^;\\r\\n]+?(?=[ \\t]+\\b${SENSITIVE_NAME}\\b(?:[ \\t]+|[:=])|\\r?\\n|$)|[^;\\r\\n]+?(?=[ \\t]+\\b${SENSITIVE_NAME}\\b(?:[ \\t]+|[:=])|\\r?\\n|$))`,
  "gi",
);
const SENSITIVE_BARE_VALUE = new RegExp(`\\b(${SENSITIVE_NAME})\\s+(?![A-Za-z0-9_.-]+\\s*[:=]|\\[REDACTED\\])([^,;\\r\\n]+?)(?=(?:\\s+(?:via|and)\\s+)|[,;\\r\\n]|$)`, "gi");
const UNREDACTED_SENSITIVE_ASSIGNMENT = new RegExp(`(?:\\b${SENSITIVE_NAME}|${SENSITIVE_KEY})\\s*[:=](?!\\s*\\[REDACTED\\])`, "i");
const AUTHORIZATION_TOKEN = /\b(Bearer|Basic)(?:\s*[:=])?\s*([^\s,;]+)/gi;
const BRACKETED_SENSITIVE_ASSIGNMENT = new RegExp(`(\\[[^\\]\\r\\n]*${SENSITIVE_NAME}[^\\]\\r\\n]*\\]\\s*[:=]\\s*)(?!\\s*\\[REDACTED\\])([^\\r\\n]+)`, "gi");
const ENCODED_SENSITIVE_ASSIGNMENT = new RegExp(`(\\b[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*\\s*%3[dD]\\s*)(?!\\s*\\[REDACTED\\])([^\\r\\n]+)`, "gi");
const SENSITIVE_BLOCK_HEADER = new RegExp(`^([ \\t]*${SENSITIVE_KEY_TOKEN}\\s*[:=]\\s*[|>][-+0-9]*)\\s*$`, "i");
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gi;
const SENSITIVE_FILENAME = new RegExp("(?<![A-Za-z0-9])(?:[A-Za-z0-9_.-]*(?:" + SENSITIVE_NAME + "|env|id[_ -]?rsa)[A-Za-z0-9_.-]*)(?![A-Za-z0-9])", "gi");
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const SENSITIVE_MULTILINE_ASSIGNMENT = new RegExp(`(${SENSITIVE_KEY_TOKEN}\\s*[:=])\\s*\\r?\\n(?:[ \\t]+[^\\r\\n]*(?:\\r?\\n|$))+`, "gi");
const SENSITIVE_COLLECTION_ASSIGNMENT = new RegExp(`(${SENSITIVE_KEY}\\s*[:=]\\s*)([\\[{])`, "gi");

function collectionEnd(text: string, openingIndex: number): number | undefined {
  const stack: string[] = [];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = openingIndex; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const opening = stack.at(-1);
      if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) return undefined;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

function hasUnbalancedDelimiter(text: string): boolean {
  const stack: string[] = [];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of text) {
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opening = stack.at(-1);
      if ((character === "}" && opening === "{") || (character === "]" && opening === "[")) stack.pop();
    }
  }
  return quote !== undefined || stack.length > 0;
}

function redactSensitiveCollections(text: string): string {
  let output = "";
  let cursor = 0;
  SENSITIVE_COLLECTION_ASSIGNMENT.lastIndex = 0;
  for (let match = SENSITIVE_COLLECTION_ASSIGNMENT.exec(text); match !== null; match = SENSITIVE_COLLECTION_ASSIGNMENT.exec(text)) {
    const openingIndex = match.index + match[0].length - 1;
    const end = collectionEnd(text, openingIndex);
    if (end === undefined) {
      output += text.slice(cursor, match.index) + match[1] + "[REDACTED]";
      cursor = text.length;
      break;
    }
    output += text.slice(cursor, match.index) + match[1] + "[REDACTED]";
    cursor = end;
    SENSITIVE_COLLECTION_ASSIGNMENT.lastIndex = end;
  }
  return output + text.slice(cursor);
}

function redactSensitiveBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const redacted: string[] = [];
  let blockIndent: number | undefined;
  for (const line of lines) {
    const indent = line.match(/^[ \\t]*/)?.[0].length ?? 0;
    if (blockIndent !== undefined) {
      if (line.trim() === "" || indent > blockIndent) {
        redacted.push(`${line.slice(0, indent)}[REDACTED]`);
        continue;
      }
      blockIndent = undefined;
    }
    const match = SENSITIVE_BLOCK_HEADER.exec(line);
    SENSITIVE_BLOCK_HEADER.lastIndex = 0;
    if (match !== null) {
      blockIndent = indent;
      redacted.push(`${match[1]} [REDACTED]`);
    } else {
      redacted.push(line);
    }
  }
  return redacted.join("\n");
}

function redactSensitiveContinuations(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const line = lines[index]!;
    const match = UNREDACTED_SENSITIVE_ASSIGNMENT.exec(line);
    if (match === null) continue;
    const value = line.slice(match.index + match[0].length).trim();
    if (value.length === 0 || value === "[REDACTED]" || value.startsWith("|") || value.startsWith(">")) continue;
    const next = lines[index + 1]!;
    if (next.trim() === value) lines[index + 1] = `${next.slice(0, next.length - next.trimStart().length)}[REDACTED]`;
  }
  return lines.join("\n");
}

export function redactSensitiveText(text: string): string {
  const normalized = text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTERS, "");
  const redacted = redactSensitiveCollections(redactSensitiveBlocks(redactSensitiveContinuations(normalized)))
    .replace(SENSITIVE_MULTILINE_ASSIGNMENT, "$1[REDACTED]")
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED]")
    .replace(AUTHORIZATION_TOKEN, "$1 [REDACTED]")
    .replace(BRACKETED_SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(ENCODED_SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_QUOTED_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_BARE_VALUE, "$1 [REDACTED]");
  return redacted.split(/\r?\n/).map((line) => UNREDACTED_SENSITIVE_ASSIGNMENT.test(line) ? "[REDACTED]" : line).join("\n");
}

export function redactOperationalText(text: string, values: string[] = []): string {
  let redacted = text;
  for (const value of values.filter((candidate) => candidate.length > 0).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(value).join("<redacted-path>");
  }
  return redactSensitiveText(redacted)
    .replace(/\/(?:[^"'<>`\n,;)\]}]|\\ )+?(?=$|[\n"'<>`,;)\]}]|\s+[A-Za-z0-9_.-]+\s*[:=])/g, "<redacted-path>")
    .replace(/\b[A-Za-z]:[\\/](?:[^"'<>`\n,;)\]}]|\\ )+?(?=$|[\n"'<>`,;)\]}]|\s+[A-Za-z0-9_.-]+\s*[:=])/g, "<redacted-path>")
    .replace(/(^|[\s"'(=:])(?:\.\.?[\\/])+[^"'<>`\n,;)\]}]+/g, "$1<redacted-path>")
    .replace(/(^|[\s"'(=:])\\\\[^"'<>`\n,;)\]}]+/g, "$1<redacted-path>")
    .replace(/(^|[\s"'(=:])(?=[^"'<>`\n,;)\]}\s]+[\\/]\.\.?[\\/])[^"'<>`\n,;)\]}]+/g, "$1<redacted-path>")
    .replace(/(?<![A-Za-z0-9])(?:(?:[0-9A-Fa-f]{0,4}:){1,7})(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9])/g, "<redacted-address>")
    .replace(/(?<![A-Za-z0-9])(?:(?:[0-9A-Fa-f]{0,4}:){2,}[0-9A-Fa-f]{0,4}(?:%[A-Za-z0-9._-]+)?)(?![A-Za-z0-9])/g, "<redacted-address>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-address>");
}

function redactDirectoryListing(text: string, values: string[] = []): string {
  return redactOperationalText(text, values).replace(SENSITIVE_FILENAME, "<redacted-name>");
}

export function validateSshToken(value: string, label: string): void {
  if (value.length === 0 || value.startsWith("-") || /[\u0000\r\n\t\s@/\\]/.test(value)) {
    throw new CliError(`error: --${label} contains an invalid SSH token`);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function containedPath(root: string, candidate: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidate);
    return isContainedPath(root, resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function safeTail(file: string, lines: number, allowedRoot?: string): Promise<string> {
  if (lines <= 0) return "";
  try {
    const safeFile = allowedRoot === undefined ? file : await containedPath(allowedRoot, file);
    if (safeFile === undefined) return "";
    const handle = await open(safeFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
      if (partialLine) {
        const partialPrefix = text.slice(0, firstLineEnd);
        const partialProbe = partialPrefix.length > 8_192
          ? `${partialPrefix.slice(0, 4_096)}\n${partialPrefix.slice(-4_096)}`
          : partialPrefix;
        const sensitiveAssignment = UNREDACTED_SENSITIVE_ASSIGNMENT.test(partialProbe)
          && /(?:[:=]\s*$|[:=]\s*[|>][-+0-9]*\s*$|[\[{])/.test(partialPrefix);
        UNREDACTED_SENSITIVE_ASSIGNMENT.lastIndex = 0;
        if (hasUnbalancedDelimiter(partialPrefix) || /^\s/.test(partialPrefix) || sensitiveAssignment) {
          return "[REDACTED: bounded log tail begins mid-record]";
        }
      }
      const completeText = partialLine ? text.slice(firstLineEnd + 1) : text;
      return redactSensitiveText(completeText.split(/\r?\n/).slice(-lines).join("\n"));
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function commandFirstLines(args: string[], lines: number, redactions: string[] = [], redactNames = false): Promise<string> {
  try {
    const result = await runWithStdin(args, "", LOCAL_COMMAND_TIMEOUT_MS, MAX_LOCAL_COMMAND_OUTPUT_BYTES);
    const selected = result.stdout.split(/\r?\n/).slice(0, lines).join("\n").trimEnd();
    const marker = result.timedOut ? "[command timed out]" : result.outputTruncated ? "[output truncated]" : "";
    const output = [selected, marker].filter(Boolean).join("\n");
    return redactNames ? redactDirectoryListing(output, redactions) : redactOperationalText(output, redactions);
  } catch {
    return "[command unavailable]";
  }
}

async function boundedDirectoryEntries(path: string, limit = MAX_LOCAL_DIRECTORY_ENTRIES): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const directory = await opendir(path);
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    for await (const entry of directory) {
      if (entries.length >= limit) {
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
  const requestedLocalDir = resolve(expandUser(options.localDir));
  const lines: string[] = [
    "## Local",
    "",
    "- Host: <local-host>",
    `- Collected at: ${isoTimestamp()}`,
    `- Client data dir: \`${options.localDir.length > 0 ? "<configured-local-dir>" : "<unset>"}\``,
    "",
  ];
  let directory;
  let localDir: string | undefined;
  try {
    directory = await lstat(requestedLocalDir);
    if (directory.isDirectory() && !directory.isSymbolicLink()) localDir = await realpath(requestedLocalDir);
  } catch {
    directory = undefined;
  }
  if (options.localDir.length === 0 || directory?.isDirectory() !== true || localDir === undefined) {
    lines.push("> Local dir not found. Skipping local collection.", "");
    return lines.join("\n");
  }

  const pathRedactions = [localDir, process.env.HOME ?? homedir(), homedir()];
  lines.push("### Directory overview", "", await commandFirstLines(["ls", "-la", "--", localDir], 200, pathRedactions, true), "");
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
  if (logFiles.length > 0) lines.push(await commandFirstLines(["ls", "-la", "--", ...logFiles], 200, pathRedactions, true));
  lines.push("");

  const clientLog = join(localDir, "client_log.txt");
  try {
    const safeClientLog = await containedPath(localDir, clientLog);
    if (safeClientLog !== undefined && (await lstat(safeClientLog)).isFile()) {
      lines.push("### client_log.txt (tail 80)", "", redactOperationalText((await safeTail(safeClientLog, 80, localDir)).trimEnd(), pathRedactions), "");
    }
  } catch {
    // The file is optional.
  }

  const clusters: string[] = [];
  let clusterScanTruncated = false;
  let clusterEntriesScanned = 0;
  for (const entry of entries) {
    if (clusters.length >= MAX_LOCAL_CLUSTER_PATHS) {
      clusterScanTruncated = true;
      break;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("Cluster_")) {
      clusterEntriesScanned += 1;
      const cluster = await containedPath(localDir, join(localDir, entry.name));
      if (cluster !== undefined) clusters.push(cluster);
      continue;
    }
    if (clusterEntriesScanned >= MAX_LOCAL_CLUSTER_SCAN_ENTRIES) {
      clusterScanTruncated = true;
      break;
    }
    let profileEntries: Dirent[];
    let profileTruncated = false;
    try {
      const listing = await boundedDirectoryEntries(join(localDir, entry.name), Math.min(MAX_LOCAL_DIRECTORY_ENTRIES, MAX_LOCAL_CLUSTER_SCAN_ENTRIES - clusterEntriesScanned));
      profileEntries = listing.entries;
      profileTruncated = listing.truncated;
    } catch {
      profileEntries = [];
    }
    clusterEntriesScanned += profileEntries.length;
    if (profileTruncated) clusterScanTruncated = true;
    for (const profileEntry of profileEntries) {
      if (clusters.length >= MAX_LOCAL_CLUSTER_PATHS) {
        clusterScanTruncated = true;
        break;
      }
      if (profileEntry.isDirectory() && profileEntry.name.startsWith("Cluster_")) {
        const cluster = await containedPath(localDir, join(localDir, entry.name, profileEntry.name));
        if (cluster !== undefined) clusters.push(cluster);
      }
    }
  }
  if (clusterScanTruncated) lines.push(`> Cluster path scan truncated at ${MAX_LOCAL_CLUSTER_SCAN_ENTRIES} entries.`, "");
  if (clusters.length > 0) {
    lines.push("### Local clusters (paths only; secrets redacted)", "");
    for (const [index, cluster] of clusters.sort().entries()) {
      lines.push(`- <cluster-${index + 1}>`);
      try {
        const tokenPath = await containedPath(localDir, join(cluster, "cluster_token.txt"));
        if (tokenPath !== undefined && (await lstat(tokenPath)).isFile()) lines.push("  - cluster_token.txt: present (redacted)");
      } catch {
        // Optional secret marker.
      }
      try {
        const iniPath = await containedPath(localDir, join(cluster, "cluster.ini"));
        if (iniPath !== undefined && (await lstat(iniPath)).isFile()) lines.push("  - cluster.ini: present (contains cluster_password; do not paste)");
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

  let result: CommandResult;
  try {
    result = await runWithStdin(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "bash", "-s"], script);
  } catch (error) {
    const detail = redactOperationalText(error instanceof Error ? error.message : String(error), [options.host, options.user, homedir()]);
    lines.push("> Remote collection command could not be started.");
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
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
    console.error(formatCliError(error));
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
    const detail = redactOperationalText(error instanceof Error ? error.message : String(error), [outputPath, dirname(outputPath)]);
    console.error(`error: cannot publish snapshot at <configured-output>: ${detail || "publication failed"}`);
    return 2;
  }
  console.log(outputPath);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
