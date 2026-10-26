import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, main } from "./foundation_contract_check.ts";
import { REPO_ROOT } from "./repo_util.ts";

const TOPIC = "docs/specs/project-foundation";

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "toolkit-foundation-"));
  try {
    for (const path of ["docs", "skills", "AGENTS.md", "README.md", "GLOSSARY.md", "PUBLIC_SKILLS.txt", "package.json", ".github/workflows/ci.yml", "bin/foundation_contract_check.test.ts"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function replace(root: string, path: string, before: string, after: string): void {
  const file = join(root, path);
  const text = readFileSync(file, "utf8");
  expect(text).toContain(before);
  writeFileSync(file, text.replace(before, after));
}

test("accepts the standalone current membership and CI without consumer state", () => {
  fixture((root) => expect(check(root)).toEqual([]));
});

test("rejects an empty, duplicate, malformed, or reduced manifest", () => {
  for (const content of ["", "xp-infra\nxp-infra\n", "../escape\n", "xp-infra\n"]) {
    fixture((root) => {
      writeFileSync(join(root, "PUBLIC_SKILLS.txt"), content);
      expect(check(root).length).toBeGreaterThan(0);
    });
  }
});

test("rejects duplicate, stale, and non-clickable catalog entries", () => {
  for (const replacement of ["| `removed-skill` |", "| `unknown-skill` |", "| `invalid_name` | "]) {
    fixture((root) => {
      replace(root, "skills/README.md", "| `xp-infra` |", replacement);
      expect(check(root)).toContain("FOUNDATION_CATALOG_DRIFT");
    });
  }
  fixture((root) => {
    replace(root, "skills/README.md", "[Skill source](xp-infra/SKILL.md)", "`xp-infra/SKILL.md`");
    expect(check(root)).toContain("FOUNDATION_CATALOG_DRIFT");
  });
});

test("rejects missing, duplicate, extra, or malformed matrix rows", () => {
  for (const replacement of ["| `removed-skill` |", "| `unknown-skill` |", "| `invalid_name` |", "| `xp-infra` ||"]) {
    fixture((root) => {
      replace(root, `${TOPIC}/SCRIPT-LANGUAGE-MATRIX.md`, "| `xp-infra` |", replacement);
      expect(check(root)).toContain("FOUNDATION_MATRIX_DRIFT");
    });
  }
});

test("rejects stale membership counts in each active contract", () => {
  for (const path of ["SPEC.md", "IMPLEMENTATION.md", "SCRIPT-LANGUAGE-MATRIX.md"]) {
    fixture((root) => {
      replace(root, `${TOPIC}/${path}`, "Public membership: 11", "Public membership: 13");
      expect(check(root)).toContain(`FOUNDATION_COUNT_DRIFT ${path}`);
    });
  }
});

test("rejects historical delivery numbering used in an active contract", () => {
  fixture((root) => {
    replace(root, `${TOPIC}/SPEC.md`, "site artifact checks apply", "PR 8 artifact checks apply");
    expect(check(root)).toContain("FOUNDATION_STALE_CONTRACT SPEC.md");
  });
});

test("requires complete migration coverage and behavior evidence for completion", () => {
  fixture((root) => {
    replace(root, `${TOPIC}/IMPLEMENTATION.md`, "[Behavior evidence](../../../skills/buzzer-audio-preview/tests/buzzer_preview.test.ts)", "[Release integration evidence missing](../../../skills/buzzer-audio-preview/tests/buzzer_preview.test.ts)");
    expect(check(root)).toContain("FOUNDATION_MIGRATION_EVIDENCE_MISSING buzzer-audio-preview");
  });
  fixture((root) => {
    replace(root, `${TOPIC}/IMPLEMENTATION.md`, "| `xp-infra` | deferred |", "| `unknown-skill` | complete |");
    expect(check(root)).toContain("FOUNDATION_COVERAGE_DRIFT");
    expect(check(root)).toContain("FOUNDATION_INVALID_COVERAGE unknown-skill");
  });
  fixture((root) => {
    replace(root, `${TOPIC}/IMPLEMENTATION.md`, "| `buzzer-audio-preview` | migrated |", "| `buzzer-audio-preview` | no-runtime |");
    expect(check(root)).toContain("FOUNDATION_ALLOCATION_COVERAGE_DRIFT buzzer-audio-preview");
  });
});

test("preserves GOV, LANG, COMMON and all domain scenario identities", () => {
  for (const id of ["REQ-FOUNDATION-GOV-05", "REQ-FOUNDATION-LANG-06", "REQ-FOUNDATION-COMMON-07", "VER-FOUNDATION-HELPERS-06", "VER-FOUNDATION-SITE-06"]) {
    fixture((root) => {
      replace(root, `${TOPIC}/SPEC.md`, `### ${id}`, `### ${id}-removed`);
      expect(check(root)).toContain(`FOUNDATION_ID_DRIFT ${id}`);
    });
  }
});

test("rejects broken source links, escaping links, and non-regular inputs", () => {
  fixture((root) => {
    replace(root, `${TOPIC}/SCRIPT-LANGUAGE-MATRIX.md`, "../../../skills/buzzer-audio-preview/scripts/buzzer_preview.ts", "../../../skills/buzzer-audio-preview/scripts/missing.ts");
    expect(check(root).some((finding) => finding.startsWith("FOUNDATION_BROKEN_LINK"))).toBe(true);
  });
  fixture((root) => {
    replace(root, `${TOPIC}/SPEC.md`, "../../../GLOSSARY.md", "../../../../outside.md");
    expect(check(root).some((finding) => finding.startsWith("FOUNDATION_BROKEN_LINK"))).toBe(true);
  });
  fixture((root) => {
    rmSync(join(root, "PUBLIC_SKILLS.txt"));
    symlinkSync(join(REPO_ROOT, "PUBLIC_SKILLS.txt"), join(root, "PUBLIC_SKILLS.txt"));
    expect(check(root)[0]).toContain("FOUNDATION_INPUT_ERROR");
  });
});

test("rejects local command drift, bypassed gates, and narrowed test discovery", () => {
  fixture((root) => {
    replace(root, "AGENTS.md", "bun run check", "bun run removed-check");
    expect(check(root)).toContain("FOUNDATION_LOCAL_COMMAND_DRIFT AGENTS.md bun run check");
  });
  fixture((root) => {
    replace(root, "package.json", " && bun run bin/public_tool_boundary_check.ts", "");
    expect(check(root)).toContain("FOUNDATION_CHECK_WIRING_DRIFT");
  });
  fixture((root) => {
    replace(root, "package.json", "bun run bin/test_runner.ts --scope skills", "bun test bin");
    expect(check(root)).toContain("FOUNDATION_TEST_WIRING_DRIFT skills");
  });
});

test("rejects CI platform, runtime, permission, and validation drift", () => {
  const cases = [
    ["macos-latest", "ubuntu-24.04", "FOUNDATION_CI_PLATFORM_DRIFT"],
    ["bun-version: latest", "bun-version: 1.4.4", "FOUNDATION_CI_RUNTIME_DRIFT"],
    ["contents: read", "contents: write", "FOUNDATION_CI_PERMISSION_DRIFT"],
    ["bun run check", "bun run missing-check", "FOUNDATION_CI_COMMAND_DRIFT bun run check"],
    ["bun run test:repo", "bun test bin/some.test.ts", "FOUNDATION_CI_COMMAND_DRIFT bun run test:repo"],
    ["pull_request:", "workflow_dispatch:", "FOUNDATION_CI_PLATFORM_DRIFT"],
    ["    runs-on:", "    if: false\n    runs-on:", "FOUNDATION_CI_JOB_BYPASS"],
    ["os: [ubuntu-latest, macos-latest]", "os: [ubuntu-latest, macos-latest]\n        exclude: [{os: macos-latest}]", "FOUNDATION_CI_JOB_BYPASS"],
    ["      - name: Run repository checks", "      - continue-on-error: true\n        name: Run repository checks", "FOUNDATION_CI_STEP_BYPASS"],
  ];
  for (const [before, after, finding] of cases) {
    fixture((root) => {
      replace(root, ".github/workflows/ci.yml", before, after);
      expect(check(root)).toContain(finding);
    });
  }
});

test("fails closed on malformed files and unsupported CLI arguments", () => {
  fixture((root) => {
    writeFileSync(join(root, "package.json"), "{");
    expect(check(root).some((finding) => finding.startsWith("FOUNDATION_INPUT_ERROR"))).toBe(true);
  });
  expect(main(["--unknown"])).toBe(2);
  expect(main(["--help", "--unknown"])).toBe(2);
  expect(main(["--help"])).toBe(0);
});
