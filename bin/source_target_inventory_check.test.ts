import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "./source_target_inventory_check.ts";

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
