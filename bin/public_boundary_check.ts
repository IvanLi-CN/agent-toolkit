#!/usr/bin/env bun
/** Reject private environment markers from public repository files. */

import { relativePath, REPO_ROOT, trackedFiles } from "./repo_util.ts";
import { existsSync, readFileSync } from "node:fs";

export const FORBIDDEN_MARKERS = ["CODEX_" + "THREAD_ID"];
const SECRET_NAME = String.raw`(?:api[_-]?key|apikey|access[_-]?key|accesskey|token|secret|secret[_-]?key|secretkey|secret[_-]?access[_-]?key|secretaccesskey|password|passwd|private[_-]?key|privatekey|credential)`;
const SECRET_VALUE = String.raw`(?![$<\{])[^'"\r\n]{16,}`;
const REGEX_HELPER_ASSIGNMENT = new RegExp(String.raw`^[ \t]*(?:local[ \t]+)?(?:re|regex|pattern)[_-][A-Za-z0-9_-]*[ \t]*=`, "i");
const COMPOUND_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?<name>[A-Za-z0-9_-]+)\s*=\s*['"]${SECRET_VALUE}['"]`, "i");
const JSON_SECRET_FIELD = new RegExp(String.raw`["'](?<name>[A-Za-z0-9_-]+)["']\s*:\s*["']${SECRET_VALUE}["']`, "i");
const SECRET_SUFFIXES = [
  "api_key", "apikey", "access_key", "accesskey", "token", "secret",
  "secret_key", "secretkey", "secret_access_key", "secretaccesskey", "password", "passwd",
  "private_key", "privatekey", "credential",
];

export const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["absolute-home-path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/],
  ["private-hostname", /\b[A-Za-z0-9-]+\.(?:internal|lan|local)\b/],
  ["jwt-like-secret", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["quoted-secret-assignment", new RegExp(String.raw`(?<![A-Za-z0-9_-])${SECRET_NAME}\s*=\s*['"]${SECRET_VALUE}['"]`, "i")],
  ["prefixed-quoted-secret-assignment", COMPOUND_ASSIGNMENT],
  ["json-secret-field", JSON_SECRET_FIELD],
];

const IGNORED_PRIVATE_HOSTNAMES = new Set(["config.local", "threading.local"]);

function normalizeSecretField(name: string): string {
  return name.replaceAll("-", "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function isSecretField(name: string): boolean {
  const normalized = normalizeSecretField(name);
  return SECRET_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`) || normalized.endsWith(suffix),
  );
}

function isSimpleSecretField(name: string): boolean {
  return SECRET_SUFFIXES.includes(normalizeSecretField(name));
}

export function isRegexHelperAssignment(content: string, match: RegExpExecArray): boolean {
  const lineStart = content.lastIndexOf("\n", match.index - 1) + 1;
  const nextLine = content.indexOf("\n", match.index + match[0].length);
  const lineEnd = nextLine < 0 ? content.length : nextLine;
  const line = content.slice(lineStart, lineEnd);
  return REGEX_HELPER_ASSIGNMENT.test(line) && /[([|]/.test(match[0]);
}

function matchesPattern(label: string, pattern: RegExp, content: string): boolean {
  for (const match of content.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
    const value = match[0];
    if (IGNORED_PRIVATE_HOSTNAMES.has(value)) {
      continue;
    }
    if (label === "prefixed-quoted-secret-assignment") {
      const name = match.groups?.name ?? "";
      if (!isSecretField(name) || isSimpleSecretField(name)) {
        continue;
      }
      if (isRegexHelperAssignment(content, match)) {
        continue;
      }
    }
    if (label === "json-secret-field" && !isSecretField(match.groups?.name ?? "")) {
      continue;
    }
    return true;
  }
  return false;
}

export function check(repoRoot: string = REPO_ROOT): string[] {
  const findings: string[] = [];
  for (const path of trackedFiles(repoRoot)) {
    if (!existsSync(path)) {
      continue;
    }
    const content = requireText(path);
    for (const marker of FORBIDDEN_MARKERS) {
      if (content.includes(marker)) {
        findings.push(`${relativePath(path, repoRoot)}: forbidden marker ${marker}`);
      }
    }
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (matchesPattern(label, pattern, content)) {
        findings.push(`${relativePath(path, repoRoot)}: forbidden pattern ${label}`);
      }
    }
  }
  return findings;
}

function requireText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${String(error)}`);
  }
}

export function main(): number {
  const findings = check();
  for (const finding of findings) {
    console.log(`FINDING ${finding}`);
  }
  if (findings.length > 0) {
    return 1;
  }
  console.log("PASS public boundary: no forbidden private markers");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
