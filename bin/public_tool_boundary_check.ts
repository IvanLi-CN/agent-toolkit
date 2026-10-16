#!/usr/bin/env bun
/** Check root public tools for private runtime coupling and broken local imports. */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
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

const IMPORT_GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r\n|\r|\n))*`;
const IMPORT_PREFIX = String.raw`(?:\bfrom${IMPORT_GAP}|\bimport${IMPORT_GAP}(?:\(${IMPORT_GAP})?|\brequire${IMPORT_GAP}\(${IMPORT_GAP})`;
const RELATIVE_IMPORT = new RegExp(String.raw`${IMPORT_PREFIX}["'](\.{1,2}[\\/][^"']+)["']`, "g");
const ABSOLUTE_IMPORT = new RegExp(String.raw`${IMPORT_PREFIX}["']((?:file://|/|\\|[A-Za-z]:[\\/])[^"']+)["']`, "g");
const EXCLUDED_TEST_FILE = /(?:\.test\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$|^test[-_].*\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$|_test\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$)/;
const PUBLIC_TOOL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py", ".sh"];
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SCANNABLE_LOCAL_EXTENSIONS = new Set([...PUBLIC_TOOL_EXTENSIONS, ".json"]);
const NODE_MODULE_BUILTINS = new Set(["module", "node:module"]);
const RELATIVE_SPECIFIER = /^\.{1,2}[\\/]/;
const ABSOLUTE_SPECIFIER = /^(?:file:\/\/|\/|\\|[A-Za-z]:[\\/])/;

function isExcludedTestPath(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  return EXCLUDED_TEST_FILE.test(name);
}

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
    `${absolute}.jsx`,
    `${absolute}.cjs`,
    `${absolute}.mjs`,
    `${absolute}.json`,
    join(absolute, "index.ts"),
    join(absolute, "index.js"),
  ];
}

function isInside(root: string, candidate: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|\\)/.test(candidate)) return false;
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
  if (/^(?:[A-Za-z]:[\\/]|\\)/.test(specifier)) return specifier;
  return specifier.startsWith("file://") ? fileURLToPath(specifier) : resolve(specifier);
}

type JavaScriptImports = { specifiers: string[]; hasUnverifiableDynamicImport: boolean };

function isImportMeta(node: ts.Expression | undefined): boolean {
  return !!node && ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta";
}

function isImportMetaRequire(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "require" && isImportMeta(node.expression);
  }
  return ts.isElementAccessExpression(node) && isImportMeta(node.expression) && !!node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "require";
}

function isRequireExpression(node: ts.Expression, aliases: Set<string>): boolean {
  return (ts.isIdentifier(node) && aliases.has(node.text)) || isImportMetaRequire(node);
}

function javascriptImports(file: string, content: string): JavaScriptImports {
  const extension = extname(file).toLowerCase();
  if (!JAVASCRIPT_EXTENSIONS.has(extension)) {
    return { specifiers: [], hasUnverifiableDynamicImport: false };
  }
  const scriptKind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : JAVASCRIPT_EXTENSIONS.has(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];
  let hasUnverifiableDynamicImport = false;
  const requireAliases = new Set(["require"]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (NODE_MODULE_BUILTINS.has(node.moduleSpecifier.text)) {
        hasUnverifiableDynamicImport = true;
      }
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (NODE_MODULE_BUILTINS.has(node.moduleSpecifier.text)) {
        hasUnverifiableDynamicImport = true;
      }
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      if (NODE_MODULE_BUILTINS.has(node.moduleReference.expression.text)) {
        hasUnverifiableDynamicImport = true;
      }
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isRequireExpression(node.initializer, requireAliases)) {
      requireAliases.add(node.name.text);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isRequireExpression(node.right, requireAliases)) {
      requireAliases.add(node.left.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = isRequireExpression(node.expression, requireAliases);
      const isCreateRequire = (ts.isIdentifier(node.expression) && node.expression.text === "createRequire") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire");
      if (isCreateRequire) {
        hasUnverifiableDynamicImport = true;
      }
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          if ((isDynamicImport || isRequire) && NODE_MODULE_BUILTINS.has(argument.text)) {
            hasUnverifiableDynamicImport = true;
          }
          specifiers.push(argument.text);
        } else {
          hasUnverifiableDynamicImport = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, hasUnverifiableDynamicImport };
}

function checkImportSpecifier(repoRoot: string, path: string, relative: string, specifier: string, findings: string[], onResolved?: (path: string) => void): void {
  if (RELATIVE_SPECIFIER.test(specifier)) {
    const candidates = importCandidates(path, specifier);
    if (candidates.some((candidate) => !isInside(repoRoot, candidate))) {
      findings.push(`${relative}: local reference outside public repository ${specifier}`);
      return;
    }
    const existing = resolveExistingFile(candidates);
    if (existing) {
      try {
        const realExisting = realpathSync(existing);
        if (!isInside(repoRoot, realExisting)) {
          findings.push(`${relative}: local reference resolves outside public repository ${specifier}`);
        } else if (isExcludedTestPath(existing) || isExcludedTestPath(realExisting)) {
          findings.push(`${relative}: local reference targets excluded test file ${specifier}`);
        } else if (!SCANNABLE_LOCAL_EXTENSIONS.has(extname(realExisting).toLowerCase())) {
          findings.push(`${relative}: local reference cannot be inspected ${specifier}`);
        } else {
          onResolved?.(existing);
        }
      } catch {
        findings.push(`${relative}: unreadable local reference ${specifier}`);
      }
      return;
    }
    findings.push(`${relative}: missing local reference ${specifier}`);
    return;
  }
  if (!ABSOLUTE_SPECIFIER.test(specifier)) return;
  try {
    const absolute = absoluteImportPath(specifier);
    if (!isInside(repoRoot, absolute)) {
      findings.push(`${relative}: local reference outside public repository ${specifier}`);
      return;
    }
    const existing = resolveExistingFile(importCandidates(path, absolute));
    if (!existing) {
      findings.push(`${relative}: missing local reference ${specifier}`);
    } else {
      const realExisting = realpathSync(existing);
      if (!isInside(repoRoot, realExisting)) {
        findings.push(`${relative}: local reference resolves outside public repository ${specifier}`);
      } else if (isExcludedTestPath(existing) || isExcludedTestPath(realExisting)) {
        findings.push(`${relative}: local reference targets excluded test file ${specifier}`);
      } else if (!SCANNABLE_LOCAL_EXTENSIONS.has(extname(realExisting).toLowerCase())) {
        findings.push(`${relative}: local reference cannot be inspected ${specifier}`);
      } else {
        onResolved?.(existing);
      }
    }
  } catch {
    findings.push(`${relative}: unreadable local reference ${specifier}`);
  }
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
  const pending = [...collected.files];
  const scanned = new Set<string>();
  while (pending.length > 0) {
    const path = pending.shift();
    if (!path) continue;
    const key = resolve(path);
    if (scanned.has(key)) continue;
    scanned.add(key);
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
    const parsed = javascriptImports(path, content);
    if (parsed.hasUnverifiableDynamicImport) {
      findings.push(`${relative}: dynamic import or require cannot be verified`);
    }
    if (parsed.specifiers.length > 0) {
      for (const specifier of parsed.specifiers) {
        checkImportSpecifier(repoRoot, path, relative, specifier, findings, (dependency) => {
          const dependencyKey = resolve(dependency);
          if (!scanned.has(dependencyKey) && !pending.some((candidate) => resolve(candidate) === dependencyKey)) {
            pending.push(dependency);
          }
        });
      }
    } else if (!JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
      for (const match of content.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1];
        if (specifier) checkImportSpecifier(repoRoot, path, relative, specifier, findings, (dependency) => pending.push(dependency));
      }
      for (const match of content.matchAll(ABSOLUTE_IMPORT)) {
        const specifier = match[1];
        if (specifier) checkImportSpecifier(repoRoot, path, relative, specifier, findings, (dependency) => pending.push(dependency));
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
