#!/usr/bin/env bun

import { join } from "node:path";
import { REMOTE_COMMAND_TIMEOUT_MS, redactOperationalText, validateSshToken } from "./dst_snapshot.ts";
import { spawnSupervised, type SupervisedChild } from "./process_supervisor.ts";

export const MAX_MOD_OVERRIDE_BYTES = 1024 * 1024;

export type ModState = "true" | "false" | "unknown";

export interface ModRecord {
  id: string;
  state: ModState;
}

export interface ShardSummary {
  shard: "Master" | "Caves";
  present: boolean;
  filePath: string;
  mods: ModRecord[];
}

interface ModOptions {
  host: string;
  user: string;
  cluster: string;
  shard: "Master" | "Caves" | "both";
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

function isRecordStart(line: string): RegExpExecArray | null {
  return /\["workshop-(\d+)"\]/.exec(line);
}

function stripConfigurationSegment(line: string, start: number, initialDepth: number): { outside: string; depth: number } {
  let depth = initialDepth;
  let opened = initialDepth > 0;
  let end = -1;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (character === "{") {
      depth += 1;
      opened = true;
    } else if (character === "}" && opened) {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  return { outside: end >= 0 ? `${line.slice(0, start)}${line.slice(end + 1)}` : line.slice(0, start), depth };
}

export class ModOverrideParser {
  private readonly records: ModRecord[] = [];
  private current: string | undefined;
  private state: ModState = "unknown";
  private inConfig = false;
  private configDepth = 0;
  private pendingConfig = false;
  private remainder = "";

  private finishCurrent(): void {
    if (this.current !== undefined) this.records.push({ id: this.current, state: this.state });
  }

  private consumeLine(line: string): void {
    const start = isRecordStart(line);
    if (start !== null) {
      this.finishCurrent();
      this.current = start[1]!;
      this.state = "unknown";
      this.inConfig = false;
      this.configDepth = 0;
      this.pendingConfig = false;
    }
    if (this.current === undefined) return;

    let outsideLine = line;
    if (this.inConfig) {
      const segment = stripConfigurationSegment(line, 0, this.configDepth);
      this.configDepth = segment.depth;
      this.inConfig = this.configDepth > 0;
      outsideLine = segment.outside;
    } else if (this.pendingConfig) {
      const openingBrace = line.indexOf("{");
      if (openingBrace >= 0) {
        const segment = stripConfigurationSegment(line, openingBrace, 0);
        this.configDepth = segment.depth;
        this.inConfig = this.configDepth > 0;
        this.pendingConfig = false;
        outsideLine = segment.outside;
      } else {
        outsideLine = "";
      }
    } else {
      const marker = line.indexOf("configuration_options");
      if (marker >= 0) {
        const segment = stripConfigurationSegment(line, marker, 0);
        this.configDepth = segment.depth;
        this.inConfig = this.configDepth > 0;
        this.pendingConfig = !this.inConfig && line.slice(marker).indexOf("{") < 0;
        outsideLine = segment.outside;
      }
    }

    if (this.state === "unknown" && !this.inConfig && /enabled\s*=\s*true/.test(outsideLine)) this.state = "true";
    if (this.state === "unknown" && !this.inConfig && /enabled\s*=\s*false/.test(outsideLine)) this.state = "false";
  }

  consume(text: string): void {
    const lines = `${this.remainder}${text}`.split(/\r?\n/);
    this.remainder = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  finish(): ModRecord[] {
    if (this.remainder.length > 0) this.consumeLine(this.remainder);
    this.finishCurrent();
    return this.records.sort((left, right) => Number(left.id) - Number(right.id) || left.id.localeCompare(right.id));
  }
}

export function parseModOverrides(source: string): ModRecord[] {
  const parser = new ModOverrideParser();
  parser.consume(source);
  return parser.finish();
}

function listIds(records: ModRecord[], state: ModState): string[] {
  return records.filter((record) => record.state === state).map((record) => record.id);
}

function displayIds(ids: string[]): string {
  return ids.length === 0 ? "(none)" : ids.join(" ");
}

export function renderSummary(cluster: string, summary: ShardSummary): string {
  if (!summary.present) return [`## ${cluster} / ${summary.shard}`, "", `- modoverrides.lua: missing (${summary.filePath})`, ""].join("\n");
  const enabled = listIds(summary.mods, "true");
  const disabled = listIds(summary.mods, "false");
  const unknown = listIds(summary.mods, "unknown");
  const lines = [
    `## ${cluster} / ${summary.shard}`,
    "",
    "- modoverrides.lua: present",
    `- mods: ${summary.mods.length}`,
    `- enabled: ${enabled.length}`,
    `- disabled: ${disabled.length}`,
    `- unknown: ${unknown.length}`,
    "",
    `enabled_ids: ${displayIds(enabled)}`,
    `disabled_ids: ${displayIds(disabled)}`,
  ];
  if (unknown.length > 0) lines.push(`unknown_ids: ${unknown.join(" ")}`);
  lines.push("");
  return lines.join("\n");
}

function idsOnly(records: ModRecord[], state: ModState): Set<string> {
  return new Set(listIds(records, state));
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((id) => !right.has(id)).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

export function renderDiff(cluster: string, master: ShardSummary, caves: ShardSummary): string {
  if (!master.present || !caves.present) return "";
  const masterEnabled = idsOnly(master.mods, "true");
  const cavesEnabled = idsOnly(caves.mods, "true");
  const masterDisabled = idsOnly(master.mods, "false");
  const cavesDisabled = idsOnly(caves.mods, "false");
  return [
    `## Diff (Master vs Caves)`,
    "",
    `enabled_only_in_master: ${displayIds(difference(masterEnabled, cavesEnabled))}`,
    `enabled_only_in_caves: ${displayIds(difference(cavesEnabled, masterEnabled))}`,
    `disabled_only_in_master: ${displayIds(difference(masterDisabled, cavesDisabled))}`,
    `disabled_only_in_caves: ${displayIds(difference(cavesDisabled, masterDisabled))}`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function startRemote(options: ModOptions, shard: "Master" | "Caves"): Promise<SupervisedChild> {
  const target = `${options.user}@${options.host}`;
  const remoteCommand = `bash -s -- ${shellQuote(options.cluster)} ${shellQuote(shard)}`;
  return spawnSupervised(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, remoteCommand]);
}

function killProcessTree(supervised: SupervisedChild, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32") {
    try { process.kill(-supervised.child.pid, signal); } catch { /* The supervisor may already be gone. */ }
  }
  try { supervised.child.kill(signal); } catch { /* The supervisor may already be gone. */ }
}

async function terminateAndReap(supervised: SupervisedChild): Promise<void> {
  const observedExit = supervised.wrapperExited;
  killProcessTree(supervised, "SIGTERM");
  await Promise.race([observedExit, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  killProcessTree(supervised, "SIGKILL");
  await Promise.race([observedExit, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  await supervised.cleanup();
}

async function readText(stream: ReadableStream<Uint8Array>, maxBytes = 64 * 1024, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    if (cancelPromise === undefined) cancelPromise = reader.cancel().catch(() => undefined);
    return cancelPromise;
  };
  const readWithDeadline = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    type ReadResult = Awaited<ReturnType<typeof reader.read>>;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadResult>((resolve) => {
          timer = setTimeout(() => {
            void cancelReader();
            resolve({ done: true } as ReadResult);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    while (true) {
      const { done, value } = await readWithDeadline();
      if (done) break;
      if (remaining <= 0) {
        await cancelReader();
        break;
      }
      const chunk = value ?? new Uint8Array();
      const portion = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
      text += decoder.decode(portion, { stream: true });
      remaining -= portion.byteLength;
      if (chunk.byteLength > portion.byteLength) {
        await cancelReader();
        break;
      }
    }
    return text + decoder.decode();
  } finally {
    if (cancelPromise !== undefined) await cancelPromise;
    reader.releaseLock();
  }
}

export async function parseRemoteResponseStream(
  cluster: string,
  shard: "Master" | "Caves",
  filePath: string,
  stream: ReadableStream<Uint8Array>,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
): Promise<ShardSummary> {
  const reader = stream.getReader();
  const headerBytes: number[] = [];
  let header: string | undefined;
  let bodyRemaining = 0;
  let parser: ModOverrideParser | undefined;
  let bodyDecoder: TextDecoder | undefined;
  let trailingBytes = false;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    if (cancelPromise === undefined) cancelPromise = reader.cancel().catch(() => undefined);
    return cancelPromise;
  };
  const deadline = Date.now() + timeoutMs;

  const consumeBody = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return;
    if (parser === undefined || bodyDecoder === undefined || bodyRemaining === 0) {
      trailingBytes = true;
      return;
    }
    const portion = bytes.byteLength > bodyRemaining ? bytes.slice(0, bodyRemaining) : bytes;
    bodyRemaining -= portion.byteLength;
    parser.consume(bodyDecoder.decode(portion, { stream: true }));
    if (portion.byteLength < bytes.byteLength) trailingBytes = true;
  };

  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        await cancelReader();
        throw new Error(`remote mod collection timed out after ${timeoutMs / 1000}s`);
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
        await cancelReader();
        throw new Error(`remote mod collection timed out after ${timeoutMs / 1000}s`);
      }
      const { done, value } = result.value;
      if (done) break;
      const bytes = value ?? new Uint8Array();
      if (header === undefined) {
        const newline = bytes.indexOf(10);
        if (newline < 0) {
          headerBytes.push(...bytes);
          if (headerBytes.length > 4096) throw new Error("remote mod collection returned an invalid response");
          continue;
        }
        headerBytes.push(...bytes.slice(0, newline));
        header = new TextDecoder().decode(Uint8Array.from(headerBytes)).replace(/\r$/, "");
        const rest = bytes.slice(newline + 1);
        if (header === "MISSING" || header.startsWith("MISSING ")) {
          if (rest.byteLength > 0) trailingBytes = true;
        } else if (header === "CLUSTER_MISSING") {
          throw new Error(`remote cluster not found: ${cluster}`);
        } else {
          const match = /^PRESENT (\d+)$/.exec(header);
          if (match === null) throw new Error("remote mod collection returned an invalid response");
          const length = Number(match[1]);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MOD_OVERRIDE_BYTES) throw new Error(`remote mod collection exceeds ${MAX_MOD_OVERRIDE_BYTES} bytes`);
          bodyRemaining = length;
          parser = new ModOverrideParser();
          bodyDecoder = new TextDecoder();
          consumeBody(rest);
        }
      } else {
        consumeBody(bytes);
      }
    }

    if (header === undefined) throw new Error("remote mod collection returned an invalid response");
    if (header === "MISSING" || header.startsWith("MISSING ")) {
      if (trailingBytes) throw new Error("remote mod collection returned an invalid response");
      return { shard, present: false, filePath, mods: [] };
    }
    if (bodyRemaining !== 0) throw new Error("remote mod collection returned a truncated file");
    if (parser === undefined || bodyDecoder === undefined || trailingBytes) throw new Error("remote mod collection returned an invalid response");
    parser.consume(bodyDecoder.decode());
    return { shard, present: true, filePath, mods: parser.finish() };
  } finally {
    if (cancelPromise !== undefined) await cancelPromise;
    reader.releaseLock();
  }
}

function optionValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${option} requires a value`);
  return [value, index + 2];
}

function usage(): void {
  console.log(`Extract enabled/disabled Workshop mod IDs from DST shard modoverrides.lua via SSH.

Usage:
  dst_mods_from_modoverrides.ts [--host <ip>] [--user <ssh-user>] [--cluster <name>] [--shard Master|Caves|both]

Defaults:
  --host    value from DST_HOST
  --user    value from DST_USER
  --cluster value from DST_CLUSTER
  --shard   both

Notes:
  - Reads only modoverrides.lua (does not read cluster.ini), so it will not expose cluster_password.
  - Outputs only Workshop IDs and enabled state; configuration_options are never printed.`);
}

export function parseArgs(args: string[], env: Record<string, string | undefined> = process.env): ModOptions | "help" {
  let host = env.DST_HOST ?? "";
  let user = env.DST_USER ?? "";
  let cluster = env.DST_CLUSTER ?? "";
  let shard: ModOptions["shard"] = "both";
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--host" || arg === "--user" || arg === "--cluster" || arg === "--shard") {
      const [value, next] = optionValue(args, index, arg);
      if (arg === "--host") host = value;
      else if (arg === "--user") user = value;
      else if (arg === "--cluster") cluster = value;
      else if (value === "Master" || value === "master") shard = "Master";
      else if (value === "Caves" || value === "caves") shard = "Caves";
      else if (value === "both") shard = "both";
      else throw new CliError(`Invalid --shard: ${value} (expected Master|Caves|both)`);
      index = next;
      continue;
    }
    throw new CliError(`Unknown arg: ${arg}`);
  }
  if (host.length === 0) throw new CliError("error: --host or DST_HOST is required");
  if (user.length === 0) throw new CliError("error: --user or DST_USER is required");
  if (cluster.length === 0) throw new CliError("error: --cluster or DST_CLUSTER is required");
  if (cluster === "." || cluster === ".." || cluster.includes("/") || cluster.includes("\\") || cluster.includes("\0") || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(cluster)) {
    throw new CliError("error: --cluster must be a single path segment");
  }
  validateSshToken(host, "host");
  validateSshToken(user, "user");
  return { host, user, cluster, shard };
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  let parsed: ModOptions | "help";
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

  try {
    const script = await Bun.file(join(import.meta.dir, "dst_mods_remote_collect.sh")).text();
    const shards: Array<"Master" | "Caves"> = parsed.shard === "both" ? ["Master", "Caves"] : [parsed.shard];
    const summaries: ShardSummary[] = [];
    for (const shard of shards) {
      const supervised = await startRemote(parsed, shard);
      const child = supervised.child;
      const filePath = "modoverrides.lua";
      const stderrPromise = readText(child.stderr);
      const exitPromise = supervised.exited;
      let timedOut = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessTree(supervised, "SIGTERM");
        if (forceKillTimer === undefined) forceKillTimer = setTimeout(() => killProcessTree(supervised, "SIGKILL"), 1_000);
      }, REMOTE_COMMAND_TIMEOUT_MS);
      let summary: ShardSummary;
      try {
        child.stdin.write(script);
        child.stdin.end();
        try {
          summary = await parseRemoteResponseStream(parsed.cluster, shard, filePath, child.stdout);
        } catch (error) {
          killProcessTree(supervised, "SIGTERM");
          if (forceKillTimer === undefined) forceKillTimer = setTimeout(() => killProcessTree(supervised, "SIGKILL"), 1_000);
          await readText(child.stdout, 64 * 1024, 1_000);
          const [exitCode, stderr] = await Promise.all([exitPromise, stderrPromise]);
          const detail = redactOperationalText(stderr.trim(), [parsed.host, parsed.user]);
          if (timedOut) throw new Error(`SSH collection timed out after ${REMOTE_COMMAND_TIMEOUT_MS / 1000}s`);
          if (exitCode !== 0 && detail.length > 0) throw new Error(detail);
          throw error;
        }
        const [exitCode, stderr] = await Promise.all([exitPromise, stderrPromise]);
        if (timedOut) throw new Error(`SSH collection timed out after ${REMOTE_COMMAND_TIMEOUT_MS / 1000}s`);
        if (exitCode !== 0) {
          const detail = redactOperationalText(stderr.trim(), [parsed.host, parsed.user]);
          throw new Error(detail || `SSH collection failed for ${shard}`);
        }
      } finally {
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        await terminateAndReap(supervised);
      }
      summaries.push(summary);
      process.stdout.write(renderSummary(parsed.cluster, summary));
    }
    if (parsed.shard === "both") process.stdout.write(renderDiff(parsed.cluster, summaries[0]!, summaries[1]!));
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
