#!/usr/bin/env bun
/** Check root public tools for private runtime coupling and broken local imports. */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRegularFile, isPathInside, REPO_ROOT, readText, relativePath, resolveExistingFile, walkFiles } from "./repo_util.ts";

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

const RELATIVE_IMPORT = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\()["'](\.{1,2}[\\/][^"']+)["']/g;
const ABSOLUTE_IMPORT = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\()["']((?:file:\/\/|\/|\\\\|[A-Za-z]:[\\/])[^"']+)["']/g;
const EXCLUDED_TEST_FILE = /(?:\.test\.(?:ts|tsx|js|py|sh)$|^test[-_].*\.(?:ts|tsx|js|py|sh)$|_test\.(?:ts|tsx|js|py|sh)$)/;
const PUBLIC_TOOL_EXTENSIONS = [".ts", ".tsx", ".js", ".py", ".sh"];

function collectPublicToolFiles(repoRoot: string): { files: string[]; rejectedSymlinks: string[] } {
  const rejectedSymlinks: string[] = [];
  const files = walkFiles(join(repoRoot, "bin"), {
    ignoredDirectories: new Set([".git"]),
    onRejectedSymlink: (path) => rejectedSymlinks.push(path),
  }).filter((path) => {
    const name = path.split(/[\\/]/).at(-1) ?? "";
    return PUBLIC_TOOL_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
      (name === "test_runner.ts" || !EXCLUDED_TEST_FILE.test(name));
  });
  return { files, rejectedSymlinks: rejectedSymlinks.sort() };
}

export function publicToolFiles(repoRoot: string = REPO_ROOT): string[] {
  return collectPublicToolFiles(repoRoot).files;
}

function importCandidates(file: string, specifier: string): string[] {
  const absolute = resolve(dirname(file), specifier.replaceAll("\\", "/"));
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
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate)) return false;
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

function absoluteImportPath(specifier: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(specifier)) return specifier;
  return specifier.startsWith("file://") ? fileURLToPath(specifier) : resolve(specifier);
}

export function check(repoRoot: string = REPO_ROOT): string[] {
  const findings: string[] = [];
  const binRoot = join(repoRoot, "bin");
  try {
    if (lstatSync(binRoot).isSymbolicLink()) {
      findings.push(`${relativePath(binRoot, repoRoot)}: root tool directory is a symbolic link`);
      return findings;
    }
  } catch {
    // A missing bin directory produces no public tools and is handled by the caller's repository checks.
  }
  const collected = collectPublicToolFiles(repoRoot);
  for (const path of collected.rejectedSymlinks) {
    findings.push(`${relativePath(path, repoRoot)}: symbolic link escapes public tool boundary`);
  }
  for (const path of collected.files) {
    const relative = relativePath(path, repoRoot);
    if (!isPathInside(repoRoot, path) || !isDirectRegularFile(path)) {
      findings.push(`${relative}: public tool path is not a regular file inside the repository`);
      continue;
    }
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
    for (const match of content.matchAll(ABSOLUTE_IMPORT)) {
      const specifier = match[1];
      if (!specifier) continue;
      try {
        const absolute = absoluteImportPath(specifier);
        if (!isInside(repoRoot, absolute)) {
          findings.push(`${relative}: local reference outside public repository ${specifier}`);
          continue;
        }
        const existing = resolveExistingFile(importCandidates(path, absolute));
        if (!existing) {
          findings.push(`${relative}: missing local reference ${specifier}`);
        } else if (!isInside(repoRoot, realpathSync(existing))) {
          findings.push(`${relative}: local reference resolves outside public repository ${specifier}`);
        }
      } catch {
        findings.push(`${relative}: unreadable local reference ${specifier}`);
      }
    }
  }
  return findings;
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length > 0) {
    console.error("usage: public_tool_boundary_check.ts");
    return 2;
  }
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
