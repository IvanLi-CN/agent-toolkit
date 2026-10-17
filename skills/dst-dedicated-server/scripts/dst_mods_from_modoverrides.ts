#!/usr/bin/env bun

import { join } from "node:path";

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

function braceDelta(line: string): number {
  let opens = 0;
  let closes = 0;
  for (const character of line) {
    if (character === "{") opens += 1;
    if (character === "}") closes += 1;
  }
  return opens - closes;
}

export function parseModOverrides(source: string): ModRecord[] {
  const records: ModRecord[] = [];
  let current: string | undefined;
  let state: ModState = "unknown";
  let inConfig = false;
  let configDepth = 0;
  const finish = () => {
    if (current !== undefined) records.push({ id: current, state });
  };
  for (const line of source.split(/\r?\n/)) {
    const start = isRecordStart(line);
    if (start !== null) {
      finish();
      current = start[1]!;
      state = "unknown";
      inConfig = false;
      configDepth = 0;
    }
    if (current === undefined) continue;

    if (!inConfig && line.includes("configuration_options")) {
      configDepth += braceDelta(line);
      if (configDepth > 0) inConfig = true;
    } else if (inConfig) {
      configDepth += braceDelta(line);
      if (configDepth <= 0) {
        inConfig = false;
        configDepth = 0;
      }
    }

    if (state === "unknown" && !inConfig && /enabled\s*=\s*true/.test(line)) state = "true";
    if (state === "unknown" && !inConfig && /enabled\s*=\s*false/.test(line)) state = "false";
  }
  finish();
  return records.sort((left, right) => Number(left.id) - Number(right.id) || left.id.localeCompare(right.id));
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

interface RemoteResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

async function collectRemote(script: string, options: ModOptions, shard: "Master" | "Caves"): Promise<RemoteResult> {
  const target = `${options.user}@${options.host}`;
  const remoteCommand = `bash -s -- ${shellQuote(options.cluster)} ${shellQuote(shard)}`;
  const child = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, remoteCommand],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  child.stdin.write(script);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]);
  return { exitCode, stdout, stderr };
}

function parseRemoteResult(cluster: string, shard: "Master" | "Caves", filePath: string, result: RemoteResult): ShardSummary {
  const textDecoder = new TextDecoder();
  const headerEnd = result.stdout.indexOf(10);
  const header = textDecoder.decode(headerEnd < 0 ? result.stdout : result.stdout.slice(0, headerEnd));
  if (header === "MISSING" || header.startsWith("MISSING ")) {
    return { shard, present: false, filePath: header.startsWith("MISSING ") ? header.slice("MISSING ".length) : filePath, mods: [] };
  }
  if (header === "CLUSTER_MISSING") throw new Error(`remote cluster not found: ${cluster}`);
  const match = /^PRESENT (\d+)$/.exec(header);
  if (match === null || headerEnd < 0) throw new Error("remote mod collection returned an invalid response");
  const length = Number(match[1]);
  const content = result.stdout.slice(headerEnd + 1, headerEnd + 1 + length);
  if (content.byteLength !== length) throw new Error("remote mod collection returned a truncated file");
  return { shard, present: true, filePath, mods: parseModOverrides(textDecoder.decode(content)) };
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
      const result = await collectRemote(script, parsed, shard);
      const filePath = `~/.klei/DoNotStarveTogether/${parsed.cluster}/${shard}/modoverrides.lua`;
      const responseHeader = new TextDecoder().decode(result.stdout.slice(0, result.stdout.indexOf(10) < 0 ? result.stdout.length : result.stdout.indexOf(10)));
      if (responseHeader === "CLUSTER_MISSING") throw new Error(`remote cluster not found: ${parsed.cluster}`);
      if (result.exitCode !== 0) {
        const detail = new TextDecoder().decode(result.stderr).trim();
        throw new Error(detail || `SSH collection failed for ${shard}`);
      }
      summaries.push(parseRemoteResult(parsed.cluster, shard, filePath, result));
    }
    const output = summaries.map((summary) => renderSummary(parsed.cluster, summary)).join("\n");
    const diff = parsed.shard === "both" ? renderDiff(parsed.cluster, summaries[0]!, summaries[1]!) : "";
    process.stdout.write(output + diff);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
