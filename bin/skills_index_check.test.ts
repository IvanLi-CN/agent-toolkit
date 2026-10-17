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
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | `skills/alpha/**` |\n| `external-beta` | external | `external-skills/external-beta/**` |\n");
    expect(check(root)).toEqual([]);
  });
});

test("rejects personal consumer paths anywhere in the public catalog", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "Third-party source: ~/.agents/skills/alpha/**\n\n| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | `skills/alpha/**` |\n");
    expect(check(root)).toEqual(["PERSONAL_CONSUMER_PATH_IN_SKILLS_README"]);
  });
});

test("accepts clickable relative Skill source links", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | [Skill source](alpha/SKILL.md) |\n");
    expect(check(root)).toEqual([]);
  });
});

test("rejects clickable links whose targets do not exist", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | [Skill source](alpha/MISSING.md) |\n");
    expect(check(root)).toEqual([
      "INVALID_INDEX_PATH skill=alpha line=3 path=alpha/MISSING.md",
      "INVALID_INDEX_LINK skill=alpha line=3 target=alpha/MISSING.md",
    ]);
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

test("reports a local index path that names a different Skill", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | `skills/wrong/**` |\n");
    expect(check(root)).toEqual(["INVALID_INDEX_PATH skill=alpha line=3 path=skills/wrong/**"]);
  });
});

test("ignores tables that are unrelated to the Skill index", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n| `alpha` | local | `skills/alpha/**` |\n\n| `flow_type` | Route |\n|---|---|\n| `fast-track` | route |\n");
    expect(check(root)).toEqual([]);
  });
});

test("uses an explicit repository root and ignores a directory named SKILL.md", () => {
  withFixture((root) => {
    mkdirSync(join(root, "skills", "alpha", "SKILL.md"), { recursive: true });
    writeFileSync(join(root, "skills", "README.md"), "| Skill | Description | Path |\n|---|---|---|\n");
    expect(main(["--repo-root", root])).toBe(0);
    expect(main([`--repo-root=${root}`])).toBe(0);
    expect(main(["--help"])).toBe(0);
    expect(main(["--help", "--unknown"])).toBe(2);
    expect(main(["--unknown"])).toBe(2);
  });
});
