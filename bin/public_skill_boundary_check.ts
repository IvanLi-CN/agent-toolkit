#!/usr/bin/env bun
/** Reject consumer-runtime coupling from public Skills. */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDirectRegularFile, isPathInside, REPO_ROOT, readText, relativePath, trackedFiles, walkFiles } from "./repo_util.ts";

export const PUBLIC_MANIFEST = join(REPO_ROOT, "PUBLIC_SKILLS.txt");
export const PRIVATE_REFERENCE_NAMES = new Set(["hosts.txt", "inventory.md", "deployment-policy.yaml"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", "dist", "build", "coverage", "reports", "artifacts", "tmp"]);
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

type SkillScan = { files: string[]; rejectedSymlinks: string[]; invalidPaths: string[] };

function scanSkillFiles(repoRoot: string, skillRoot: string, tracked: string[] = []): SkillScan {
  const rejectedSymlinks = new Set<string>();
  const invalidPaths = new Set<string>();
  const files = new Set(walkFiles(skillRoot, {
    ignoredDirectories: IGNORED_DIRECTORIES,
    shouldIgnoreDirectory: (_, name) => IGNORED_DIRECTORIES.has(name) || name.endsWith(".egg-info"),
    onRejectedSymlink: (path) => rejectedSymlinks.add(path),
  }));
  for (const path of tracked) {
    const relative = relativePath(path, skillRoot);
    if (relative && !relative.startsWith("../")) {
      if (!isPathInside(repoRoot, path)) {
        rejectedSymlinks.add(path);
      } else if (isDirectRegularFile(path)) {
        files.add(path);
      } else {
        invalidPaths.add(path);
      }
    }
  }
  for (const path of [...files]) {
    if (!isDirectRegularFile(path)) {
      files.delete(path);
      invalidPaths.add(path);
    }
  }
  return {
    files: [...files].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    rejectedSymlinks: [...rejectedSymlinks].sort(),
    invalidPaths: [...invalidPaths].sort(),
  };
}

function loadTrackedFiles(repoRoot: string): { paths: string[]; error?: string } {
  try {
    return { paths: trackedFiles(repoRoot) };
  } catch (error) {
    let hasGitMetadata = false;
    try {
      lstatSync(join(repoRoot, ".git"));
      hasGitMetadata = true;
    } catch (metadataError) {
      hasGitMetadata = (metadataError as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (hasGitMetadata) {
      return { paths: [], error: String(error) };
    }
    return { paths: [] };
  }
}

export function check(repoRoot: string = REPO_ROOT, manifest: string = PUBLIC_MANIFEST): string[] {
  const findings: string[] = [];
  if (!isPathInside(repoRoot, manifest) || !isDirectRegularFile(manifest)) {
    return ["INVALID_PUBLIC_SKILLS_MANIFEST"];
  }
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

  const tracked = loadTrackedFiles(repoRoot);
  if (tracked.error) {
    findings.push(`TRACKED_FILE_ENUMERATION_ERROR ${tracked.error}`);
  }
  const actual = repositorySkills(repoRoot);
  const listed = new Set(names);
  for (const name of [...actual].filter((name) => !listed.has(name)).sort()) {
    findings.push(`UNLISTED_PUBLIC_SKILL ${name}`);
  }
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (entry.name === "README.md") {
      const readme = join(skillsRoot, entry.name);
      if (!isDirectRegularFile(readme) || !isPathInside(repoRoot, readme)) {
        findings.push("INVALID_PUBLIC_SKILLS_README");
      }
      continue;
    }
    if (!actual.has(entry.name)) {
      findings.push(`UNEXPECTED_PUBLIC_SKILLS_ENTRY ${entry.name}`);
    }
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
    const scanned = scanSkillFiles(repoRoot, skillRoot, tracked.paths);
    for (const path of scanned.invalidPaths) {
      findings.push(`PUBLIC_SKILL_FILE_CHANGED_DURING_VALIDATION ${relativePath(path, repoRoot)}`);
    }
    for (const path of scanned.files) {
      if (!isPathInside(repoRoot, path) || !isDirectRegularFile(path)) {
        findings.push(`PUBLIC_SKILL_FILE_CHANGED_DURING_VALIDATION ${relativePath(path, repoRoot)}`);
        continue;
      }
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
    for (const path of scanned.rejectedSymlinks) {
      findings.push(`${relativePath(path, repoRoot)}: symbolic link escapes public Skill boundary`);
    }
  }
  return findings;
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length > 0) {
    console.error("usage: public_skill_boundary_check.ts");
    return 2;
  }
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
