#!/usr/bin/env bun
/** Reject consumer-runtime coupling from public Skills. */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDirectRegularFile, isPathInside, REPO_ROOT, readText, relativePath, walkFiles } from "./repo_util.ts";

export const PUBLIC_MANIFEST = join(REPO_ROOT, "PUBLIC_SKILLS.txt");
export const PRIVATE_REFERENCE_NAMES = new Set(["hosts.txt", "inventory.md", "deployment-policy.yaml"]);
const runtimeNamePattern = "CODEX_" + "[A-Z0-9_]+";
const runtimeHomeMarker = "$" + "CODEX_" + "HOME";
const dotRuntimeMarker = "." + "codex";
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nativeSurfacePattern = ["Task" + "Space", "agent_" + "session"].map(escapeRegExp).join("|");
export const PUBLIC_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["codex-runtime-marker", new RegExp(`(?:\\b${runtimeNamePattern}\\b|${escapeRegExp(runtimeHomeMarker)}|${escapeRegExp(dotRuntimeMarker)}(?:[\\/\\\\]|\\b))`, "i")],
  ["codex-product-reference", /\bCodex\b/i],
  ["codex-native-surface", new RegExp(`\\b(?:${nativeSurfacePattern})\\b|native\\s+(?:task|worktree|background)`, "i")],
];

export function publicSkills(manifest: string = PUBLIC_MANIFEST): string[] {
  return readText(manifest)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function repositorySkills(repoRoot: string): Set<string> {
  const skillsRoot = join(repoRoot, "skills");
  const result = new Set<string>();
  if (!existsSync(skillsRoot) || !isPathInside(repoRoot, skillsRoot)) return result;
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (isDirectRegularFile(join(skillsRoot, entry.name, "SKILL.md"))) {
      result.add(entry.name);
    }
  }
  return result;
}

export function check(repoRoot: string = REPO_ROOT, manifest: string = PUBLIC_MANIFEST): string[] {
  const findings: string[] = [];
  let names: string[];
  try {
    names = publicSkills(manifest);
  } catch (error) {
    return [`MANIFEST_READ_ERROR ${manifest}: ${String(error)}`];
  }

  if (names.length !== new Set(names).size) {
    findings.push("DUPLICATE_PUBLIC_SKILL_NAME");
  }

  const invalidNames = [...new Set(names.filter((name) => !PUBLIC_SKILL_NAME_PATTERN.test(name)))].sort();
  for (const name of invalidNames) {
    findings.push(`INVALID_PUBLIC_SKILL_NAME ${name}`);
  }

  const skillsRoot = join(repoRoot, "skills");
  if (!isPathInside(repoRoot, skillsRoot)) {
    findings.push("SYMLINKED_PUBLIC_SKILLS_ROOT");
    return findings;
  }

  const actual = repositorySkills(repoRoot);
  const listed = new Set(names);
  for (const name of [...actual].filter((name) => !listed.has(name)).sort()) {
    findings.push(`UNLISTED_PUBLIC_SKILL ${name}`);
  }

  for (const name of names) {
    if (!PUBLIC_SKILL_NAME_PATTERN.test(name)) continue;
    const skillRoot = join(repoRoot, "skills", name);
    const skillFile = join(skillRoot, "SKILL.md");
    if (lstatSync(skillRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
      findings.push(`SYMLINKED_PUBLIC_SKILL ${name}`);
      continue;
    }
    if (!isPathInside(repoRoot, skillRoot) || !isPathInside(repoRoot, skillFile)) {
      findings.push(`PUBLIC_SKILL_PATH_ESCAPES_REPOSITORY ${name}`);
      continue;
    }
    if (!isDirectRegularFile(skillFile)) {
      findings.push(`MISSING_PUBLIC_SKILL ${name}`);
      continue;
    }
    const rejectedSymlinks: string[] = [];
    for (const path of walkFiles(skillRoot, { onRejectedSymlink: (path) => rejectedSymlinks.push(path) })) {
      const relative = relativePath(path, repoRoot);
      if (path.split(/[\\/]/).at(-2) === "references" && PRIVATE_REFERENCE_NAMES.has(path.split(/[\\/]/).at(-1) ?? "")) {
        findings.push(`${relative}: private operator reference must stay outside repository`);
      }
      let content: string;
      try {
        content = readText(path);
      } catch (error) {
        findings.push(`READ_ERROR ${relative}: ${String(error)}`);
        continue;
      }
      for (const [label, pattern] of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          findings.push(`${relative}: forbidden public coupling ${label}`);
        }
      }
    }
    for (const path of rejectedSymlinks.sort()) {
      findings.push(`${relativePath(path, repoRoot)}: symbolic link escapes public Skill boundary`);
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
  console.log(`PASS public Skill boundary: ${publicSkills().length} standalone Skills`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
