#!/usr/bin/env bun

import { constants, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, mkdtemp, open, opendir, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSupervised, SUPERVISOR_UNKNOWN_TARGET_STATUS, type SupervisedChild } from "./process_supervisor.ts";

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
  cleanupVerified: boolean;
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
  try { supervised.child.kill(signal); } catch { /* The supervisor may already be gone. */ }
}

export const MAX_REMOTE_OUTPUT_BYTES = 256 * 1024;
export const REMOTE_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const LOCAL_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_LOCAL_DIRECTORY_ENTRIES = 4_096;
export const MAX_LOCAL_CLUSTER_PATHS = 4_096;
export const MAX_LOCAL_CLUSTER_SCAN_ENTRIES = 4_096;
export const MAX_LOCAL_LOG_LISTING_ENTRIES = 200;
const SUPERVISOR_STOP_GRACE_MS = 250;
const SUPERVISOR_FORCE_KILL_MS = 6_000;
const SNAPSHOT_TEMP_PREFIX = ".dst-snapshot-tmp-";
const SNAPSHOT_TEMP_ROOT_NAME = ".agent-toolkit-dst-snapshot-tmp";
const SNAPSHOT_OWNER_MARKER = "agent-toolkit-dst-snapshot-v1\n";
const SNAPSHOT_TEMP_STALE_MS = 15 * 60 * 1000;
const MAX_SNAPSHOT_TEMP_SCAN_ENTRIES = 128;

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
  onTimeout: () => void,
  timeoutMs: number,
  stopPromise?: Promise<unknown>,
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
      type ReadOutcome = { kind: "data"; value: ReadResult } | { kind: "timeout" } | { kind: "stopped" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<ReadOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      });
      const readPromise = new Promise<ReadOutcome>((resolve, reject) => {
        reader.read().then(
          (value) => resolve({ kind: "data", value }),
          (error) => {
            reject(error);
          },
        );
      });
      const stopPromiseResult = stopPromise?.then(() => ({ kind: "stopped" } as ReadOutcome), () => ({ kind: "stopped" } as ReadOutcome));
      const result = await Promise.race([readPromise, timeoutPromise, ...(stopPromiseResult === undefined ? [] : [stopPromiseResult])]);
      if (timer !== undefined) clearTimeout(timer);
      if (result.kind === "stopped") {
        await cancelReader();
        await Promise.race([readPromise, Bun.sleep(100).then(() => undefined)]);
        break;
      }
      if (result.kind === "timeout") {
        onTimeout();
        await cancelReader();
        await Promise.race([readPromise, Bun.sleep(100).then(() => undefined)]);
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
  let result: CommandResult | undefined;
  let operationError: unknown;
  let operationFailed = false;
  let stopRequested = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const requestStop = () => {
    stopRequested = true;
    killProcessTree(supervised, "SIGTERM");
    if (forceKillTimer === undefined) forceKillTimer = setTimeout(() => killProcessTree(supervised, "SIGKILL"), SUPERVISOR_FORCE_KILL_MS);
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
    const stdoutPromise = readBounded(child.stdout, maxOutputBytes, stopForLimit, stopForReadTimeout, timeoutMs, exitPromise);
    const stderrPromise = readBounded(child.stderr, maxOutputBytes, stopForLimit, stopForReadTimeout, timeoutMs, exitPromise);
    timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);
    const exitCode = await exitPromise;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    result = {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated: outputTruncated || stdout.truncated || stderr.truncated,
      timedOut,
      cleanupVerified: true,
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    let naturalCleanupTimer: ReturnType<typeof setTimeout> | undefined;
    if (operationFailed || stopRequested) requestStop();
    else naturalCleanupTimer = setTimeout(requestStop, SUPERVISOR_FORCE_KILL_MS);
    const cleanupReady = await supervised.waitForCleanupAcknowledged();
    if (naturalCleanupTimer !== undefined) clearTimeout(naturalCleanupTimer);
    await Promise.race([supervised.wrapperExited.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, SUPERVISOR_STOP_GRACE_MS))]);
    const wrapperExited = await Promise.race([supervised.wrapperExited.then(() => true, () => true), Bun.sleep(0).then(() => false)]);
    if (!cleanupReady || !wrapperExited) {
      if (!cleanupReady) await supervised.forceCleanup();
      killProcessTree(supervised, "SIGKILL");
    }
    await Promise.race([supervised.wrapperExited.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, SUPERVISOR_STOP_GRACE_MS))]);
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    await supervised.cleanup();
    await Promise.all([
      child.stdout.cancel().catch(() => undefined),
      child.stderr.cancel().catch(() => undefined),
    ]);
    if (result !== undefined) result.cleanupVerified = cleanupReady;
    if (!cleanupReady && operationFailed && operationError instanceof Error) {
      operationError.message = `${operationError.message}; supervisor_cleanup_unverified`;
    }
  }
  if (operationFailed) throw operationError;
  if (result === undefined) throw new Error("supervisor_command_result_missing");
  return result;
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

const SENSITIVE_NAME = "(?:password|passwd|pass[ _-]?phrase|pwd|secret|token|credential(?:s)?|jwt|private[_ -]?key|api[_ -]?key|access[_ -]?key|signing[_ -]?key|encryption[_ -]?key|database[_ -]?url|mongo[_ -]?uri|authorization|bearer|cookie|set[ _-]?cookie|session(?:[_ -]?id)?)";
const SENSITIVE_BARE_KEY = `(?:[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)`;
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
const SENSITIVE_BARE_VALUE = new RegExp(`(?<![A-Za-z0-9_.-])(${SENSITIVE_BARE_KEY})\\s+(?![A-Za-z0-9_.-]+\\s*[:=]|\\[REDACTED\\])([^,;\\r\\n]+?)(?=(?:\\s+(?:via|and)\\s+)|[,;\\r\\n]|$)`, "gi");
const UNREDACTED_SENSITIVE_ASSIGNMENT = new RegExp(`(?:${SENSITIVE_BARE_KEY}|${SENSITIVE_KEY})\\s*[:=](?!\\s*\\[REDACTED\\])`, "i");
const AUTHORIZATION_TOKEN = /\b(Bearer|Basic)(?:\s*[:=])?\s*([^\s,;]+)/gi;
const JSON_AUTHORIZATION_ASSIGNMENT = /(["'])(Bearer|Basic)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\r\n]+)/gi;
const BRACKETED_SENSITIVE_ASSIGNMENT = new RegExp(`(\\[[^\\]\\r\\n]*${SENSITIVE_NAME}[^\\]\\r\\n]*\\]\\s*[:=]\\s*)(?!\\s*\\[REDACTED\\])([^\\r\\n]+)`, "gi");
const ENCODED_SENSITIVE_ASSIGNMENT = new RegExp(`(\\b[A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*\\s*%3[dD]\\s*)(?!\\s*\\[REDACTED\\])([^\\r\\n]+)`, "gi");
const SENSITIVE_BLOCK_HEADER = new RegExp(`^([ \\t]*${SENSITIVE_KEY_TOKEN}\\s*[:=]\\s*[|>][-+0-9]*)\\s*$`, "i");
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi;
const SENSITIVE_FILENAME = new RegExp("(?<![A-Za-z0-9])(?:[A-Za-z0-9_.-]*(?:" + SENSITIVE_NAME + "|env|id[_ -]?rsa|private[._-]?(?:key|pem)|api[._-]?key|auth[._-]?json)[A-Za-z0-9_.-]*)(?![A-Za-z0-9])", "gi");
const RAW_JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
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
    .replace(JSON_AUTHORIZATION_ASSIGNMENT, "$1$2$1: [REDACTED]")
    .replace(AUTHORIZATION_TOKEN, "$1 [REDACTED]")
    .replace(BRACKETED_SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(ENCODED_SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_QUOTED_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_BARE_VALUE, "$1 [REDACTED]")
    .replace(RAW_JWT, "[REDACTED JWT]");
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
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-address>")
    .replace(/\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g, "<redacted-host>");
}

function escapeReportText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;");
}

function escapeReportInlineText(text: string): string {
  return escapeReportText(text)
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;");
}

function renderReportCodeBlock(text: string, values: string[] = []): string {
  return ["```text", escapeReportText(redactOperationalText(text, values)), "```"].join("\n");
}

function renderReportInline(text: string, values: string[] = []): string {
  const normalized = redactOperationalText(text, values).replace(/\r?\n/g, " ");
  return normalized.length > 0 ? `\`${escapeReportInlineText(normalized)}\`` : "";
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
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const nonBlocking = constants.O_NONBLOCK ?? 0;
    let safeFile = file;
    let rootIdentity: { dev: number; ino: number } | undefined;
    let fileIdentity: { dev: number; ino: number } | undefined;
    if (allowedRoot !== undefined) {
      const safeRoot = await realpath(allowedRoot);
      const rootMetadata = await lstat(safeRoot);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return "";
      const relativeFile = relative(safeRoot, file);
      if (relativeFile === "" || relativeFile.startsWith("..") || isAbsolute(relativeFile) || relativeFile.includes("/") || relativeFile.includes("\\")) return "";
      rootIdentity = { dev: rootMetadata.dev, ino: rootMetadata.ino };
      safeFile = join(safeRoot, relativeFile);
      const fileMetadata = await lstat(safeFile);
      if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) return "";
      fileIdentity = { dev: fileMetadata.dev, ino: fileMetadata.ino };
    } else {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return "";
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(safeFile, constants.O_RDONLY | nonBlocking | noFollow);
      const metadata = await handle.stat();
      if (!metadata.isFile()) return "";
      if (fileIdentity !== undefined && (metadata.dev !== fileIdentity.dev || metadata.ino !== fileIdentity.ino)) return "";
      if (rootIdentity !== undefined) {
        const currentRoot = await lstat(dirname(safeFile));
        if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) return "";
      }
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
      if (partialLine) return "[REDACTED: bounded log tail begins mid-record]";
      const redactedText = redactSensitiveText(completeText);
      return redactedText.split(/\r?\n/).slice(-lines).join("\n");
    } finally {
      await handle?.close();
    }
  } catch {
    return "";
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

function renderBoundedDirectoryOverview(entries: Dirent[], truncated: boolean, redactions: string[]): string {
  const lines = entries.map((entry) => {
    const kind = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other";
    const displayName = escapeReportName(entry.name);
    return `- ${kind}: <code>${displayName}</code>`;
  });
  if (truncated) lines.push(`> Directory entry scan truncated at ${MAX_LOCAL_DIRECTORY_ENTRIES} entries.`);
  return redactDirectoryListing(lines.join("\n"), redactions);
}

function formatPermissionMode(mode: number, entry: Dirent): string {
  const type = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : entry.isFile() ? "-" : "?";
  const bits = [
    [0o400, "r"], [0o200, "w"], [0o100, "x"],
    [0o040, "r"], [0o020, "w"], [0o010, "x"],
    [0o004, "r"], [0o002, "w"], [0o001, "x"],
  ] as const;
  return type + bits.map(([bit, value]) => (mode & bit) !== 0 ? value : "-").join("");
}

function escapeReportName(name: string): string {
  return JSON.stringify(name)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;");
}

function redactReportName(name: string): string {
  return `<code>${escapeReportName(redactSensitiveText(name).replace(SENSITIVE_FILENAME, "<redacted-name>"))}</code>`;
}

async function renderKnownLogListing(localDir: string, entries: Dirent[], redactions: string[]): Promise<string> {
  const logEntries = entries
    .filter((entry) => entry.isFile() && entry.name.includes("log") && entry.name.endsWith(".txt"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_LOCAL_LOG_LISTING_ENTRIES);
  const lines: string[] = [];
  const renderedNames = new Map<string, string>();
  for (const entry of logEntries) {
    try {
      const metadata = await lstat(join(localDir, entry.name));
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const nameToken = `__AGENT_TOOLKIT_LOG_NAME_${renderedNames.size}__`;
      renderedNames.set(nameToken, redactReportName(entry.name));
      lines.push(`${formatPermissionMode(metadata.mode, entry)} ${metadata.nlink} ${metadata.uid}:${metadata.gid} ${metadata.size} ${metadata.mtime.toISOString()} ${nameToken}`);
    } catch {
      // The directory entry may disappear between the bounded scan and metadata read.
    }
  }
  let output = redactDirectoryListing(lines.join("\n"), redactions);
  for (const [token, name] of renderedNames) output = output.replaceAll(token, name);
  return output;
}

async function ensureSnapshotTemporaryRoot(parent: string): Promise<string> {
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new Error("snapshot output parent must be a real directory");
  const root = join(parent, SNAPSHOT_TEMP_ROOT_NAME);
  let createdRoot = false;
  try {
    await mkdir(root, { mode: 0o700 });
    createdRoot = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error("snapshot temporary root must be a private directory");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("snapshot temporary root is not owned by the current user");
  const marker = join(root, ".owner");
  const readMarker = async (path = marker): Promise<boolean | undefined> => {
    let markerMetadata;
    try {
      markerMetadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return false;
    }
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
      return false;
    }
    if (typeof process.getuid === "function" && markerMetadata.uid !== process.getuid()) {
      return false;
    }
    const noFollow = constants.O_NOFOLLOW;
    if (noFollow === undefined) return false;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) return false;
      const expected = new TextEncoder().encode(SNAPSHOT_OWNER_MARKER);
      const buffer = new Uint8Array(expected.byteLength + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== expected.byteLength) return false;
      for (let index = 0; index < expected.byteLength; index += 1) {
        if (buffer[index] !== expected[index]) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
  if (createdRoot) {
    const temporaryMarker = join(root, `.owner-tmp-${randomUUID()}`);
    try {
      const handle = await open(temporaryMarker, "wx", 0o600);
      try {
        await handle.writeFile(SNAPSHOT_OWNER_MARKER);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryMarker, marker);
        await syncDirectory(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EEXIST" && code !== "ENOENT") || await readMarker() !== true) throw error;
      }
    } finally {
      await unlink(temporaryMarker).catch(() => undefined);
    }
    return root;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = await readMarker();
    if (value === true) return root;
    if (value === false) throw new Error("snapshot temporary root owner marker is invalid");
    await Bun.sleep(5);
  }
  const directory = await opendir(root);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= 4) throw new Error("snapshot temporary root owner marker is invalid");
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  const temporaryEntries = entries.filter((entry) => entry.startsWith(".owner-tmp-"));
  const unknownEntries = entries.filter((entry) => entry !== ".owner" && !entry.startsWith(".owner-tmp-"));
  if (unknownEntries.length > 0 || temporaryEntries.length > 1) throw new Error("snapshot temporary root owner marker is invalid");
  if (temporaryEntries.length === 1) {
    const temporaryMarker = join(root, temporaryEntries[0]!);
    if (await readMarker(temporaryMarker) !== true) {
      if (await readMarker() === true) return root;
      throw new Error("snapshot temporary root owner marker is invalid");
    }
    try {
      await link(temporaryMarker, marker);
      await syncDirectory(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") throw error;
      if (await readMarker() !== true) throw new Error("snapshot temporary root owner marker is invalid");
    } finally {
      await unlink(temporaryMarker).catch(() => undefined);
    }
    return root;
  }
  if (entries.length !== 0) throw new Error("snapshot temporary root owner marker is invalid");
  const temporaryMarker = join(root, `.owner-tmp-${randomUUID()}`);
  try {
    const handle = await open(temporaryMarker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(SNAPSHOT_OWNER_MARKER);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryMarker, marker);
    await syncDirectory(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== "EEXIST" && code !== "ENOENT") || await readMarker() !== true) throw error;
  } finally {
    await unlink(temporaryMarker).catch(() => undefined);
  }
  return root;
}

async function cleanupSnapshotTemporaryDirectories(root: string): Promise<void> {
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    let scanned = 0;
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAX_SNAPSHOT_TEMP_SCAN_ENTRIES) throw new Error(`snapshot temp directory scan exceeded ${MAX_SNAPSHOT_TEMP_SCAN_ENTRIES} entries`);
      if (!entry.name.startsWith(SNAPSHOT_TEMP_PREFIX) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || Date.now() - metadata.mtimeMs < SNAPSHOT_TEMP_STALE_MS) continue;
        if (await readMarkerForCleanup(join(path, ".owner")) === false) continue;
        await rm(path, { recursive: true, force: true, maxRetries: 0 });
      } catch {
        // Preserve a concurrently changing directory for a later invocation.
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function readMarkerForCleanup(path: string): Promise<boolean | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return false;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return false;
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) return false;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) return false;
    const expected = new TextEncoder().encode(SNAPSHOT_OWNER_MARKER);
    const buffer = new Uint8Array(expected.byteLength + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== expected.byteLength) return false;
    return expected.every((value, index) => buffer[index] === value);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
  let entryListing: { entries: Dirent[]; truncated: boolean };
  try {
    entryListing = await boundedDirectoryEntries(localDir);
  } catch {
    lines.push("> Directory entries unavailable; skipping filesystem-derived details.", "");
    return lines.join("\n");
  }
  const entries = entryListing.entries;
  lines.push("### Directory overview", "", renderBoundedDirectoryOverview(entries, entryListing.truncated, pathRedactions), "");
  lines.push("### Known log files (first 200 lines of listing)", "");
  const knownLogListing = await renderKnownLogListing(localDir, entries, pathRedactions);
  if (knownLogListing.length > 0) lines.push(knownLogListing);
  lines.push("");

  const clientLog = join(localDir, "client_log.txt");
  try {
    const clientTail = await safeTail(clientLog, 80, localDir);
    if (clientTail.length > 0) lines.push("### client_log.txt (tail 80)", "", renderReportCodeBlock(clientTail.trimEnd(), pathRedactions), "");
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
  if (Bun.which("ssh") === null) {
    lines.push("> ssh not found on this machine. Skipping remote collection.", "");
    return { text: lines.join("\n"), failed: false };
  }
  const target = `${options.user}@${options.host}`;
  let connectivity: CommandResult;
  try {
    connectivity = await runWithStdin(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "echo", "ok"], "", 5_000);
  } catch (error) {
    if (error instanceof Error && error.message === "supervisor_not_ready") {
      lines.push("> Local process supervisor could not establish a verified process-group anchor.", "> Remote collection was not attempted; fix the local runtime and retry.", "");
      return { text: lines.join("\n"), failed: true };
    }
    const detail = renderReportInline(error instanceof Error ? error.message : String(error), [options.host, options.user, homedir()]);
    lines.push("> Remote SSH connectivity check could not be started.");
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  if (connectivity.timedOut) {
    if (connectivity.exitCode === SUPERVISOR_UNKNOWN_TARGET_STATUS) {
      lines.push("> Remote SSH connectivity check timed out after 5s; local process supervisor exited before recording the SSH result; remote collection was not attempted.", "");
      if (!connectivity.cleanupVerified) lines.splice(lines.length - 1, 0, "> Local process cleanup could not be verified.");
      const detail = renderReportInline(connectivity.stderr.trim(), [options.host, options.user]);
      if (detail.length > 0) lines.splice(lines.length - 1, 0, `> Reason: ${detail}`);
      return { text: lines.join("\n"), failed: true };
    }
    lines.push("> Remote SSH connectivity check timed out after 5s. Verify reachability and run the command interactively, then re-run this script.", "");
    if (!connectivity.cleanupVerified) {
      lines.splice(lines.length - 1, 0, "> Local process cleanup could not be verified; remote collection was not attempted.");
      const detail = renderReportInline(connectivity.stderr.trim(), [options.host, options.user]);
      if (detail.length > 0) lines.splice(lines.length - 1, 0, `> Reason: ${detail}`);
      return { text: lines.join("\n"), failed: true };
    }
    return { text: lines.join("\n"), failed: false };
  }
  if (connectivity.exitCode === SUPERVISOR_UNKNOWN_TARGET_STATUS) {
    lines.push("> Local process supervisor exited before recording the SSH result; remote collection was not attempted.", "");
    const detail = renderReportInline(connectivity.stderr.trim(), [options.host, options.user]);
    if (detail.length > 0) lines.splice(lines.length - 1, 0, `> Reason: ${detail}`);
    return { text: lines.join("\n"), failed: true };
  }
  if (connectivity.exitCode !== 0) {
    if (!connectivity.cleanupVerified) {
      lines.push("> Local process supervisor exited before recording the SSH result, or cleanup could not be verified; remote collection was not attempted.", "");
      const detail = renderReportInline(connectivity.stderr.trim(), [options.host, options.user]);
      if (detail.length > 0) lines.splice(lines.length - 1, 0, `> Reason: ${detail}`);
      return { text: lines.join("\n"), failed: true };
    }
    lines.push("> Remote SSH failed (host down, wrong IP/port, or missing SSH key).");
    const detail = renderReportInline(connectivity.stderr.trim(), [options.host, options.user]);
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("> Next step: verify reachability and run the configured SSH target interactively, then re-run this script.", "");
    return { text: lines.join("\n"), failed: false };
  }
  if (!connectivity.cleanupVerified) {
    lines.push("> Local process cleanup could not be verified; remote collection was not attempted.", "");
    return { text: lines.join("\n"), failed: true };
  }

  let result: CommandResult;
  try {
    result = await runWithStdin(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "bash", "-s"], script);
  } catch (error) {
    const detail = renderReportInline(error instanceof Error ? error.message : String(error), [options.host, options.user, homedir()]);
    lines.push("> Remote collection command could not be started.");
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  if (result.timedOut) {
    if (result.exitCode === SUPERVISOR_UNKNOWN_TARGET_STATUS) {
      lines.push("> Local process supervisor exited before recording the remote collection result; remote collection was not completed.", "");
      return { text: lines.join("\n"), failed: true };
    }
    lines.push(`> Remote collection timed out after ${REMOTE_COMMAND_TIMEOUT_MS / 1000}s.`);
    if (!result.cleanupVerified) lines.push("> Local process cleanup could not be verified.");
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  if (result.outputTruncated) {
    lines.push(`> Remote collection exceeded the ${MAX_REMOTE_OUTPUT_BYTES}-byte output limit.`);
    if (!result.cleanupVerified) lines.push("> Local process cleanup could not be verified.");
    if (result.exitCode === SUPERVISOR_UNKNOWN_TARGET_STATUS) lines.push("> Local process supervisor exited before recording the remote collection result; remote collection was not completed.");
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  if (result.exitCode === SUPERVISOR_UNKNOWN_TARGET_STATUS) {
    lines.push("> Local process supervisor exited before recording the remote collection result; remote collection was not completed.", "");
    return { text: lines.join("\n"), failed: true };
  }
  if (result.exitCode !== 0) {
    lines.push("> Remote collection command failed.");
    const detail = renderReportInline(result.stderr.trim(), [options.host, options.user]);
    if (detail.length > 0) lines.push(`> Reason: ${detail}`);
    if (!result.cleanupVerified) lines.push("> Local process cleanup could not be verified.");
    lines.push("");
    return { text: lines.join("\n"), failed: true };
  }
  if (!result.cleanupVerified) {
    lines.push("> Remote collection completed but local process cleanup could not be verified.", "");
    return { text: lines.join("\n"), failed: true };
  }
  lines.push(renderReportCodeBlock(result.stdout.trimEnd(), [options.host, options.user, homedir()]), "");
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
    const tempRoot = await ensureSnapshotTemporaryRoot(parent);
    await cleanupSnapshotTemporaryDirectories(tempRoot);
    const tempDir = await mkdtemp(join(tempRoot, SNAPSHOT_TEMP_PREFIX));
    const tempPath = join(tempDir, basename(outputPath));
    try {
      const owner = await open(join(tempDir, ".owner"), "wx", 0o600);
      try {
        await owner.writeFile(SNAPSHOT_OWNER_MARKER);
        await owner.sync();
      } finally {
        await owner.close();
      }
      const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
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
