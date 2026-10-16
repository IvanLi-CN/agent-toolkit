#!/usr/bin/env bun
/** Compare a split public/private Skill inventory with this checkout. */

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PUBLIC_SKILL_NAME_PATTERN } from "./public_skill_boundary_check.ts";
import { isDirectRegularFile, isPathInside, REPO_ROOT, readText, runGit } from "./repo_util.ts";

const IGNORED_INVENTORY_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", "dist", "build", "coverage", "reports", "artifacts", "tmp"]);

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function hasSkillMarker(path: string): boolean {
  return isDirectRegularFile(path) || isSymlink(path);
}

export function targetInventory(root: string): Set<string> {
  const skillsRoot = join(root, "skills");
  const result = new Set<string>();
  if (!existsSync(skillsRoot) || !isPathInside(root, skillsRoot) || !lstatSync(skillsRoot).isDirectory()) return result;
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if ((entry.isDirectory() || entry.isSymbolicLink()) && hasSkillMarker(join(skillsRoot, entry.name, "SKILL.md"))) {
      result.add(entry.name);
    }
  }
  return result;
}

export function targetSymlinkInventory(root: string): Set<string> {
  return new Set([...targetSymlinkPaths(root)]
    .map((path) => path.split("/")[1])
    .filter((name): name is string => Boolean(name)));
}

export function targetSymlinkPaths(root: string): Set<string> {
  const skillsRoot = join(root, "skills");
  const result = new Set<string>();
  if (isSymlink(skillsRoot)) {
    result.add("skills");
    return result;
  }
  if (!existsSync(skillsRoot)) return result;
  if (!isPathInside(root, skillsRoot) || !lstatSync(skillsRoot).isDirectory()) return result;
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativeDirectory && (IGNORED_INVENTORY_DIRECTORIES.has(entry.name) || entry.name.endsWith(".egg-info"))) continue;
      if (entry.isSymbolicLink()) {
        result.add(`skills/${relativePath}`);
      } else if (entry.isDirectory()) {
        visit(path, relativePath);
      }
    }
  };
  visit(skillsRoot, "");
  return result;
}

export function targetGitlinkPaths(root: string): Set<string> {
  const target = resolve(root);
  try {
    lstatSync(join(target, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new Error(`cannot inspect target Git metadata: ${String(error)}`);
  }
  const topLevel = runGit(["rev-parse", "--show-toplevel"], target);
  if (topLevel.exitCode !== 0) {
    throw new Error(`git rev-parse failed for target: ${topLevel.stderr.trim()}`);
  }
  try {
    if (realpathSync(topLevel.stdout.trim()) !== realpathSync(target)) {
      throw new Error(`target is not a Git repository root: ${target}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("target is not a Git repository root:")) throw error;
    throw new Error(`cannot resolve target Git root: ${String(error)}`);
  }
  const result = runGit(["ls-files", "-s", "-z", "--", "skills"], target);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed for target: ${result.stderr.trim()}`);
  }
  const paths = new Set<string>();
  for (const item of result.stdout.split("\0")) {
    const separator = item.indexOf("\t");
    if (separator < 0) continue;
    const mode = item.slice(0, separator).split(/\s+/)[0] ?? "";
    const path = item.slice(separator + 1);
    if (mode === "160000" && (path === "skills" || path.startsWith("skills/"))) paths.add(path);
  }
  return paths;
}

export function manifestEntries(path: string): string[] {
  return readText(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function manifestInventory(path: string): Set<string> {
  return new Set(manifestEntries(path));
}

type SnapshotTree = { skillNames: Set<string>; symlinkPaths: Set<string>; gitlinkPaths: Set<string> };

function snapshotTree(source: string, revision: string): SnapshotTree {
  const result = runGit(["ls-tree", "-r", "-z", revision, "--", "skills"], resolve(source));
  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  }
  const skillNames = new Set<string>();
  const symlinkPaths = new Set<string>();
  const gitlinkPaths = new Set<string>();
  for (const item of result.stdout.split("\0")) {
    const separator = item.indexOf("\t");
    if (separator < 0) continue;
    const metadata = item.slice(0, separator);
    const path = item.slice(separator + 1);
    const mode = metadata?.split(/\s+/)[0] ?? "";
    if (!path) continue;
    if (["100644", "100755"].includes(mode) && path.startsWith("skills/") && path.endsWith("/SKILL.md") && path.split("/").length === 3) {
      skillNames.add(path.slice("skills/".length, -"/SKILL.md".length));
    }
    if (mode === "120000" && (path === "skills" || path.startsWith("skills/"))) {
      symlinkPaths.add(path);
    }
    if (mode === "160000" && (path === "skills" || path.startsWith("skills/"))) {
      gitlinkPaths.add(path);
    }
  }
  return { skillNames, symlinkPaths, gitlinkPaths };
}

export function snapshotInventory(source: string, revision: string): Set<string> {
  return snapshotTree(source, revision).skillNames;
}

export function snapshotSymlinkInventory(source: string, revision: string): Set<string> {
  return new Set([...snapshotTree(source, revision).symlinkPaths]
    .map((path) => path.split("/")[1])
    .filter((name): name is string => Boolean(name)));
}

export type ParsedArgs = { sourceRoot?: string; revision: string; targetRoot: string; manifest?: string };
const USAGE = "usage: source_target_inventory_check.ts --source-root <path> [--source-revision <revision>] [--target-root <path>] [--public-manifest <path>]";

function requiredValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(USAGE);
  }
  return value;
}

export function parseArgs(args: string[]): ParsedArgs {
  let sourceRoot: string | undefined;
  let revision = "HEAD";
  let targetRoot = REPO_ROOT;
  let manifest: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source-root") {
      sourceRoot = resolve(requiredValue(args, index));
      index += 1;
    } else if (arg.startsWith("--source-root=")) {
      const value = arg.slice("--source-root=".length);
      if (!value) throw new Error(USAGE);
      sourceRoot = resolve(value);
    } else if (arg === "--source-revision") {
      revision = requiredValue(args, index);
      index += 1;
    } else if (arg.startsWith("--source-revision=")) {
      const value = arg.slice("--source-revision=".length);
      if (!value) throw new Error(USAGE);
      revision = value;
    } else if (arg === "--target-root") {
      targetRoot = resolve(requiredValue(args, index));
      index += 1;
    } else if (arg.startsWith("--target-root=")) {
      const value = arg.slice("--target-root=".length);
      if (!value) throw new Error(USAGE);
      targetRoot = resolve(value);
    } else if (arg === "--public-manifest") {
      manifest = resolve(requiredValue(args, index));
      index += 1;
    } else if (arg.startsWith("--public-manifest=")) {
      const value = arg.slice("--public-manifest=".length);
      if (!value) throw new Error(USAGE);
      manifest = resolve(value);
    } else {
      throw new Error(USAGE);
    }
  }
  return { sourceRoot, revision, targetRoot, manifest };
}

export type InventoryResult = {
  findings: string[];
  publicCount: number;
  privateCount: number;
};

export function inspect(
  sourceRoot: string,
  revision = "HEAD",
  targetRoot = REPO_ROOT,
  publicManifest = join(targetRoot, "PUBLIC_SKILLS.txt"),
): InventoryResult {
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  const snapshot = snapshotTree(source, revision);
  const expectedSource = snapshot.skillNames;
  const actual = targetInventory(target);
  const sourceSymlinkPaths = new Set([...snapshot.symlinkPaths, ...targetSymlinkPaths(source)]);
  const targetSymlinkPathsSet = targetSymlinkPaths(target);
  const targetGitlinkPathsSet = targetGitlinkPaths(target);
  const publicManifestEntries = manifestEntries(publicManifest);
  const publicNames = new Set(publicManifestEntries);
  const privateNames = new Set([...expectedSource].filter((name) => !publicNames.has(name)));
  const findings: string[] = [];

  if (publicManifestEntries.length !== publicNames.size) {
    findings.push("DUPLICATE_PUBLIC_MANIFEST_ENTRY");
  }
  for (const name of [...publicNames].filter((name) => !PUBLIC_SKILL_NAME_PATTERN.test(name)).sort()) {
    findings.push(`INVALID_PUBLIC_SKILL_NAME ${name}`);
  }

  if (targetSymlinkPathsSet.has("skills")) findings.push("SYMLINKED_TARGET_SKILLS_ROOT");
  if (sourceSymlinkPaths.has("skills") || isSymlink(join(source, "skills"))) findings.push("SYMLINKED_SOURCE_SKILLS_ROOT");
  for (const path of [...snapshot.gitlinkPaths].sort()) {
    findings.push(`UNSUPPORTED_SOURCE_GITLINK ${path}`);
  }
  for (const path of [...targetGitlinkPathsSet].sort()) {
    findings.push(`UNSUPPORTED_TARGET_GITLINK ${path}`);
  }
  for (const path of [...targetSymlinkPathsSet].filter((path) => path !== "skills").sort()) {
    const parts = path.split("/");
    if (parts.length === 2 || (parts.length === 3 && path.endsWith("/SKILL.md"))) {
      findings.push(`SYMLINKED_TARGET_SKILL ${parts[1]}`);
    } else {
      findings.push(`SYMLINKED_TARGET_PATH ${path}`);
    }
  }
  for (const path of [...sourceSymlinkPaths].filter((path) => path !== "skills").sort()) {
    const parts = path.split("/");
    if (parts.length === 2 || (parts.length === 3 && path.endsWith("/SKILL.md"))) {
      findings.push(`SYMLINKED_SOURCE_SKILL ${parts[1]}`);
    } else {
      findings.push(`SYMLINKED_SOURCE_PATH ${path}`);
    }
  }

  for (const name of [...publicNames].filter((name) => !expectedSource.has(name)).sort()) {
    findings.push(`PUBLIC_SKILL_NOT_IN_SOURCE_SNAPSHOT ${name}`);
  }
  for (const name of [...publicNames].filter((name) => !actual.has(name)).sort()) {
    findings.push(`MISSING_PUBLIC_TARGET_SKILL ${name}`);
  }
  for (const name of [...actual].filter((name) => !publicNames.has(name)).sort()) {
    findings.push(`UNEXPECTED_PRIVATE_TARGET_SKILL ${name}`);
  }

  const sourceSkills = join(source, "skills");
  if (existsSync(sourceSkills) && !lstatSync(sourceSkills).isSymbolicLink()) {
    const owned = new Set<string>();
    for (const entry of readdirSync(sourceSkills, { withFileTypes: true })) {
      if (entry.isDirectory() && isDirectRegularFile(join(sourceSkills, entry.name, "SKILL.md"))) owned.add(entry.name);
    }
    for (const name of [...new Set([...publicNames].filter((item) => owned.has(item)))].sort()) {
      findings.push(`PUBLIC_SKILL_SOURCE_DUPLICATE ${name}`);
    }
    for (const name of [...privateNames].filter((item) => !owned.has(item)).sort()) {
      findings.push(`MISSING_PRIVATE_SOURCE_SKILL ${name}`);
    }
    for (const name of [...owned].filter((item) => !privateNames.has(item)).sort()) {
      findings.push(`UNEXPECTED_SOURCE_SKILL ${name}`);
    }
  } else if (privateNames.size > 0) {
    findings.push(`MISSING_PRIVATE_SOURCE_TREE count=${privateNames.size}`);
  }
  return { findings, publicCount: publicNames.size, privateCount: privateNames.size };
}

export function check(
  sourceRoot: string,
  revision = "HEAD",
  targetRoot = REPO_ROOT,
  publicManifest = join(targetRoot, "PUBLIC_SKILLS.txt"),
): string[] {
  return inspect(sourceRoot, revision, targetRoot, publicManifest).findings;
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
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(`ERROR ${String(error)}`);
    return 2;
  }
  if (!parsed.sourceRoot) {
    console.error(USAGE);
    return 2;
  }
  let result: InventoryResult;
  try {
    result = inspect(parsed.sourceRoot, parsed.revision, parsed.targetRoot, parsed.manifest ?? join(parsed.targetRoot, "PUBLIC_SKILLS.txt"));
  } catch (error) {
    console.error(`ERROR ${String(error)}`);
    return 2;
  }
  if (result.findings.length > 0) {
    const findings = result.findings;
    findings.forEach((finding) => console.log(`FINDING ${finding}`));
    return 1;
  }
  console.log(`PASS source-target inventory: public=${result.publicCount} target skills, private=${result.privateCount} source skills, no duplicate source`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
