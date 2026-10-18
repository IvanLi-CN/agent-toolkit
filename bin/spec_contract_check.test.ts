import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, main } from "./spec_contract_check.ts";

test("accepts a minimal canonical Spec", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-spec-"));
  try {
    const path = join(root, "docs", "specs", "sample-topic", "SPEC.md");
    mkdirSync(join(root, "docs", "specs", "sample-topic"), { recursive: true });
    writeFileSync(path, "# Sample\n\n## Context and Scope\n\nContext.\n\n## Requirements\n\n### REQ-SAMPLE-01\n\nThe project MUST work.\n\n## Verification\n\n### VER-SAMPLE-01\n\n- covers: `REQ-SAMPLE-01`\n\n## Related ADRs\n\nNone\n");
    expect(check(path, root)).toEqual([]);
    expect(main([`--path=${path}`, `--repo-root=${root}`])).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects progress checkboxes and unresolved decisions", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-spec-invalid-"));
  try {
    const path = join(root, "docs", "specs", "sample-topic", "SPEC.md");
    mkdirSync(join(root, "docs", "specs", "sample-topic"), { recursive: true });
    writeFileSync(path, "# Sample\n\n## Context and Scope\n\nContext.\n\n## Requirements\n\n### REQ-SAMPLE-01\n\nThe project MUST work.\n\n## Verification\n\n### VER-SAMPLE-01\n\n- covers: `REQ-SAMPLE-01`\n- [ ] pending\n\n## Related ADRs\n\nNone\n\nTODO\n");
    const findings = check(path, root);
    expect(findings.some((finding) => finding.includes("SPEC_CHECKBOX_FORBIDDEN"))).toBe(true);
    expect(findings.some((finding) => finding.includes("SPEC_UNRESOLVED_DECISION"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for unsupported or incomplete command-line options", () => {
  expect(main(["--all"])).toBe(2);
  expect(main(["--path"])).toBe(2);
  expect(main(["--unknown"])).toBe(2);
  expect(main(["--help"])).toBe(0);
  expect(main(["--help", "--unknown"])).toBe(2);
});

test("rejects a canonical-looking Spec reached through a symlinked ancestor", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-spec-link-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(join(outside, "link"), { recursive: true });
    writeFileSync(join(outside, "link", "SPEC.md"), "# external\n");
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    symlinkSync(join(outside, "link"), join(root, "docs", "specs", "link"), "dir");
    expect(check(join(root, "docs", "specs", "link", "SPEC.md"), root)[0]).toContain("SPEC_PATH_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires Related ADR targets to be regular repository files", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-spec-adr-shape-"));
  try {
    const path = join(root, "docs", "specs", "sample-topic", "SPEC.md");
    mkdirSync(join(root, "docs", "specs", "sample-topic"), { recursive: true });
    mkdirSync(join(root, "docs", "adr", "0001-example.md"), { recursive: true });
    writeFileSync(path, "# Sample\n\n## Context and Scope\n\nContext.\n\n## Requirements\n\n### REQ-SAMPLE-01\n\nThe project MUST work.\n\n## Verification\n\n### VER-SAMPLE-01\n\n- covers: `REQ-SAMPLE-01`\n\n## Related ADRs\n\n- [Example](../../adr/0001-example.md)\n");
    expect(check(path, root).some((finding) => finding.includes("SPEC_RELATED_ADRS_INVALID"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
