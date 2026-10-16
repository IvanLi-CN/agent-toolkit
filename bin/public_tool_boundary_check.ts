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
const PYTHON_RELATIVE_IMPORT = /\bfrom\s+(\.+[A-Za-z_][A-Za-z0-9_.]*|\.+)\s+import\s+\(?\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\)?/g;
const PYTHON_LOCAL_IMPORT = /(?:^[ \t]*|;[ \t]*)import\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/gm;
const SHELL_SOURCE_IMPORT = /(?:^[ \t]*|[;&|][ \t]*|then[ \t]+)(?:source\b|\.)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;|]+))/gm;
const EXCLUDED_TEST_FILE = /(?:\.test\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$|^test[-_].*\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$|_test\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$)/;
const PUBLIC_TOOL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py", ".sh"];
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SCANNABLE_LOCAL_EXTENSIONS = new Set([...PUBLIC_TOOL_EXTENSIONS, ".json"]);
const NODE_MODULE_BUILTINS = new Set(["module", "node:module"]);
const RELATIVE_SPECIFIER = /^\.{1,2}[\\/]/;
const ABSOLUTE_SPECIFIER = /^(?:file:\/\/|\/|\\|[A-Za-z]:[\\/])/;
const EXECUTABLE_MODULE_URL = /^(?:blob|data|javascript):/i;

function isExcludedTestPath(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  return EXCLUDED_TEST_FILE.test(name);
}

function pythonRelativeSpecifiers(moduleSpecifier: string, importedNames: string): string[] {
  const dotCount = moduleSpecifier.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = moduleSpecifier.slice(dotCount).replaceAll(".", "/");
  const prefix = dotCount === 1 ? "./" : "../".repeat(dotCount - 1);
  return moduleName ? [`${prefix}${moduleName}`] : importedNames.split(",").map((name) => `${prefix}${name.trim()}`);
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
    `${absolute}.py`,
    `${absolute}.sh`,
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

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isImportMeta(node: ts.Expression | undefined): boolean {
  const expression = node ? unwrapExpression(node) : undefined;
  return !!expression && ts.isMetaProperty(expression) && expression.keywordToken === ts.SyntaxKind.ImportKeyword && expression.name.text === "meta";
}

function isImportMetaReference(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  return isImportMeta(expression) || (ts.isIdentifier(expression) && aliases.has(expression.text));
}

type MemberAccess = { receiver: ts.Expression; name: string };

function memberAccess(node: ts.Expression): MemberAccess | undefined {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression, name: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression) && !!expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    return { receiver: expression.expression, name: expression.argumentExpression.text };
  }
  return undefined;
}

function isImportMetaRequire(node: ts.Expression): boolean {
  const access = memberAccess(node);
  return access?.name === "require" && isImportMeta(access.receiver);
}

function isRequireExpression(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) && aliases.has(expression.text)) return true;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return isRequireExpression(expression.right, aliases);
  }
  const access = memberAccess(expression);
  return access?.name === "require" || isImportMetaRequire(expression);
}

function isRequireBindExpression(node: ts.Expression, aliases: Set<string>): boolean {
  const access = memberAccess(node);
  return access?.name === "bind" && isRequireExpression(access.receiver, aliases);
}

function isRequireBindCall(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  return ts.isCallExpression(expression) && isRequireBindExpression(expression.expression, aliases);
}

function isLoaderExpression(node: ts.Expression, aliases: Set<string>): boolean {
  return isRequireExpression(node, aliases) || isRequireBindExpression(node, aliases) || isRequireBindCall(node, aliases);
}

function isRequireMethodCall(node: ts.Expression, aliases: Set<string>): boolean {
  const access = memberAccess(node);
  return (access?.name === "apply" || access?.name === "bind" || access?.name === "call") && isRequireExpression(access.receiver, aliases);
}

function requireBindingNames(name: ts.BindingName, initializer: ts.Expression): string[] {
  if (!isImportMeta(initializer) || !ts.isObjectBindingPattern(name)) return [];
  const names: string[] = [];
  for (const element of name.elements) {
    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
    const propertyName = element.propertyName;
    const propertyText = propertyName && ts.isStringLiteralLike(propertyName) ? propertyName.text : propertyName && ts.isIdentifier(propertyName) ? propertyName.text : element.name.text;
    if (propertyText === "require") names.push(element.name.text);
  }
  return names;
}

function collectRequireAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set(["require"]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        for (const name of requireBindingNames(node.name, node.initializer)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.name) && isLoaderExpression(node.initializer, aliases) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isLoaderExpression(node.right, aliases) && !aliases.has(node.left.text)) {
        aliases.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
}

function collectImportMetaAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        isImportMetaReference(node.initializer, aliases) &&
        !aliases.has(node.name.text)) {
        aliases.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
}

function isRequirePropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node);
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
  const requireAliases = collectRequireAliases(source);
  const importMetaAliases = collectImportMetaAliases(source);
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
    } else if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = isRequireExpression(expression, requireAliases) || isRequireBindCall(expression, requireAliases);
      if (isRequireMethodCall(expression, requireAliases)) {
        hasUnverifiableDynamicImport = true;
      }
      const isCreateRequire = (ts.isIdentifier(expression) && expression.text === "createRequire") ||
        (ts.isPropertyAccessExpression(expression) && expression.name.text === "createRequire") ||
        (ts.isElementAccessExpression(expression) && !!expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression) && expression.argumentExpression.text === "createRequire");
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
    } else if (ts.isElementAccessExpression(node) && isImportMetaReference(node.expression, importMetaAliases)) {
      if (!node.argumentExpression || !ts.isStringLiteralLike(node.argumentExpression)) {
        hasUnverifiableDynamicImport = true;
      }
    } else if (ts.isIdentifier(node) && node.text === "require" && !isRequirePropertyName(node)) {
      hasUnverifiableDynamicImport = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, hasUnverifiableDynamicImport };
}

function checkImportSpecifier(repoRoot: string, path: string, relative: string, specifier: string, findings: string[], onResolved?: (path: string) => void): void {
  if (EXECUTABLE_MODULE_URL.test(specifier)) {
    findings.push(`${relative}: executable module URL cannot be verified`);
    return;
  }
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
  const enqueue = (dependency: string): void => {
    const dependencyKey = resolve(dependency);
    if (!scanned.has(dependencyKey) && !pending.some((candidate) => resolve(candidate) === dependencyKey)) {
      pending.push(dependency);
    }
  };
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
        checkImportSpecifier(repoRoot, path, relative, specifier, findings, enqueue);
      }
    } else if (!JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
      for (const match of content.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1];
        if (specifier) checkImportSpecifier(repoRoot, path, relative, specifier, findings, enqueue);
      }
      for (const match of content.matchAll(ABSOLUTE_IMPORT)) {
        const specifier = match[1];
        if (specifier) checkImportSpecifier(repoRoot, path, relative, specifier, findings, enqueue);
      }
      if (extname(path).toLowerCase() === ".py") {
        for (const match of content.matchAll(PYTHON_RELATIVE_IMPORT)) {
          const moduleSpecifier = match[1];
          const importedNames = match[2];
          if (moduleSpecifier && importedNames) {
            for (const specifier of pythonRelativeSpecifiers(moduleSpecifier, importedNames)) {
              checkImportSpecifier(repoRoot, path, relative, specifier, findings, enqueue);
            }
          }
        }
        for (const match of content.matchAll(PYTHON_LOCAL_IMPORT)) {
          const importedNames = match[1];
          if (importedNames) {
            for (const name of importedNames.split(",").map((item) => item.trim().split(/\s+as\s+/i)[0]).filter(Boolean)) {
              const specifier = `./${name}`;
              if (resolveExistingFile(importCandidates(path, specifier))) {
                checkImportSpecifier(repoRoot, path, relative, specifier, findings, enqueue);
              }
            }
          }
        }
      }
      if (extname(path).toLowerCase() === ".sh") {
        for (const match of content.matchAll(SHELL_SOURCE_IMPORT)) {
          const source = match[1] ?? match[2] ?? match[3];
          if (source) {
            const specifier = RELATIVE_SPECIFIER.test(source) || ABSOLUTE_SPECIFIER.test(source) ? source : `./${source}`;
            checkImportSpecifier(repoRoot, path, relative, specifier, findings, enqueue);
          }
        }
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
