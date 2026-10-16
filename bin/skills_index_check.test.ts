import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, main } from "./skills_index_check.ts";

function withFixture(callback: (root: string) => void): void {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-skills-index-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a complete local index and explicit external entry", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | `skills/alpha/**` |\n| `external-beta` | external | `~/.agents/skills/external-beta/**` |\n");
    expect(check(root)).toEqual([]);
  });
});

test("reports missing and stale entries", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `stale` | missing | `skills/stale/**` |\n");
    expect(check(root)).toEqual([
      "MISSING_INDEX_ENTRY skill=alpha",
      "STALE_INDEX_ENTRY skill=stale line=3",
    ]);
  });
});

test("reports duplicate entries", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | first | `skills/alpha/**` |\n| `alpha` | second | `skills/alpha/**` |\n");
    expect(check(root)).toEqual(["DUPLICATE_INDEX_ENTRY skill=alpha count=2"]);
  });
});

test("uses an explicit repository root and ignores a directory named SKILL.md", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha", "SKILL.md"), { recursive: true });
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n");
    expect(main(["--repo-root", root])).toBe(0);
    expect(main(["--unknown"])).toBe(2);
  });
});
