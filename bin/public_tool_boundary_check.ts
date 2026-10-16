#!/usr/bin/env bun
/** Check root public tools for private runtime coupling and broken local imports. */

import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { REPO_ROOT, readText, relativePath, resolveExistingFile, walkFiles } from "./repo_util.ts";

const runtimeNamePattern = "CODEX_" + "[A-Z0-9_]+";
const runtimeHomeMarker = "$" + "CODEX_" + "HOME";
const dotRuntimeMarker = "." + "codex";
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const privateRootPattern = `(?:^|["'\`])\\.\\.\\/${escapeRegExp(dotRuntimeMarker)}(?:[\\/\\\\]|["'\`]|$)`;
const nativeSurfacePattern = ["Task" + "Space", "agent_" + "session"].map(escapeRegExp).join("|");
export const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["codex-runtime-marker", new RegExp(`(?:\\b${runtimeNamePattern}\\b|${escapeRegExp(runtimeHomeMarker)}|${escapeRegExp(dotRuntimeMarker)}(?:[\\/\\\\]|\\b))`, "i")],
  ["codex-native-surface", new RegExp(`\\b(?:${nativeSurfacePattern})\\b|native\\s+(?:task|worktree|background)`, "i")],
  ["private-consumer-root", new RegExp(`(?:~\\/\\.agents\\/skills|${privateRootPattern})`, "i")],
];

const RELATIVE_IMPORT = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\()["'](\.{1,2}\/[^"']+)["']/g;
const EXCLUDED_TEST_FILE = /(?:\.test|^test[-_]).*\.ts$/;

export function publicToolFiles(repoRoot: string = REPO_ROOT): string[] {
  return walkFiles(join(repoRoot, "bin"), { ignoredDirectories: new Set([".git"]) })
    .filter((path) => path.endsWith(".ts") && !EXCLUDED_TEST_FILE.test(path.split(/[\\/]/).at(-1) ?? ""));
}

function importCandidates(file: string, specifier: string): string[] {
  const absolute = resolve(dirname(file), specifier);
  return [
    absolute,
    `${absolute}.ts`,
    `${absolute}.tsx`,
    `${absolute}.js`,
    `${absolute}.json`,
    join(absolute, "index.ts"),
    join(absolute, "index.js"),
  ];
}

function isInside(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  let realRoot = absoluteRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The lexical check below still handles roots that do not exist yet.
  }
  return (
    absoluteCandidate === absoluteRoot ||
    absoluteCandidate.startsWith(`${absoluteRoot}${sep}`) ||
    absoluteCandidate === realRoot ||
    absoluteCandidate.startsWith(`${realRoot}${sep}`)
  );
}

export function check(repoRoot: string = REPO_ROOT): string[] {
  const findings: string[] = [];
  for (const path of publicToolFiles(repoRoot)) {
    const relative = relativePath(path, repoRoot);
    const content = readText(path);
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        findings.push(`${relative}: forbidden public tool coupling ${label}`);
      }
    }
    for (const match of content.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const candidates = importCandidates(path, specifier);
      if (candidates.some((candidate) => !isInside(repoRoot, candidate))) {
        findings.push(`${relative}: local reference outside public repository ${specifier}`);
        continue;
      }
      const existing = resolveExistingFile(candidates);
      if (existing) {
        try {
          if (!isInside(repoRoot, realpathSync(existing))) {
            findings.push(`${relative}: local reference resolves outside public repository ${specifier}`);
          }
        } catch {
          findings.push(`${relative}: unreadable local reference ${specifier}`);
        }
        continue;
      }
      findings.push(`${relative}: missing local reference ${specifier}`);
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
  console.log(`PASS public tool boundary: ${publicToolFiles().length} root tools`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
