#!/usr/bin/env bun
/** Compare a split public/private Skill inventory with this checkout. */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRegularFile, REPO_ROOT, readText, runGit } from "./repo_util.ts";

export function targetInventory(root: string): Set<string> {
  const skillsRoot = join(root, "skills");
  const result = new Set<string>();
  if (!existsSync(skillsRoot)) return result;
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(".") && entry.isDirectory() && isRegularFile(join(skillsRoot, entry.name, "SKILL.md"))) {
      result.add(entry.name);
    }
  }
  return result;
}

export function manifestInventory(path: string): Set<string> {
  return new Set(
    readText(path)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
}

export function snapshotInventory(source: string, revision: string): Set<string> {
  const result = runGit(["ls-tree", "-r", "--name-only", revision, "--", "skills"], resolve(source));
  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  }
  const prefix = "skills/";
  const suffix = "/SKILL.md";
  return new Set(
    result.stdout
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item.startsWith(prefix) && item.endsWith(suffix) && item.split("/").length === 3)
      .map((item) => item.slice(prefix.length, -suffix.length)),
  );
}

export type ParsedArgs = { sourceRoot?: string; revision: string; targetRoot: string; manifest?: string };

function requiredValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("usage: source_target_inventory_check.ts --source-root <path> [--source-revision <revision>]");
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
    } else if (arg === "--source-revision") {
      revision = requiredValue(args, index);
      index += 1;
    } else if (arg === "--target-root") {
      targetRoot = resolve(requiredValue(args, index));
      index += 1;
    } else if (arg === "--public-manifest") {
      manifest = resolve(requiredValue(args, index));
      index += 1;
    } else {
      throw new Error("usage: source_target_inventory_check.ts --source-root <path> [--source-revision <revision>]");
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
  const expectedSource = snapshotInventory(source, revision);
  const actual = targetInventory(target);
  const publicNames = manifestInventory(publicManifest);
  const privateNames = new Set([...expectedSource].filter((name) => !publicNames.has(name)));
  const findings: string[] = [];

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
      if (entry.isDirectory() && isRegularFile(join(sourceSkills, entry.name, "SKILL.md"))) owned.add(entry.name);
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
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(`ERROR ${String(error)}`);
    return 2;
  }
  if (!parsed.sourceRoot) {
    console.error("usage: source_target_inventory_check.ts --source-root <path> [--source-revision <revision>]");
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
