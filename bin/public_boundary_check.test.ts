import { expect, test } from "bun:test";
import { check, FORBIDDEN_PATTERNS, isRegexHelperAssignment } from "./public_boundary_check.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function pattern(label: string): RegExp {
  const pattern = FORBIDDEN_PATTERNS.find(([name]) => name === label)?.[1];
  if (!pattern) throw new Error(`missing pattern ${label}`);
  return pattern;
}

test("detects secret assignments and ignores redacted placeholders", () => {
  const name = "api_" + "key";
  const fixtureValue = "0123456789abcdef";
  expect(pattern("quoted-secret-assignment").test(`${name}="${fixtureValue}"`)).toBe(true);
  expect(pattern("json-secret-field").test(`{"${name}":"<redacted>"}`)).toBe(false);
});

test("detects compound and punctuation-leading secret values", () => {
  const name = "DATABASE_" + "PASSWORD";
  const fixtureValue = "0123456789abcdef";
  const punctuationName = "pass" + "word";
  const punctuationValue = "!" + fixtureValue;
  expect(pattern("prefixed-quoted-secret-assignment").test(`${name}="${fixtureValue}"`)).toBe(true);
  expect(pattern("quoted-secret-assignment").test(`${punctuationName}="${punctuationValue}"`)).toBe(true);
});

test("recognizes explicit regex helper assignments", () => {
  const content = 'local re_english_write_token="(write|writes|writing)"';
  const match = pattern("prefixed-quoted-secret-assignment").exec(content);
  expect(match).not.toBeNull();
  if (match) expect(isRegexHelperAssignment(content, match)).toBe(true);
});

test("checks tracked public files", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-public-boundary-"));
  try {
    writeFileSync(join(root, "safe.md"), "neutral example\n");
    const result = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
