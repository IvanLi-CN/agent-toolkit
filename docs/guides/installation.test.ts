import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

function fileIdentity(path: string): string {
  const { dev, ino } = lstatSync(path);
  return `${dev}:${ino}`;
}

function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return {
    identity: fileIdentity(path),
    mode: stat.mode,
    contents: stat.isSymbolicLink() ? readlinkSync(path)
      : stat.isDirectory() ? readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])
        : readFileSync(path, "utf8"),
  };
}

for (const [operation, script] of [["enable", enable], ["disable", disable]] as const) {
  for (const kind of ["directory", "foreign-directory", "file", "symlink", "dangling-symlink"]) {
    test(`${operation} preserves an existing consumer-root lock: ${kind}`, () => {
      const f = fixture();
      if (operation === "disable") f.ok(enable);
      const lock = join(f.consumer, ".agent-toolkit-links.lock");
      const foreign = join(f.root, "foreign-lock");
      if (kind === "directory" || kind === "foreign-directory") {
        mkdirSync(lock);
        if (kind === "foreign-directory") writeFileSync(join(lock, ".owner.foreign"), "foreign owner\n");
      } else if (kind === "file") {
        writeFileSync(lock, "foreign lock file\n");
      } else {
        if (kind === "symlink") {
          mkdirSync(foreign);
          writeFileSync(join(foreign, ".owner.foreign"), "foreign owner\n");
        }
        symlinkSync(foreign, lock);
      }
      const before = snapshot(f.root);
      // These failures must retain the lock; fixture.fail() expects its removal.
      const result = f.run(script);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("consumer-root lock is already held or unavailable; no state was changed");
      expect(result.stdout).not.toMatch(/Enabled |Disabled /u);
      // Includes entry/record state, lock type/identity/contents and symlink referents.
      expect(snapshot(f.root)).toEqual(before);
    });
  }

  for (const fault of ["replacement", "foreign-contents", "token-loss"] as const) {
    test(`${operation} refuses lock release and preserves evidence after ${fault}`, () => {
      const f = fixture();
      if (operation === "disable") f.ok(enable);
      const lock = join(f.consumer, ".agent-toolkit-links.lock");
      const mutation = fault === "replacement" ? `
        command mv "$LOCK_DIR" "$LOCK_DIR.original"
        command mkdir "$LOCK_DIR"
        printf 'foreign owner\\n' > "$LOCK_DIR/.foreign"`
        : fault === "foreign-contents" ? `printf 'foreign owner\\n' > "$LOCK_DIR/.foreign"`
          : `command unlink "$lock_token"`;
      // Interpose a native command at the last staging-directory removal, after
      // link/record work and before release_lock. Do not replace installer logic.
      const result = f.run(script, `rmdir() {
        command rmdir "$@" || return $?
        if [ "$1" = "${operation === "enable" ? "$link_tmp" : "$PENDING"}" ]; then
          printf '%s\\n' "$lock_dir_identity" "$lock_token_identity" "$lock_token" "$lock_owner" > "$CONSUMER_SKILLS/../lock-before"
          ${mutation}
          path_identity "$LOCK_DIR" > "$CONSUMER_SKILLS/../lock-injected"
          if [ -f "$LOCK_DIR/.foreign" ]; then
            path_identity "$LOCK_DIR/.foreign" >> "$CONSUMER_SKILLS/../lock-injected"
          fi
        fi
      }`);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(1);
      const reason = fault === "replacement" ? "lock directory identity changed"
        : fault === "foreign-contents" ? "lock directory contains unexpected state"
          : "ownership token is missing or foreign";
      expect(result.stderr).toContain(`Consumer-root lock ownership could not be proven; leaving it untouched: ${reason}`);
      expect(result.stderr).toContain("consumer-root lock could not be released safely");
      expect(result.stdout).not.toMatch(/Enabled |Disabled /u);

      const [directoryId, tokenId, tokenPath, owner] = readFileSync(join(f.root, "lock-before"), "utf8").trimEnd().split("\n");
      expect(tokenPath!).toStartWith(`${lock}/.owner.`);
      expect(owner).toMatch(/^pid=\d+ token=/u);
      expect(owner!).toEndWith(` token=${tokenPath}`);
      const tokenName = basename(tokenPath!);
      const [injectedLockId, foreignId] = readFileSync(join(f.root, "lock-injected"), "utf8").trimEnd().split("\n");
      expect(lstatSync(lock).isDirectory()).toBe(true);
      expect(fileIdentity(lock)).toBe(injectedLockId);
      if (fault === "replacement") {
        expect(fileIdentity(lock)).not.toBe(directoryId);
        expect(fileIdentity(`${lock}.original`)).toBe(directoryId);
        expect(readdirSync(`${lock}.original`)).toEqual([tokenName]);
        expect(fileIdentity(join(`${lock}.original`, tokenName))).toBe(tokenId);
        expect(readFileSync(join(`${lock}.original`, tokenName), "utf8")).toBe(`${owner}\n`);
        expect(readdirSync(lock)).toEqual([".foreign"]);
      } else {
        expect(fileIdentity(lock)).toBe(directoryId);
        if (fault === "foreign-contents") {
          expect(readdirSync(lock).sort()).toEqual([".foreign", tokenName].sort());
          expect(fileIdentity(tokenPath!)).toBe(tokenId);
          expect(readFileSync(tokenPath!, "utf8")).toBe(`${owner}\n`);
        } else {
          expect(readdirSync(lock)).toEqual([]);
          f.absent(tokenPath!);
        }
      }
      if (fault !== "token-loss") {
        expect(fileIdentity(join(lock, ".foreign"))).toBe(foreignId);
        expect(readFileSync(join(lock, ".foreign"), "utf8")).toBe("foreign owner\n");
      }
      // Release failure does not roll back already completed link/record work.
      if (operation === "enable") {
        expect(lstatSync(f.target).isSymbolicLink()).toBe(true);
        expect(readlinkSync(f.target)).toBe(f.directory);
        expect(readFileSync(f.record, "utf8")).toContain(`link_file_id=${fileIdentity(f.target)}\n`);
        expect(readdirSync(f.ledger)).toEqual([`${skill}.record`]);
      } else {
        f.absent(f.target);
        f.absent(f.record);
        f.absent(f.ledger);
      }
      f.absent(f.pending);
    });
  }
}

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
