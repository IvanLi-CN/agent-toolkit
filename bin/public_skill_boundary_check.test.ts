import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("rejects private operator reference names and unlisted Skills", () => {
  const { root, manifest } = fixture("# standalone\n");
  try {
    mkdirSync(join(root, "skills", "alpha", "references"));
    writeFileSync(join(root, "skills", "alpha", "references", "hosts.txt"), "neutral alias\n");
    mkdirSync(join(root, "skills", "extra"));
    writeFileSync(join(root, "skills", "extra", "SKILL.md"), "# extra\n");
    expect(check(root, manifest)).toEqual([
      "UNLISTED_PUBLIC_SKILL extra",
      "skills/alpha/references/hosts.txt: private operator reference must stay outside repository",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
