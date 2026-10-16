#!/usr/bin/env bun
/** Compare a split public/private Skill inventory with this checkout. */

import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, readText, runGit } from "./repo_util.ts";

export function targetInventory(root: string): Set<string> {
  const skillsRoot = join(root, "skills");
  const result = new Set<string>();
  if (!existsSync(skillsRoot)) return result;
  for (const entry of new Bun.Glob("*").scanSync({ cwd: skillsRoot, onlyFiles: false })) {
    if (!entry.startsWith(".") && existsSync(join(skillsRoot, entry, "SKILL.md"))) {
      result.add(entry);
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

function parseArgs(args: string[]): { sourceRoot?: string; revision: string; targetRoot: string; manifest?: string } {
  let sourceRoot: string | undefined;
  let revision = "HEAD";
  let targetRoot = REPO_ROOT;
  let manifest: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source-root") sourceRoot = args[++index];
    else if (arg === "--source-revision") revision = args[++index] ?? revision;
    else if (arg === "--target-root") targetRoot = resolve(args[++index] ?? targetRoot);
    else if (arg === "--public-manifest") manifest = resolve(args[++index] ?? "");
  }
  return { sourceRoot, revision, targetRoot, manifest };
}

export function check(
  sourceRoot: string,
  revision = "HEAD",
  targetRoot = REPO_ROOT,
  publicManifest = join(targetRoot, "PUBLIC_SKILLS.txt"),
): string[] {
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
    for (const entry of new Bun.Glob("*").scanSync({ cwd: sourceSkills, onlyFiles: false })) {
      if (existsSync(join(sourceSkills, entry, "SKILL.md"))) owned.add(entry);
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
  return findings;
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  const parsed = parseArgs(args);
  if (!parsed.sourceRoot) {
    console.error("usage: source_target_inventory_check.ts --source-root <path> [--source-revision <revision>]");
    return 2;
  }
  let findings: string[];
  try {
    findings = check(parsed.sourceRoot, parsed.revision, parsed.targetRoot, parsed.manifest ?? join(parsed.targetRoot, "PUBLIC_SKILLS.txt"));
  } catch (error) {
    console.error(`ERROR ${String(error)}`);
    return 2;
  }
  if (findings.length > 0) {
    findings.forEach((finding) => console.log(`FINDING ${finding}`));
    return 1;
  }
  const publicCount = manifestInventory(parsed.manifest ?? join(parsed.targetRoot, "PUBLIC_SKILLS.txt")).size;
  const sourceCount = snapshotInventory(parsed.sourceRoot, parsed.revision).size - publicCount;
  console.log(`PASS source-target inventory: public=${publicCount} target skills, private=${sourceCount} source skills, no duplicate source`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
