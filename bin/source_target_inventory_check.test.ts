import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, main, manifestInventory, parseArgs, targetInventory, targetSymlinkInventory } from "./source_target_inventory_check.ts";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

test("passes a synthetic public/private source snapshot", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills", "public"), { recursive: true });
    mkdirSync(join(source, "skills", "private"), { recursive: true });
    writeFileSync(join(source, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(source, "skills", "private", "SKILL.md"), "# private\n");
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "add", "skills");
    git(source, "commit", "-qm", "fixture");
    rmSync(join(source, "skills", "public"), { recursive: true, force: true });

    mkdirSync(join(target, "skills", "public"), { recursive: true });
    writeFileSync(join(target, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "public\n");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores comments, blank lines, and surrounding manifest whitespace", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-manifest-"));
  try {
    const manifest = join(root, "PUBLIC_SKILLS.txt");
    writeFileSync(manifest, "# comment\n\nalpha\n beta \n");
    expect(manifestInventory(manifest)).toEqual(new Set(["alpha", "beta"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports missing and duplicate source boundaries", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-invalid-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills", "public"), { recursive: true });
    writeFileSync(join(source, "skills", "public", "SKILL.md"), "# public\n");
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "add", "skills");
    git(source, "commit", "-qm", "fixture");
    mkdirSync(join(target, "skills", "public"), { recursive: true });
    writeFileSync(join(target, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "public\nmissing\n");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "PUBLIC_SKILL_NOT_IN_SOURCE_SNAPSHOT missing",
      "MISSING_PUBLIC_TARGET_SKILL missing",
      "PUBLIC_SKILL_SOURCE_DUPLICATE public",
      "UNEXPECTED_SOURCE_SKILL public",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counts only regular Skill files and rejects malformed options", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-shape-"));
  try {
    mkdirSync(join(root, "skills", "valid"), { recursive: true });
    mkdirSync(join(root, "skills", "valid", "SKILL.md"), { recursive: true });
    mkdirSync(join(root, "skills", "regular"), { recursive: true });
    writeFileSync(join(root, "skills", "regular", "SKILL.md"), "# regular\n");
    mkdirSync(join(root, "skills", ".hidden"), { recursive: true });
    writeFileSync(join(root, "skills", ".hidden", "SKILL.md"), "# hidden\n");
    expect(targetInventory(root)).toEqual(new Set([".hidden", "regular"]));
    mkdirSync(join(root, "outside", "linked"), { recursive: true });
    writeFileSync(join(root, "outside", "linked", "SKILL.md"), "# linked\n");
    symlinkSync(join(root, "outside", "linked"), join(root, "skills", "linked"), "dir");
    expect(targetInventory(root)).toEqual(new Set([".hidden", "linked", "regular"]));
    expect(targetSymlinkInventory(root)).toEqual(new Set(["linked"]));
    expect(parseArgs(["--source-root=/tmp/source", "--source-revision=HEAD", "--target-root=/tmp/target", "--public-manifest=/tmp/public"])).toEqual({
      sourceRoot: "/tmp/source",
      revision: "HEAD",
      targetRoot: "/tmp/target",
      manifest: "/tmp/public",
    });
    expect(() => parseArgs(["--unknown"])).toThrow();
    expect(() => parseArgs(["--source-root"])).toThrow();
    expect(main(["--help"])).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
