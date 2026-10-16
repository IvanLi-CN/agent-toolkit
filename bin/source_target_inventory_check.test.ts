import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnvironment } from "./repo_util.ts";
import { check, main, manifestInventory, parseArgs, targetInventory, targetSymlinkInventory, targetSymlinkPaths } from "./source_target_inventory_check.ts";

function git(cwd: string, ...args: string[]): void {
  const templateDir = join(cwd, ".git-template");
  mkdirSync(templateDir, { recursive: true });
  const env = {
    ...gitEnvironment(Bun.env),
    GIT_CONFIG_GLOBAL: join(cwd, ".git-global-config"),
    GIT_CONFIG_SYSTEM: join(cwd, ".git-system-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: templateDir,
    GIT_DEFAULT_HASH: "sha1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const result = Bun.spawnSync(["git", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${templateDir}`, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

test("removes Git repository-selection environment overrides", () => {
  const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  expect(gitEnvironment({
    GIT_DIR: "/tmp/foreign/.git",
    GIT_WORK_TREE: "/tmp/foreign",
    GIT_INDEX_FILE: "/tmp/foreign/index",
    GIT_NAMESPACE: "foreign",
    GIT_CONFIG: "/tmp/foreign/config",
    GIT_CONFIG_COUNT: "1",
    GIT_SHALLOW_FILE: "/tmp/foreign/shallow",
    GIT_TEMPLATE_DIR: "/tmp/foreign/template",
    GIT_SSH_COMMAND: "ssh",
    PATH: "/usr/bin",
  })).toEqual({
    GIT_SSH_COMMAND: "ssh",
    PATH: "/usr/bin",
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
});

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

test("reports duplicate public manifest entries in the standalone inventory check", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-duplicate-"));
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
    rmSync(join(source, "skills", "public"), { recursive: true, force: true });
    mkdirSync(join(target, "skills", "public"), { recursive: true });
    writeFileSync(join(target, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "public\npublic\n");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "DUPLICATE_PUBLIC_MANIFEST_ENTRY",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports invalid public names in the standalone inventory check", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-invalid-name-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills", ".hidden"), { recursive: true });
    writeFileSync(join(source, "skills", ".hidden", "SKILL.md"), "# hidden\n");
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "add", "skills");
    git(source, "commit", "-qm", "fixture");
    rmSync(join(source, "skills", ".hidden"), { recursive: true, force: true });
    mkdirSync(join(target, "skills", ".hidden"), { recursive: true });
    writeFileSync(join(target, "skills", ".hidden", "SKILL.md"), "# hidden\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), ".hidden\n");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "INVALID_PUBLIC_SKILL_NAME .hidden",
    ]);
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
    mkdirSync(join(root, "skills", "regular", "references"), { recursive: true });
    symlinkSync(join(root, "outside", "linked", "SKILL.md"), join(root, "skills", "regular", "references", "linked.md"));
    mkdirSync(join(root, "skills", "regular", "build"), { recursive: true });
    symlinkSync(join(root, "outside", "linked", "SKILL.md"), join(root, "skills", "regular", "build", "ignored.md"));
    mkdirSync(join(root, "outside", "build"), { recursive: true });
    writeFileSync(join(root, "outside", "build", "SKILL.md"), "# build\n");
    symlinkSync(join(root, "outside", "build"), join(root, "skills", "build"), "dir");
    expect(targetSymlinkPaths(root)).toEqual(new Set(["skills/build", "skills/linked", "skills/regular/references/linked.md"]));
    expect(parseArgs(["--source-root=/tmp/source", "--source-revision=HEAD", "--target-root=/tmp/target", "--public-manifest=/tmp/public"])).toEqual({
      sourceRoot: "/tmp/source",
      revision: "HEAD",
      targetRoot: "/tmp/target",
      manifest: "/tmp/public",
    });
    expect(() => parseArgs(["--unknown"])).toThrow();
    expect(() => parseArgs(["--source-root"])).toThrow();
    expect(main(["--help"])).toBe(0);
    expect(main(["--help", "--unknown"])).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports nested source and target symlinks", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-nested-link-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills", "public", "references"), { recursive: true });
    writeFileSync(join(source, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(source, "outside.md"), "# outside\n");
    symlinkSync(join(source, "outside.md"), join(source, "skills", "public", "references", "linked.md"));
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "add", "skills", "outside.md");
    git(source, "commit", "-qm", "fixture");

    mkdirSync(join(target, "skills", "public", "references"), { recursive: true });
    writeFileSync(join(target, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "public\n");
    writeFileSync(join(target, "outside.md"), "# outside\n");
    symlinkSync(join(target, "outside.md"), join(target, "skills", "public", "references", "linked.md"));
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "SYMLINKED_TARGET_PATH skills/public/references/linked.md",
      "SYMLINKED_SOURCE_PATH skills/public/references/linked.md",
      "PUBLIC_SKILL_SOURCE_DUPLICATE public",
      "UNEXPECTED_SOURCE_SKILL public",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a source skills-root symlink from the requested Git revision", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-root-link-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(root, "outside", "skills"), { recursive: true });
    mkdirSync(source, { recursive: true });
    symlinkSync(join(root, "outside", "skills"), join(source, "skills"), "dir");
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "add", "skills");
    git(source, "commit", "-qm", "fixture");
    rmSync(join(source, "skills"), { force: true });
    mkdirSync(join(source, "skills"), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "SYMLINKED_SOURCE_SKILLS_ROOT",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports Gitlinks in the source Skill snapshot", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-gitlink-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills"), { recursive: true });
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,skills/external");
    git(source, "commit", "-qm", "fixture");
    mkdirSync(join(target, "skills"), { recursive: true });
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "UNSUPPORTED_SOURCE_GITLINK skills/external",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports Gitlinks in the target Skill tree", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-target-gitlink-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills"), { recursive: true });
    git(source, "init", "-q");
    git(source, "commit", "--allow-empty", "-qm", "fixture");
    mkdirSync(join(target, "skills"), { recursive: true });
    git(target, "init", "-q");
    git(target, "update-index", "--add", "--cacheinfo", "160000,2222222222222222222222222222222222222222,skills/external");
    git(target, "commit", "-qm", "fixture");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "UNSUPPORTED_TARGET_GITLINK skills/external",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a Gitlink at the target Skills root", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-target-root-gitlink-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills"), { recursive: true });
    git(source, "init", "-q");
    git(source, "commit", "--allow-empty", "-qm", "fixture");
    mkdirSync(target, { recursive: true });
    git(target, "init", "-q");
    git(target, "update-index", "--add", "--cacheinfo", "160000,3333333333333333333333333333333333333333,skills");
    git(target, "commit", "-qm", "fixture");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([
      "UNSUPPORTED_TARGET_GITLINK skills",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when target Git index enumeration fails", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-target-git-failure-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    mkdirSync(join(source, "skills"), { recursive: true });
    git(source, "init", "-q");
    git(source, "commit", "--allow-empty", "-qm", "fixture");
    mkdirSync(target, { recursive: true });
    git(target, "init", "-q");
    git(target, "commit", "--allow-empty", "-qm", "fixture");
    writeFileSync(join(target, ".git", "index"), "corrupt-index\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "");
    expect(() => check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toThrow("git ls-files failed for target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves target repository paths with trailing spaces", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-target-trailing-space-"));
  const source = join(root, "source");
  const target = join(root, "target ");
  try {
    mkdirSync(join(source, "skills"), { recursive: true });
    git(source, "init", "-q");
    git(source, "commit", "--allow-empty", "-qm", "fixture");
    mkdirSync(target, { recursive: true });
    git(target, "init", "-q");
    git(target, "commit", "--allow-empty", "-qm", "fixture");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves special characters in committed symlink paths", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-inventory-special-link-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const linkName = "link\tname";
  try {
    mkdirSync(join(source, "skills", "public", "references"), { recursive: true });
    writeFileSync(join(source, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(source, "outside.md"), "# outside\n");
    symlinkSync(join(source, "outside.md"), join(source, "skills", "public", "references", linkName));
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    git(source, "add", "skills", "outside.md");
    git(source, "commit", "-qm", "fixture");
    rmSync(join(source, "skills", "public", "references", linkName), { force: true });
    mkdirSync(join(target, "skills", "public"), { recursive: true });
    writeFileSync(join(target, "skills", "public", "SKILL.md"), "# public\n");
    writeFileSync(join(target, "PUBLIC_SKILLS.txt"), "public\n");
    expect(check(source, "HEAD", target, join(target, "PUBLIC_SKILLS.txt"))).toContain(
      `SYMLINKED_SOURCE_PATH skills/public/references/${linkName}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
