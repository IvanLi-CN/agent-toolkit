#!/usr/bin/env bun
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { diagnostic, options, readBounded, sshCollect } from "./dst_common.ts";
import { parseMods, type Mod } from "./mod_parser.ts";

export function decodeFiles(buffer: Buffer, shards: string[]): Map<string, string | null> {
  let offset = 0;
  function line(): string {
    const end = buffer.indexOf(10, offset);
    if (end < 0 || end - offset > 100) throw new Error("invalid remote mod framing");
    const result = buffer.toString("utf8", offset, end); offset = end + 1; return result;
  }
  if (line() !== "DSTMODS1") throw new Error("invalid remote mod framing");
  const files = new Map<string, string | null>();
  for (const shard of shards) {
    const [name, size] = line().split("\t");
    if (name !== shard) throw new Error("unexpected remote shard");
    if (size === "missing") { files.set(shard, null); continue; }
    if (!/^(0|[1-9][0-9]*)$/.test(size ?? "") || Number(size) > 1_048_576 || offset + Number(size) > buffer.length) throw new Error("invalid remote mod size");
    files.set(shard, buffer.toString("utf8", offset, offset + Number(size))); offset += Number(size);
  }
  if (offset !== buffer.length) throw new Error("unexpected trailing remote mod data");
  return files;
}
export function reportMods(files: Map<string, string | null>, cluster: string): string {
  const lines: string[] = [];
  const parsed = new Map<string, Mod[]>();
  for (const [shard, source] of files) {
    lines.push(`## ${cluster} / ${shard}`);
    if (source === null) { lines.push("- modoverrides.lua: missing", ""); continue; }
    const mods = parseMods(source); parsed.set(shard, mods);
    lines.push("- modoverrides.lua: present", `- mods: ${mods.length}`);
    for (const [label, state] of [["enabled", "true"], ["disabled", "false"], ["unknown", "unknown"]] as const) lines.push(`- ${label}: ${mods.filter(m => m.enabled === state).length}`);
    lines.push("");
    for (const [label, state] of [["enabled", "true"], ["disabled", "false"], ["unknown", "unknown"]] as const) {
      const ids = mods.filter(m => m.enabled === state).map(m => m.id);
      if (ids.length || label !== "unknown") lines.push(`${label}_ids: ${ids.join(" ") || "(none)"}`);
    }
    lines.push("");
  }
  if (parsed.has("Master") && parsed.has("Caves")) {
    lines.push("## Diff (Master vs Caves)");
    for (const [label, state] of [["enabled", "true"], ["disabled", "false"]] as const) {
      for (const [a, b] of [["Master", "Caves"], ["Caves", "Master"]]) {
        const other = new Set(parsed.get(b)!.filter(m => m.enabled === state).map(m => m.id));
        const ids = parsed.get(a)!.filter(m => m.enabled === state && !other.has(m.id)).map(m => m.id);
        lines.push(`${label}_only_in_${a.toLowerCase()}: ${ids.join(" ") || "(none)"}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const opts = options(args, true);
  if (opts.help) { console.log("Usage: bun dst_mods_from_modoverrides.ts [--host HOST --user USER --cluster NAME | --cluster-dir PATH] [--shard Master|Caves|both]"); return; }
  const shard = opts.shard!.toLowerCase();
  const shards = shard === "both" ? ["Master", "Caves"] : [shard === "master" ? "Master" : "Caves"];
  const files = new Map<string, string | null>();
  if (opts["cluster-dir"]) {
    if (!statSync(opts["cluster-dir"]).isDirectory()) throw new Error("cluster directory not found");
    for (const name of shards) {
      const file = join(opts["cluster-dir"], name, "modoverrides.lua"); files.set(name, existsSync(file) ? readBounded(file) : null);
    }
  } else {
    for (const [name, source] of decodeFiles(await sshCollect(opts.host!, opts.user, "mods", opts.cluster!, shards.length === 2 ? "both" : shards[0]), shards)) files.set(name, source);
  }
  console.log(reportMods(files, opts.cluster ?? "local cluster"));
}
if (import.meta.main) {
  try { await main(); } catch (error) { console.error(`error: ${diagnostic(error)}`); process.exitCode = 2; }
}
