import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const skill = readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8");
const cli = readFileSync(join(import.meta.dir, "../references/cli.md"), "utf8");
const runbook = readFileSync(join(import.meta.dir, "../references/runbook.md"), "utf8");

test("XP-07 host-managed upgrade does not invent an unsupported --yes flag", () => {
  const command = "sudo xp-ops upgrade --version VERSION";
  expect(skill).toContain("pass `--yes` only when that command exposes it");
  expect(skill).toContain("completed policy and preflight gates and the exact documented command");
  expect(cli).toContain(`\n${command}\n`);
  expect(cli).toContain("`xp-ops upgrade` does not expose `--yes`");
  expect(cli).not.toContain(`${command} --yes`);
  expect(runbook).toContain(`\`${command}\`; this command has no \`--yes\`, so never append one.`);
});
