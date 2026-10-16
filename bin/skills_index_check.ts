#!/usr/bin/env bun
/** Check that skills/README.md indexes every repository-local Skill. */

import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDirectRegularFile, isPathInside, REPO_ROOT, readText } from "./repo_util.ts";

export const SKILL_NAME_PATTERN = /^`([a-z0-9-]+)`$/;
export const EXTERNAL_PATH_PATTERN = /~?\/?[^`]*\.agents\/skills\/([a-z0-9-]+)(?:\/|`)/;

export type IndexEntry = {
  name: string;
  lineNumber: number;
  external: boolean;
  path: string;
  linkTarget?: string;
};

function pathCell(value: string): { path: string; linkTarget?: string } {
  const trimmed = value.trim();
  const markdownLink = trimmed.match(/^\[[^\]]+\]\(([^)]+)\)$/);
  const linkTarget = markdownLink?.[1]?.trim() ?? trimmed;
  const path = linkTarget.startsWith("`") && linkTarget.endsWith("`") ? linkTarget.slice(1, -1) : linkTarget;
  return markdownLink ? { path, linkTarget: path } : { path };
}

export function repositorySkills(skillsRoot: string): Set<string> {
  const result = new Set<string>();
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (isDirectRegularFile(join(skillsRoot, entry.name, "SKILL.md"))) {
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
    const pathCellValue = pathCell(cells[2] ?? "");
    const path = pathCellValue.path;
    const externalMatch = EXTERNAL_PATH_PATTERN.exec(path);
    entries.push({
      name,
      lineNumber,
      external: Boolean(externalMatch && externalMatch[1] === name),
      path,
      linkTarget: pathCellValue.linkTarget,
    });
  }
  return entries;
}

export function check(repoRoot: string = REPO_ROOT): string[] {
  const skillsRoot = join(repoRoot, "skills");
  const readmePath = join(skillsRoot, "README.md");
  if (!isPathInside(repoRoot, skillsRoot)) return ["SYMLINKED_SKILLS_ROOT"];
  if (!isPathInside(repoRoot, readmePath)) return ["SYMLINKED_SKILLS_README"];
  const actual = repositorySkills(skillsRoot);
  const entries = indexEntries(readmePath);
  const localEntries = entries.filter((entry) => !entry.external);
  const indexed = new Set(localEntries.map((entry) => entry.name));
  const findings: string[] = [];

  for (const entry of localEntries) {
    const expected = [`skills/${entry.name}/`, `skills/${entry.name}/**`, `${entry.name}/`, `${entry.name}/**`, `${entry.name}/SKILL.md`];
    if (!expected.includes(entry.path)) {
      findings.push(`INVALID_INDEX_PATH skill=${entry.name} line=${entry.lineNumber} path=${entry.path || "<missing>"}`);
    }
    if (entry.linkTarget) {
      try {
        const targetWithoutFragment = entry.linkTarget.split(/[?#]/, 1)[0] ?? "";
        const target = resolve(dirname(readmePath), decodeURIComponent(targetWithoutFragment));
        const targetStats = lstatSync(target, { throwIfNoEntry: false });
        if (!targetWithoutFragment || !isPathInside(repoRoot, target) || (!targetStats?.isFile() && !targetStats?.isDirectory())) {
          findings.push(`INVALID_INDEX_LINK skill=${entry.name} line=${entry.lineNumber} target=${entry.linkTarget || "<missing>"}`);
        }
      } catch {
        findings.push(`INVALID_INDEX_LINK skill=${entry.name} line=${entry.lineNumber} target=${entry.linkTarget || "<missing>"}`);
      }
    }
  }

  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (entry.isSymbolicLink()) {
      findings.push(`SYMLINKED_SKILLS_ENTRY skill=${entry.name}`);
      continue;
    }
    if (entry.isDirectory()) {
      const marker = join(skillsRoot, entry.name, "SKILL.md");
      try {
        if (lstatSync(marker).isSymbolicLink()) findings.push(`SYMLINKED_SKILL_MARKER skill=${entry.name}`);
      } catch {
        // Missing markers are reported through the normal index comparison.
      }
    }
  }

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
  for (const [name, count] of [...counts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (count > 1) {
      findings.push(`DUPLICATE_INDEX_ENTRY skill=${name} count=${count}`);
    }
  }
  return findings;
}

const USAGE = "usage: skills_index_check.ts [--repo-root <path>]";

function parseArgs(args: string[]): string {
  let repoRoot = resolve(process.cwd());
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo-root") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(USAGE);
      repoRoot = resolve(value);
    } else if (arg.startsWith("--repo-root=")) {
      const value = arg.slice("--repo-root=".length);
      if (!value) throw new Error(USAGE);
      repoRoot = resolve(value);
    } else {
      throw new Error(USAGE);
    }
  }
  return repoRoot;
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.includes("--help")) {
    if (args.length !== 1) {
      console.error(USAGE);
      return 2;
    }
    console.log(USAGE);
    return 0;
  }
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
