#!/usr/bin/env bun
import { existsSync, opendirSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { diagnostic, options, sshCollect } from "./dst_common.ts";

export const MAX_ROOT_ENTRIES = 200;
export const MAX_CLUSTER_ENTRIES = 100;
export const MAX_DIRECTORY_SCAN_ENTRIES = 1024;
type DirectoryEntry = { name: string; isDirectory(): boolean; isFile(): boolean };

export function collectBoundedEntries(read: () => DirectoryEntry | null, limit = MAX_DIRECTORY_SCAN_ENTRIES): DirectoryEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid directory scan limit");
  const entries: DirectoryEntry[] = [];
  for (let count = 0; count < limit; count++) {
    const entry = read();
    if (!entry) break;
    entries.push(entry);
  }
  return entries;
}

function readDirectoryEntries(directory: string): DirectoryEntry[] {
  const handle = opendirSync(directory);
  try { return collectBoundedEntries(() => handle.readSync()); }
  finally { handle.closeSync(); }
}

export function localReport(directory?: string): string {
  const lines = ["## Local", "", `- Host: ${hostname()}`, `- Collected at: ${new Date().toISOString()}`, `- Client data dir: ${directory ?? "<unset>"}`, ""];
  if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) return lines.concat("> Local dir not found. Skipping local collection.", "").join("\n");
  const entries = readDirectoryEntries(directory).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ROOT_ENTRIES);
  lines.push("### Directory overview (names only; first 200)", "", ...entries.map(e => `- ${e.name}${e.isDirectory() ? "/" : ""}`), "", "### Known log files (metadata only)", "");
  for (const entry of entries) if (entry.isFile() && /log.*\.txt$/.test(entry.name)) lines.push(`- ${entry.name}: present (contents omitted)`);
  lines.push("", "### Local clusters (paths only; secrets redacted)", "");
  let count = 0;
  for (const parent of entries.filter(e => e.isDirectory())) {
    const parentPath = join(directory, parent.name);
    const nested = parent.name.startsWith("Cluster_") ? [] : readDirectoryEntries(parentPath);
    const clusters = parent.name.startsWith("Cluster_") ? [parentPath] : nested.filter(e => e.isDirectory() && e.name.startsWith("Cluster_")).slice(0, MAX_CLUSTER_ENTRIES).map(e => join(parentPath, e.name));
    for (const cluster of clusters) {
      if (++count > MAX_CLUSTER_ENTRIES) break;
      lines.push(`- ${cluster}`);
      for (const name of ["cluster_token.txt", "cluster.ini"]) if (existsSync(join(cluster, name))) lines.push(`  - ${name}: present (redacted)`);
      for (const shard of ["Master", "Caves"]) if (existsSync(join(cluster, shard))) lines.push(`  - ${shard}/: present`);
    }
    if (count >= MAX_CLUSTER_ENTRIES) break;
  }
  return lines.join("\n") + "\n";
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const opts = options(args, false);
  if (opts.help) { console.log("Usage: bun dst_snapshot.ts [--host HOST] [--user USER] [--local-dir PATH] [--out PATH] [--no-local] [--no-remote]"); return; }
  const output = opts.out ?? join(tmpdir(), `dst-snapshot-${Date.now()}.md`);
  const lines = ["# DST snapshot", "", `- Generated: ${new Date().toISOString()}`, `- Remote: ${opts.host ? (opts.user ? `${opts.user}@` : "") + opts.host : "<unset>"}`, `- Local dir: ${opts["local-dir"] ?? "<unset>"}`, ""];
  if (opts["no-local"]) lines.push("## Local", "", "> Skipped (--no-local).", "");
  else {
    try { lines.push(localReport(opts["local-dir"])); }
    catch { lines.push("## Local", "", "> Local collection failed; verify directory permissions.", ""); }
  }
  lines.push("## Remote", "");
  if (opts["no-remote"]) lines.push("> Skipped (--no-remote).", "");
  else {
    try { lines.push((await sshCollect(opts.host!, opts.user, "snapshot")).toString("utf8")); }
    catch (error) { lines.push(`> ${diagnostic(error)}`, ""); }
  }
  writeFileSync(output, lines.join("\n")); console.log(output);
}
if (import.meta.main) {
  try { await main(); } catch (error) { console.error(`error: ${diagnostic(error)}`); process.exitCode = 2; }
}
