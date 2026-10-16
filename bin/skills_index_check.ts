#!/usr/bin/env bun
/** Check that skills/README.md indexes every repository-local Skill. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readText, relativePath, walkFiles } from "./repo_util.ts";

export const SKILL_NAME_PATTERN = /^`([a-z0-9-]+)`$/;
export const EXTERNAL_PATH_PATTERN = /~?\/?[^`]*\.agents\/skills\/([a-z0-9-]+)(?:\/|`)/;

export type IndexEntry = {
  name: string;
  lineNumber: number;
  external: boolean;
};

export function repositorySkills(skillsRoot: string): Set<string> {
  const result = new Set<string>();
  for (const path of walkFiles(skillsRoot)) {
    if (!path.endsWith("/SKILL.md") && !path.endsWith("\\SKILL.md")) {
      continue;
    }
    const relative = relativePath(path, skillsRoot);
    const [name] = relative.split("/");
    if (name && !name.startsWith(".") && existsSync(join(skillsRoot, name, "SKILL.md"))) {
      result.add(name);
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

export function main(): number {
  const findings = check();
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
