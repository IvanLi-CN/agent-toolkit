#!/usr/bin/env bun
/** Check root public tools for private runtime coupling and broken local imports. */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
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
const PYTHON_NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
const PYTHON_IMPORT_GAP = String.raw`(?:[ \t\r\n]|\\[ \t]*(?:\r\n|\r|\n)|#[^\r\n]*(?:\r\n|\r|\n))*`;
const PYTHON_IMPORT_START = String.raw`(?:^[ \t]*|;[ \t]*)`;
const PYTHON_IMPORTED_NAME = String.raw`${PYTHON_NAME}(?:${PYTHON_IMPORT_GAP}as${PYTHON_IMPORT_GAP}${PYTHON_NAME})?`;
const PYTHON_IMPORTED_NAMES = String.raw`(?:${PYTHON_IMPORTED_NAME}|\*)(?:${PYTHON_IMPORT_GAP},${PYTHON_IMPORT_GAP}(?:${PYTHON_IMPORTED_NAME}|\*))*`;
const PYTHON_RELATIVE_IMPORT = new RegExp(String.raw`${PYTHON_IMPORT_START}from${PYTHON_IMPORT_GAP}(\.+${PYTHON_NAME}(?:\.${PYTHON_NAME})*|\.+)${PYTHON_IMPORT_GAP}import${PYTHON_IMPORT_GAP}\(?${PYTHON_IMPORT_GAP}(${PYTHON_IMPORTED_NAMES})${PYTHON_IMPORT_GAP},?${PYTHON_IMPORT_GAP}\)?`, "gm");
const PYTHON_FROM_IMPORT = new RegExp(String.raw`${PYTHON_IMPORT_START}from${PYTHON_IMPORT_GAP}(${PYTHON_NAME}(?:\.${PYTHON_NAME})*)${PYTHON_IMPORT_GAP}import${PYTHON_IMPORT_GAP}\(?${PYTHON_IMPORT_GAP}(${PYTHON_IMPORTED_NAMES})${PYTHON_IMPORT_GAP},?${PYTHON_IMPORT_GAP}\)?`, "gm");
const PYTHON_LOCAL_IMPORT = new RegExp(String.raw`(?:^[ \t]*|[;:][ \t]*)import\s+(${PYTHON_NAME}(?:\.${PYTHON_NAME})*(?:\s+as\s+${PYTHON_NAME})?(?:\s*,\s*${PYTHON_NAME}(?:\.${PYTHON_NAME})*(?:\s+as\s+${PYTHON_NAME})?)*)(?:\s*,\s*)?`, "gm");
const SHELL_SOURCE_IMPORT = /(?:^[ \t]*|[;&|(){}][ \t]*|(?:then|do)[ \t]+)(?:source\b|\.)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;|]+))/gm;
const EXCLUDED_TEST_FILE = /(?:\.test\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$|^test[-_].*\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$|_test\.(?:ts|tsx|js|jsx|cjs|mjs|py|sh)$)/;
const PUBLIC_TOOL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py", ".sh"];
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SCANNABLE_LOCAL_EXTENSIONS = new Set([...PUBLIC_TOOL_EXTENSIONS, ".json"]);
const NODE_MODULE_BUILTINS = new Set(["module", "node:module"]);
const RELATIVE_SPECIFIER = /^\.{1,2}[\\/]/;
const ABSOLUTE_SPECIFIER = /^(?:file:\/\/|\/|\\|[A-Za-z]:[\\/])/;
const EXECUTABLE_MODULE_URL = /^(?:blob|data|javascript):/i;

// Keep line structure intact while removing Python comments and string literals from import matching.
function maskPythonNonCode(content: string): string {
  const characters = content.split("");
  let quote: "'" | '"' | undefined;
  let triple = false;
  let comment = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content.slice(index, index + 3);
    if (comment) {
      if (character === "\n" || character === "\r") {
        comment = false;
      } else {
        characters[index] = " ";
      }
      continue;
    }
    if (quote) {
      if (triple && next === quote.repeat(3)) {
        characters[index] = " ";
        characters[index + 1] = " ";
        characters[index + 2] = " ";
        index += 2;
        quote = undefined;
        triple = false;
      } else if (!triple && character === quote) {
        characters[index] = " ";
        quote = undefined;
      } else if (character === "\\") {
        characters[index] = " ";
        if (index + 1 < content.length && content[index + 1] !== "\n" && content[index + 1] !== "\r") {
          characters[index + 1] = " ";
          index += 1;
        }
      } else if (character !== "\n" && character !== "\r") {
        characters[index] = " ";
      }
      continue;
    }
    if (character === "#") {
      characters[index] = " ";
      comment = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      triple = next === character.repeat(3);
      characters[index] = " ";
      if (triple) {
        characters[index + 1] = " ";
        characters[index + 2] = " ";
        index += 2;
      }
    }
  }
  return characters.join("");
}

function isExcludedTestPath(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  return EXCLUDED_TEST_FILE.test(name);
}

function pythonRelativeSpecifiers(moduleSpecifier: string, importedNames: string): string[] {
  const dotCount = moduleSpecifier.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = moduleSpecifier.slice(dotCount).replaceAll(".", "/");
  const prefix = dotCount === 1 ? "./" : "../".repeat(dotCount - 1);
  const names = pythonImportedNames(importedNames);
  return moduleName
    ? [`${prefix}${moduleName}`, ...names.map((name) => `${prefix}${moduleName}/${name}`)]
    : names.map((name) => `${prefix}${name}`);
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
    ...(extname(file).toLowerCase() === ".py" ? [join(absolute, "__init__.py")] : []),
    join(absolute, "index.ts"),
    join(absolute, "index.js"),
  ];
}

function pythonImportCandidates(file: string, specifier: string): string[] {
  const absolute = resolve(dirname(file), specifier.replaceAll("\\", "/"));
  return [
    `${absolute}.py`,
    join(absolute, "__init__.py"),
  ];
}

function pythonImportedNames(importedNames: string): string[] {
  return importedNames
    .replace(/#[^\r\n]*(?:\r\n|\r|\n|$)/g, "\n")
    .split(",")
    .map((name) => name.trim().split(/\s+as\s+/i)[0]?.trim() ?? "")
    .filter(Boolean);
}

function pythonRelativeBaseDirectory(file: string, moduleSpecifier: string): string {
  const dotCount = moduleSpecifier.match(/^\.+/)?.[0].length ?? 0;
  return resolve(dirname(file), dotCount > 1 ? "../".repeat(dotCount - 1) : ".");
}

function pythonRelativeSpecifier(file: string, target: string): string {
  const specifier = relative(dirname(file), target).replaceAll("\\", "/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function pythonSearchSpecifier(file: string, searchRoot: string, moduleName: string): string {
  const target = resolve(searchRoot, moduleName.replaceAll(".", "/"));
  return pythonRelativeSpecifier(file, target);
}

function pythonPackageInitializerSpecifier(moduleSpecifier: string): string {
  const dotCount = moduleSpecifier.match(/^\.+/)?.[0].length ?? 0;
  return `${dotCount === 1 ? "./" : "../".repeat(dotCount - 1)}__init__`;
}

function pythonInitializerExportsName(path: string, name: string): boolean {
  try {
    const escapedName = escapeRegExp(name);
    const content = readText(path);
    const code = maskPythonNonCode(content);
    return new RegExp(String.raw`(?:^|\r?\n)[ \t]*(?:(?:(?:async[ \t]+)?def|class)[ \t]+${escapedName}\b|${escapedName}[ \t]*(?:=|:=)|(?:from|import)\b[^\r\n]*\b${escapedName}\b)`, "m").test(code) ||
      new RegExp(String.raw`__all__[ \t]*=[^\r\n]*\b${escapedName}\b`, "m").test(content);
  } catch {
    return false;
  }
}

function pythonInitializerAllNames(path: string): string[] | null | undefined {
  try {
    const content = readText(path);
    const code = maskPythonNonCode(content);
    if (!/__all__[ \t]*=/.test(code)) return undefined;
    const match = content.match(/__all__[ \t]*=[ \t]*(?:\[|\()([\s\S]*?)(?:\]|\))/m);
    if (!match) return null;
    return [...(match[1] ?? "").matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map((item) => item[1]).filter((name): name is string => Boolean(name));
  } catch {
    return null;
  }
}

function pythonPackageInitializers(repoRoot: string, file: string, specifier: string): string[] {
  const moduleBase = resolve(dirname(file), specifier.replaceAll("\\", "/"));
  let directory = isDirectRegularFile(join(moduleBase, "__init__.py")) ? moduleBase : dirname(moduleBase);
  const result: string[] = [];
  while (isPathInside(repoRoot, directory)) {
    const initializer = join(directory, "__init__.py");
    if (isDirectRegularFile(initializer)) result.push(initializer);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return result;
}

function pythonModuleInitializer(file: string, specifier: string): string | undefined {
  const initializer = join(resolve(dirname(file), specifier.replaceAll("\\", "/")), "__init__.py");
  return isDirectRegularFile(initializer) ? initializer : undefined;
}

function pythonNamespaceDirectory(repoRoot: string, file: string, specifier: string): string | undefined {
  const directory = resolve(dirname(file), specifier.replaceAll("\\", "/"));
  if (!isInside(repoRoot, directory)) return undefined;
  try {
    if (lstatSync(directory).isDirectory() && !isDirectRegularFile(join(directory, "__init__.py"))) return directory;
  } catch {
    // Missing namespace directories are reported by the normal Python resolver.
  }
  return undefined;
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
  if (ts.isBinaryExpression(expression) && (expression.operatorToken.kind === ts.SyntaxKind.CommaToken || expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
    return isImportMetaReference(expression.right, aliases);
  }
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

const DYNAMIC_CODE_NAMES = new Set(["eval", "Function"]);
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "global", "window", "self"]);

function isDynamicCodeReference(node: ts.Expression, aliases: Set<string> = DYNAMIC_CODE_NAMES): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return aliases.has(expression.text);
  const access = memberAccess(expression);
  return access !== undefined && DYNAMIC_CODE_NAMES.has(access.name);
}

function isGlobalObjectReference(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isBinaryExpression(expression) && (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken || expression.operatorToken.kind === ts.SyntaxKind.CommaToken)) {
    return isGlobalObjectReference(expression.right, aliases);
  }
  return ts.isIdentifier(expression) && aliases.has(expression.text);
}

function isUnknownGlobalPropertyAccess(node: ts.ElementAccessExpression, aliases: Set<string>): boolean {
  if (!isGlobalObjectReference(node.expression, aliases) || !node.argumentExpression) return false;
  const argument = unwrapExpression(node.argumentExpression);
  return !ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument);
}

function isImportMetaRequire(node: ts.Expression, importMetaAliases: Set<string> = new Set()): boolean {
  const access = memberAccess(node);
  return access?.name === "require" && isImportMetaReference(access.receiver, importMetaAliases);
}

function isRequireExpression(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) && aliases.has(expression.text)) return true;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return isRequireExpression(expression.right, aliases, importMetaAliases);
  }
  const access = memberAccess(expression);
  return access?.name === "require" || isImportMetaRequire(expression, importMetaAliases);
}

function isRequireBindExpression(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const access = memberAccess(node);
  return access?.name === "bind" && isRequireExpression(access.receiver, aliases, importMetaAliases);
}

function isRequireBindCall(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const expression = unwrapExpression(node);
  return ts.isCallExpression(expression) && isRequireBindExpression(expression.expression, aliases, importMetaAliases);
}

function isLoaderExpression(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  return isRequireExpression(node, aliases, importMetaAliases) || isRequireBindExpression(node, aliases, importMetaAliases) || isRequireBindCall(node, aliases, importMetaAliases);
}

function isRequireMethodCall(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const access = memberAccess(node);
  return (access?.name === "apply" || access?.name === "bind" || access?.name === "call") && isRequireExpression(access.receiver, aliases, importMetaAliases);
}

function staticPropertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrapExpression(node.expression);
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
  }
  return undefined;
}

function assignmentTargetName(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargetName(expression.left);
  }
  return undefined;
}

function isModuleContainerReference(node: ts.Expression, importMetaAliases: Set<string>, moduleAliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return isModuleContainerReference(expression.right, importMetaAliases, moduleAliases);
  }
  return isImportMetaReference(expression, importMetaAliases) || (ts.isIdentifier(expression) && moduleAliases.has(expression.text));
}

function isImportMetaContainerReference(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return isImportMetaContainerReference(expression.right, aliases);
  }
  return isImportMetaReference(expression, aliases);
}

function hasUnverifiableImportMetaBinding(name: ts.BindingName, initializer: ts.Expression, aliases: Set<string>): boolean {
  if (!isImportMetaContainerReference(initializer, aliases) || !ts.isObjectBindingPattern(name)) return false;
  return name.elements.some((element) => ts.isBindingElement(element) && !!element.propertyName && staticPropertyName(element.propertyName) === undefined);
}

function hasUnverifiableImportMetaAssignment(left: ts.Expression, initializer: ts.Expression, aliases: Set<string>): boolean {
  if (!isImportMetaContainerReference(initializer, aliases)) return false;
  const expression = unwrapExpression(left);
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name) && staticPropertyName(property.name) === undefined);
}

function hasUnverifiableGlobalBinding(name: ts.BindingName, initializer: ts.Expression, aliases: Set<string>): boolean {
  if (!isGlobalObjectReference(initializer, aliases) || !ts.isObjectBindingPattern(name)) return false;
  return name.elements.some((element) => ts.isBindingElement(element) && !!element.propertyName && staticPropertyName(element.propertyName) === undefined);
}

function hasUnverifiableGlobalAssignment(left: ts.Expression, initializer: ts.Expression, aliases: Set<string>): boolean {
  if (!isGlobalObjectReference(initializer, aliases)) return false;
  const expression = unwrapExpression(left);
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name) && staticPropertyName(property.name) === undefined);
}

function requireBindingNames(name: ts.BindingName, initializer: ts.Expression, importMetaAliases: Set<string>, moduleAliases: Set<string>): string[] {
  const expression = unwrapExpression(initializer);
  const isModuleContainer = isModuleContainerReference(expression, importMetaAliases, moduleAliases);
  if (!isModuleContainer || !ts.isObjectBindingPattern(name)) return [];
  const names: string[] = [];
  for (const element of name.elements) {
    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
    const propertyText = staticPropertyName(element.propertyName) ?? (element.propertyName ? undefined : element.name.text);
    if (propertyText === "require") names.push(element.name.text);
  }
  return names;
}

function requireAssignmentNames(left: ts.Expression, initializer: ts.Expression, importMetaAliases: Set<string>, moduleAliases: Set<string>): string[] {
  if (!isModuleContainerReference(initializer, importMetaAliases, moduleAliases)) return [];
  const expression = unwrapExpression(left);
  if (!ts.isObjectLiteralExpression(expression)) return [];
  const names: string[] = [];
  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property)) {
      const propertyName = staticPropertyName(property.name);
      const targetName = assignmentTargetName(property.initializer);
      if (propertyName === "require" && targetName) names.push(targetName);
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "require") {
      names.push(property.name.text);
    }
  }
  return names;
}

function collectRequireAliases(source: ts.SourceFile, importMetaAliases: Set<string>): Set<string> {
  const aliases = new Set(["require"]);
  const moduleAliases = new Set(["module"]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) {
        if (ts.isIdentifier(node.name) && isModuleContainerReference(node.initializer, importMetaAliases, moduleAliases) && !moduleAliases.has(node.name.text)) {
          moduleAliases.add(node.name.text);
          changed = true;
        }
        for (const name of requireBindingNames(node.name, node.initializer, importMetaAliases, moduleAliases)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.name) && isLoaderExpression(node.initializer, aliases, importMetaAliases) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left) && isModuleContainerReference(node.right, importMetaAliases, moduleAliases) && !moduleAliases.has(node.left.text)) {
          moduleAliases.add(node.left.text);
          changed = true;
        }
        for (const name of requireAssignmentNames(node.left, node.right, importMetaAliases, moduleAliases)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.left) && isLoaderExpression(node.right, aliases, importMetaAliases) && !aliases.has(node.left.text)) {
          aliases.add(node.left.text);
          changed = true;
        }
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
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer &&
        isImportMetaReference(node.initializer, aliases) &&
        !aliases.has(node.name.text)) {
        aliases.add(node.name.text);
        changed = true;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && isImportMetaReference(node.right, aliases) &&
        !aliases.has(node.left.text)) {
        aliases.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
}

function dynamicCodeAssignmentNames(left: ts.Expression, initializer: ts.Expression, globalAliases: Set<string>): string[] {
  if (!isGlobalObjectReference(initializer, globalAliases)) return [];
  const expression = unwrapExpression(left);
  if (!ts.isObjectLiteralExpression(expression)) return [];
  const names: string[] = [];
  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property)) {
      const propertyName = staticPropertyName(property.name);
      const targetName = assignmentTargetName(property.initializer);
      if (propertyName && DYNAMIC_CODE_NAMES.has(propertyName) && targetName) names.push(targetName);
    } else if (ts.isShorthandPropertyAssignment(property) && DYNAMIC_CODE_NAMES.has(property.name.text)) {
      names.push(property.name.text);
    }
  }
  return names;
}

type DynamicCodeAnalysis = { aliases: Set<string>; globalAliases: Set<string> };

function collectDynamicCodeAliases(source: ts.SourceFile): DynamicCodeAnalysis {
  const aliases = new Set(DYNAMIC_CODE_NAMES);
  const globalAliases = new Set(GLOBAL_OBJECT_NAMES);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) {
        if (ts.isIdentifier(node.name) && isDynamicCodeReference(node.initializer, aliases) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
        if (ts.isIdentifier(node.name) && isGlobalObjectReference(node.initializer, globalAliases) && !globalAliases.has(node.name.text)) {
          globalAliases.add(node.name.text);
          changed = true;
        }
        if (ts.isObjectBindingPattern(node.name) && isGlobalObjectReference(node.initializer, globalAliases)) {
          for (const element of node.name.elements) {
            if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
            const propertyText = staticPropertyName(element.propertyName) ?? (element.propertyName ? undefined : element.name.text);
            if (propertyText !== undefined && DYNAMIC_CODE_NAMES.has(propertyText) && !aliases.has(element.name.text)) {
              aliases.add(element.name.text);
              changed = true;
            }
          }
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && isDynamicCodeReference(node.right, aliases) &&
        !aliases.has(node.left.text)) {
        aliases.add(node.left.text);
        changed = true;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left) && isGlobalObjectReference(node.right, globalAliases) &&
          !globalAliases.has(node.left.text)) {
          globalAliases.add(node.left.text);
          changed = true;
        }
        for (const name of dynamicCodeAssignmentNames(node.left, node.right, globalAliases)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { aliases, globalAliases };
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
  const importMetaAliases = collectImportMetaAliases(source);
  const requireAliases = collectRequireAliases(source, importMetaAliases);
  const dynamicCodeAnalysis = collectDynamicCodeAliases(source);
  const dynamicCodeAliases = dynamicCodeAnalysis.aliases;
  const globalObjectAliases = dynamicCodeAnalysis.globalAliases;
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && hasUnverifiableImportMetaBinding(node.name, node.initializer, importMetaAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && hasUnverifiableGlobalBinding(node.name, node.initializer, globalObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasUnverifiableImportMetaAssignment(node.left, node.right, importMetaAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasUnverifiableGlobalAssignment(node.left, node.right, globalObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isPropertyAccessExpression(node) &&
      (isImportMetaRequire(node, importMetaAliases) || isDynamicCodeReference(node, dynamicCodeAliases)) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
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
      const isRequire = isRequireExpression(expression, requireAliases, importMetaAliases) || isRequireBindCall(expression, requireAliases, importMetaAliases);
      if (isDynamicCodeReference(expression, dynamicCodeAliases)) {
        hasUnverifiableDynamicImport = true;
      }
      if (isRequireMethodCall(expression, requireAliases, importMetaAliases)) {
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
    } else if (ts.isNewExpression(node) && isDynamicCodeReference(node.expression, dynamicCodeAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isElementAccessExpression(node) && isImportMetaReference(node.expression, importMetaAliases)) {
      const isRequireProperty = !!node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "require";
      const isDirectCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!node.argumentExpression || !ts.isStringLiteralLike(node.argumentExpression) || (isRequireProperty && !isDirectCall)) {
        hasUnverifiableDynamicImport = true;
      }
    } else if (ts.isElementAccessExpression(node) && isUnknownGlobalPropertyAccess(node, globalObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isElementAccessExpression(node) && isDynamicCodeReference(node, dynamicCodeAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isIdentifier(node) && (node.text === "require" || dynamicCodeAliases.has(node.text)) && !isRequirePropertyName(node)) {
      hasUnverifiableDynamicImport = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, hasUnverifiableDynamicImport };
}

type ImportCandidateResolver = (file: string, specifier: string) => string[];

function checkImportSpecifier(
  repoRoot: string,
  path: string,
  relative: string,
  specifier: string,
  findings: string[],
  onResolved?: (path: string) => void,
  candidatesForSpecifier: ImportCandidateResolver = importCandidates,
): void {
  if (EXECUTABLE_MODULE_URL.test(specifier)) {
    findings.push(`${relative}: executable module URL cannot be verified`);
    return;
  }
  if (RELATIVE_SPECIFIER.test(specifier)) {
    const candidates = candidatesForSpecifier(path, specifier);
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
    const existing = resolveExistingFile(candidatesForSpecifier(path, absolute));
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
  type PendingTool = { path: string; pythonSearchRoot: string };
  const pending: PendingTool[] = collected.files.map((path) => ({ path, pythonSearchRoot: dirname(path) }));
  const scanned = new Set<string>();
  const enqueue = (dependency: string, pythonSearchRoot: string = dirname(dependency)): void => {
    const dependencyKey = `${resolve(dependency)}\0${resolve(pythonSearchRoot)}`;
    if (!scanned.has(dependencyKey) && !pending.some((candidate) => `${resolve(candidate.path)}\0${resolve(candidate.pythonSearchRoot)}` === dependencyKey)) {
      pending.push({ path: dependency, pythonSearchRoot });
    }
  };
  while (pending.length > 0) {
    const item = pending.shift();
    if (!item) continue;
    const { path, pythonSearchRoot } = item;
    const key = `${resolve(path)}\0${resolve(pythonSearchRoot)}`;
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
        const pythonContent = maskPythonNonCode(content);
        const checkPythonSpecifier = (specifier: string): void => {
          checkImportSpecifier(repoRoot, path, relative, specifier, findings, (resolved) => {
            enqueue(resolved, pythonSearchRoot);
            for (const initializer of pythonPackageInitializers(repoRoot, path, specifier)) enqueue(initializer, pythonSearchRoot);
          }, pythonImportCandidates);
        };
        const enqueuePythonInitializers = (specifier: string): void => {
          for (const initializer of pythonPackageInitializers(repoRoot, path, specifier)) enqueue(initializer, pythonSearchRoot);
        };
        const pythonReferenceExists = (specifier: string): boolean => {
          return Boolean(resolveExistingFile(pythonImportCandidates(path, specifier)) || pythonNamespaceDirectory(repoRoot, path, specifier));
        };
        const checkPythonReference = (specifier: string): boolean => {
          if (resolveExistingFile(pythonImportCandidates(path, specifier))) {
            checkPythonSpecifier(specifier);
            return true;
          }
          if (pythonNamespaceDirectory(repoRoot, path, specifier)) {
            enqueuePythonInitializers(specifier);
            return true;
          }
          return false;
        };
        const scanPythonWildcard = (packageSpecifier: string, initializer: string | undefined): void => {
          if (!initializer) return;
          const names = pythonInitializerAllNames(initializer);
          if (names === null) {
            findings.push(`${relative}: wildcard Python import cannot be verified`);
            return;
          }
          for (const name of names ?? []) {
            const specifier = `${packageSpecifier}/${name}`;
            if (pythonReferenceExists(specifier)) checkPythonReference(specifier);
          }
        };
        for (const match of pythonContent.matchAll(PYTHON_RELATIVE_IMPORT)) {
          const moduleSpecifier = match[1];
          const importedNames = match[2];
          if (moduleSpecifier && importedNames) {
            const specifiers = pythonRelativeSpecifiers(moduleSpecifier, importedNames);
            const moduleName = moduleSpecifier.replace(/^\.+/, "");
            const moduleSpecifierPath = moduleName ? specifiers[0] : undefined;
            const names = pythonImportedNames(importedNames);
            const initializer = join(pythonRelativeBaseDirectory(path, moduleSpecifier), "__init__.py");
            const moduleInitializer = moduleSpecifierPath ? pythonModuleInitializer(path, moduleSpecifierPath) : undefined;
            const moduleNamespace = moduleSpecifierPath ? pythonNamespaceDirectory(repoRoot, path, moduleSpecifierPath) : undefined;
            if (!moduleName) enqueuePythonInitializers(pythonPackageInitializerSpecifier(moduleSpecifier));
            for (const [index, specifier] of specifiers.entries()) {
              if (!moduleName && names[index] === "*") continue;
              if (checkPythonReference(specifier)) continue;
              if (specifier === moduleSpecifierPath) {
                checkPythonSpecifier(specifier);
              } else if (!moduleName && names[index] &&
                (!isDirectRegularFile(initializer) || !pythonInitializerExportsName(initializer, names[index]))) {
                checkPythonSpecifier(specifier);
              } else if (moduleName && names[index - 1] && names[index - 1] !== "*" &&
                ((moduleNamespace && !moduleInitializer) || (moduleInitializer && !pythonInitializerExportsName(moduleInitializer, names[index - 1])))) {
                checkPythonSpecifier(specifier);
              }
            }
            if (names.includes("*")) {
              if (!moduleName) checkPythonSpecifier(pythonPackageInitializerSpecifier(moduleSpecifier));
              const packageSpecifier = moduleSpecifierPath ?? (pythonRelativeSpecifier(path, pythonRelativeBaseDirectory(path, moduleSpecifier)).replace(/\/$/, "") || ".");
              scanPythonWildcard(packageSpecifier, moduleInitializer ?? (isDirectRegularFile(initializer) ? initializer : undefined));
            }
          }
        }
        for (const match of pythonContent.matchAll(PYTHON_FROM_IMPORT)) {
          const moduleName = match[1];
          const importedNames = match[2];
          if (moduleName && importedNames) {
            const modulePath = moduleName.replaceAll(".", "/");
            const moduleSpecifier = pythonSearchSpecifier(path, pythonSearchRoot, modulePath);
            const topSpecifier = pythonSearchSpecifier(path, pythonSearchRoot, modulePath.split("/")[0] ?? modulePath);
            if (!pythonReferenceExists(topSpecifier)) continue;
            const names = pythonImportedNames(importedNames);
            const moduleInitializer = pythonModuleInitializer(path, moduleSpecifier);
            const moduleNamespace = pythonNamespaceDirectory(repoRoot, path, moduleSpecifier);
            if (!checkPythonReference(moduleSpecifier)) {
              checkPythonSpecifier(moduleSpecifier);
              continue;
            }
            for (const name of names) {
              if (name === "*") continue;
              const specifier = `${moduleSpecifier}/${name}`;
              if (checkPythonReference(specifier)) continue;
              if ((moduleInitializer && !pythonInitializerExportsName(moduleInitializer, name)) || (moduleNamespace && !moduleInitializer)) {
                checkPythonSpecifier(specifier);
              }
            }
            if (names.includes("*")) {
              scanPythonWildcard(moduleSpecifier, moduleInitializer);
            }
          }
        }
        for (const match of pythonContent.matchAll(PYTHON_LOCAL_IMPORT)) {
          const importedNames = match[1];
          if (importedNames) {
            for (const name of pythonImportedNames(importedNames)) {
              const moduleName = name.replaceAll(".", "/");
              const topSpecifier = pythonSearchSpecifier(path, pythonSearchRoot, moduleName.split("/")[0] ?? moduleName);
              if (!pythonReferenceExists(topSpecifier)) continue;
              const specifier = pythonSearchSpecifier(path, pythonSearchRoot, moduleName);
              if (!checkPythonReference(specifier)) checkPythonSpecifier(specifier);
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
