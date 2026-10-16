import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "./public_skill_boundary_check.ts";

function fixture(content: string): { root: string; manifest: string } {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-skill-boundary-"));
  mkdirSync(join(root, "skills", "alpha"), { recursive: true });
  writeFileSync(join(root, "skills", "alpha", "SKILL.md"), content);
  const manifest = join(root, "PUBLIC_SKILLS.txt");
  writeFileSync(manifest, "alpha\n");
  return { root, manifest };
}

test("accepts a standalone Skill", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    expect(check(root, manifest)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects runtime and native task coupling", () => {
  const { root, manifest } = fixture("Use $CODEX_HOME for the helper.\n");
  try {
    expect(check(root, manifest)).toEqual(["skills/alpha/SKILL.md: forbidden public coupling codex-runtime-marker"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects product references and native task surfaces", () => {
  for (const content of ["Use " + "Codex" + " Plan Mode.\n", "Use a native task Worktree.\n"]) {
    const { root, manifest } = fixture(content);
    try {
      const label = content.startsWith("Use Codex") ? "codex-product-reference" : "codex-native-surface";
      expect(check(root, manifest)).toEqual([`skills/alpha/SKILL.md: forbidden public coupling ${label}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects private operator reference names and unlisted Skills", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    mkdirSync(join(root, "skills", "alpha", "references"));
    writeFileSync(join(root, "skills", "alpha", "references", "hosts.txt"), "neutral alias\n");
    mkdirSync(join(root, "skills", "extra"));
    writeFileSync(join(root, "skills", "extra", "SKILL.md"), "Use $CODEX_HOME.\n");
    expect(check(root, manifest)).toEqual([
      "UNLISTED_PUBLIC_SKILL extra",
      "skills/alpha/references/hosts.txt: private operator reference must stay outside repository",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid manifest names and hidden Skill-shaped directories", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    writeFileSync(manifest, "alpha\n../../outside\n");
    mkdirSync(join(root, "skills", ".private"), { recursive: true });
    writeFileSync(join(root, "skills", ".private", "SKILL.md"), "# hidden\n");
    expect(check(root, manifest)).toEqual([
      "INVALID_PUBLIC_SKILL_NAME ../../outside",
      "UNLISTED_PUBLIC_SKILL .private",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unlisted files directly under the public Skills root", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    writeFileSync(join(root, "skills", "private-data.md"), "private operator notes\n");
    expect(check(root, manifest)).toEqual(["UNEXPECTED_PUBLIC_SKILLS_ENTRY private-data.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked public Skill directory", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    rmSync(join(root, "skills", "alpha"), { recursive: true, force: true });
    mkdirSync(join(root, "outside", "alpha"), { recursive: true });
    writeFileSync(join(root, "outside", "alpha", "SKILL.md"), "# linked\n");
    symlinkSync(join(root, "outside", "alpha"), join(root, "skills", "alpha"), "dir");
    expect(check(root, manifest)).toEqual(["SYMLINKED_PUBLIC_SKILL alpha"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a nested symlink that escapes the Skill boundary", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    mkdirSync(join(root, "outside", "references"), { recursive: true });
    writeFileSync(join(root, "outside", "references", "linked.md"), "# linked\n");
    symlinkSync(join(root, "outside", "references"), join(root, "skills", "alpha", "linked"), "dir");
    expect(check(root, manifest)).toEqual([
      "skills/alpha/linked: symbolic link escapes public Skill boundary",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a public manifest that is outside the repository boundary", () => {
  const { root } = fixture("# standalone\n");
  const outside = join(root, "..", "agent-toolkit-manifest-outside.txt");
  const linkedManifest = join(root, "linked-manifest.txt");
  try {
    writeFileSync(outside, "alpha\n");
    symlinkSync(outside, linkedManifest);
    expect(check(root, linkedManifest)).toEqual(["INVALID_PUBLIC_SKILLS_MANIFEST"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
