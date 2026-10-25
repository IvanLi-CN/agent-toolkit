import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Execute the published examples, rather than maintaining a second installer.
const guide = readFileSync(new URL("./installation.md", import.meta.url), "utf8");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skill = "docs-no-revision-markers";
const roots: string[] = [];
function example(heading: string): string {
  const section = guide.slice(guide.indexOf(heading));
  const script = section.match(/```bash\n([\s\S]*?)\n```/u)?.[1];
  if (!script) throw new Error(`Missing Bash example: ${heading}`);
  return script;
}
const enable = example("## Direct source links");
const disable = example("## Disable and uninstall");
function fixture() {
  mkdirSync(join(repo, "tmp"), { recursive: true });
  const root = mkdtempSync(join(repo, "tmp", "installation-smoke-"));
  roots.push(root);
  const source = join(root, "source");
  const consumer = join(root, "consumer");
  const directory = join(source, "skills", skill);
  const target = join(consumer, skill);
  const ledger = join(consumer, ".agent-toolkit-links");
  const record = join(ledger, `${skill}.record`);
  const pending = join(ledger, `.${skill}.disable`);
  mkdirSync(directory, { recursive: true });
  mkdirSync(consumer);
  writeFileSync(join(directory, "SKILL.md"), "# Fixture Skill\n");
  const run = (script: string, prelude = "") => spawnSync("bash", ["-c", script
    .replace("TOOLKIT_SOURCE=/path/to/agent-toolkit", 'TOOLKIT_SOURCE="$SMOKE_SOURCE"')
    .replace("CONSUMER_SKILLS=/path/to/consumer/skills", 'CONSUMER_SKILLS="$SMOKE_CONSUMER"')
    .replace("set -eu", () => `set -eu\n${prelude}`)], {
    cwd: root,
    env: { ...process.env, SMOKE_SOURCE: source, SMOKE_CONSUMER: consumer },
    encoding: "utf8",
    timeout: 15_000,
  });
  const ok = (script: string, prelude = "") => {
    const result = run(script, prelude);
    expect(`${result.stdout}${result.stderr}`).not.toContain("unbound variable");
    expect(result.status, result.stderr).toBe(0);
  };
  const fail = (script: string, prelude = "") => {
    const result = run(script, prelude);
    expect(result.status, result.stdout).not.toBe(0);
    expect(existsSync(join(consumer, ".agent-toolkit-links.lock")), result.stderr).toBe(false);
    return result;
  };
  const absent = (path: string) => {
    expect(existsSync(path)).toBe(false);
    expect(() => lstatSync(path)).toThrow(); // Includes dangling symlinks.
  };
  return { root, source, consumer, directory, target, ledger, record, pending, run, ok, fail, absent };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("guide entrypoints and contract links resolve to local files and heading anchors", () => {
  const files = ["README.md", "CONTRIBUTING.md", "skills/README.md", "docs/specs/project-foundation/IMPLEMENTATION.md", "docs/adr/0028-language-and-runtime-policy.md",
    ...readdirSync(join(repo, "docs/guides")).filter((name) => name.endsWith(".md")).map((name) => `docs/guides/${name}`)];
  for (const name of files) {
    const text = readFileSync(join(repo, name), "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/gu)) {
      const href = match[1]!;
      if (/^[a-z]+:/iu.test(href)) continue;
      const [path, anchor] = href.split("#");
      const destination = path ? resolve(repo, dirname(name), decodeURIComponent(path)) : join(repo, name);
      expect(existsSync(destination), `${name}: ${href}`).toBe(true);
      if (anchor) {
        const headings = Array.from(readFileSync(destination, "utf8").matchAll(/^#{1,6} (.+)$/gmu), (heading) => heading[1]!
          .toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /gu, "-"));
        expect(headings, `${name}: ${href}`).toContain(decodeURIComponent(anchor));
      }
    }
  }
  const membership = readFileSync(join(repo, "PUBLIC_SKILLS.txt"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  expect(membership).toHaveLength(13);
  const groups = ["isolated-execution", "service-operations", "git-and-docs", "media-previews", "cad-repair"]
    .map((name) => readFileSync(join(repo, `docs/guides/${name}.md`), "utf8")).join("\n");
  for (const name of membership) expect(groups.split(`## ${name}\n`)).toHaveLength(2);
});

test("published enable/disable examples parse under the installed Bash", () => {
  for (const script of [enable, disable]) {
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  }
});

test("ownership carries source and symlink file identities; disable permits re-enable", () => {
  const f = fixture();
  f.ok(enable);
  const source = lstatSync(f.directory);
  const link = lstatSync(f.target);
  const record = readFileSync(f.record, "utf8");
  expect(record.trim().split("\n")).toHaveLength(7);
  expect(record).toContain(`source_file_id=${source.dev}:${source.ino}\n`);
  expect(record).toContain(`link_file_id=${link.dev}:${link.ino}\n`);
  expect(readlinkSync(f.target)).toBe(f.directory);
  f.ok(disable);
  f.absent(f.target);
  f.absent(f.record);
  f.absent(f.pending);
  f.ok(enable);
  f.ok(disable);
});

test("source replacement at the identical canonical pathname fails closed", () => {
  const f = fixture();
  f.ok(enable);
  const before = readFileSync(f.record, "utf8");
  // Retain the old inode so this scenario does not depend on inode reuse policy.
  renameSync(f.directory, `${f.directory}.old`);
  mkdirSync(f.directory);
  expect(f.fail(disable).stderr).toContain("source identity changed");
  expect(readFileSync(f.record, "utf8")).toBe(before);
  expect(lstatSync(f.target).isSymbolicLink()).toBe(true);
});

test("reconciliation removes an owned dangling link after source deletion", () => {
  const f = fixture();
  f.ok(enable);
  rmSync(f.directory, { recursive: true });
  f.ok(disable);
  f.absent(f.target);
  f.absent(f.record);
});

for (const phase of ["pending-directory", "pending-record", "captured-link", "removed-link", "removed-record"]) {
  test(`TERM after ${phase} leaves a resumable state and allows re-enable`, () => {
    const f = fixture();
    f.ok(enable);
    const prelude = `
mkdir() { command mkdir "$@"; if [ "${phase}" = pending-directory ] && [ "$1" = "$PENDING" ]; then kill -s TERM $$; fi; }
mv() {
  command mv "$@"
  if { [ "${phase}" = pending-record ] && [ "$1" = "$RECORD" ]; } || { [ "${phase}" = captured-link ] && [ "$1" = "$TARGET" ]; }; then kill -s TERM $$; fi
}
unlink() {
  command unlink "$@"
  if { [ "${phase}" = removed-link ] && [ "$1" = ./link ]; } || { [ "${phase}" = removed-record ] && [ "$1" = ./record ]; }; then kill -s TERM $$; fi
}`;
    const interrupted = f.fail(disable, prelude);
    expect(interrupted.status, interrupted.stderr).toBe(143);
    expect(existsSync(f.pending)).toBe(true);
    if (phase !== "pending-directory") f.absent(f.record);
    f.fail(enable);
    f.ok(disable);
    f.absent(f.pending);
    f.absent(f.record);
    f.absent(f.target);
    f.ok(enable);
    f.ok(disable);
  });
}

test("record unlink failure retains a pending tombstone that disable can finish", () => {
  const f = fixture();
  f.ok(enable);
  f.fail(disable, 'unlink() { if [ "$1" = ./record ]; then return 1; fi; command unlink "$@"; }');
  f.absent(f.target);
  f.absent(f.record);
  expect(existsSync(join(f.pending, "record"))).toBe(true);
  f.ok(disable);
  f.ok(enable);
  f.ok(disable);
});

test("replacement between final public-path check and capture is preserved by inode verification", () => {
  const f = fixture();
  f.ok(enable);
  const result = f.fail(disable, `mv() {
    if [ "$1" = "$TARGET" ]; then
      command mv "$TARGET" "$TARGET.original"
      command ln -s "$SOURCE_TARGET" "$TARGET"
    fi
    command mv "$@"
  }`);
  expect(result.stderr).toContain("link file identity changed");
  expect(lstatSync(join(f.pending, "link")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(f.pending, "link"))).toBe(f.directory);
  expect(lstatSync(`${f.target}.original`).ino).not.toBe(lstatSync(join(f.pending, "link")).ino);
  expect(existsSync(join(f.pending, "record"))).toBe(true);
});

test("replacement of public target after capture survives final private unlink", () => {
  const f = fixture();
  f.ok(enable);
  f.ok(disable, `unlink() {
    if [ "$1" = ./link ]; then command ln -s /foreign-source "$TARGET"; fi
    command unlink "$@"
  }`);
  expect(readlinkSync(f.target)).toBe("/foreign-source");
  f.absent(f.record);
  f.absent(f.pending);
});

for (const kind of ["missing-record", "malformed-record", "legacy-record", "foreign-record", "same-target-new-link", "directory", "foreign-link"]) {
  test(`disable preserves unsafe input: ${kind}`, () => {
    const f = fixture();
    f.ok(enable);
    const record = readFileSync(f.record, "utf8");
    if (kind === "missing-record") rmSync(f.record);
    if (kind === "malformed-record") writeFileSync(f.record, `${record}unexpected=value\n`);
    if (kind === "legacy-record") writeFileSync(f.record, record.replace("ownership/2", "ownership/1"));
    if (kind === "foreign-record") writeFileSync(f.record, record.replace(`skill=${skill}`, "skill=foreign"));
    if (["same-target-new-link", "directory", "foreign-link"].includes(kind)) {
      renameSync(f.target, `${f.target}.old`);
      if (kind === "directory") mkdirSync(f.target);
      else symlinkSync(kind === "foreign-link" ? "/foreign-source" : f.directory, f.target);
    }
    const before = lstatSync(f.target);
    f.fail(disable);
    expect(lstatSync(f.target).ino).toBe(before.ino);
    f.absent(f.pending);
  });
}
