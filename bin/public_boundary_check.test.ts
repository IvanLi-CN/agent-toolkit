import { expect, test } from "bun:test";
import { check, FORBIDDEN_PATTERNS, isRegexHelperAssignment, main } from "./public_boundary_check.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  expect(pattern("json-secret-field").test(`{"${name}":"${fixtureValue}"}`)).toBe(true);
  expect(pattern("json-secret-field").test(`{"${name}":"<redacted>"}`)).toBe(false);
  expect(pattern("unquoted-secret-assignment").test(`${name}=0123456789abcdef`)).toBe(true);
  expect(pattern("unquoted-secret-assignment").test(`${name}: 0123456789abcdef`)).toBe(true);
  expect(pattern("unquoted-secret-assignment").test(`${name}=<redacted>`)).toBe(false);
  expect(pattern("unquoted-secret-assignment").test(`${name}=provided-out-of-band`)).toBe(false);
});

test("detects prefixed, lowercase, and compound secret assignments", () => {
  const fixtureValue = "0123456789abcdef";
  const names = [
    ["CVM_", "API_KEY"],
    ["DATABASE_", "PASSWORD"],
    ["database_", "password"],
    ["aws_", "secret_access_key"],
    ["database", "Password"],
    ["aws", "SecretAccessKey"],
    ["secret", "Key"],
    ["appDatabase", "Password"],
    ["serviceClient", "Secret"],
  ];
  for (const parts of names) {
    const name = parts.join("");
    expect(pattern("prefixed-quoted-secret-assignment").test(`${name}="${fixtureValue}"`)).toBe(true);
    expect(pattern("unquoted-secret-assignment").test(`${name}=${fixtureValue}`)).toBe(true);
  }
});

test("detects punctuation-leading secret values", () => {
  const fixtureValue = "0123456789abcdef";
  const name = "pass" + "word";
  for (const prefix of ["!", "(", "["]) {
    expect(pattern("quoted-secret-assignment").test(`${name}="${prefix}${fixtureValue}"`)).toBe(true);
  }
});

test("detects compound, camel-case, and Pascal-case JSON secret fields", () => {
  const fixtureValue = "0123456789abcdef";
  const names = [
    ["database_", "password"],
    ["aws_", "secret_access_key"],
    ["secret_", "key"],
    ["database", "Password"],
    ["client", "Secret"],
    ["aws", "SecretAccessKey"],
    ["secret", "Key"],
    ["Database", "Password"],
    ["Client", "Secret"],
    ["Aws", "SecretAccessKey"],
    ["Secret", "Key"],
  ];
  for (const parts of names) {
    const name = parts.join("");
    expect(pattern("json-secret-field").test(`{"${name}":"${fixtureValue}"}`)).toBe(true);
  }
});

test("recognizes explicit regex helper assignments", () => {
  const helperName = "re_english_write_" + "token";
  const content = `local ${helperName}="(write|writes|writing|modify)"`;
  const match = pattern("prefixed-quoted-secret-assignment").exec(content);
  expect(match).not.toBeNull();
  if (match) expect(isRegexHelperAssignment(content, match)).toBe(true);
});

test("does not exclude names that merely resemble regex helpers", () => {
  const fixtureValue = "0123456789abcdef";
  for (const parts of [["redis_", "password"], ["request_", "api_key"]]) {
    const content = `${parts.join("")}="(${fixtureValue}"`;
    const match = pattern("prefixed-quoted-secret-assignment").exec(content);
    expect(match).not.toBeNull();
    if (match) expect(isRegexHelperAssignment(content, match)).toBe(false);
  }
});

test("does not let a regex-helper name hide a literal secret", () => {
  const content = `${["pattern", "api_key"].join("_")}=\"(${"0123456789abcdef"}\"`;
  const match = pattern("prefixed-quoted-secret-assignment").exec(content);
  expect(match).not.toBeNull();
  if (match) expect(isRegexHelperAssignment(content, match)).toBe(false);
});

test("does not classify long hyphenated input as a secret assignment", () => {
  expect(pattern("prefixed-quoted-secret-assignment").test("a-".repeat(8000) + "!")).toBe(false);
});

test("matches complete private hostnames while allowing neutral local helper names", () => {
  const privateHostname = pattern("private-hostname");
  expect(privateHostname.test("config" + ".local")).toBe(true);
  expect(privateHostname.test("threading" + ".local")).toBe(true);
  expect(privateHostname.test("prod.config" + ".local")).toBe(true);
  expect(privateHostname.test("db." + "INTERNAL")).toBe(true);
});

test("detects Windows personal paths", () => {
  expect(pattern("absolute-home-path").test("C:\\Users\\fixture-user\\private.txt")).toBe(true);
});

test("detects credential-bearing URLs, bearer tokens, and complete PEM blocks", () => {
  const credential = "a".repeat(24);
  expect(pattern("credentialed-url").test("https://user:" + credential + "@example.test")).toBe(true);
  expect(pattern("bearer-token").test("Bearer " + credential)).toBe(true);
  expect(pattern("private-key-block").test("-----BEGIN " + "PRIVATE KEY-----\n" + "A".repeat(48) + "\n-----END " + "PRIVATE KEY-----")).toBe(true);
});

test("checks tracked public files", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-public-boundary-"));
  try {
    writeFileSync(join(root, "safe.md"), "neutral example\n");
    symlinkSync(join(root, "missing.md"), join(root, "linked.md"));
    const result = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(check(root)).toEqual(["linked.md: symbolic links are not allowed in public repository"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported public-boundary CLI options", () => {
  expect(main(["--unknown"])).toBe(2);
});
