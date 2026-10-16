import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, main } from "./spec_contract_check.ts";

test("accepts a minimal canonical Spec", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-spec-"));
  try {
    const path = join(root, "docs", "specs", "sample-topic", "SPEC.md");
    mkdirSync(join(root, "docs", "specs", "sample-topic"), { recursive: true });
    writeFileSync(path, "# Sample\n\n## Context and Scope\n\nContext.\n\n## Requirements\n\n### REQ-SAMPLE-01\n\nThe project MUST work.\n\n## Verification\n\n### VER-SAMPLE-01\n\n- covers: `REQ-SAMPLE-01`\n\n## Related ADRs\n\nNone\n");
    expect(check(path, root)).toEqual([]);
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
});
