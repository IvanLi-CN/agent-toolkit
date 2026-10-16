#!/usr/bin/env bun
/** Check that skills/README.md indexes every repository-local Skill. */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRegularFile, REPO_ROOT, readText } from "./repo_util.ts";

export const SKILL_NAME_PATTERN = /^`([a-z0-9-]+)`$/;
export const EXTERNAL_PATH_PATTERN = /~?\/?[^`]*\.agents\/skills\/([a-z0-9-]+)(?:\/|`)/;

export type IndexEntry = {
  name: string;
  lineNumber: number;
  external: boolean;
};

export function repositorySkills(skillsRoot: string): Set<string> {
  const result = new Set<string>();
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) {
      continue;
    }
    if (isRegularFile(join(skillsRoot, entry.name, "SKILL.md"))) {
      result.add(entry.name);
    }
  }
  return result;
}

export function indexEntries(readmePath: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  let inSkillTable = false;
  for (const [index, rawLine] of readText(readmePath).split("\n").entries()) {
    const lineNumber = index + 1;
    const stripped = rawLine.trim();
    if (stripped.startsWith("| Skill |")) {
      inSkillTable = true;
      continue;
    }
    if (inSkillTable && (!stripped || !stripped.startsWith("|"))) {
      inSkillTable = false;
    }
    if (!inSkillTable || stripped.startsWith("|---")) {
      continue;
    }
    const cells = stripped
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    const match = SKILL_NAME_PATTERN.exec(cells[0] ?? "");
    if (!match) {
      continue;
    }
    const name = match[1];
    const externalMatch = EXTERNAL_PATH_PATTERN.exec(stripped);
    entries.push({
      name,
      lineNumber,
      external: Boolean(externalMatch && externalMatch[1] === name),
    });
  }
  return entries;
}

export function check(repoRoot: string = REPO_ROOT): string[] {
  const skillsRoot = join(repoRoot, "skills");
  const readmePath = join(skillsRoot, "README.md");
  const actual = repositorySkills(skillsRoot);
  const entries = indexEntries(readmePath);
  const localEntries = entries.filter((entry) => !entry.external);
  const indexed = new Set(localEntries.map((entry) => entry.name));
  const findings: string[] = [];

  for (const name of [...actual].filter((name) => !indexed.has(name)).sort()) {
    findings.push(`MISSING_INDEX_ENTRY skill=${name}`);
  }
  for (const entry of localEntries) {
    if (!actual.has(entry.name)) {
      findings.push(`STALE_INDEX_ENTRY skill=${entry.name} line=${entry.lineNumber}`);
    }
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  for (const [name, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (count > 1) {
      findings.push(`DUPLICATE_INDEX_ENTRY skill=${name} count=${count}`);
    }
  }
  return findings;
}

function parseArgs(args: string[]): string {
  let repoRoot = resolve(process.cwd());
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--repo-root") {
      throw new Error("usage: skills_index_check.ts [--repo-root <path>]");
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error("usage: skills_index_check.ts [--repo-root <path>]");
    }
    repoRoot = resolve(value);
  }
  return repoRoot;
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  let repoRoot: string;
  try {
    repoRoot = parseArgs(args);
  } catch (error) {
    console.error(`ERROR ${String(error)}`);
    return 2;
  }
  const findings = check(repoRoot);
  for (const finding of findings) {
    console.log(`FINDING ${finding}`);
  }
  if (findings.length > 0) {
    return 1;
  }
  console.log("PASS skills index: every repository-local skill is indexed exactly once");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
