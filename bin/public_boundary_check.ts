#!/usr/bin/env bun
/** Reject private environment markers from public repository files. */

import { isDirectRegularFile, isPathInside, relativePath, REPO_ROOT, trackedFiles } from "./repo_util.ts";
import { lstatSync, readFileSync } from "node:fs";

export const FORBIDDEN_MARKERS = ["CODEX_" + "THREAD_ID"];
const SECRET_NAME = String.raw`(?:api[_-]?key|apikey|access[_-]?key|accesskey|token|secret|secret[_-]?key|secretkey|secret[_-]?access[_-]?key|secretaccesskey|password|passwd|private[_-]?key|privatekey|credential)`;
const COMPOUND_SECRET_NAME = String.raw`[A-Za-z0-9_-]*${SECRET_NAME}[A-Za-z0-9_-]*`;
const SECRET_VALUE = String.raw`(?![$<\{])[^'"\r\n]{16,}`;
const UNQUOTED_SECRET_VALUE = String.raw`(?!provided-out-of-band\b|redacted\b|placeholder\b|changeme\b)[A-Za-z0-9][A-Za-z0-9._~+/=-]{15,}`;
const REGEX_HELPER_ASSIGNMENT = new RegExp(String.raw`^[ \t]*(?:local[ \t]+)?(?:re|regex)[_-][A-Za-z0-9_-]*[ \t]*=`, "i");
const COMPOUND_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?<name>[A-Za-z0-9_-]+)\s*=\s*['"]${SECRET_VALUE}['"]`, "i");
const JSON_SECRET_FIELD = new RegExp(String.raw`["'](?<name>[A-Za-z0-9_-]+)["']\s*:\s*["']${SECRET_VALUE}["']`, "i");
const QUOTED_SECRET_FIELD = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?<name>${COMPOUND_SECRET_NAME})\s*:\s*["']${SECRET_VALUE}["']`, "i");
const YAML_BLOCK_SECRET_FIELD = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?<name>${COMPOUND_SECRET_NAME})\s*:\s*[|>][ \t]*(?:[1-9][-+]?|[-+]?[1-9]|[-+])?[ \t]*(?:#[^\r\n]*)?\r?\n[ \t]+${UNQUOTED_SECRET_VALUE}`, "i");
const UNQUOTED_SECRET_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?<name>${COMPOUND_SECRET_NAME})\s*[:=]\s*${UNQUOTED_SECRET_VALUE}(?![A-Za-z0-9._~+/=-])`, "i");
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----\r?\n(?:[ \t]*[A-Za-z0-9+/]{40,}={0,2}\r?\n(?:[ \t]*[A-Za-z0-9+/]{1,128}={0,2}\r?\n)*)[ \t]*-----END [A-Z0-9 _-]*PRIVATE KEY-----/;
const CREDENTIAL_URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]{16,}@/i;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i;
const SECRET_SUFFIXES = [
  "api_key", "apikey", "access_key", "accesskey", "token", "secret",
  "secret_key", "secretkey", "secret_access_key", "secretaccesskey", "password", "passwd",
  "private_key", "privatekey", "credential",
];

export const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["absolute-home-path", /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/](?:Users|home)[\\/])[A-Za-z0-9._-]+/i],
  ["private-hostname", /(?<![A-Za-z0-9.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|lan|local)\b/i],
  ["jwt-like-secret", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["quoted-secret-assignment", new RegExp(String.raw`(?<![A-Za-z0-9_-])${SECRET_NAME}\s*=\s*['"]${SECRET_VALUE}['"]`, "i")],
  ["prefixed-quoted-secret-assignment", COMPOUND_ASSIGNMENT],
  ["json-secret-field", JSON_SECRET_FIELD],
  ["quoted-secret-field", QUOTED_SECRET_FIELD],
  ["yaml-block-secret-field", YAML_BLOCK_SECRET_FIELD],
  ["unquoted-secret-assignment", UNQUOTED_SECRET_ASSIGNMENT],
  ["private-key-block", PRIVATE_KEY_BLOCK],
  ["credentialed-url", CREDENTIAL_URL],
  ["bearer-token", BEARER_TOKEN],
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
  const name = match.groups?.name ?? "";
  const hasRegexOperator = /(?:\||\[[^\]\r\n]*\]|\\.|[?+*]|\{\d+(?:,\d*)?\})/.test(match[0]);
  return REGEX_HELPER_ASSIGNMENT.test(`${name}=`) && hasRegexOperator && !/[0-9a-f]{16,}/i.test(match[0]);
}

function matchesPattern(label: string, pattern: RegExp, content: string): boolean {
  for (const match of content.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
    const value = match[0];
    if (IGNORED_PRIVATE_HOSTNAMES.has(value)) {
      continue;
    }
    if (label === "prefixed-quoted-secret-assignment" || label === "quoted-secret-field" || label === "yaml-block-secret-field" || label === "unquoted-secret-assignment") {
      const name = match.groups?.name ?? "";
      if (!isSecretField(name) || (label === "prefixed-quoted-secret-assignment" && isSimpleSecretField(name))) {
        continue;
      }
      if (label === "prefixed-quoted-secret-assignment" && isRegexHelperAssignment(content, match)) {
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
    try {
      if (lstatSync(path).isSymbolicLink()) {
        findings.push(`${relativePath(path, repoRoot)}: symbolic links are not allowed in public repository`);
        continue;
      }
    } catch (error) {
      findings.push(`${relativePath(path, repoRoot)}: cannot inspect tracked path: ${String(error)}`);
      continue;
    }
    if (!isPathInside(repoRoot, path)) {
      findings.push(`${relativePath(path, repoRoot)}: path escapes public repository`);
      continue;
    }
    if (!isDirectRegularFile(path)) {
      findings.push(`${relativePath(path, repoRoot)}: tracked path is not a regular file`);
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

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length > 0) {
    console.error("usage: public_boundary_check.ts");
    return 2;
  }
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
