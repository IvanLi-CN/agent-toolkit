#!/usr/bin/env bun
/** Check root public tools for private runtime coupling and broken local imports. */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import { isDirectRegularFile, isPathInside, isRegularFile, REPO_ROOT, readText, relativePath, resolveExistingFile, walkFiles } from "./repo_util.ts";

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
const ABSOLUTE_IMPORT = new RegExp(String.raw`${IMPORT_PREFIX}["']((?:file:|/|\\|[A-Za-z]:[\\/])[^"']+)["']`, "gi");
const PYTHON_NAME = String.raw`[\p{ID_Start}_][\p{ID_Continue}]*`;
const PYTHON_IMPORT_GAP = String.raw`(?:[ \t\f\v\r\n]|\\[ \t]*(?:\r\n|\r|\n)|#[^\r\n]*(?:\r\n|\r|\n))*`;
const PYTHON_DOT_GAP = String.raw`(?:[ \t\f\v]|\\[ \t]*(?:\r\n|\r|\n)|#[^\r\n]*(?:\r\n|\r|\n))*`;
const PYTHON_DOTTED_NAME = String.raw`${PYTHON_NAME}(?:${PYTHON_DOT_GAP}\.${PYTHON_DOT_GAP}${PYTHON_NAME})*`;
const PYTHON_RELATIVE_MODULE = String.raw`\.+(?:${PYTHON_DOT_GAP}${PYTHON_NAME}(?:${PYTHON_DOT_GAP}\.${PYTHON_DOT_GAP}${PYTHON_NAME})*)?`;
const PYTHON_IMPORT_START = String.raw`(?:^[ \t\f\v]*|[;:][ \t\f\v]*)`;
const PYTHON_IMPORTED_NAME = String.raw`${PYTHON_NAME}(?:${PYTHON_IMPORT_GAP}\bas\b${PYTHON_IMPORT_GAP}${PYTHON_NAME})?`;
const PYTHON_IMPORTED_NAMES = String.raw`(?:${PYTHON_IMPORTED_NAME}|\*)(?:${PYTHON_IMPORT_GAP},${PYTHON_IMPORT_GAP}(?:${PYTHON_IMPORTED_NAME}|\*))*`;
const PYTHON_LOCAL_IMPORTED_NAME = String.raw`${PYTHON_DOTTED_NAME}(?:${PYTHON_IMPORT_GAP}\bas\b${PYTHON_IMPORT_GAP}${PYTHON_NAME})?`;
const PYTHON_LOCAL_IMPORT_NAMES = String.raw`${PYTHON_LOCAL_IMPORTED_NAME}(?:${PYTHON_IMPORT_GAP},${PYTHON_IMPORT_GAP}${PYTHON_LOCAL_IMPORTED_NAME})*`;
const PYTHON_RELATIVE_IMPORT = new RegExp(String.raw`${PYTHON_IMPORT_START}from\b${PYTHON_IMPORT_GAP}(${PYTHON_RELATIVE_MODULE})${PYTHON_IMPORT_GAP}import\b${PYTHON_IMPORT_GAP}\(?${PYTHON_IMPORT_GAP}(${PYTHON_IMPORTED_NAMES})${PYTHON_IMPORT_GAP},?${PYTHON_IMPORT_GAP}\)?`, "gmu");
const PYTHON_FROM_IMPORT = new RegExp(String.raw`${PYTHON_IMPORT_START}from\b${PYTHON_IMPORT_GAP}(${PYTHON_DOTTED_NAME})${PYTHON_IMPORT_GAP}import\b${PYTHON_IMPORT_GAP}\(?${PYTHON_IMPORT_GAP}(${PYTHON_IMPORTED_NAMES})${PYTHON_IMPORT_GAP},?${PYTHON_IMPORT_GAP}\)?`, "gmu");
const PYTHON_LOCAL_IMPORT = new RegExp(String.raw`${PYTHON_IMPORT_START}import\b${PYTHON_IMPORT_GAP}\(?${PYTHON_IMPORT_GAP}(${PYTHON_LOCAL_IMPORT_NAMES})${PYTHON_IMPORT_GAP},?${PYTHON_IMPORT_GAP}\)?`, "gmu");
const PYTHON_DYNAMIC_GAP = String.raw`(?:\s|\\[ \t]*(?:\r\n|\r|\n))*`;
const PYTHON_DYNAMIC_CALL = new RegExp(String.raw`(?<![\p{ID_Continue}.])(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}\(|(?<![\p{ID_Continue}])(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}\(`, "gu");
const PYTHON_DYNAMIC_WRAPPED_MEMBER_CALL = new RegExp(String.raw`\(\s*(?:\(\s*)*(${PYTHON_NAME})\s*\.\s*(import_module|__import__)\s*(?:\)\s*)+\(`, "gu");
const PYTHON_DYNAMIC_WRAPPED_CALL = new RegExp(String.raw`\(\s*(?:\(\s*)*(${PYTHON_NAME})\s*(?:\)\s*)+\(`, "gu");
const EXCLUDED_TEST_FILE = /(?:\.test\.(?:ts|tsx|mts|cts|js|jsx|cjs|mjs|py|sh)$|^test[-_].*\.(?:ts|tsx|mts|cts|js|jsx|cjs|mjs|py|sh)$|_test\.(?:ts|tsx|mts|cts|js|jsx|cjs|mjs|py|sh)$)/;
const PUBLIC_TOOL_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".cjs", ".mjs", ".py", ".sh"];
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".cts", ".ts", ".tsx"]);
const SCANNABLE_LOCAL_EXTENSIONS = new Set([...PUBLIC_TOOL_EXTENSIONS, ".json"]);
const NODE_MODULE_BUILTINS = new Set(["module", "node:module"]);
const RELATIVE_SPECIFIER = /^\.{1,2}[\\/]/;
const ABSOLUTE_SPECIFIER = /^(?:file:|\/|\\|[A-Za-z]:[\\/])/i;
const EXECUTABLE_MODULE_URL = /^(?:blob|data|javascript):/i;

type ShellToken = { kind: "word" | "operator" | "newline"; value: string; quoted?: boolean; unquotedLeadingTilde?: boolean; unquotedGlob?: boolean; dynamic?: boolean; commandSubstitutions?: string[] };

function shellCommandSubstitution(content: string, start: number): { body: string; end: number } | undefined {
  let depth = 1;
  let caseDepth = 0;
  let quote: "'" | '"' | undefined;
  let comment = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (comment) {
      if (character === "\n" || character === "\r") comment = false;
      continue;
    }
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if ((index === 0 || !/[A-Za-z0-9_]/.test(content[index - 1] ?? "")) && content.startsWith("case", index) && /[\s;(]/.test(content[index + 4] ?? "")) {
      caseDepth += 1;
      index += 3;
    } else if ((index === 0 || !/[A-Za-z0-9_]/.test(content[index - 1] ?? "")) && content.startsWith("esac", index) && /[\s;&|)}`]/.test(content[index + 4] ?? "")) {
      caseDepth = Math.max(0, caseDepth - 1);
      index += 3;
    } else if (character === "\\") {
      index += 1;
    } else if (character === "#" && (index === start || /\s|[;|&(){}]/.test(content[index - 1] ?? ""))) {
      comment = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      if (caseDepth > 0) continue;
      depth -= 1;
      if (depth === 0) return { body: content.slice(start, index), end: index };
    }
  }
  return undefined;
}

function shellBacktickSubstitution(content: string, start: number): { body: string; end: number } | undefined {
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === "\\") {
      index += 1;
    } else if (content[index] === "`") {
      return { body: content.slice(start, index), end: index };
    }
  }
  return undefined;
}

function shellCommandSubstitutions(content: string): string[] {
  const substitutions: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\\") {
      index += 1;
      continue;
    }
    if (content.startsWith("$(", index)) {
      const substitution = shellCommandSubstitution(content, index + 2);
      if (!substitution) {
        substitutions.push(content.slice(index + 2));
        break;
      }
      substitutions.push(substitution.body);
      index = substitution.end;
    } else if (content[index] === "`") {
      const substitution = shellBacktickSubstitution(content, index + 1);
      substitutions.push(substitution?.body ?? content.slice(index + 1));
      index = substitution?.end ?? content.length;
    }
  }
  return substitutions;
}

function shellAnsiCCharacter(content: string, index: number): { value: string; nextIndex: number; dynamic: boolean } {
  const escaped = content[index + 1];
  if (escaped === undefined) return { value: "", nextIndex: index + 1, dynamic: true };
  const simpleEscapes: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    e: "\u001b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\u000b",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  const simple = simpleEscapes[escaped];
  if (simple !== undefined) return { value: simple, nextIndex: index + 2, dynamic: false };
  const hex = content.slice(index + 1).match(/^x([0-9A-Fa-f]{1,2})/);
  if (hex?.[1]) return { value: String.fromCodePoint(Number.parseInt(hex[1], 16)), nextIndex: index + 2 + hex[1].length, dynamic: false };
  const unicode = content.slice(index + 1).match(/^u([0-9A-Fa-f]{4})|^U([0-9A-Fa-f]{8})/);
  if (unicode?.[1] || unicode?.[2]) {
    const codePoint = Number.parseInt(unicode[1] ?? unicode[2] ?? "", 16);
    if (Number.isInteger(codePoint) && codePoint <= 0x10ffff) {
      return { value: String.fromCodePoint(codePoint), nextIndex: index + 2 + (unicode[1] ?? unicode[2] ?? "").length, dynamic: false };
    }
  }
  const octal = content.slice(index + 1).match(/^([0-7]{1,3})/);
  if (octal?.[1]) return { value: String.fromCodePoint(Number.parseInt(octal[1], 8)), nextIndex: index + 1 + octal[0].length, dynamic: false };
  return { value: escaped, nextIndex: index + 2, dynamic: true };
}

function shellTokens(content: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; expand: boolean }> = [];
  let activeHeredoc: { delimiter: string; stripTabs: boolean; expand: boolean } | undefined;
  let activeHeredocBody = "";
  let expectingHeredocDelimiter = false;
  let heredocStripTabs = false;
  let arithmeticDepth = 0;
  let index = 0;
  while (index < content.length) {
    if (activeHeredoc) {
      const end = content.indexOf("\n", index);
      const line = content.slice(index, end < 0 ? content.length : end).replace(/\r$/, "");
      const comparable = activeHeredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (comparable === activeHeredoc.delimiter) {
        if (activeHeredoc.expand) {
          const substitutions = shellCommandSubstitutions(activeHeredocBody);
          if (substitutions.length > 0) tokens.push({ kind: "word", value: "", commandSubstitutions: substitutions });
        }
        activeHeredoc = pendingHeredocs.shift();
        activeHeredocBody = "";
      } else if (activeHeredoc.expand) {
        activeHeredocBody += `${line}\n`;
      }
      index = end < 0 ? content.length : end + 1;
      continue;
    }
    const character = content[index];
    if (character === "\n" || character === "\r") {
      tokens.push({ kind: "newline", value: character });
      if (character === "\n" && pendingHeredocs.length > 0) activeHeredoc = pendingHeredocs.shift();
      index += 1;
      continue;
    }
    if (/\s/.test(character ?? "")) {
      index += 1;
      continue;
    }
    if (character === "#") {
      const end = content.indexOf("\n", index);
      index = end < 0 ? content.length : end;
      continue;
    }
    if (content.startsWith("((", index)) {
      tokens.push({ kind: "operator", value: "(" }, { kind: "operator", value: "(" });
      arithmeticDepth += 1;
      index += 2;
      continue;
    }
    if (arithmeticDepth > 0 && content.startsWith("))", index)) {
      tokens.push({ kind: "operator", value: ")" }, { kind: "operator", value: ")" });
      arithmeticDepth -= 1;
      index += 2;
      continue;
    }
    if (arithmeticDepth === 0) {
      const hereString = content.slice(index).match(/^\d*<<</)?.[0];
      if (hereString) {
        tokens.push({ kind: "operator", value: "<<<" });
        index += hereString.length;
        continue;
      }
      const hereDocument = content.slice(index).match(/^\d*<<-?/)?.[0];
      if (hereDocument) {
        const value = hereDocument.endsWith("<<-") ? "<<-" : "<<";
        tokens.push({ kind: "operator", value });
        expectingHeredocDelimiter = true;
        heredocStripTabs = value === "<<-";
        index += hereDocument.length;
        continue;
      }
    }
    const redirection = content.slice(index).match(/^\d*(?:&>>|&>|>>|>&|<&|<>|>|<)/)?.[0];
    if (redirection) {
      tokens.push({ kind: "operator", value: redirection.replace(/^\d+/, "") });
      index += redirection.length;
      continue;
    }
    if ([";", "&", "|", "(", ")", "{", "}", "!"].includes(character ?? "")) {
      tokens.push({ kind: "operator", value: character ?? "" });
      index += 1;
      continue;
    }
    let value = "";
    let quoted = false;
    let unquotedLeadingTilde = false;
    let unquotedGlob = false;
    let dynamic = false;
    const commandSubstitutions: string[] = [];
    while (index < content.length) {
      const current = content[index];
      if (!current || /\s/.test(current) || [";", "&", "|", "(", ")", "{", "}", "<", ">"].includes(current)) break;
      if (current === "\\") {
        if (content[index + 1] === "\n") {
          index += 2;
          continue;
        }
        if (content[index + 1] === "\r") {
          index += content[index + 2] === "\n" ? 3 : 2;
          continue;
        }
        quoted = true;
        value += content[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (current === "$" && content[index + 1] === "'") {
        quoted = true;
        index += 2;
        while (index < content.length) {
          const quotedCharacter = content[index];
          if (quotedCharacter === "'") {
            index += 1;
            break;
          }
          if (quotedCharacter === "\\" && index + 1 < content.length) {
            const decoded = shellAnsiCCharacter(content, index);
            value += decoded.value;
            dynamic ||= decoded.dynamic;
            index = decoded.nextIndex;
          } else {
            value += quotedCharacter ?? "";
            index += 1;
          }
        }
        continue;
      }
      if (current === "`") {
        const substitution = shellBacktickSubstitution(content, index + 1);
        commandSubstitutions.push(substitution?.body ?? content.slice(index + 1));
        value += "``";
        index = substitution?.end === undefined ? content.length : substitution.end + 1;
        continue;
      }
      if (current === "$" && content[index + 1] === "(") {
        const substitution = shellCommandSubstitution(content, index + 2);
        if (!substitution) {
          commandSubstitutions.push(content.slice(index + 2));
          value += "$()";
          index = content.length;
        } else {
          commandSubstitutions.push(substitution.body);
          value += "$()";
          index = substitution.end + 1;
        }
        continue;
      }
      if (current === "$") {
        dynamic = true;
      }
      if (current === "~" && value.length === 0) {
        unquotedLeadingTilde = true;
      }
      if (["*", "?", "["].includes(current)) {
        unquotedGlob = true;
      }
      if (current === "'" || current === '"') {
        quoted = true;
        const quote = current;
        index += 1;
        while (index < content.length) {
          const quotedCharacter = content[index];
          if (quotedCharacter === quote) {
            index += 1;
            break;
          }
          if (quote === '"' && quotedCharacter === "\\") {
            if (content[index + 1] === "\n") {
              index += 2;
              continue;
            }
            if (content[index + 1] === "\r") {
              index += content[index + 2] === "\n" ? 3 : 2;
              continue;
            }
            const escaped = content[index + 1];
            if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") value += escaped;
            else value += `\\${escaped ?? ""}`;
            index += 2;
          } else if (quote === '"' && quotedCharacter === "$" && content[index + 1] === "(") {
            const substitution = shellCommandSubstitution(content, index + 2);
            if (!substitution) {
              commandSubstitutions.push(content.slice(index + 2));
              index = content.length;
            } else {
              commandSubstitutions.push(substitution.body);
              value += "$()";
              index = substitution.end + 1;
            }
          } else if (quote === '"' && quotedCharacter === "$") {
            dynamic = true;
            value += quotedCharacter;
            index += 1;
          } else if (quote === '"' && quotedCharacter === "`") {
            const substitution = shellBacktickSubstitution(content, index + 1);
            commandSubstitutions.push(substitution?.body ?? content.slice(index + 1));
            value += "``";
            index = substitution?.end === undefined ? content.length : substitution.end + 1;
          } else {
            value += quotedCharacter ?? "";
            index += 1;
          }
        }
        continue;
      }
      value += current;
      index += 1;
    }
    if (value.length > 0 || quoted) {
      tokens.push({ kind: "word", value, quoted, ...(unquotedLeadingTilde ? { unquotedLeadingTilde: true } : {}), ...(unquotedGlob ? { unquotedGlob: true } : {}), ...(dynamic ? { dynamic: true } : {}), ...(commandSubstitutions.length > 0 ? { commandSubstitutions } : {}) });
      if (expectingHeredocDelimiter) {
        pendingHeredocs.push({ delimiter: value, stripTabs: heredocStripTabs, expand: !quoted });
        expectingHeredocDelimiter = false;
      }
    } else {
      index += 1;
    }
  }
  if (activeHeredoc?.expand) {
    const substitutions = shellCommandSubstitutions(activeHeredocBody);
    if (substitutions.length > 0) tokens.push({ kind: "word", value: "", commandSubstitutions: substitutions });
  }
  return tokens;
}

type ShellSourceAnalysis = { specifiers: string[]; hasUnverifiableDynamicSource: boolean; hasWorkingDirectoryChanged: boolean };

function shellSourceAnalysis(content: string): ShellSourceAnalysis {
  const result: string[] = [];
  let hasUnverifiableDynamicSource = false;
  const tokens = shellTokens(content);
  const controlWords = new Set(["case", "do", "elif", "else", "for", "if", "then", "until", "while"]);
  const commandWrappers = new Set(["builtin", "command", "time"]);
  const redirectionOperators = new Set(["<<<", "<<-", "<<", "&>>", "&>", ">>", ">&", "<&", "<>", ">", "<"]);
  let commandStart = true;
  let sourceArgument = false;
  let wrapperPending = false;
  let redirectionArgument = false;
  let workingDirectoryChanged = false;
  let nestedWorkingDirectoryChanged = false;
  for (const token of tokens) {
    if (token.kind === "newline") {
      commandStart = true;
      sourceArgument = false;
      wrapperPending = false;
      redirectionArgument = false;
      continue;
    }
    if (token.kind === "operator") {
      if ([";", "&", "|", "(", ")", "{", "}"].includes(token.value)) {
        commandStart = true;
        sourceArgument = false;
        wrapperPending = false;
        redirectionArgument = false;
      } else if (token.value === "<" && sourceArgument) {
        hasUnverifiableDynamicSource = true;
        sourceArgument = false;
        commandStart = false;
      } else if (redirectionOperators.has(token.value)) {
        redirectionArgument = true;
      }
      continue;
    }
    for (const substitution of token.commandSubstitutions ?? []) {
      const nested = shellSourceAnalysis(substitution);
      result.push(...nested.specifiers);
      hasUnverifiableDynamicSource ||= nested.hasUnverifiableDynamicSource;
      nestedWorkingDirectoryChanged ||= nested.hasWorkingDirectoryChanged;
    }
    if (token.dynamic && sourceArgument) hasUnverifiableDynamicSource = true;
    if (token.value.length === 0 && (token.commandSubstitutions?.length ?? 0) > 0) continue;
    if (redirectionArgument) {
      redirectionArgument = false;
      continue;
    }
    if (sourceArgument) {
      if ((token.commandSubstitutions?.length ?? 0) > 0 || workingDirectoryChanged || token.dynamic || token.unquotedGlob || (token.value.startsWith("~") && token.unquotedLeadingTilde)) hasUnverifiableDynamicSource = true;
      else result.push(token.value);
      sourceArgument = false;
      commandStart = false;
      continue;
    }
    if (!commandStart) continue;
    if (wrapperPending && (token.value === "--" || token.value.startsWith("-"))) {
      if (token.value === "--") wrapperPending = false;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      commandStart = true;
    } else if (controlWords.has(token.value) || token.value === "!") {
      commandStart = true;
    } else if (commandWrappers.has(token.value)) {
      commandStart = true;
      wrapperPending = true;
    } else if (token.value === "cd" || token.value === "pushd" || token.value === "popd") {
      workingDirectoryChanged = true;
      commandStart = false;
      wrapperPending = false;
    } else if (token.value === "source" || token.value === ".") {
      sourceArgument = true;
      commandStart = false;
      wrapperPending = false;
    } else if (token.value === "eval") {
      hasUnverifiableDynamicSource = true;
      commandStart = false;
      wrapperPending = false;
    } else {
      commandStart = false;
      wrapperPending = false;
    }
  }
  return { specifiers: result, hasUnverifiableDynamicSource, hasWorkingDirectoryChanged: workingDirectoryChanged || nestedWorkingDirectoryChanged };
}

function shellSourceChangesWorkingDirectory(file: string, repoRoot: string, visited: Set<string> = new Set()): boolean {
  const key = resolve(file);
  if (visited.has(key)) return false;
  visited.add(key);
  if (!isPathInside(repoRoot, file) || !isDirectRegularFile(file)) return true;
  const analysis = shellSourceAnalysis(readText(file));
  if (analysis.hasWorkingDirectoryChanged) return true;
  for (const source of analysis.specifiers) {
    const candidates = shellImportCandidates(file, source, repoRoot);
    const existing = resolveExistingFile(candidates);
    if (!existing || !isPathInside(repoRoot, existing)) continue;
    if (shellSourceChangesWorkingDirectory(existing, repoRoot, visited)) return true;
  }
  return false;
}

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

function pythonFStringExpressionWithoutFormat(expression: string): string {
  let quote: "'" | '"' | undefined;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (["(", "[", "{"].includes(character ?? "")) {
      depth += 1;
    } else if ([")", "]", "}"].includes(character ?? "")) {
      depth = Math.max(0, depth - 1);
    } else if (character === ":" && depth === 0 && !/^\s*lambda\b/.test(expression)) {
      return expression.slice(0, index);
    }
  }
  return expression;
}

function pythonBraceExpressions(content: string): string[] {
  const expressions: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content.startsWith("{{", index) || content.startsWith("}}", index)) {
      index += 1;
      continue;
    }
    if (content[index] !== "{") continue;
    const start = index + 1;
    let depth = 1;
    let quote: "'" | '"' | undefined;
    let comment = false;
    let end = -1;
    for (index = start; index < content.length; index += 1) {
      const character = content[index];
      if (comment) {
        if (character === "\n" || character === "\r") comment = false;
        continue;
      }
      if (quote) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === '"') quote = character;
      else if (character === "#") comment = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) break;
    const expression = content.slice(start, end);
    const code = pythonFStringExpressionWithoutFormat(expression);
    expressions.push(code);
    if (code.length < expression.length) expressions.push(...pythonBraceExpressions(expression.slice(code.length + 1)));
    expressions.push(...pythonFStringExpressions(code));
  }
  return expressions;
}

function pythonFStringExpressions(content: string): string[] {
  const expressions: string[] = [];
  const codeMask = maskPythonNonCode(content);
  const prefixPattern = /(?:^|[^A-Za-z0-9_])(?:[fF][rR]?|[rR][fF])("""|'''|"|')/g;
  for (const match of content.matchAll(prefixPattern)) {
    const quote = match[1];
    if (!quote) continue;
    const quoteStart = (match.index ?? 0) + match[0].length - quote.length;
    const prefix = content.slice(Math.max(0, quoteStart - 2), quoteStart).match(/[fFrR]{1,2}$/)?.[0];
    if (!prefix || codeMask.slice(quoteStart - prefix.length, quoteStart) !== prefix) continue;
    const triple = quote.length === 3;
    let index = quoteStart + quote.length;
    while (index < content.length) {
      if (triple && content.startsWith(quote, index)) break;
      if (!triple && content[index] === quote) break;
      if (content[index] === "\\") {
        index += content[index + 1] === "{" ? 1 : 2;
        continue;
      }
      if (content.startsWith("{{", index) || content.startsWith("}}", index)) {
        index += 2;
        continue;
      }
      if (content[index] !== "{") {
        index += 1;
        continue;
      }
      const expressionStart = index + 1;
      let depth = 1;
      let expressionQuote: "'" | '"' | undefined;
      let expressionComment = false;
      let expressionEnd = -1;
      for (index = expressionStart; index < content.length; index += 1) {
        const character = content[index];
        if (expressionComment) {
          if (character === "\n" || character === "\r") expressionComment = false;
          continue;
        }
        if (expressionQuote) {
          if (character === "\\") {
            index += 1;
          } else if (character === expressionQuote) {
            expressionQuote = undefined;
          }
          continue;
        }
        if (character === "'" || character === '"') {
          expressionQuote = character;
        } else if (character === "#") {
          expressionComment = true;
        } else if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            expressionEnd = index;
            break;
          }
        }
      }
      if (expressionEnd < 0) break;
      const expression = content.slice(expressionStart, expressionEnd);
      const code = pythonFStringExpressionWithoutFormat(expression);
      expressions.push(code);
      if (code.length < expression.length) expressions.push(...pythonBraceExpressions(expression.slice(code.length + 1)));
      expressions.push(...pythonFStringExpressions(code));
      index = expressionEnd + 1;
    }
  }
  return expressions;
}

function pythonCallArguments(content: string): string[] {
  const argumentsList: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (["(", "[", "{"].includes(character ?? "")) {
      depth += 1;
    } else if ([")", "]", "}"].includes(character ?? "")) {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      argumentsList.push(content.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (content.slice(start).trim().length > 0) argumentsList.push(content.slice(start).trim());
  return argumentsList;
}

function pythonStaticFromlist(value: string): string[] | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "None") return [];
  const scalar = pythonStaticStringSequence(trimmed);
  if (scalar) return scalar;
  if (!((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("(") && trimmed.endsWith(")")))) return null;
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) return [];
  return pythonStaticStringSequence(body);
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
    let executable = false;
    try {
      executable = (lstatSync(path).mode & 0o111) !== 0;
    } catch {
      // The walk already filtered to direct files; a concurrent removal is handled as absent.
    }
    return (PUBLIC_TOOL_EXTENSIONS.some((extension) => name.endsWith(extension)) || executable) &&
      (name === "test_runner.ts" || !EXCLUDED_TEST_FILE.test(name));
  });
  return { files, rejectedSymlinks: rejectedSymlinks.sort() };
}

export function publicToolFiles(repoRoot: string = REPO_ROOT): string[] {
  return collectPublicToolFiles(repoRoot).files;
}

function moduleSpecifierPath(file: string, specifier: string, specifierIsFilePath = false): string {
  if (specifierIsFilePath) {
    const normalized = specifier.replaceAll("\\", "/");
    return RELATIVE_SPECIFIER.test(normalized) ? resolve(dirname(file), normalized) : resolve(normalized);
  }
  if (/^(?:[A-Za-z]:[\\/]|\\)/.test(specifier)) {
    return resolve(specifier.replaceAll("\\", "/"));
  }
  const moduleUrl = new URL(specifier.replaceAll("\\", "/"), pathToFileURL(file).href);
  if (moduleUrl.protocol !== "file:") throw new Error(`unsupported module URL: ${specifier}`);
  return fileURLToPath(moduleUrl);
}

function importCandidates(file: string, specifier: string, repoRoot?: string, specifierIsFilePath = false): string[] {
  let absolute: string;
  try {
    absolute = moduleSpecifierPath(file, specifier, specifierIsFilePath);
  } catch {
    return [];
  }
  if (repoRoot && !isInside(repoRoot, absolute)) return [absolute];
  const extension = extname(absolute).toLowerCase();
  if (extension.length > 0) {
    if (extension === ".js") return [absolute, `${absolute.slice(0, -extension.length)}.tsx`, `${absolute.slice(0, -extension.length)}.jsx`, `${absolute.slice(0, -extension.length)}.ts`];
    if (extension === ".jsx") return [absolute, `${absolute.slice(0, -extension.length)}.tsx`, `${absolute.slice(0, -extension.length)}.ts`];
    if (extension === ".mjs") return [absolute, `${absolute.slice(0, -extension.length)}.mts`];
    return [absolute];
  }
  const candidates = moduleFileCandidates(absolute);
  candidates.push(...packageMainCandidates(absolute, repoRoot));
  candidates.push(...moduleFileCandidates(join(absolute, "index")));
  return [...new Set(candidates)];
}

function moduleFileCandidates(base: string): string[] {
  return [base, base + ".tsx", base + ".jsx", base + ".mts", base + ".ts", base + ".mjs", base + ".js", base + ".cts", base + ".cjs", base + ".json"];
}

function stripJsonComments(content: string): string {
  const characters = content.split("");
  let quote: "'" | '"' | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      else characters[index] = " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
        blockComment = false;
      } else if (character !== "\n" && character !== "\r") {
        characters[index] = " ";
      }
      continue;
    }
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "/" && next === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      lineComment = true;
    } else if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      blockComment = true;
    }
  }
  const withoutComments = characters.join("");
  const normalized = withoutComments.split("");
  quote = undefined;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"') {
      quote = character;
    } else if (character === ",") {
      let next = index + 1;
      while (/\s/.test(withoutComments[next] ?? "")) next += 1;
      if (withoutComments[next] === "}" || withoutComments[next] === "]") normalized[index] = " ";
    }
  }
  return normalized.join("");
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(stripJsonComments(readText(path))) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function packageMainCandidates(directory: string, repoRoot?: string): string[] {
  if (repoRoot && !isInside(repoRoot, directory)) return [];
  const packageFile = join(directory, "package.json");
  if (!isRegularFile(packageFile)) return [];
  if (repoRoot) {
    try {
      const realPackageFile = realpathSync(packageFile);
      if (!isInside(repoRoot, realPackageFile)) return [realPackageFile];
    } catch {
      return [];
    }
  }
  try {
    const packageJson = readJsonObject(packageFile) as { main?: unknown } | undefined;
    if (typeof packageJson?.main !== "string") return [];
    const mainTarget = resolve(directory, packageJson.main);
    return [
      ...moduleFileCandidates(mainTarget),
      ...moduleFileCandidates(join(mainTarget, "index")),
    ];
  } catch {
    return [];
  }
}

function packageImportValues(value: unknown, replacement: string): string[] {
  if (typeof value === "string") return [value.replaceAll("*", replacement)];
  if (Array.isArray(value)) {
    return value.flatMap((item) => packageImportValues(item, replacement));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => packageImportValues(item, replacement));
  }
  return [];
}

type PackageImportResolution = { found: boolean; invalid: boolean; targets: string[]; externalTargets: string[] };

function packageImportTargets(repoRoot: string, file: string, specifier: string): PackageImportResolution {
  if (!specifier.startsWith("#")) return { found: false, invalid: false, targets: [], externalTargets: [] };
  let directory = dirname(file);
  while (isPathInside(repoRoot, directory)) {
    const packageFile = join(directory, "package.json");
    if (isRegularFile(packageFile)) {
      try {
        const realPackageFile = realpathSync(packageFile);
        if (!isInside(repoRoot, realPackageFile)) return { found: true, invalid: true, targets: [], externalTargets: [] };
        const packageJson = JSON.parse(readText(packageFile)) as { imports?: unknown };
        if (packageJson.imports === null || typeof packageJson.imports !== "object") return { found: false, invalid: false, targets: [], externalTargets: [] };
        const imports = packageJson.imports as Record<string, unknown>;
        let selected: Array<{ value: unknown; replacement: string }> | undefined;
        if (Object.prototype.hasOwnProperty.call(imports, specifier)) {
          selected = [{ value: imports[specifier], replacement: "" }];
        } else {
          const wildcard = Object.entries(imports)
          .filter(([key]) => key.includes("*"))
          .map(([key, value]) => {
            const wildcardIndex = key.indexOf("*");
            const prefix = key.slice(0, wildcardIndex);
            const suffix = key.slice(wildcardIndex + 1);
            return specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length
              ? { key, value, replacement: specifier.slice(prefix.length, specifier.length - suffix.length) }
              : undefined;
          })
          .filter((item): item is { key: string; value: unknown; replacement: string } => item !== undefined)
          .sort((left, right) => {
            const leftPrefixLength = left.key.indexOf("*");
            const rightPrefixLength = right.key.indexOf("*");
            return rightPrefixLength - leftPrefixLength || right.key.length - left.key.length;
          })[0];
          selected = wildcard ? [{ value: wildcard.value, replacement: wildcard.replacement }] : undefined;
        }
        if (!selected) return { found: false, invalid: false, targets: [], externalTargets: [] };
        const targets = selected.flatMap(({ value, replacement }) => packageImportValues(value, replacement));
        let invalid = targets.length === 0;
        const localTargets: string[] = [];
        const externalTargets: string[] = [];
        for (const target of targets) {
          if (target.startsWith("./")) {
            try {
              localTargets.push(resolve(directory, decodeURIComponent(target)));
            } catch {
              invalid = true;
            }
          } else if (target.startsWith(".") || ABSOLUTE_SPECIFIER.test(target) || EXECUTABLE_MODULE_URL.test(target)) {
            invalid = true;
          } else {
            externalTargets.push(target);
          }
        }
        return { found: true, invalid, targets: localTargets, externalTargets };
      } catch {
        return { found: true, invalid: true, targets: [], externalTargets: [] };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { found: false, invalid: false, targets: [], externalTargets: [] };
}

function packageManifest(repoRoot: string, file: string): { directory: string; packageJson: Record<string, unknown>; invalid?: boolean } | undefined {
  let directory = dirname(file);
  while (isPathInside(repoRoot, directory)) {
    const packageFile = join(directory, "package.json");
    if (isRegularFile(packageFile)) {
      try {
        const realPackageFile = realpathSync(packageFile);
        if (!isInside(repoRoot, realPackageFile)) return { directory, packageJson: {}, invalid: true };
        return { directory, packageJson: JSON.parse(readText(packageFile)) as Record<string, unknown> };
      } catch {
        return { directory, packageJson: {}, invalid: true };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function packageTargetsFromValues(directory: string, values: unknown[], replacement: string, allowExternal = true): PackageImportResolution {
  const targets = values.flatMap((value) => packageImportValues(value, replacement));
  let invalid = targets.length === 0;
  const localTargets: string[] = [];
  const externalTargets: string[] = [];
  for (const target of targets) {
    if (target.startsWith("./")) {
      try {
        localTargets.push(resolve(directory, decodeURIComponent(target)));
      } catch {
        invalid = true;
      }
    } else if (target.startsWith(".") || ABSOLUTE_SPECIFIER.test(target) || EXECUTABLE_MODULE_URL.test(target)) {
      invalid = true;
    } else if (allowExternal) {
      externalTargets.push(target);
    } else {
      invalid = true;
    }
  }
  return { found: true, invalid, targets: localTargets, externalTargets };
}

function tsconfigTargetsFromValues(repoRoot: string, directory: string, values: unknown[], replacement: string): PackageImportResolution {
  const targets = values.flatMap((value) => packageImportValues(value, replacement));
  let invalid = targets.length === 0;
  const localTargets: string[] = [];
  for (const target of targets) {
    if (ABSOLUTE_SPECIFIER.test(target) || EXECUTABLE_MODULE_URL.test(target)) {
      invalid = true;
      continue;
    }
    try {
      const resolvedTarget = resolve(directory, decodeURIComponent(target));
      if (!isPathInside(repoRoot, resolvedTarget)) invalid = true;
      localTargets.push(resolvedTarget);
    } catch {
      invalid = true;
    }
  }
  return { found: true, invalid, targets: localTargets, externalTargets: [] };
}

function packageSelfImportTargets(repoRoot: string, file: string, specifier: string): PackageImportResolution {
  const manifest = packageManifest(repoRoot, file);
  if (manifest?.invalid) return { found: true, invalid: true, targets: [], externalTargets: [] };
  const packageName = typeof manifest?.packageJson.name === "string" ? manifest.packageJson.name : undefined;
  if (!manifest || !packageName || (specifier !== packageName && !specifier.startsWith(`${packageName}/`))) {
    return { found: false, invalid: false, targets: [], externalTargets: [] };
  }
  const subpath = specifier === packageName ? "." : `./${specifier.slice(packageName.length + 1)}`;
  const exportsValue = manifest.packageJson.exports;
  if (exportsValue === undefined) return { found: true, invalid: false, targets: [resolve(manifest.directory, subpath)], externalTargets: [] };
  let selected: unknown[] | undefined;
  if (typeof exportsValue === "object" && exportsValue !== null && !Array.isArray(exportsValue)) {
    const exportsObject = exportsValue as Record<string, unknown>;
    const hasSubpathKeys = Object.keys(exportsObject).some((key) => key.startsWith("."));
    if (hasSubpathKeys) {
      if (Object.prototype.hasOwnProperty.call(exportsObject, subpath)) {
        selected = [exportsObject[subpath]];
      } else {
        const wildcard = Object.entries(exportsObject)
          .filter(([key]) => key.includes("*") && key.startsWith("."))
          .map(([key, value]) => {
            const wildcardIndex = key.indexOf("*");
            const prefix = key.slice(0, wildcardIndex);
            const suffix = key.slice(wildcardIndex + 1);
            return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length
              ? { key, value, replacement: subpath.slice(prefix.length, subpath.length - suffix.length) }
              : undefined;
          })
          .filter((item): item is { key: string; value: unknown; replacement: string } => item !== undefined)
          .sort((left, right) => right.key.indexOf("*") - left.key.indexOf("*") || right.key.length - left.key.length)[0];
        if (wildcard) return packageTargetsFromValues(manifest.directory, [wildcard.value], wildcard.replacement, false);
      }
    } else {
      if (subpath !== ".") return { found: true, invalid: true, targets: [], externalTargets: [] };
      selected = [exportsValue];
    }
  } else {
    if (subpath !== ".") return { found: true, invalid: true, targets: [], externalTargets: [] };
    selected = [exportsValue];
  }
  return packageTargetsFromValues(manifest.directory, selected ?? [], "", false);
}

type TsconfigLayer = { directory: string; compilerOptions: Record<string, unknown> };

function tsconfigLayers(repoRoot: string, configFile: string, visited: Set<string> = new Set()): { layers: TsconfigLayer[]; invalid: boolean } {
  if (!isPathInside(repoRoot, configFile) || !isRegularFile(configFile)) return { layers: [], invalid: true };
  let realConfigFile: string;
  try {
    realConfigFile = realpathSync(configFile);
    if (!isInside(repoRoot, realConfigFile)) return { layers: [], invalid: true };
  } catch {
    return { layers: [], invalid: true };
  }
  if (visited.has(realConfigFile)) return { layers: [], invalid: true };
  visited.add(realConfigFile);
  const config = readJsonObject(configFile);
  if (!config) return { layers: [], invalid: true };
  const compilerOptions = config.compilerOptions !== null && typeof config.compilerOptions === "object" && !Array.isArray(config.compilerOptions)
    ? config.compilerOptions as Record<string, unknown>
    : {};
  const layers: TsconfigLayer[] = [{ directory: dirname(configFile), compilerOptions }];
  let invalid = false;
  if (config.extends !== undefined) {
    if (typeof config.extends !== "string") return { layers, invalid: true };
    const extendsValue = config.extends;
    if (RELATIVE_SPECIFIER.test(extendsValue) || ABSOLUTE_SPECIFIER.test(extendsValue)) {
      const extendedBase = resolve(dirname(configFile), extendsValue);
      const candidates = [
        extendedBase,
        extendedBase.endsWith(".json") ? extendedBase : `${extendedBase}.json`,
        join(extendedBase, "tsconfig.json"),
        join(extendedBase, "jsconfig.json"),
      ];
      const extendedConfig = candidates.find((candidate) => isPathInside(repoRoot, candidate) && isRegularFile(candidate));
      if (!extendedConfig) {
        invalid = true;
      } else {
        const parent = tsconfigLayers(repoRoot, extendedConfig, visited);
        layers.push(...parent.layers);
        invalid ||= parent.invalid;
      }
    } else {
      invalid = true;
    }
  }
  return { layers, invalid };
}

function tsconfigPathMatch(paths: Record<string, unknown>, specifier: string): { value: unknown; replacement: string } | undefined {
  if (Object.prototype.hasOwnProperty.call(paths, specifier)) return { value: paths[specifier], replacement: "" };
  return Object.entries(paths)
    .filter(([key]) => key.includes("*"))
    .map(([key, value]) => {
      const wildcardIndex = key.indexOf("*");
      const prefix = key.slice(0, wildcardIndex);
      const suffix = key.slice(wildcardIndex + 1);
      return specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length
        ? { key, value, replacement: specifier.slice(prefix.length, specifier.length - suffix.length) }
        : undefined;
    })
    .filter((item): item is { key: string; value: unknown; replacement: string } => item !== undefined)
    .sort((left, right) => {
      const leftPrefix = left.key.slice(0, left.key.indexOf("*")).length;
      const rightPrefix = right.key.slice(0, right.key.indexOf("*")).length;
      const leftSuffix = left.key.length - left.key.indexOf("*") - 1;
      const rightSuffix = right.key.length - right.key.indexOf("*") - 1;
      return rightPrefix - leftPrefix || rightSuffix - leftSuffix || right.key.length - left.key.length;
    })[0];
}

function tsconfigPathTargets(repoRoot: string, file: string, specifier: string): PackageImportResolution {
  let directory = dirname(file);
  while (isPathInside(repoRoot, directory)) {
    const configFiles = ["tsconfig.json", "jsconfig.json"]
      .map((name) => join(directory, name))
      .filter((configFile) => isRegularFile(configFile));
    if (configFiles.length > 0) {
      let invalid = false;
      let found = false;
      const targets: string[] = [];
      const externalTargets: string[] = [];
      for (const configFile of configFiles) {
        const resolved = tsconfigLayers(repoRoot, configFile);
        invalid ||= resolved.invalid;
        const baseUrlLayer = resolved.layers.find((layer) => typeof layer.compilerOptions.baseUrl === "string");
        const baseDirectory = baseUrlLayer ? resolve(baseUrlLayer.directory, baseUrlLayer.compilerOptions.baseUrl as string) : undefined;
        const pathLayer = resolved.layers.find((layer) => Object.prototype.hasOwnProperty.call(layer.compilerOptions, "paths"));
        let matchedPath = false;
        if (pathLayer) {
          const paths = pathLayer.compilerOptions.paths;
          if (paths !== null && typeof paths === "object" && !Array.isArray(paths)) {
            const match = tsconfigPathMatch(paths as Record<string, unknown>, specifier);
            if (match) {
              const pathBaseDirectory = baseDirectory ?? pathLayer.directory;
              const values = packageImportValues(match.value, match.replacement);
              const result = tsconfigTargetsFromValues(repoRoot, pathBaseDirectory, values, "");
              found = true;
              invalid ||= result.invalid;
              targets.push(...result.targets);
              externalTargets.push(...result.externalTargets);
              matchedPath = true;
            }
          } else {
            invalid = true;
          }
        }
        if (!matchedPath && baseDirectory) {
          const baseTarget = resolve(baseDirectory, specifier);
          if (resolveExistingFile(importCandidates(file, baseTarget, repoRoot, true)) || isRegularFile(baseTarget) || isPathInside(repoRoot, baseTarget) && isRegularFile(join(baseTarget, "package.json"))) {
            found = true;
            targets.push(baseTarget);
          }
        }
      }
      if (found || invalid) {
        return { found: found || invalid, invalid, targets: [...new Set(targets)], externalTargets: [...new Set(externalTargets)] };
      }
      return { found: false, invalid: false, targets: [], externalTargets: [] };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { found: false, invalid: false, targets: [], externalTargets: [] };
}

function pythonImportCandidates(file: string, specifier: string): string[] {
  const absolute = resolve(dirname(file), specifier.replaceAll("\\", "/"));
  return [
    `${absolute}.py`,
    join(absolute, "__init__.py"),
  ];
}

function shellImportCandidates(file: string, specifier: string, repoRoot?: string): string[] {
  const normalized = specifier;
  const candidates: string[] = [];
  if (repoRoot && !normalized.startsWith("../")) candidates.push(resolve(repoRoot, normalized));
  if (repoRoot && normalized.startsWith("../")) {
    const cwdCandidate = resolve(process.cwd(), normalized);
    if (isRegularFile(cwdCandidate)) candidates.push(cwdCandidate);
  }
  candidates.push(resolve(dirname(file), normalized));
  return [...new Set(candidates)];
}

function pythonImportedNames(importedNames: string): string[] {
  return importedNames
    .replace(/\\[ \t]*(?:\r\n|\r|\n)/g, "")
    .replace(/#[^\r\n]*(?:\r\n|\r|\n|$)/g, "\n")
    .split(",")
    .map((name) => name.trim().split(/\s+as\s+/i)[0]?.trim().replace(/\s+/g, "") ?? "")
    .filter(Boolean);
}

function pythonImportedBindings(importedNames: string): Array<{ name: string; alias: string }> {
  return importedNames
    .replace(/\\[ \t]*(?:\r\n|\r|\n)/g, "")
    .replace(/#[^\r\n]*(?:\r\n|\r|\n|$)/g, "\n")
    .split(",")
    .map((item) => {
      const parts = item.trim().split(/\s+as\s+/i).map((part) => part.trim()).filter(Boolean);
      const name = (parts[0] ?? "").replace(/\s+/g, "");
      return { name, alias: (parts[1] ?? name).replace(/\s+/g, "") };
    })
    .filter((binding) => binding.name.length > 0 && binding.alias.length > 0);
}

function pythonNormalizeImportName(value: string): string {
  return value
    .replace(/\\[ \t]*(?:\r\n|\r|\n)/g, "")
    .replace(/#[^\r\n]*(?:\r\n|\r|\n|$)/g, "")
    .replace(/\s+/g, "");
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

function pythonModuleScopeCode(code: string): string {
  const lines = code.split(/(\r\n|\r|\n)/);
  const functionOrClassIndents: number[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const meaningful = line.trim().length > 0;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (meaningful) {
      while (functionOrClassIndents.at(-1) !== undefined && (functionOrClassIndents.at(-1) ?? 0) >= indent) functionOrClassIndents.pop();
    }
    const insideFunctionOrClass = functionOrClassIndents.length > 0;
    if (insideFunctionOrClass) lines[index] = line.replace(/[^\r\n]/g, " ");
    else if (/^(?:async[ \t]+)?(?:def|class)\b/.test(line.slice(indent))) functionOrClassIndents.push(indent);
  }
  return lines.join("");
}

function pythonDeterministicModuleCode(code: string): string {
  const lines = code.split(/(\r\n|\r|\n)/);
  const uncertainBlocks: number[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const meaningful = line.trim().length > 0;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (meaningful) {
      while (uncertainBlocks.at(-1) !== undefined && indent <= (uncertainBlocks.at(-1) ?? 0)) uncertainBlocks.pop();
      if (uncertainBlocks.length > 0) {
        lines[index] = line.replace(/[^\r\n]/g, " ");
        continue;
      }
    }
    const statement = line.slice(indent);
    const inlineColon = statement.indexOf(":");
    if (inlineColon >= 0 && /\S/.test(statement.slice(inlineColon + 1)) && /^(?:if|elif|else|for|while|with|try|except|finally|def|class|match|case)\b/.test(statement)) {
      const inlineBody = statement.slice(inlineColon + 1);
      const deterministicInline = /^if\s+(?:True|1)\s*:/.test(statement) ? inlineBody : inlineBody.replace(/[^\r\n]/g, " ");
      lines[index] = line.slice(0, indent + inlineColon + 1) + deterministicInline;
      continue;
    }
    if (/^if\b/.test(statement) && !/^if\s+(?:True|1)\s*:/.test(statement)) uncertainBlocks.push(indent);
    else if (/^(?:elif|else|try|except|finally|for|while|with|match|case)\b/.test(statement)) uncertainBlocks.push(indent);
  }
  return lines.join("");
}

function pythonUncertainNameChange(code: string, name: string): boolean {
  const masked = maskPythonNonCode(code);
  const deterministic = pythonDeterministicModuleCode(masked);
  const rawLines = masked.split(/\r\n|\r|\n/);
  const deterministicLines = deterministic.split(/\r\n|\r|\n/);
  const escapedName = escapeRegExp(name);
  const namePattern = new RegExp(String.raw`\b${escapedName}\b`, "gu");
  return rawLines.some((line, index) => {
    if (line.trim().length === 0) return false;
    const deterministicLine = deterministicLines[index] ?? "";
    return [...line.matchAll(namePattern)].some((match) => {
      const start = match.index ?? -1;
      return start >= 0 && deterministicLine.slice(start, start + name.length).trim().length === 0;
    });
  });
}

function pythonImportBindingIsLoader(line: string, name: string): boolean {
  const trimmed = line.trim();
  const fromMatch = trimmed.match(/^from[ \t]+([\p{ID_Start}_][\p{ID_Continue}_]*(?:[ \t]*\.[ \t]*[\p{ID_Start}_][\p{ID_Continue}_]*)*)[ \t]+import[ \t]+(.+)$/u);
  const importMatch = trimmed.match(/^import[ \t]+(.+)$/u);
  const moduleName = fromMatch?.[1]?.replace(/\s+/g, "") ?? "";
  const importedNames = fromMatch?.[2] ?? importMatch?.[1];
  if (!importedNames) return false;
  for (const binding of pythonImportedBindings(importedNames)) {
    const boundName = importMatch && binding.name.includes(".") && binding.name === binding.alias
      ? binding.name.split(".")[0]
      : binding.alias;
    if (boundName !== name) continue;
    if (importMatch) {
      return ["importlib", "builtins", "runpy"].includes(binding.name.split(".")[0] ?? "") || binding.name.startsWith("importlib.");
    }
    return (moduleName === "importlib" && ["import_module", "util", "machinery"].includes(binding.name)) ||
      (moduleName === "importlib.util" && ["spec_from_file_location", "module_from_spec"].includes(binding.name)) ||
      (moduleName === "importlib.machinery" && binding.name === "SourceFileLoader") ||
      (moduleName === "builtins" && binding.name === "__import__") ||
      (moduleName === "runpy" && ["run_path", "run_module"].includes(binding.name));
  }
  return false;
}

function pythonNameBoundInLine(line: string, name: string, knownLoaderNames: ReadonlySet<string>): boolean {
  const escapedName = escapeRegExp(name);
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (new RegExp(String.raw`^(?:async[ \t]+)?(?:def|class)[ \t]+${escapedName}(?![\p{ID_Continue}])`, "u").test(trimmed)) return true;
  if (/^(?:from\b[\s\S]*\bimport|import)\b/.test(trimmed)) {
    const importedNames = trimmed.replace(/^from\b[\s\S]*\bimport\s+|^import\s+/, "");
    for (const binding of pythonImportedBindings(importedNames)) {
      const boundName = trimmed.startsWith("import ") && binding.name.includes(".") && binding.name === binding.alias
        ? binding.name.split(".")[0]
        : binding.alias;
      if (boundName === name) return !pythonImportBindingIsLoader(trimmed, name);
    }
  }
  if (new RegExp(String.raw`^(?:async[ \t]+)?for[ \t]+(?:${escapedName}(?:[ \t]*,|[ \t]+in\b)|\([^\n]*\b${escapedName}\b[^\n]*\))[\s\S]*\bin\b`, "u").test(trimmed)) return true;
  if (new RegExp(String.raw`^(?:with|except)\b[\s\S]*\bas[ \t]+${escapedName}(?![\p{ID_Continue}])`, "u").test(trimmed)) return true;
  const assignment = trimmed.match(new RegExp(String.raw`^(?:\(?[ \t]*)${escapedName}(?![\p{ID_Continue}])[ \t]*(?::[^=\r\n]+)?(?:=|:=|\+=|-=|\*=|/=|//=|%=|&=|\|=|\^=|<<=|>>=)([\s\S]*)$`, "u"));
  if (!assignment) return false;
  const rightHandSideRoot = assignment[1]?.trim().replace(/^[ (]+/, "").match(new RegExp(String.raw`^(${PYTHON_NAME})`, "u"))?.[1];
  return rightHandSideRoot === undefined || !knownLoaderNames.has(rightHandSideRoot);
}

function pythonNameBoundToKnownLoaderInLine(line: string, name: string, knownLoaderNames: ReadonlySet<string>): boolean {
  const escapedName = escapeRegExp(name);
  const trimmed = line.trim();
  const assignment = trimmed.match(new RegExp(String.raw`^(?:\(?[ \t]*)${escapedName}(?![\p{ID_Continue}])[ \t]*(?::[^=\r\n]+)?(?:=|:=|\+=|-=|\*=|/=|//=|%=|&=|\|=|\^=|<<=|>>=)([\s\S]*)$`, "u"));
  if (!assignment) return false;
  const rightHandSideRoot = assignment[1]?.trim().replace(/^[ (]+/, "").match(new RegExp(String.raw`^(${PYTHON_NAME})`, "u"))?.[1];
  return rightHandSideRoot !== undefined && knownLoaderNames.has(rightHandSideRoot);
}

function pythonStatementSegments(line: string): string[] {
  const result: string[] = [];
  for (const segment of line.split(";")) {
    result.push(segment);
    const trimmed = segment.trim();
    const colon = trimmed.indexOf(":");
    if (colon < 0 || !/\S/.test(trimmed.slice(colon + 1)) || !/^(?:if|elif|else|for|while|with|try|except|finally|def|class|match|case)\b/.test(trimmed)) continue;
    result.push(trimmed.slice(colon + 1));
  }
  return result;
}

function pythonNameShadowedAt(code: string, index: number, name: string, knownLoaderNames: ReadonlySet<string>): boolean {
  if (pythonUncertainNameChange(code, name)) return false;
  const lines = pythonDeterministicModuleCode(code).split(/\r\n|\r|\n/);
  const lineIndex = Math.max(0, code.slice(0, index).split(/\r\n|\r|\n/).length - 1);
  const functionScopes: Array<{ line: number; indent: number; parameters: Set<string> }> = [];
  for (let current = 0; current <= lineIndex; current += 1) {
    const line = lines[current] ?? "";
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    const definition = line.slice(indent).match(/^(?:async[ \t]+)?def[ \t]+[\p{ID_Start}_][\p{ID_Continue}_]*[ \t]*\(([^)]*)\)/u);
    if (!definition) continue;
    const parameters = new Set<string>();
    for (const parameter of (definition[1] ?? "").split(",")) {
      const candidate = parameter.trim().replace(/^[*]+/, "").split(/[=:]/, 1)[0]?.trim();
      if (candidate && candidate !== "/") parameters.add(candidate);
    }
    functionScopes.push({ line: current, indent, parameters });
  }
  for (const scope of functionScopes.reverse()) {
    const callIndent = lines[lineIndex]?.match(/^[ \t]*/)?.[0].length ?? 0;
    if (lineIndex <= scope.line || callIndent <= scope.indent) continue;
    let end = lines.length;
    for (let current = scope.line + 1; current < lines.length; current += 1) {
      const line = lines[current] ?? "";
      if (line.trim().length > 0 && (line.match(/^[ \t]*/)?.[0].length ?? 0) <= scope.indent) {
        end = current;
        break;
      }
    }
    if (lineIndex >= end) continue;
    // A parameter is unknown at analysis time. Treating it as a safe shadow can
    // hide a real loader supplied by the caller, so let the dynamic check fail closed.
    if (scope.parameters.has(name)) return false;
    let shadowed = false;
    let nestedScopeIndent: number | undefined;
    for (let current = scope.line + 1; current <= lineIndex; current += 1) {
      let line = lines[current] ?? "";
      if (current === lineIndex) {
        const linePrefix = code.slice(0, index).split(/\r\n|\r|\n/).at(-1) ?? "";
        line = line.slice(0, linePrefix.length);
      }
      const meaningful = line.trim().length > 0;
      const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (nestedScopeIndent !== undefined) {
        if (meaningful && indent <= nestedScopeIndent) nestedScopeIndent = undefined;
        else continue;
      }
      const statement = line.slice(indent);
      if (meaningful && indent > scope.indent && /^(?:async[ \t]+)?(?:def|class)\b/.test(statement)) {
        if (pythonNameBoundInLine(line, name, knownLoaderNames)) shadowed = true;
        nestedScopeIndent = indent;
        continue;
      }
      for (const segment of pythonStatementSegments(line)) {
        if (pythonImportBindingIsLoader(segment, name) || pythonNameBoundToKnownLoaderInLine(segment, name, knownLoaderNames)) shadowed = false;
        else if (pythonNameBoundInLine(segment, name, knownLoaderNames)) shadowed = true;
      }
    }
    return shadowed;
  }
  return false;
}

function pythonReadStaticString(value: string, start: number): { value: string; nextIndex: number } | undefined {
  const quote = value[start];
  if (quote !== "'" && quote !== '"') return undefined;
  let content = "";
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) return { value: content, nextIndex: index + 1 };
    if (character === "\\") return undefined;
    content += character ?? "";
  }
  return undefined;
}

function pythonStaticStringSequence(value: string): string[] | null {
  const names: string[] = [];
  const namePattern = new RegExp(String.raw`^${PYTHON_NAME}$`, "u");
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (value[index] === ",") {
      index += 1;
      continue;
    }
    if (index >= value.length) break;
    const first = pythonReadStaticString(value, index);
    if (!first) return null;
    let combined = first.value;
    index = first.nextIndex;
    while (true) {
      const whitespaceStart = index;
      while (/\s/.test(value[index] ?? "")) index += 1;
      const adjacent = pythonReadStaticString(value, index);
      if (!adjacent) {
        if (index === whitespaceStart) break;
        break;
      }
      combined += adjacent.value;
      index = adjacent.nextIndex;
    }
    if (!namePattern.test(combined)) return null;
    names.push(combined);
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (index < value.length && value[index] !== ",") return null;
    if (value[index] === ",") index += 1;
  }
  return names;
}

function pythonInitializerExportsName(path: string, name: string): boolean {
  try {
    const escapedName = escapeRegExp(name);
    const content = readText(path);
    const code = pythonDeterministicModuleCode(pythonModuleScopeCode(maskPythonNonCode(content)));
    if (pythonUncertainNameChange(pythonModuleScopeCode(maskPythonNonCode(content)), name)) return false;
    const assignmentPattern = new RegExp(String.raw`(?:^|[;:\r\n])[ \t]*(?:(?:(?:async[ \t]+)?(?:def|class)[ \t]+${escapedName}(?![\p{ID_Continue}]))|${escapedName}[ \t]*(?::[^\r\n=]+)?[ \t]*(?:=|:=))`, "gmu");
    const assignments = [...code.matchAll(assignmentPattern)];
    const deletionPattern = new RegExp(String.raw`(?:^|[;:\r\n])[ \t]*del[ \t]+[^\r\n;]*\b${escapedName}\b`, "gmu");
    const deletions = [...code.matchAll(deletionPattern)];
    const exportEvents = assignments.map((match) => match.index ?? -1);
    for (const match of code.matchAll(PYTHON_RELATIVE_IMPORT)) {
      if (pythonImportedBindings(match[2] ?? "").some((binding) => binding.alias === name)) exportEvents.push(match.index ?? -1);
    }
    for (const match of code.matchAll(PYTHON_FROM_IMPORT)) {
      if (pythonImportedBindings(match[2] ?? "").some((binding) => binding.alias === name)) exportEvents.push(match.index ?? -1);
    }
    for (const match of code.matchAll(PYTHON_LOCAL_IMPORT)) {
      if (pythonImportedBindings(match[1] ?? "").some((binding) => binding.alias === name ||
        (binding.name === binding.alias && binding.name.split(".")[0] === name))) exportEvents.push(match.index ?? -1);
    }
    const lastExport = Math.max(...exportEvents, -1);
    const lastDeletion = Math.max(...deletions.map((match) => match.index ?? -1), -1);
    return lastExport >= 0 && lastExport > lastDeletion;
  } catch {
    return false;
  }
}

function pythonInitializerAllNames(path: string): string[] | null | undefined {
  try {
    const content = readText(path);
    const moduleScopeCode = pythonModuleScopeCode(maskPythonNonCode(content));
    const code = pythonDeterministicModuleCode(moduleScopeCode);
    const assignmentPattern = /(?:^|[;:\r\n])[ \t]*__all__[ \t]*(?::[^\r\n=]+)?[ \t]*(\+?=)/gm;
    const assignments = [...code.matchAll(assignmentPattern)];
    const possibleAssignments = [...moduleScopeCode.matchAll(assignmentPattern)];
    const uncertainAssignmentPattern = /(?:^|[;:\r\n])[ \t]*(?:\([ \t]*__all__[ \t]*\)|__all__[ \t]*,[^\r\n=]+)[ \t]*(?:\+?=)/m;
    if (uncertainAssignmentPattern.test(moduleScopeCode)) return null;
    const mutationPattern = /__all__[ \t]*(?:\.|\[)/g;
    const mutations = [...code.matchAll(mutationPattern)];
    const possibleMutations = [...moduleScopeCode.matchAll(mutationPattern)];
    if (possibleAssignments.length !== assignments.length || possibleMutations.length !== mutations.length) return null;
    const importedAll = [PYTHON_RELATIVE_IMPORT, PYTHON_FROM_IMPORT, PYTHON_LOCAL_IMPORT].some((pattern) => {
      for (const match of moduleScopeCode.matchAll(pattern)) {
        if (pythonImportedBindings(match[2] ?? match[1] ?? "").some((binding) => binding.alias === "__all__")) return true;
      }
      return false;
    });
    const deletedAll = new RegExp(String.raw`(?:^|[;:\r\n])[ \t]*del[ \t]+[^\r\n;]*\b__all__\b`, "g").test(code);
    const aliasedAll = new RegExp(String.raw`(?:^|[;:\r\n])[ \t]*\(?[ \t]*${PYTHON_NAME}[ \t]*\)?[ \t]*=[ \t]*\(?[ \t]*__all__\b`, "gu").test(code);
    if (importedAll || deletedAll || aliasedAll) return null;
    if (assignments.length === 0) return undefined;
    if (assignments.length !== 1 || assignments[0]?.[1] !== "=") return null;
    if (/__all__[ \t]*(?:\.|\[)/.test(code)) return null;
    const assignment = assignments[0];
    const rightHandSideStart = (assignment.index ?? 0) + assignment[0].length;
    const bracketIndex = code.indexOf("[", rightHandSideStart);
    const parenIndex = code.indexOf("(", rightHandSideStart);
    const openIndex = bracketIndex >= 0 && (parenIndex < 0 || bracketIndex < parenIndex) ? bracketIndex : parenIndex;
    if (openIndex < 0) return null;
    const opening = code[openIndex];
    const closing = opening === "[" ? "]" : ")";
    let depth = 0;
    let closeIndex = -1;
    for (let index = openIndex; index < code.length; index += 1) {
      if (code[index] === opening) depth += 1;
      if (code[index] === closing) {
        depth -= 1;
        if (depth === 0) {
          closeIndex = index;
          break;
        }
      }
    }
    if (closeIndex < 0) return null;
    const expressionPrefix = code.slice(rightHandSideStart, openIndex);
    if (expressionPrefix.trim().length > 0) return null;
    const trailing = code.slice(closeIndex + 1).match(/^[ \t]*(?:\r?\n|;|$)/);
    if (!trailing) return null;
    const body = content.slice(openIndex + 1, closeIndex).replace(/#[^\r\n]*/g, "");
    return pythonStaticStringSequence(body);
  } catch {
    return null;
  }
}

function pythonPackageInitializers(repoRoot: string, file: string, specifier: string, boundary?: string): string[] {
  const moduleBase = resolve(dirname(file), specifier.replaceAll("\\", "/"));
  let directory = isDirectRegularFile(join(moduleBase, "__init__.py")) ? moduleBase : dirname(moduleBase);
  const result: string[] = [];
  while (isPathInside(repoRoot, directory) && (!boundary || isPathInside(boundary, directory))) {
    const initializer = join(directory, "__init__.py");
    if (isPathInside(repoRoot, initializer) && (!boundary || isPathInside(boundary, initializer)) && isDirectRegularFile(initializer)) result.push(initializer);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return result;
}

function pythonModuleInitializer(repoRoot: string, file: string, specifier: string): string | undefined {
  const initializer = join(resolve(dirname(file), specifier.replaceAll("\\", "/")), "__init__.py");
  return isPathInside(repoRoot, initializer) && isDirectRegularFile(initializer) ? initializer : undefined;
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

function absoluteImportPath(file: string, specifier: string, specifierIsFilePath = false): string {
  return moduleSpecifierPath(file, specifier, specifierIsFilePath);
}

type PublicToolLanguage = "javascript" | "python" | "shell" | "unknown";

function shebangTokens(value: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"') {
        const escaped = value[index + 1];
        if (escaped === undefined) return undefined;
        token += escaped;
        index += 1;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined) return undefined;
      token += escaped;
      tokenStarted = true;
      index += 1;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function shebangInterpreter(shebang: string): string | undefined {
  const tokens = shebangTokens(shebang.replace(/^#!\s*/, "").trim());
  if (!tokens || tokens.length === 0) return undefined;
  const first = tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (first !== "env") return first;
  const envInterpreter = (argumentsList: string[], start: number): string | undefined => {
    let index = start;
    while (index < argumentsList.length) {
      const token = argumentsList[index] ?? "";
      if (token === "--" || token === "-") return argumentsList[index + 1]?.split(/[\\/]/).at(-1)?.toLowerCase();
      if (token === "-S" || token === "--split-string") {
        const split = shebangTokens(argumentsList.slice(index + 1).join(" "));
        return split ? envInterpreter(split, 0) : undefined;
      }
      if (token.startsWith("-S") && token.length > 2) {
        const split = shebangTokens([token.slice(2), ...argumentsList.slice(index + 1)].join(" "));
        return split ? envInterpreter(split, 0) : undefined;
      }
      if (token.startsWith("--split-string=") && token.length > "--split-string=".length) {
        const split = shebangTokens([token.slice("--split-string=".length), ...argumentsList.slice(index + 1)].join(" "));
        return split ? envInterpreter(split, 0) : undefined;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "-i" || token === "-v" || token === "--ignore-environment" || token === "--null" || token === "--debug") {
        index += 1;
        continue;
      }
      if (["-u", "--unset", "-C", "--chdir", "-P", "--path", "--argv0", "--block-signal", "--default-signal", "--ignore-signal", "--process-slot-var"].includes(token)) {
        index += 2;
        continue;
      }
      if (/^-u.+/.test(token) || /^-C.+/.test(token) || /^-P.+/.test(token) || token.startsWith("--unset=") || token.startsWith("--chdir=") || token.startsWith("--path=") || token.startsWith("--argv0=") || token.startsWith("--block-signal=") || token.startsWith("--default-signal=") || token.startsWith("--ignore-signal=") || token.startsWith("--process-slot-var=")) {
        index += 1;
        continue;
      }
      if (token.startsWith("-") && token.length > 2) {
        const shortOptions = token.slice(1);
        for (let optionIndex = 0; optionIndex < shortOptions.length; optionIndex += 1) {
          const option = shortOptions[optionIndex];
          if (option === "S") {
            const inlineArgument = shortOptions.slice(optionIndex + 1);
            const splitText = inlineArgument || argumentsList[index + 1];
            if (!inlineArgument) index += 1;
            const split = splitText === undefined ? undefined : shebangTokens(splitText === "" ? "" : [splitText, ...argumentsList.slice(index + 1)].join(" "));
            return split ? envInterpreter(split, 0) : undefined;
          }
          if (option === "i" || option === "v" || option === "0" || option === "a") continue;
          if (option === "u" || option === "C" || option === "P") {
            if (optionIndex + 1 < shortOptions.length) break;
            index += 1;
            break;
          }
          return undefined;
        }
        index += 1;
        continue;
      }
      if (token.startsWith("-")) return undefined;
      return token.split(/[\\/]/).at(-1)?.toLowerCase();
    }
    return undefined;
  };
  return envInterpreter(tokens, 1);
}

function shebangChangesWorkingDirectory(shebang: string): boolean {
  const tokens = shebangTokens(shebang.replace(/^#!\s*/, "").trim());
  if (!tokens || tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase() !== "env") return false;
  const scan = (argumentsList: string[], start: number): boolean => {
    for (let index = start; index < argumentsList.length; index += 1) {
      const token = argumentsList[index] ?? "";
      if (token === "--" || token === "-") return false;
      if (token === "-C" || token === "--chdir" || token.startsWith("-C") || token.startsWith("--chdir=")) return true;
      if (token === "-S" || token === "--split-string") {
        const split = shebangTokens(argumentsList.slice(index + 1).join(" "));
        return split ? scan(split, 0) : false;
      }
      if (token.startsWith("-S") && token.length > 2) {
        const split = shebangTokens([token.slice(2), ...argumentsList.slice(index + 1)].join(" "));
        return split ? scan(split, 0) : false;
      }
      if (token.startsWith("--split-string=") && token.length > "--split-string=".length) {
        const split = shebangTokens([token.slice("--split-string=".length), ...argumentsList.slice(index + 1)].join(" "));
        return split ? scan(split, 0) : false;
      }
      if (token.startsWith("-") && token.length > 2) {
        const options = token.slice(1);
        for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
          const option = options[optionIndex];
          if (option === "C") return true;
          if (option === "S") {
            const inlineArgument = options.slice(optionIndex + 1);
            const splitText = inlineArgument || argumentsList[index + 1];
            if (!inlineArgument) index += 1;
            const split = splitText === undefined ? undefined : shebangTokens([splitText, ...argumentsList.slice(index + 1)].join(" "));
            return split ? scan(split, 0) : false;
          }
        }
      }
    }
    return false;
  };
  return scan(tokens, 1);
}

function publicToolLanguage(path: string, content: string): PublicToolLanguage {
  const shebang = content.match(/^#![^\r\n]*/)?.[0] ?? "";
  const interpreter = shebangInterpreter(shebang);
  if (shebang && interpreter === undefined) return "unknown";
  if (interpreter && /^(?:python|python[23]|pypy)(?:\d+(?:\.\d+)?)?$/.test(interpreter)) return "python";
  if (interpreter && /^(?:bash|dash|ksh|sh|zsh)$/.test(interpreter)) return "shell";
  if (interpreter && /^(?:bun|deno|node)$/.test(interpreter)) return "javascript";
  const extension = extname(path).toLowerCase();
  if (extension === ".py") return "python";
  if (extension === ".sh") return "shell";
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return "javascript";
  return "unknown";
}

type JavaScriptSpecifier = { specifier: string; specifierIsFilePath: boolean };
type JavaScriptImports = { specifiers: JavaScriptSpecifier[]; hasUnverifiableDynamicImport: boolean };

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current)) {
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
  const access = memberAccess(expression);
  if (access?.name === "globalThis") return isGlobalObjectReference(access.receiver, aliases);
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

function isCommonJsConstructorReference(node: ts.Expression, moduleAliases: Set<string>, constructorAliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) && constructorAliases.has(expression.text)) return true;
  const access = memberAccess(expression);
  const receiver = access ? unwrapExpression(access.receiver) : undefined;
  return access?.name === "constructor" && !!receiver && ts.isIdentifier(receiver) && moduleAliases.has(receiver.text);
}

function isCommonJsLoaderExpression(node: ts.Expression, moduleAliases: Set<string>, constructorAliases: Set<string>): boolean {
  const loadAccess = memberAccess(node);
  if (loadAccess?.name !== "_load") return false;
  return isCommonJsConstructorReference(loadAccess.receiver, moduleAliases, constructorAliases);
}

function isRequireBindExpression(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const access = memberAccess(node);
  return access?.name === "bind" && isRequireExpression(access.receiver, aliases, importMetaAliases);
}

function isRequireBindCall(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const expression = unwrapExpression(node);
  return ts.isCallExpression(expression) && isRequireBindExpression(expression.expression, aliases, importMetaAliases);
}

function isLoaderExpression(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set(), moduleAliases: Set<string> = new Set(), constructorAliases: Set<string> = new Set()): boolean {
  return isRequireExpression(node, aliases, importMetaAliases) || isRequireBindExpression(node, aliases, importMetaAliases) || isRequireBindCall(node, aliases, importMetaAliases) || isCommonJsLoaderExpression(node, moduleAliases, constructorAliases);
}

function isRequireMethodCall(node: ts.Expression, aliases: Set<string>, importMetaAliases: Set<string> = new Set()): boolean {
  const access = memberAccess(node);
  return (access?.name === "apply" || access?.name === "bind" || access?.name === "call") && isRequireExpression(access.receiver, aliases, importMetaAliases);
}

function isBuiltinModuleLoaderReference(
  node: ts.Expression,
  processAliases: Set<string> = new Set(["process"]),
  builtinModuleAliases: Set<string> = new Set(),
  globalAliases: Set<string> = GLOBAL_OBJECT_NAMES,
): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) && builtinModuleAliases.has(expression.text)) return true;
  const access = memberAccess(expression);
  const receiver = access ? unwrapExpression(access.receiver) : undefined;
  if ((access?.name === "call" || access?.name === "apply" || access?.name === "bind") && receiver) {
    return isBuiltinModuleLoaderReference(receiver, processAliases, builtinModuleAliases, globalAliases);
  }
  return access?.name === "getBuiltinModule" && !!receiver && isProcessReference(receiver, processAliases, globalAliases);
}

type ProcessAnalysis = { aliases: Set<string>; builtinModuleAliases: Set<string>; hasUnverifiable: boolean };

function isProcessModuleReference(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isCallExpression(expression)) return false;
  const isRequire = ts.isIdentifier(expression.expression) && expression.expression.text === "require";
  const isDynamicImport = expression.expression.kind === ts.SyntaxKind.ImportKeyword;
  if (!isRequire && !isDynamicImport) return false;
  const argument = expression.arguments[0];
  return !!argument && ts.isStringLiteralLike(argument) && (argument.text === "process" || argument.text === "node:process");
}

function isProcessPromiseReference(node: ts.Expression, promiseAliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  return isProcessModuleReference(expression) || ts.isIdentifier(expression) && promiseAliases.has(expression.text);
}

type ProcessBindingNames = { aliases: string[]; builtinModuleAliases: string[]; hasUnverifiable: boolean };

function processBindingNames(name: ts.BindingName, initializer: ts.Expression, aliases: Set<string>, globalAliases: Set<string>, treatAsProcessObject = false): ProcessBindingNames {
  if (!ts.isObjectBindingPattern(name)) return { aliases: [], builtinModuleAliases: [], hasUnverifiable: false };
  const isProcessObject = treatAsProcessObject || isProcessReference(initializer, aliases, globalAliases);
  const isGlobalObject = isGlobalObjectReference(initializer, globalAliases);
  if (!isProcessObject && !isGlobalObject) return { aliases: [], builtinModuleAliases: [], hasUnverifiable: false };
  const processNames: string[] = [];
  const builtinNames: string[] = [];
  let hasUnverifiable = false;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
      const propertyName = staticPropertyName(element.propertyName) ?? (element.propertyName ? undefined : element.name.text);
      if (element.dotDotDotToken || element.propertyName && propertyName === undefined) {
        hasUnverifiable = true;
        continue;
      }
      if (isProcessObject && propertyName === "default") processNames.push(element.name.text);
      if (isGlobalObject && propertyName === "process") processNames.push(element.name.text);
      if (isProcessObject && propertyName === "getBuiltinModule") builtinNames.push(element.name.text);
      continue;
    }
    hasUnverifiable = true;
  }
  return { aliases: processNames, builtinModuleAliases: builtinNames, hasUnverifiable };
}

function processAssignmentNames(left: ts.Expression, initializer: ts.Expression, aliases: Set<string>, globalAliases: Set<string>): ProcessBindingNames {
  const expression = unwrapExpression(left);
  if (!ts.isObjectLiteralExpression(expression)) return { aliases: [], builtinModuleAliases: [], hasUnverifiable: false };
  const isProcessObject = isProcessReference(initializer, aliases, globalAliases);
  const isGlobalObject = isGlobalObjectReference(initializer, globalAliases);
  if (!isProcessObject && !isGlobalObject) return { aliases: [], builtinModuleAliases: [], hasUnverifiable: false };
  const processNames: string[] = [];
  const builtinNames: string[] = [];
  let hasUnverifiable = false;
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasUnverifiable = true;
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const targetName = assignmentTargetName(property.initializer);
      const propertyName = staticPropertyName(property.name);
      if (!propertyName || !targetName) {
        hasUnverifiable = true;
        continue;
      }
      if (isProcessObject && propertyName === "default") processNames.push(targetName);
      if (isGlobalObject && propertyName === "process") processNames.push(targetName);
      if (isProcessObject && propertyName === "getBuiltinModule") builtinNames.push(targetName);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      if (isProcessObject && property.name.text === "default") processNames.push(property.name.text);
      if (isGlobalObject && property.name.text === "process") processNames.push(property.name.text);
      if (isProcessObject && property.name.text === "getBuiltinModule") builtinNames.push(property.name.text);
    } else {
      hasUnverifiable = true;
    }
  }
  return { aliases: processNames, builtinModuleAliases: builtinNames, hasUnverifiable };
}

function hasProcessObjectSpread(node: ts.Expression, aliases: Set<string>, globalAliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  return ts.isObjectLiteralExpression(expression) && expression.properties.some((property) =>
    ts.isSpreadAssignment(property) && isProcessReference(property.expression, aliases, globalAliases));
}

function isProcessReference(node: ts.Expression, aliases: Set<string>, globalAliases: Set<string> = GLOBAL_OBJECT_NAMES): boolean {
  const expression = unwrapExpression(node);
  const access = memberAccess(expression);
  if (access?.name === "default" && !!access.receiver && isProcessReference(access.receiver, aliases, globalAliases)) return true;
  return (ts.isIdentifier(expression) && aliases.has(expression.text)) ||
    isProcessModuleReference(expression) ||
    (access?.name === "process" && !!access.receiver && isGlobalObjectReference(access.receiver, globalAliases));
}

function collectProcessAliases(source: ts.SourceFile, globalAliases: Set<string> = GLOBAL_OBJECT_NAMES): ProcessAnalysis {
  const aliases = new Set(["process"]);
  const builtinModuleAliases = new Set<string>();
  const promiseAliases = new Set<string>();
  let hasUnverifiable = false;
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && (node.moduleSpecifier.text === "process" || node.moduleSpecifier.text === "node:process")) {
        const clause = node.importClause;
        if (clause?.name && !aliases.has(clause.name.text)) {
          aliases.add(clause.name.text);
          changed = true;
        }
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) && !aliases.has(clause.namedBindings.name.text)) {
          aliases.add(clause.namedBindings.name.text);
          changed = true;
        }
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            const imported = staticPropertyName(element.propertyName) ?? element.name.text;
            if (imported === "default" && !aliases.has(element.name.text)) {
              aliases.add(element.name.text);
              changed = true;
            }
            if (imported === "getBuiltinModule" && !builtinModuleAliases.has(element.name.text)) {
              builtinModuleAliases.add(element.name.text);
              changed = true;
            }
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression) && (node.moduleReference.expression.text === "process" || node.moduleReference.expression.text === "node:process") && !aliases.has(node.name.text)) {
        aliases.add(node.name.text);
        changed = true;
      } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) {
        if (ts.isIdentifier(node.name) && isProcessReference(node.initializer, aliases, globalAliases) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
        if (ts.isIdentifier(node.name) && isProcessModuleReference(node.initializer) && !promiseAliases.has(node.name.text)) {
          promiseAliases.add(node.name.text);
          changed = true;
        }
        const initializerExpression = unwrapExpression(node.initializer);
        if (ts.isIdentifier(node.name) && ts.isIdentifier(initializerExpression) && promiseAliases.has(initializerExpression.text) && !promiseAliases.has(node.name.text)) {
          promiseAliases.add(node.name.text);
          changed = true;
        }
        const bindings = processBindingNames(node.name, node.initializer, aliases, globalAliases);
        hasUnverifiable ||= bindings.hasUnverifiable;
        if (hasProcessObjectSpread(node.initializer, aliases, globalAliases)) hasUnverifiable = true;
        for (const name of bindings.aliases) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        for (const name of bindings.builtinModuleAliases) {
          if (!builtinModuleAliases.has(name)) {
            builtinModuleAliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.name) && isBuiltinModuleLoaderReference(node.initializer, aliases, builtinModuleAliases, globalAliases) && !builtinModuleAliases.has(node.name.text)) {
          builtinModuleAliases.add(node.name.text);
          changed = true;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left) && isProcessReference(node.right, aliases, globalAliases) && !aliases.has(node.left.text)) {
          aliases.add(node.left.text);
          changed = true;
        }
        if (ts.isIdentifier(node.left) && isProcessModuleReference(node.right) && !promiseAliases.has(node.left.text)) {
          promiseAliases.add(node.left.text);
          changed = true;
        }
        const right = unwrapExpression(node.right);
        if (ts.isIdentifier(node.left) && ts.isIdentifier(right) && promiseAliases.has(right.text) && !promiseAliases.has(node.left.text)) {
          promiseAliases.add(node.left.text);
          changed = true;
        }
        const bindings = processAssignmentNames(node.left, node.right, aliases, globalAliases);
        hasUnverifiable ||= bindings.hasUnverifiable;
        if (hasProcessObjectSpread(node.right, aliases, globalAliases)) hasUnverifiable = true;
        for (const name of bindings.aliases) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        for (const name of bindings.builtinModuleAliases) {
          if (!builtinModuleAliases.has(name)) {
            builtinModuleAliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.left) && isBuiltinModuleLoaderReference(node.right, aliases, builtinModuleAliases, globalAliases) && !builtinModuleAliases.has(node.left.text)) {
          builtinModuleAliases.add(node.left.text);
          changed = true;
        }
      }
      if (ts.isCallExpression(node)) {
        const thenAccess = memberAccess(node.expression);
        const callback = node.arguments[0];
        const processPromise = thenAccess?.name === "then" && isProcessPromiseReference(thenAccess.receiver, promiseAliases);
        if (processPromise && callback && !ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) hasUnverifiable = true;
        if (processPromise && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const parameter = callback.parameters[0];
          if (parameter) {
            if (ts.isIdentifier(parameter.name) && !aliases.has(parameter.name.text)) {
              aliases.add(parameter.name.text);
              changed = true;
            }
            const bindings = processBindingNames(parameter.name, thenAccess.receiver, aliases, globalAliases, processPromise);
            hasUnverifiable ||= bindings.hasUnverifiable;
            for (const name of bindings.aliases) {
              if (!aliases.has(name)) {
                aliases.add(name);
                changed = true;
              }
            }
            for (const name of bindings.builtinModuleAliases) {
              if (!builtinModuleAliases.has(name)) {
                builtinModuleAliases.add(name);
                changed = true;
              }
            }
          }
        }
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isIdentifier(initializer) && aliases.has(initializer.text) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const initializer = unwrapExpression(node.right);
        if (ts.isIdentifier(initializer) && aliases.has(initializer.text) && !aliases.has(node.left.text)) {
          aliases.add(node.left.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { aliases, builtinModuleAliases, hasUnverifiable };
}

function staticPropertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrapExpression(node.expression);
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteralLike(expression.left) && ts.isStringLiteralLike(expression.right)) {
      return expression.left.text + expression.right.text;
    }
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

function hasUnverifiableModuleBinding(name: ts.BindingName, initializer: ts.Expression, importMetaAliases: Set<string>, moduleAliases: Set<string>): boolean {
  if (!isModuleContainerReference(initializer, importMetaAliases, moduleAliases) || !ts.isObjectBindingPattern(name)) return false;
  return name.elements.some((element) => ts.isBindingElement(element) && !!element.propertyName && staticPropertyName(element.propertyName) === undefined);
}

function hasUnverifiableModuleAssignment(left: ts.Expression, initializer: ts.Expression, importMetaAliases: Set<string>, moduleAliases: Set<string>): boolean {
  if (!isModuleContainerReference(initializer, importMetaAliases, moduleAliases)) return false;
  const expression = unwrapExpression(left);
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name) && staticPropertyName(property.name) === undefined);
}

function isUnknownModulePropertyAccess(node: ts.ElementAccessExpression, importMetaAliases: Set<string>, moduleAliases: Set<string>): boolean {
  if (!isModuleContainerReference(node.expression, importMetaAliases, moduleAliases) || !node.argumentExpression) return false;
  const argument = unwrapExpression(node.argumentExpression);
  return !ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument);
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

type RequireAnalysis = { aliases: Set<string>; moduleAliases: Set<string>; constructorAliases: Set<string> };

function collectRequireAliases(source: ts.SourceFile, importMetaAliases: Set<string>): RequireAnalysis {
  const aliases = new Set(["require"]);
  const moduleAliases = new Set(["module"]);
  const constructorAliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) {
        if (ts.isIdentifier(node.name) && isModuleContainerReference(node.initializer, importMetaAliases, moduleAliases) && !moduleAliases.has(node.name.text)) {
          moduleAliases.add(node.name.text);
          changed = true;
        }
        if (ts.isIdentifier(node.name) && isCommonJsConstructorReference(node.initializer, moduleAliases, constructorAliases) && !constructorAliases.has(node.name.text)) {
          constructorAliases.add(node.name.text);
          changed = true;
        }
        for (const name of requireBindingNames(node.name, node.initializer, importMetaAliases, moduleAliases)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.name) && isLoaderExpression(node.initializer, aliases, importMetaAliases, moduleAliases, constructorAliases) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left) && isModuleContainerReference(node.right, importMetaAliases, moduleAliases) && !moduleAliases.has(node.left.text)) {
          moduleAliases.add(node.left.text);
          changed = true;
        }
        if (ts.isIdentifier(node.left) && isCommonJsConstructorReference(node.right, moduleAliases, constructorAliases) && !constructorAliases.has(node.left.text)) {
          constructorAliases.add(node.left.text);
          changed = true;
        }
        for (const name of requireAssignmentNames(node.left, node.right, importMetaAliases, moduleAliases)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
        if (ts.isIdentifier(node.left) && isLoaderExpression(node.right, aliases, importMetaAliases, moduleAliases, constructorAliases) && !aliases.has(node.left.text)) {
          aliases.add(node.left.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { aliases, moduleAliases, constructorAliases };
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
            if (propertyText === "globalThis" && !globalAliases.has(element.name.text)) {
              globalAliases.add(element.name.text);
              changed = true;
            } else if (propertyText !== undefined && DYNAMIC_CODE_NAMES.has(propertyText) && !aliases.has(element.name.text)) {
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
  if (!JAVASCRIPT_EXTENSIONS.has(extension) && publicToolLanguage(file, content) !== "javascript") {
    return { specifiers: [], hasUnverifiableDynamicImport: false };
  }
  const scriptKind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : [".ts", ".mts", ".cts"].includes(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: JavaScriptSpecifier[] = [];
  let hasUnverifiableDynamicImport = false;
  const importMetaAliases = collectImportMetaAliases(source);
  const requireAnalysis = collectRequireAliases(source, importMetaAliases);
  const requireAliases = requireAnalysis.aliases;
  const moduleObjectAliases = requireAnalysis.moduleAliases;
  const moduleConstructorAliases = requireAnalysis.constructorAliases;
  const dynamicCodeAnalysis = collectDynamicCodeAliases(source);
  const dynamicCodeAliases = dynamicCodeAnalysis.aliases;
  const globalObjectAliases = dynamicCodeAnalysis.globalAliases;
  const processAnalysis = collectProcessAliases(source, globalObjectAliases);
  const processAliases = processAnalysis.aliases;
  const builtinModuleAliases = processAnalysis.builtinModuleAliases;
  if (processAnalysis.hasUnverifiable) hasUnverifiableDynamicImport = true;
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && hasUnverifiableImportMetaBinding(node.name, node.initializer, importMetaAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && hasUnverifiableGlobalBinding(node.name, node.initializer, globalObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && hasUnverifiableModuleBinding(node.name, node.initializer, importMetaAliases, moduleObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasUnverifiableImportMetaAssignment(node.left, node.right, importMetaAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasUnverifiableGlobalAssignment(node.left, node.right, globalObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasUnverifiableModuleAssignment(node.left, node.right, importMetaAliases, moduleObjectAliases)) {
      hasUnverifiableDynamicImport = true;
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      (isImportMetaRequire(node, importMetaAliases) || isDynamicCodeReference(node, dynamicCodeAliases) || isBuiltinModuleLoaderReference(node, processAliases, builtinModuleAliases, globalObjectAliases)) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (NODE_MODULE_BUILTINS.has(node.moduleSpecifier.text)) {
        hasUnverifiableDynamicImport = true;
      }
      specifiers.push({ specifier: node.moduleSpecifier.text, specifierIsFilePath: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (NODE_MODULE_BUILTINS.has(node.moduleSpecifier.text)) {
        hasUnverifiableDynamicImport = true;
      }
      specifiers.push({ specifier: node.moduleSpecifier.text, specifierIsFilePath: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      if (NODE_MODULE_BUILTINS.has(node.moduleReference.expression.text)) {
        hasUnverifiableDynamicImport = true;
      }
      specifiers.push({ specifier: node.moduleReference.expression.text, specifierIsFilePath: true });
    } else if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = isRequireExpression(expression, requireAliases, importMetaAliases) || isRequireBindCall(expression, requireAliases, importMetaAliases) || isCommonJsLoaderExpression(expression, moduleObjectAliases, moduleConstructorAliases);
      if (isDynamicCodeReference(expression, dynamicCodeAliases)) {
        hasUnverifiableDynamicImport = true;
      }
      if (isRequireMethodCall(expression, requireAliases, importMetaAliases)) {
        hasUnverifiableDynamicImport = true;
      }
      if (isBuiltinModuleLoaderReference(expression, processAliases, builtinModuleAliases, globalObjectAliases)) {
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
          specifiers.push({ specifier: argument.text, specifierIsFilePath: isRequire });
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
    } else if (ts.isElementAccessExpression(node) && isProcessReference(node.expression, processAliases, globalObjectAliases) &&
      (!node.argumentExpression || (!ts.isStringLiteralLike(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)))) {
      hasUnverifiableDynamicImport = true;
    } else if (ts.isElementAccessExpression(node) && isUnknownModulePropertyAccess(node, importMetaAliases, moduleObjectAliases)) {
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

type ImportCandidateResolver = (file: string, specifier: string, repoRoot?: string, specifierIsFilePath?: boolean) => string[];
type FindingReporter = (finding: string) => void;

function checkImportSpecifierBody(
  repoRoot: string,
  path: string,
  relative: string,
  specifier: string,
  reportFinding: FindingReporter,
  onResolved?: (path: string) => void,
  candidatesForSpecifier: ImportCandidateResolver = importCandidates,
  displaySpecifier: string = specifier,
  seen: Set<string> = new Set(),
  specifierIsFilePath = false,
): void {
  if (EXECUTABLE_MODULE_URL.test(specifier)) {
    reportFinding(`${relative}: executable module URL cannot be verified`);
    return;
  }
  if (RELATIVE_SPECIFIER.test(specifier)) {
    const candidates = candidatesForSpecifier(path, specifier, repoRoot, specifierIsFilePath);
    if (candidates.some((candidate) => !isInside(repoRoot, candidate))) {
      reportFinding(`${relative}: local reference outside public repository ${displaySpecifier}`);
      return;
    }
    const existing = resolveExistingFile(candidates);
    if (existing) {
      try {
        const realExisting = realpathSync(existing);
        if (!isInside(repoRoot, realExisting)) {
          reportFinding(`${relative}: local reference resolves outside public repository ${displaySpecifier}`);
        } else if (isExcludedTestPath(existing) || isExcludedTestPath(realExisting)) {
          reportFinding(`${relative}: local reference targets excluded test file ${displaySpecifier}`);
        } else if (!SCANNABLE_LOCAL_EXTENSIONS.has(extname(realExisting).toLowerCase())) {
          reportFinding(`${relative}: local reference cannot be inspected ${displaySpecifier}`);
        } else {
          onResolved?.(existing);
        }
      } catch {
        reportFinding(`${relative}: unreadable local reference ${displaySpecifier}`);
      }
      return;
    }
    reportFinding(`${relative}: missing local reference ${displaySpecifier}`);
    return;
  }
  if (!ABSOLUTE_SPECIFIER.test(specifier)) {
    let resolvedByLocalMetadata = false;
    const selfImport = packageSelfImportTargets(repoRoot, path, specifier);
    if (selfImport.found) {
      resolvedByLocalMetadata = true;
      if (selfImport.invalid) reportFinding(`${relative}: local package import cannot be verified ${displaySpecifier}`);
      for (const target of selfImport.targets) {
        checkImportSpecifier(repoRoot, path, relative, target, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen, true);
      }
      for (const target of selfImport.externalTargets) {
        if (target.startsWith("#")) {
          checkImportSpecifier(repoRoot, path, relative, target, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen);
        } else if (NODE_MODULE_BUILTINS.has(target)) {
          reportFinding(`${relative}: dynamic import or require cannot be verified`);
        } else {
          const nestedSelfImport = packageSelfImportTargets(repoRoot, path, target);
          if (nestedSelfImport.found) {
            if (nestedSelfImport.invalid) reportFinding(`${relative}: local package import cannot be verified ${displaySpecifier}`);
            for (const localTarget of nestedSelfImport.targets) {
              checkImportSpecifier(repoRoot, path, relative, localTarget, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen, true);
            }
          }
        }
      }
    }
    const pathImport = tsconfigPathTargets(repoRoot, path, specifier);
    if (pathImport.found) {
      resolvedByLocalMetadata = true;
      if (pathImport.invalid) reportFinding(`${relative}: local path import cannot be verified ${displaySpecifier}`);
      for (const target of pathImport.targets) {
        checkImportSpecifier(repoRoot, path, relative, target, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen);
      }
    }
    if (specifier.startsWith("#")) {
      const packageImport = packageImportTargets(repoRoot, path, specifier);
      if (!packageImport.found) {
        reportFinding(`${relative}: missing local package import ${displaySpecifier}`);
      } else {
        if (packageImport.invalid) reportFinding(`${relative}: local package import cannot be verified ${displaySpecifier}`);
        for (const target of packageImport.targets) {
          checkImportSpecifier(repoRoot, path, relative, target, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen, true);
        }
        for (const target of packageImport.externalTargets) {
          if (target.startsWith("#")) {
            checkImportSpecifier(repoRoot, path, relative, target, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen);
            continue;
          }
          if (NODE_MODULE_BUILTINS.has(target)) {
            reportFinding(`${relative}: dynamic import or require cannot be verified`);
            continue;
          }
          const targetSelfImport = packageSelfImportTargets(repoRoot, path, target);
          if (targetSelfImport.found) {
            if (targetSelfImport.invalid) reportFinding(`${relative}: local package import cannot be verified ${displaySpecifier}`);
            for (const localTarget of targetSelfImport.targets) {
              checkImportSpecifier(repoRoot, path, relative, localTarget, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen, true);
            }
          }
        }
      }
    }
    if (resolvedByLocalMetadata) return;
    return;
  }
  try {
    const absolute = absoluteImportPath(path, specifier, candidatesForSpecifier === shellImportCandidates || specifierIsFilePath);
    if (!isInside(repoRoot, absolute)) {
      reportFinding(`${relative}: local reference outside public repository ${displaySpecifier}`);
      return;
    }
    const existing = resolveExistingFile(candidatesForSpecifier(path, absolute, repoRoot, true));
    if (!existing) {
      reportFinding(`${relative}: missing local reference ${displaySpecifier}`);
    } else {
      const realExisting = realpathSync(existing);
      if (!isInside(repoRoot, realExisting)) {
        reportFinding(`${relative}: local reference resolves outside public repository ${displaySpecifier}`);
      } else if (isExcludedTestPath(existing) || isExcludedTestPath(realExisting)) {
        reportFinding(`${relative}: local reference targets excluded test file ${displaySpecifier}`);
      } else if (!SCANNABLE_LOCAL_EXTENSIONS.has(extname(realExisting).toLowerCase())) {
        reportFinding(`${relative}: local reference cannot be inspected ${displaySpecifier}`);
      } else {
        onResolved?.(existing);
      }
    }
  } catch {
    reportFinding(`${relative}: unreadable local reference ${displaySpecifier}`);
  }
}

function checkImportSpecifier(
  repoRoot: string,
  path: string,
  relative: string,
  specifier: string,
  reportFinding: FindingReporter,
  onResolved?: (path: string) => void,
  candidatesForSpecifier: ImportCandidateResolver = importCandidates,
  displaySpecifier: string = specifier,
  seen: Set<string> = new Set(),
  specifierIsFilePath = false,
): void {
  const visitKey = `${resolve(path)}\0${specifierIsFilePath ? "file" : "module"}\0${specifier}`;
  if (seen.has(visitKey)) {
    if (specifier.startsWith("#")) reportFinding(`${relative}: local package import cannot be verified ${displaySpecifier}`);
    return;
  }
  seen.add(visitKey);
  try {
    checkImportSpecifierBody(repoRoot, path, relative, specifier, reportFinding, onResolved, candidatesForSpecifier, displaySpecifier, seen, specifierIsFilePath);
  } finally {
    seen.delete(visitKey);
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
  const reportedByPath = new Map<string, Set<string>>();
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
    const pathKey = resolve(path);
    const previousFindings = new Set(reportedByPath.get(pathKey) ?? []);
    const pathFindings = reportedByPath.get(pathKey) ?? new Set<string>();
    reportedByPath.set(pathKey, pathFindings);
    const reportFinding: FindingReporter = (finding) => {
      if (!previousFindings.has(finding)) findings.push(finding);
      pathFindings.add(finding);
    };
    if (!isPathInside(repoRoot, path) || !isDirectRegularFile(path)) {
      reportFinding(`${relative}: public tool path is not a regular file inside the repository`);
      continue;
    }
    const content = readText(path);
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        reportFinding(`${relative}: forbidden public tool coupling ${label}`);
      }
    }
    const language = publicToolLanguage(path, content);
    const parsed = language === "javascript" ? javascriptImports(path, content) : { specifiers: [], hasUnverifiableDynamicImport: false };
    if (parsed.hasUnverifiableDynamicImport) {
      reportFinding(`${relative}: dynamic import or require cannot be verified`);
    }
    if (parsed.specifiers.length > 0) {
      for (const { specifier, specifierIsFilePath } of parsed.specifiers) {
        checkImportSpecifier(repoRoot, path, relative, specifier, reportFinding, enqueue, importCandidates, specifier, new Set(), specifierIsFilePath);
      }
    } else if (language !== "javascript") {
      if (language === "unknown" && extname(path).toLowerCase() !== ".json") {
        for (const match of content.matchAll(RELATIVE_IMPORT)) {
          const specifier = match[1];
          if (specifier) checkImportSpecifier(repoRoot, path, relative, specifier, reportFinding, enqueue);
        }
        for (const match of content.matchAll(ABSOLUTE_IMPORT)) {
          const specifier = match[1];
          if (specifier) checkImportSpecifier(repoRoot, path, relative, specifier, reportFinding, enqueue);
        }
      }
      if (language === "python") {
        const pythonContent = maskPythonNonCode(content);
        let hasUnverifiableDynamicPythonImport = false;
        const pythonDynamicSources = [
          { code: pythonContent, source: content },
          ...pythonFStringExpressions(content).map((source) => ({ code: maskPythonNonCode(source), source })),
        ];
        const pythonDynamicImportNames = new Set(["__import__"]);
        const pythonBuiltinImportNames = new Set(["__import__"]);
        const pythonExecNames = new Set(["exec", "eval"]);
        const pythonImportlibAliases = new Set(["importlib"]);
        const pythonBuiltinsAliases = new Set(["builtins", "__builtins__"]);
        const pythonMachineryAliases = new Set(["importlib.machinery"]);
        const pythonFileLoaderMemberNames = new Set(["spec_from_file_location", "module_from_spec", "exec_module", "run_path", "run_module", "load_module", "SourceFileLoader"]);
        const pythonFileLoaderAliases = new Set<string>();
        const pythonRunpyAliases = new Set<string>();
        const pythonSpecLoaderAliases = new Set<string>();
        const pythonSourceFileLoaderAliases = new Set<string>();
        const pythonBuiltinsDictAliases = new Set<string>();
        for (const match of pythonContent.matchAll(PYTHON_LOCAL_IMPORT)) {
          for (const binding of pythonImportedBindings(match[1] ?? "")) {
            if (binding.name === "importlib" || binding.name.startsWith("importlib.")) pythonImportlibAliases.add(binding.alias);
            if (binding.name === "builtins") pythonBuiltinsAliases.add(binding.alias);
            if (binding.name === "runpy") pythonRunpyAliases.add(binding.alias);
          }
        }
        for (const match of pythonContent.matchAll(PYTHON_FROM_IMPORT)) {
          const moduleName = pythonNormalizeImportName(match[1] ?? "");
          if (moduleName === "importlib") {
            for (const binding of pythonImportedBindings(match[2] ?? "")) {
              if (binding.name === "import_module") pythonDynamicImportNames.add(binding.alias);
            }
          }
          if (moduleName === "builtins") {
            for (const binding of pythonImportedBindings(match[2] ?? "")) {
              if (binding.name === "__import__") {
                pythonDynamicImportNames.add(binding.alias);
                pythonBuiltinImportNames.add(binding.alias);
              }
              if (binding.name === "exec" || binding.name === "eval") pythonExecNames.add(binding.alias);
            }
          }
          for (const binding of pythonImportedBindings(match[2] ?? "")) {
            const isRunpyLoader = moduleName === "runpy" && (binding.name === "run_path" || binding.name === "run_module");
            const isImportlibLoader = (moduleName === "importlib" || moduleName === "importlib.util") &&
              (binding.name === "spec_from_file_location" || binding.name === "module_from_spec");
            if (isRunpyLoader || isImportlibLoader) {
              pythonFileLoaderAliases.add(binding.alias);
              if (binding.name === "spec_from_file_location") pythonSpecLoaderAliases.add(binding.alias);
            }
            if (moduleName === "importlib" && binding.name === "util") pythonImportlibAliases.add(binding.alias);
            if (moduleName === "importlib" && binding.name === "machinery") pythonMachineryAliases.add(binding.alias);
            if (moduleName === "importlib.machinery" && binding.name === "SourceFileLoader") pythonSourceFileLoaderAliases.add(binding.alias);
          }
        }
        const pythonModuleAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}=${PYTHON_DYNAMIC_GAP}(?:\(${PYTHON_DYNAMIC_GAP})*(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}\(${PYTHON_DYNAMIC_GAP}(["'])(importlib(?:\.${PYTHON_NAME})?|runpy|builtins)\3(?:${PYTHON_DYNAMIC_GAP},[^)]*)?${PYTHON_DYNAMIC_GAP}\)`, "gu");
        const pythonModuleMemberAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}=${PYTHON_DYNAMIC_GAP}(?:\(${PYTHON_DYNAMIC_GAP})*(${PYTHON_NAME}(?:${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}${PYTHON_NAME})*)${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}(import_module|__import__)${PYTHON_DYNAMIC_GAP}\((["'])(importlib(?:\.${PYTHON_NAME})?|runpy|builtins)\4(?:${PYTHON_DYNAMIC_GAP},[^)]*)?${PYTHON_DYNAMIC_GAP}\)`, "gu");
        const pythonSourceFileLoaderInstanceAliases = new Set<string>();
        let aliasSizes = "";
        while (true) {
        let moduleAliasesChanged = true;
        while (moduleAliasesChanged) {
          moduleAliasesChanged = false;
          for (const match of content.matchAll(pythonModuleAssignments)) {
            const matchStart = match.index ?? 0;
            const codeMatch = pythonContent.slice(matchStart, matchStart + match[0].length);
            const targetName = match[1];
            const loaderName = match[2];
            const moduleName = match[4];
            const loaderOffset = match[0].indexOf(loaderName ?? "");
            if (!targetName || !loaderName || !codeMatch.startsWith(targetName) || loaderOffset < 0 || codeMatch.slice(loaderOffset, loaderOffset + loaderName.length) !== loaderName) continue;
            if (!targetName || !loaderName || !moduleName || !pythonDynamicImportNames.has(loaderName)) continue;
            if (moduleName === "runpy" && !pythonRunpyAliases.has(targetName)) {
              pythonRunpyAliases.add(targetName);
              moduleAliasesChanged = true;
            }
            if (moduleName === "builtins" && !pythonBuiltinsAliases.has(targetName)) {
              pythonBuiltinsAliases.add(targetName);
              moduleAliasesChanged = true;
            }
            if (moduleName.startsWith("importlib") && !pythonImportlibAliases.has(targetName)) {
              pythonImportlibAliases.add(targetName);
              moduleAliasesChanged = true;
            }
            if (moduleName === "importlib.machinery" && !pythonMachineryAliases.has(targetName)) {
              pythonMachineryAliases.add(targetName);
              moduleAliasesChanged = true;
            }
          }
        }
        for (const match of content.matchAll(pythonModuleMemberAssignments)) {
          const matchStart = match.index ?? 0;
          const codeMatch = pythonContent.slice(matchStart, matchStart + match[0].length);
          const targetName = match[1];
          const receiverName = match[2]?.replace(/\\[ \t]*(?:\r\n|\r|\n)/g, "").replace(/\s+/g, "");
          const memberName = match[3];
          const moduleName = match[5];
          const receiverRoot = receiverName?.split(".")[0];
          const validReceiver = (memberName === "import_module" && receiverRoot !== undefined && pythonImportlibAliases.has(receiverRoot)) ||
            (memberName === "__import__" && receiverRoot !== undefined && pythonBuiltinsAliases.has(receiverRoot));
          if (!targetName || !receiverName || !memberName || !moduleName || !validReceiver || !codeMatch.startsWith(targetName)) continue;
          if (moduleName === "runpy" && !pythonRunpyAliases.has(targetName)) pythonRunpyAliases.add(targetName);
          if (moduleName === "builtins" && !pythonBuiltinsAliases.has(targetName)) pythonBuiltinsAliases.add(targetName);
          if (moduleName.startsWith("importlib") && !pythonImportlibAliases.has(targetName)) pythonImportlibAliases.add(targetName);
          if (moduleName === "importlib.machinery" && !pythonMachineryAliases.has(targetName)) pythonMachineryAliases.add(targetName);
        }
        const pythonLoaderAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})${PYTHON_DYNAMIC_GAP}=${PYTHON_DYNAMIC_GAP}(?:(?:\(${PYTHON_DYNAMIC_GAP})*(${PYTHON_NAME}(?:${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}${PYTHON_NAME})*)${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}(import_module|__import__|spec_from_file_location|module_from_spec|exec_module|run_path|run_module|load_module|SourceFileLoader)(?:${PYTHON_DYNAMIC_GAP}\))*|(?:\(${PYTHON_DYNAMIC_GAP})*(${PYTHON_NAME})(?:${PYTHON_DYNAMIC_GAP}\))*)`, "gu");
        const sourceFileLoaderNames = [...pythonSourceFileLoaderAliases].map(escapeRegExp).join("|");
        const machinerySourceFileLoaderNames = [...pythonMachineryAliases].map(escapeRegExp).join("|");
        const pythonSourceLoaderInstanceAssignments = sourceFileLoaderNames || machinerySourceFileLoaderNames
          ? new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})\s*=\s*(?:(?:${machinerySourceFileLoaderNames})\s*\.\s*)?(?:${sourceFileLoaderNames || "SourceFileLoader"})\s*\(`, "gu")
          : undefined;
        for (const match of pythonContent.matchAll(pythonSourceLoaderInstanceAssignments ?? /$^/g)) {
          if (match[1]) pythonSourceFileLoaderInstanceAliases.add(match[1]);
        }
        let loaderAliasesChanged = true;
        while (loaderAliasesChanged) {
          loaderAliasesChanged = false;
          const builtinNames = [...new Set(["__builtins__", ...pythonBuiltinsAliases, ...pythonBuiltinsDictAliases])].map(escapeRegExp).join("|");
          const pythonBuiltinAccessAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})\s*=\s*(?:getattr\s*\(\s*(?:${builtinNames})\s*,\s*(["'])(__import__|import_module)\2\s*\)|(?:${builtinNames})\s*\[\s*(["'])(__import__|import_module)\4\s*\])`, "gu");
          for (const match of content.matchAll(pythonBuiltinAccessAssignments)) {
            const targetName = match[1];
            const memberName = match[3] ?? match[5];
            if (!targetName || !memberName) continue;
            if (!pythonDynamicImportNames.has(targetName)) {
              pythonDynamicImportNames.add(targetName);
              loaderAliasesChanged = true;
            }
            if (memberName === "__import__" && !pythonBuiltinImportNames.has(targetName)) {
              pythonBuiltinImportNames.add(targetName);
              loaderAliasesChanged = true;
            }
          }
          const pythonBuiltinsDictionaryAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})\s*=\s*vars\s*\(\s*(?:${builtinNames})\s*\)`, "gu");
          for (const match of pythonContent.matchAll(pythonBuiltinsDictionaryAssignments)) {
            const targetName = match[1];
            if (targetName) pythonBuiltinsDictAliases.add(targetName);
          }
          for (const match of pythonContent.matchAll(pythonLoaderAssignments)) {
            const targetName = match[1];
            const receiverName = match[2];
            const memberName = match[3];
            const directName = match[4];
            const receiverPath = receiverName?.replace(/\s+/g, "");
            const receiverRoot = receiverPath?.split(".")[0];
            const isImportlibReceiver = receiverRoot !== undefined && pythonImportlibAliases.has(receiverRoot);
            const isRunpyReceiver = receiverRoot !== undefined && pythonRunpyAliases.has(receiverRoot);
            const isMachineryReceiver = receiverRoot !== undefined && pythonMachineryAliases.has(receiverRoot);
            const isSpecReceiver = receiverRoot !== undefined && pythonSpecLoaderAliases.has(receiverRoot);
            const isSourceLoaderReceiver = receiverRoot !== undefined && pythonSourceFileLoaderAliases.has(receiverRoot);
            const isImportlibLoader = isImportlibReceiver && memberName === "import_module";
            const isBuiltinsLoader = receiverRoot !== undefined && memberName === "__import__" && pythonBuiltinsAliases.has(receiverRoot);
            const isDirectLoader = directName !== undefined && pythonDynamicImportNames.has(directName);
            const isDirectBuiltinImport = directName !== undefined && pythonBuiltinImportNames.has(directName);
            const isImportlibAlias = directName !== undefined && pythonImportlibAliases.has(directName);
            const isBuiltinsAlias = directName !== undefined && pythonBuiltinsAliases.has(directName);
            const isRunpyAlias = directName !== undefined && pythonRunpyAliases.has(directName);
            const isFileLoaderAlias = directName !== undefined && pythonFileLoaderAliases.has(directName);
            const isRunpyLoader = isRunpyReceiver && (memberName === "run_path" || memberName === "run_module");
            const isImportlibFileLoader = (isImportlibReceiver || isMachineryReceiver) && memberName !== undefined && pythonFileLoaderMemberNames.has(memberName);
            const isSpecFileLoader = isSpecReceiver && memberName === "exec_module";
            const isSourceFileLoaderInstance = receiverRoot !== undefined && pythonSourceFileLoaderInstanceAliases.has(receiverRoot) &&
              (memberName === "load_module" || memberName === "exec_module");
            const isSourceFileLoader = isSourceLoaderReceiver && (memberName === "load_module" || memberName === "exec_module");
            if (targetName && isImportlibAlias && !pythonImportlibAliases.has(targetName)) {
              pythonImportlibAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && isBuiltinsAlias && !pythonBuiltinsAliases.has(targetName)) {
              pythonBuiltinsAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && isRunpyAlias && !pythonRunpyAliases.has(targetName)) {
              pythonRunpyAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && isFileLoaderAlias && !pythonFileLoaderAliases.has(targetName)) {
              pythonFileLoaderAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && directName !== undefined && pythonSpecLoaderAliases.has(directName) && !pythonSpecLoaderAliases.has(targetName)) {
              pythonSpecLoaderAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && memberName === "spec_from_file_location" && isImportlibReceiver && !pythonSpecLoaderAliases.has(targetName)) {
              pythonSpecLoaderAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && (isRunpyLoader || isImportlibFileLoader || isSpecFileLoader || isSourceFileLoader || isSourceFileLoaderInstance) && !pythonFileLoaderAliases.has(targetName)) {
              pythonFileLoaderAliases.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && (isImportlibLoader || isBuiltinsLoader || isDirectLoader) && !pythonDynamicImportNames.has(targetName)) {
              pythonDynamicImportNames.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && isDirectBuiltinImport && !pythonBuiltinImportNames.has(targetName)) {
              pythonBuiltinImportNames.add(targetName);
              loaderAliasesChanged = true;
            }
            if (targetName && isBuiltinsLoader && !pythonBuiltinImportNames.has(targetName)) {
              pythonBuiltinImportNames.add(targetName);
              loaderAliasesChanged = true;
            }
          }
        }
        let returnedModuleAliasesChanged = true;
        while (returnedModuleAliasesChanged) {
          returnedModuleAliasesChanged = false;
          for (const match of content.matchAll(pythonModuleAssignments)) {
            const matchStart = match.index ?? 0;
            const codeMatch = pythonContent.slice(matchStart, matchStart + match[0].length);
            const targetName = match[1];
            const loaderName = match[2];
            const moduleName = match[4];
            const loaderOffset = match[0].indexOf(loaderName ?? "");
            if (!targetName || !loaderName || !moduleName || !codeMatch.startsWith(targetName) || loaderOffset < 0 || codeMatch.slice(loaderOffset, loaderOffset + loaderName.length) !== loaderName) continue;
            if (!pythonDynamicImportNames.has(loaderName)) continue;
            if (moduleName === "runpy" && !pythonRunpyAliases.has(targetName)) {
              pythonRunpyAliases.add(targetName);
              returnedModuleAliasesChanged = true;
            }
            if (moduleName === "builtins" && !pythonBuiltinsAliases.has(targetName)) {
              pythonBuiltinsAliases.add(targetName);
              returnedModuleAliasesChanged = true;
            }
            if (moduleName.startsWith("importlib") && !pythonImportlibAliases.has(targetName)) {
              pythonImportlibAliases.add(targetName);
              returnedModuleAliasesChanged = true;
            }
            if (moduleName === "importlib.machinery" && !pythonMachineryAliases.has(targetName)) {
              pythonMachineryAliases.add(targetName);
              returnedModuleAliasesChanged = true;
            }
          }
        }
        const nextAliasSizes = [pythonDynamicImportNames.size, pythonBuiltinImportNames.size, pythonImportlibAliases.size, pythonBuiltinsAliases.size, pythonMachineryAliases.size, pythonRunpyAliases.size, pythonFileLoaderAliases.size, pythonSpecLoaderAliases.size].join(",");
        if (nextAliasSizes === aliasSizes) break;
        aliasSizes = nextAliasSizes;
        }
        let execAliasesChanged = true;
        while (execAliasesChanged) {
          execAliasesChanged = false;
          const pythonExecAliasAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})\s*=\s*(?:\(\s*)*(${PYTHON_NAME})(?:\s*\))*(?![\p{ID_Continue}])`, "gu");
          for (const match of pythonContent.matchAll(pythonExecAliasAssignments)) {
            const targetName = match[1];
            const sourceName = match[2];
            if (targetName && sourceName && pythonExecNames.has(sourceName) && !pythonExecNames.has(targetName)) {
              pythonExecNames.add(targetName);
              execAliasesChanged = true;
            }
          }
          const pythonBuiltinExecAliasAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})\s*=\s*(?:\(\s*)*(?:${[...pythonBuiltinsAliases].map(escapeRegExp).join("|")})${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}(?:exec|eval)\b(?:\s*\))*`, "gu");
          for (const match of pythonContent.matchAll(pythonBuiltinExecAliasAssignments)) {
            const targetName = match[1];
            if (targetName && !pythonExecNames.has(targetName)) {
              pythonExecNames.add(targetName);
              execAliasesChanged = true;
            }
          }
          const pythonBuiltinExecAccessAliasAssignments = new RegExp(String.raw`(?<![\p{ID_Continue}])(${PYTHON_NAME})\s*=\s*(?:getattr\s*\(\s*(?:${[...pythonBuiltinsAliases].map(escapeRegExp).join("|")})\s*,\s*(["'])(?:exec|eval)\2\s*\)|(?:${[...pythonBuiltinsAliases, ...pythonBuiltinsDictAliases].map(escapeRegExp).join("|")})\s*\[\s*(["'])(?:exec|eval)\3\s*\])`, "gu");
          for (const match of content.matchAll(pythonBuiltinExecAccessAliasAssignments)) {
            const matchStart = match.index ?? 0;
            if (!/\S/u.test(pythonContent[matchStart] ?? "")) continue;
            const targetName = match[1];
            if (targetName && !pythonExecNames.has(targetName)) {
              pythonExecNames.add(targetName);
              execAliasesChanged = true;
            }
          }
        }
        const pythonExecAliases = [...pythonExecNames].map(escapeRegExp).join("|");
        const pythonBuiltinExecAliases = [...pythonBuiltinsAliases].map(escapeRegExp).join("|");
        const pythonBuiltinExecAccessAliases = [...pythonBuiltinsAliases, ...pythonBuiltinsDictAliases].map(escapeRegExp).join("|");
        const pythonExecCall = new RegExp(String.raw`(?<![\p{ID_Continue}.])(?:${pythonExecAliases})${PYTHON_DYNAMIC_GAP}\(`, "u");
        const pythonWrappedExecCall = new RegExp(String.raw`\(\s*(?:\(\s*)*(?:${pythonExecAliases})\s*(?:\)\s*)+\(`, "u");
        const pythonBuiltinExecCall = new RegExp(String.raw`(?:\(\s*)*(?:${pythonBuiltinExecAliases})${PYTHON_DYNAMIC_GAP}\.${PYTHON_DYNAMIC_GAP}(?:exec|eval)${PYTHON_DYNAMIC_GAP}(?:\)\s*)*\(`, "u");
        const pythonBuiltinExecAccessCall = new RegExp(String.raw`(?:getattr\s*\(\s*(?:${pythonBuiltinExecAliases})\s*,\s*["'](?:exec|eval)["']\s*\)|(?:${pythonBuiltinExecAccessAliases})\s*\[\s*["'](?:exec|eval)["']\s*\])\s*\(`, "u");
        const pythonRawPatternMatchesCode = (pattern: RegExp, source: string, code: string): boolean => {
          const globalPattern = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
          for (const match of source.matchAll(globalPattern)) {
            const matchStart = match.index ?? 0;
            const nonWhitespaceOffset = match[0].search(/\S/u);
            const start = matchStart + (nonWhitespaceOffset < 0 ? 0 : nonWhitespaceOffset);
            if (/\S/u.test(code[start] ?? "")) return true;
          }
          return false;
        };
        if (pythonDynamicSources.some(({ code, source }) => pythonExecCall.test(code) || pythonWrappedExecCall.test(code) || pythonBuiltinExecCall.test(code) || pythonRawPatternMatchesCode(pythonBuiltinExecAccessCall, source, code))) {
          hasUnverifiableDynamicPythonImport = true;
        }
        const fileLoaderAliases = [...pythonFileLoaderAliases].map(escapeRegExp).join("|");
        const runpyAliases = [...pythonRunpyAliases].map(escapeRegExp).join("|");
        const importlibAliases = [...pythonImportlibAliases].map(escapeRegExp).join("|");
        const machineryAliases = [...pythonMachineryAliases].map(escapeRegExp).join("|");
        const specLoaderAliases = [...pythonSpecLoaderAliases].map(escapeRegExp).join("|");
        const sourceFileLoaderAliases = [...pythonSourceFileLoaderAliases].map(escapeRegExp).join("|");
        const sourceFileLoaderInstanceAliases = [...pythonSourceFileLoaderInstanceAliases].map(escapeRegExp).join("|");
        const pythonAliasBoundary = (aliases: string): string => "(?<![\\p{ID_Continue}])(?:" + aliases + ")(?![\\p{ID_Continue}])";
        const pythonFileLoaderAliasCall = fileLoaderAliases ? new RegExp(pythonAliasBoundary(fileLoaderAliases) + "\\s*\\(", "u") : undefined;
        const pythonFileLoaderWrappedAliasCall = fileLoaderAliases ? new RegExp("\\(\\s*" + pythonAliasBoundary(fileLoaderAliases) + "\\s*\\)\\s*\\(", "u") : undefined;
        const pythonRunpyLoaderCall = runpyAliases ? new RegExp(pythonAliasBoundary(runpyAliases) + "\\s*\\.\\s*(?:run_path|run_module)\\s*\\(", "u") : undefined;
        const pythonImportlibFileLoaderCall = importlibAliases ? new RegExp(pythonAliasBoundary(importlibAliases) + "(?:\\s*\\.\\s*[\\p{ID_Start}_][\\p{ID_Continue}]*)*\\s*\\.\\s*(?:spec_from_file_location|module_from_spec)\\s*\\(", "u") : undefined;
        const pythonSpecFileLoaderCall = specLoaderAliases ? new RegExp(pythonAliasBoundary(specLoaderAliases) + "\\s*\\.\\s*loader\\s*\\.\\s*exec_module\\s*\\(", "u") : undefined;
        const pythonSourceFileLoaderCall = sourceFileLoaderAliases ? new RegExp(pythonAliasBoundary(sourceFileLoaderAliases) + "\\s*\\([^\\n]*\\)\\s*\\.\\s*(?:load_module|exec_module)\\s*\\(", "u") : undefined;
        const pythonSourceFileLoaderInstanceCall = sourceFileLoaderInstanceAliases ? new RegExp(pythonAliasBoundary(sourceFileLoaderInstanceAliases) + "\\s*\\.\\s*(?:load_module|exec_module)\\s*\\(", "u") : undefined;
        const pythonQualifiedSourceFileLoaderCall = machineryAliases ? new RegExp(pythonAliasBoundary(machineryAliases) + "\\s*\\.\\s*SourceFileLoader\\s*\\([^\\n]*\\)\\s*\\.\\s*(?:load_module|exec_module)\\s*\\(", "u") : undefined;
        const pythonImportedSourceFileLoaderCall = importlibAliases ? new RegExp(pythonAliasBoundary(importlibAliases) + "(?:\\s*\\.\\s*[\\p{ID_Start}_][\\p{ID_Continue}]*)*\\s*\\.\\s*SourceFileLoader\\s*\\([^\\n]*\\)\\s*\\.\\s*(?:load_module|exec_module)\\s*\\(", "u") : undefined;
        if (pythonDynamicSources.some(({ code }) => (pythonFileLoaderAliasCall?.test(code) ?? false) ||
          (pythonFileLoaderWrappedAliasCall?.test(code) ?? false) ||
          (pythonRunpyLoaderCall?.test(code) ?? false) ||
          (pythonImportlibFileLoaderCall?.test(code) ?? false) ||
          (pythonSpecFileLoaderCall?.test(code) ?? false) ||
          (pythonSourceFileLoaderCall?.test(code) ?? false) ||
          (pythonSourceFileLoaderInstanceCall?.test(code) ?? false) ||
          (pythonQualifiedSourceFileLoaderCall?.test(code) ?? false) ||
          (pythonImportedSourceFileLoaderCall?.test(code) ?? false))) {
          hasUnverifiableDynamicPythonImport = true;
        }
        const checkPythonSpecifier = (specifier: string, boundary?: string): void => {
          checkImportSpecifier(repoRoot, path, relative, specifier, reportFinding, (resolved) => {
            enqueue(resolved, pythonSearchRoot);
            for (const initializer of pythonPackageInitializers(repoRoot, path, specifier, boundary)) enqueue(initializer, pythonSearchRoot);
          }, pythonImportCandidates);
        };
        const enqueuePythonInitializers = (specifier: string, boundary?: string): void => {
          for (const initializer of pythonPackageInitializers(repoRoot, path, specifier, boundary)) enqueue(initializer, pythonSearchRoot);
        };
        const pythonReferenceExists = (specifier: string): boolean => {
          return Boolean(resolveExistingFile(pythonImportCandidates(path, specifier)) || pythonNamespaceDirectory(repoRoot, path, specifier));
        };
        const checkPythonReference = (specifier: string, boundary?: string): boolean => {
          if (resolveExistingFile(pythonImportCandidates(path, specifier))) {
            checkPythonSpecifier(specifier, boundary);
            return true;
          }
          if (pythonNamespaceDirectory(repoRoot, path, specifier)) {
            enqueuePythonInitializers(specifier, boundary);
            return true;
          }
          return false;
        };
        const checkPythonDynamicImport = (moduleName: string | undefined, searchRoot: string = pythonSearchRoot): void => {
          if (!moduleName || !new RegExp(`^${PYTHON_NAME}(?:\\.${PYTHON_NAME})*$`, "u").test(moduleName)) {
            hasUnverifiableDynamicPythonImport = true;
            return;
          }
          const modulePath = moduleName.replaceAll(".", "/");
          const moduleSpecifier = pythonSearchSpecifier(path, searchRoot, modulePath);
          const topSpecifier = pythonSearchSpecifier(path, searchRoot, modulePath.split("/")[0] ?? modulePath);
          if (!pythonReferenceExists(topSpecifier)) return;
          if (!checkPythonReference(moduleSpecifier, searchRoot)) checkPythonSpecifier(moduleSpecifier, searchRoot);
        };
        const checkPythonDynamicFromlist = (moduleName: string, name: string, searchRoot: string = pythonSearchRoot): void => {
          const moduleSpecifier = pythonSearchSpecifier(path, searchRoot, moduleName.replaceAll(".", "/"));
          const initializer = pythonModuleInitializer(repoRoot, path, moduleSpecifier);
          const namespace = pythonNamespaceDirectory(repoRoot, path, moduleSpecifier);
          if (!initializer && !namespace) return;
          if (initializer && pythonInitializerExportsName(initializer, name)) return;
          checkPythonDynamicImport(`${moduleName}.${name}`, searchRoot);
        };
        const checkPythonImportArguments = (argumentsList: string[]): void => {
          const argument = argumentsList[0]?.match(new RegExp(String.raw`^[ \t\f\v\r\n]*(?:["'])(${PYTHON_NAME}(?:\.${PYTHON_NAME})*)(?:["'])$`, "u"));
          const moduleName = argument?.[1];
          if (!moduleName) {
            hasUnverifiableDynamicPythonImport = true;
            return;
          }
          if (argumentsList.some((value) => value.trim().startsWith("**"))) {
            hasUnverifiableDynamicPythonImport = true;
            return;
          }
          const namedLevel = argumentsList.find((value) => /^level\s*=/.test(value.trim()));
          const positionalLevel = argumentsList.length > 4 ? argumentsList[4] : undefined;
          const levelValue = namedLevel?.replace(/^level\s*=\s*/, "") ?? positionalLevel;
          let searchRoot = pythonSearchRoot;
          if (levelValue !== undefined) {
            const normalizedLevel = levelValue.trim();
            if (!/^\d+$/.test(normalizedLevel)) {
              hasUnverifiableDynamicPythonImport = true;
              return;
            }
            const level = Number(normalizedLevel);
            if (!Number.isSafeInteger(level) || level > 256) {
              hasUnverifiableDynamicPythonImport = true;
              return;
            }
            if (level > 0) searchRoot = pythonRelativeBaseDirectory(path, ".".repeat(level));
          }
          checkPythonDynamicImport(moduleName, searchRoot);
          const namedFromlist = argumentsList.find((value) => /^fromlist\s*=/.test(value.trim()));
          const positionalFromlist = argumentsList.length > 3 ? argumentsList[3] : undefined;
          const fromlistValue = namedFromlist?.replace(/^fromlist\s*=\s*/, "") ?? positionalFromlist;
          if (fromlistValue === undefined) return;
          const fromlist = pythonStaticFromlist(fromlistValue);
          if (fromlist === null || fromlist.some((name) => name === "*")) {
            hasUnverifiableDynamicPythonImport = true;
            return;
          }
          for (const name of fromlist) checkPythonDynamicFromlist(moduleName, name, searchRoot);
        };
        const checkPythonBuiltinAccess = (code: string, source: string): void => {
          const builtinNames = [...new Set([...pythonBuiltinsAliases, ...pythonBuiltinsDictAliases])].map(escapeRegExp).join("|");
          const access = new RegExp(String.raw`(?<![\p{ID_Continue}.])(?:getattr\s*\(\s*(?:${builtinNames})\s*,\s*["']__import__["']\s*\)|(?:${builtinNames})\s*\[\s*["']__import__["']\s*\])\s*\(`, "gu");
          const knownLoaderNames = new Set([...pythonDynamicImportNames, ...pythonBuiltinsAliases, ...pythonBuiltinsDictAliases]);
          for (const match of source.matchAll(access)) {
            const start = match.index ?? 0;
            const openIndex = start + match[0].length - 1;
            const codePrefix = code.slice(start, start + match[0].length);
            if (!codePrefix.startsWith("getattr") && !new RegExp(String.raw`^(?:${builtinNames})`, "u").test(codePrefix)) continue;
            const builtinName = code.slice(start, openIndex).match(new RegExp(String.raw`(?:${builtinNames})`, "u"))?.[0];
            if (builtinName && pythonNameShadowedAt(code, openIndex, builtinName, knownLoaderNames)) continue;
            let depth = 0;
            let closeIndex = -1;
            for (let index = openIndex; index < code.length; index += 1) {
              if (code[index] === "(") depth += 1;
              if (code[index] === ")") {
                depth -= 1;
                if (depth === 0) {
                  closeIndex = index;
                  break;
                }
              }
            }
            const argumentsList = pythonCallArguments(source.slice(openIndex + 1, closeIndex < 0 ? source.length : closeIndex));
            checkPythonImportArguments(argumentsList);
          }
        };
        const checkPythonDynamicCall = (code: string, source: string, directName: string | undefined, receiverName: string | undefined, memberName: string | undefined, openIndex: number): void => {
          const normalizedReceiverName = receiverName?.replace(/\\[ \t]*(?:\r\n|\r|\n)/g, "").replace(/\s+/g, "");
          const receiverRoot = normalizedReceiverName?.split(".")[0];
          const knownLoaderNames = new Set([
            ...pythonDynamicImportNames,
            ...pythonImportlibAliases,
            ...pythonBuiltinsAliases,
            ...pythonBuiltinsDictAliases,
            ...pythonRunpyAliases,
            ...pythonMachineryAliases,
            ...pythonFileLoaderAliases,
            ...pythonSpecLoaderAliases,
            ...pythonSourceFileLoaderAliases,
            ...pythonSourceFileLoaderInstanceAliases,
          ]);
          if ((directName && pythonNameShadowedAt(code, openIndex, directName, knownLoaderNames)) ||
            (receiverRoot && pythonNameShadowedAt(code, openIndex, receiverRoot, knownLoaderNames))) return;
          const isDynamicImportCall = directName !== undefined && pythonDynamicImportNames.has(directName);
          const isImportlibMemberCall = normalizedReceiverName !== undefined && memberName === "import_module" && pythonImportlibAliases.has(normalizedReceiverName.split(".")[0] ?? normalizedReceiverName);
          const isBuiltinsImportCall = (directName !== undefined && pythonBuiltinImportNames.has(directName)) ||
            (normalizedReceiverName !== undefined && memberName === "__import__" && new Set([...pythonBuiltinsAliases, ...pythonBuiltinsDictAliases]).has(normalizedReceiverName.split(".")[0] ?? normalizedReceiverName));
          if (!isDynamicImportCall && !isImportlibMemberCall && !isBuiltinsImportCall) return;
          if (openIndex < 0) {
            checkPythonDynamicImport(undefined);
            return;
          }
          let depth = 0;
          let closeIndex = -1;
          for (let index = openIndex; index < code.length; index += 1) {
            if (code[index] === "(") depth += 1;
            if (code[index] === ")") {
              depth -= 1;
              if (depth === 0) {
                closeIndex = index;
                break;
              }
            }
          }
          if (closeIndex < 0) {
            checkPythonDynamicImport(undefined);
            return;
          }
          const argumentsList = pythonCallArguments(source.slice(openIndex + 1, closeIndex));
          if (isBuiltinsImportCall) {
            checkPythonImportArguments(argumentsList);
          } else {
            const argument = argumentsList[0]?.match(new RegExp(String.raw`^[ \t\f\v\r\n]*(["'])(${PYTHON_NAME}(?:\.${PYTHON_NAME})*)\1$`, "u"));
            checkPythonDynamicImport(argument?.[2]);
          }
        };
        for (const { code, source } of pythonDynamicSources) {
          checkPythonBuiltinAccess(code, source);
          const dynamicCalls: Array<{ start: number; directName?: string; receiverName?: string; memberName?: string; openIndex: number }> = [];
          for (const match of code.matchAll(PYTHON_DYNAMIC_CALL)) {
            const start = match.index ?? 0;
            const openIndex = code.indexOf("(", start);
            dynamicCalls.push({ start, openIndex, directName: match[1], receiverName: match[2], memberName: match[3] });
          }
          for (const match of code.matchAll(PYTHON_DYNAMIC_WRAPPED_MEMBER_CALL)) {
            const start = match.index ?? 0;
            const openIndex = start + match[0].length - 1;
            dynamicCalls.push({ start, openIndex, receiverName: match[1], memberName: match[2] });
          }
          for (const match of code.matchAll(PYTHON_DYNAMIC_WRAPPED_CALL)) {
            const start = match.index ?? 0;
            const openIndex = start + match[0].length - 1;
            dynamicCalls.push({ start, openIndex, directName: match[1] });
          }
          dynamicCalls.sort((left, right) => left.start - right.start);
          for (const call of dynamicCalls) {
            checkPythonDynamicCall(code, source, call.directName, call.receiverName, call.memberName, call.openIndex);
          }
        }
        if (hasUnverifiableDynamicPythonImport) {
          reportFinding(`${relative}: dynamic Python import cannot be verified`);
        }
        const scanPythonWildcard = (packageSpecifier: string, initializer: string | undefined, boundary?: string): void => {
          if (!initializer) return;
          const names = pythonInitializerAllNames(initializer);
          if (names === null) {
            reportFinding(`${relative}: wildcard Python import cannot be verified`);
            return;
          }
          for (const name of names ?? []) {
            if (pythonInitializerExportsName(initializer, name)) continue;
            const specifier = `${packageSpecifier}/${name}`;
            if (pythonReferenceExists(specifier)) checkPythonReference(specifier, boundary);
            else checkPythonSpecifier(specifier, boundary);
          }
        };
        for (const match of pythonContent.matchAll(PYTHON_RELATIVE_IMPORT)) {
          const moduleSpecifier = pythonNormalizeImportName(match[1] ?? "");
          const importedNames = match[2];
          if (moduleSpecifier && importedNames) {
            const specifiers = pythonRelativeSpecifiers(moduleSpecifier, importedNames);
            const moduleName = moduleSpecifier.replace(/^\.+/, "");
            const moduleSpecifierPath = moduleName ? specifiers[0] : undefined;
            const names = pythonImportedNames(importedNames);
            const initializer = join(pythonRelativeBaseDirectory(path, moduleSpecifier), "__init__.py");
            const moduleInitializer = moduleSpecifierPath ? pythonModuleInitializer(repoRoot, path, moduleSpecifierPath) : undefined;
            const moduleNamespace = moduleSpecifierPath ? pythonNamespaceDirectory(repoRoot, path, moduleSpecifierPath) : undefined;
            if (!moduleName) enqueuePythonInitializers(pythonPackageInitializerSpecifier(moduleSpecifier));
            for (const [index, specifier] of specifiers.entries()) {
              if (!moduleName && names[index] === "*") continue;
              const importedName = moduleName ? names[index - 1] : names[index];
              const targetInitializer = moduleInitializer ?? (isPathInside(repoRoot, initializer) && isDirectRegularFile(initializer) ? initializer : undefined);
              if (specifier !== moduleSpecifierPath && importedName && targetInitializer && pythonInitializerExportsName(targetInitializer, importedName)) continue;
              if (checkPythonReference(specifier)) continue;
              if (specifier === moduleSpecifierPath) {
                checkPythonSpecifier(specifier);
              } else if (!moduleName && names[index] &&
                (!isPathInside(repoRoot, initializer) || !isDirectRegularFile(initializer) || !pythonInitializerExportsName(initializer, names[index]))) {
                checkPythonSpecifier(specifier);
              } else if (moduleName && names[index - 1] && names[index - 1] !== "*" &&
                ((moduleNamespace && !moduleInitializer) || (moduleInitializer && !pythonInitializerExportsName(moduleInitializer, names[index - 1])))) {
                checkPythonSpecifier(specifier);
              }
            }
            if (names.includes("*")) {
              if (!moduleName) checkPythonSpecifier(pythonPackageInitializerSpecifier(moduleSpecifier));
              const packageSpecifier = moduleSpecifierPath ?? (pythonRelativeSpecifier(path, pythonRelativeBaseDirectory(path, moduleSpecifier)).replace(/\/$/, "") || ".");
              scanPythonWildcard(packageSpecifier, moduleInitializer ?? (isPathInside(repoRoot, initializer) && isDirectRegularFile(initializer) ? initializer : undefined));
            }
          }
        }
        for (const match of pythonContent.matchAll(PYTHON_FROM_IMPORT)) {
          const moduleName = pythonNormalizeImportName(match[1] ?? "");
          const importedNames = match[2];
          if (moduleName && importedNames) {
            const modulePath = moduleName.replaceAll(".", "/");
            const moduleSpecifier = pythonSearchSpecifier(path, pythonSearchRoot, modulePath);
            const topSpecifier = pythonSearchSpecifier(path, pythonSearchRoot, modulePath.split("/")[0] ?? modulePath);
            if (!pythonReferenceExists(topSpecifier)) continue;
            const names = pythonImportedNames(importedNames);
            const moduleInitializer = pythonModuleInitializer(repoRoot, path, moduleSpecifier);
            const moduleNamespace = pythonNamespaceDirectory(repoRoot, path, moduleSpecifier);
            if (!checkPythonReference(moduleSpecifier, pythonSearchRoot)) {
              checkPythonSpecifier(moduleSpecifier, pythonSearchRoot);
              continue;
            }
            for (const name of names) {
              if (name === "*") continue;
              if (moduleInitializer && pythonInitializerExportsName(moduleInitializer, name)) continue;
              const specifier = `${moduleSpecifier}/${name}`;
              if (checkPythonReference(specifier, pythonSearchRoot)) continue;
              if (moduleInitializer || (moduleNamespace && !moduleInitializer)) {
                checkPythonSpecifier(specifier, pythonSearchRoot);
              }
            }
            if (names.includes("*")) {
              scanPythonWildcard(moduleSpecifier, moduleInitializer, pythonSearchRoot);
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
              if (!checkPythonReference(specifier, pythonSearchRoot)) checkPythonSpecifier(specifier, pythonSearchRoot);
            }
          }
        }
      }
      if (language === "shell") {
        const shellSources = shellSourceAnalysis(content);
        let dynamicSourceReported = shellSources.hasUnverifiableDynamicSource;
        if (dynamicSourceReported) {
          reportFinding(`${relative}: dynamic Shell source cannot be verified`);
        }
        let sourceWorkingDirectoryChanged = false;
        for (const source of shellSources.specifiers) {
          if (sourceWorkingDirectoryChanged) {
            if (!dynamicSourceReported) {
              reportFinding(`${relative}: dynamic Shell source cannot be verified`);
              dynamicSourceReported = true;
            }
            continue;
          }
          const specifier = RELATIVE_SPECIFIER.test(source) || ABSOLUTE_SPECIFIER.test(source) ? source : `./${source}`;
          if (shebangChangesWorkingDirectory(content) && !ABSOLUTE_SPECIFIER.test(source)) {
            if (!dynamicSourceReported) {
              reportFinding(`${relative}: dynamic Shell source cannot be verified`);
              dynamicSourceReported = true;
            }
            continue;
          }
          const existing = resolveExistingFile(shellImportCandidates(path, specifier, repoRoot));
          if (existing && isPathInside(repoRoot, existing) && shellSourceChangesWorkingDirectory(existing, repoRoot)) {
            if (!dynamicSourceReported) {
              reportFinding(`${relative}: dynamic Shell source cannot be verified`);
              dynamicSourceReported = true;
            }
            sourceWorkingDirectoryChanged = true;
          }
          checkImportSpecifier(repoRoot, path, relative, specifier, reportFinding, enqueue, shellImportCandidates);
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
