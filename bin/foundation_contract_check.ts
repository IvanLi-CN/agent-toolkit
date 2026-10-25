#!/usr/bin/env bun
/** Validate relationships between the public foundation contracts and CI. */

import { join, resolve } from "node:path";
import { isDirectRegularFile, isPathInside, readText, REPO_ROOT } from "./repo_util.ts";
import { publicSkills, PUBLIC_SKILL_NAME_PATTERN, repositorySkills } from "./public_skill_boundary_check.ts";
import { check as checkIndex, indexEntries } from "./skills_index_check.ts";
import { check as checkSpec } from "./spec_contract_check.ts";

const TOPIC = "docs/specs/project-foundation";
const CONTRACT_FILES = ["SPEC.md", "IMPLEMENTATION.md", "SCRIPT-LANGUAGE-MATRIX.md"];
const VALIDATION_COMMANDS = ["bun --version", "go version", "bun install --frozen-lockfile", "bun run typecheck", "bun run check", "bun run test:repo", "bun run test:skills", "go -C skills/agent-vm-ops/control vet ./..."];
const CHECK_COMMANDS = [
  "bun run typecheck",
  "bun run bin/spec_contract_check.ts --path docs/specs/project-foundation/SPEC.md",
  "bun run bin/skills_index_check.ts",
  "bun run bin/public_boundary_check.ts",
  "bun run bin/public_skill_boundary_check.ts",
  "bun run bin/public_tool_boundary_check.ts",
  "bun run bin/foundation_contract_check.ts",
  "go -C skills/agent-vm-ops/control vet ./...",
];

function sameMembers(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function tableRows(text: string, heading: string): string[][] {
  const section = text.split(`## ${heading}\n`)[1]?.split(/^## /m)[0] ?? "";
  return section.split("\n").filter((line) => /^\| `/.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

function skillNames(rows: string[][]): string[] {
  return rows.map((row) => /^`([a-z0-9-]+)`$/.exec(row[0] ?? "")?.[1] ?? "<invalid>");
}

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, {
    strategy?: { matrix?: { os?: string[]; exclude?: unknown; include?: unknown } };
    "runs-on"?: string;
    if?: unknown;
    permissions?: unknown;
    "continue-on-error"?: unknown;
    steps?: { uses?: string; with?: Record<string, unknown>; run?: string; if?: unknown; "continue-on-error"?: unknown }[];
  }>;
};

export function check(repoRoot: string = REPO_ROOT): string[] {
  const findings: string[] = [];
  const load = (path: string): string => {
    const absolute = join(repoRoot, path);
    if (!isPathInside(repoRoot, absolute) || !isDirectRegularFile(absolute)) throw new Error(`not a regular repository file: ${path}`);
    return readText(absolute);
  };
  try {
    load("PUBLIC_SKILLS.txt");
    const names = publicSkills(join(repoRoot, "PUBLIC_SKILLS.txt"));
    if (!names.length || names.some((name) => !PUBLIC_SKILL_NAME_PATTERN.test(name)) || new Set(names).size !== names.length) {
      return ["INVALID_FOUNDATION_MEMBERSHIP"];
    }
    if (!sameMembers([...repositorySkills(repoRoot)], names)) findings.push("FOUNDATION_SOURCE_MEMBERSHIP_DRIFT");
    load("skills/README.md");
    findings.push(...checkIndex(repoRoot));
    const entries = indexEntries(join(repoRoot, "skills/README.md"));
    if (!sameMembers(entries.map((entry) => entry.name), names) || entries.some((entry) => entry.external || entry.linkTarget !== `${entry.name}/SKILL.md`)) {
      findings.push("FOUNDATION_CATALOG_DRIFT");
    }
    const documents = new Map(CONTRACT_FILES.map((file) => [file, load(`${TOPIC}/${file}`)]));
    for (const [file, text] of documents) {
      const declarations = [...text.matchAll(/^[- ]*Public membership: (\d+) Skills, defined by \[PUBLIC_SKILLS\.txt\]\(\.\.\/\.\.\/\.\.\/PUBLIC_SKILLS\.txt\)\./gm)];
      if (declarations.length !== 1 || Number(declarations[0]?.[1]) !== names.length) findings.push(`FOUNDATION_COUNT_DRIFT ${file}`);
      if (/\b16(?: public)?[ -]Skills?\b|\b(?:PR|Task)\s+\d+\b/i.test(text)) findings.push(`FOUNDATION_STALE_CONTRACT ${file}`);
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (/^(?:https?:|#)/.test(link)) continue;
        const target = resolve(repoRoot, TOPIC, decodeURIComponent(link.split("#")[0]));
        if (!isPathInside(repoRoot, target) || !isDirectRegularFile(target)) findings.push(`FOUNDATION_BROKEN_LINK ${file} ${link}`);
      }
    }
    const matrix = tableRows(documents.get("SCRIPT-LANGUAGE-MATRIX.md")!, "Complete public Skill matrix");
    if (!sameMembers(skillNames(matrix), names) || matrix.some((row) => row.length !== 4 || row.some((cell) => !cell))) findings.push("FOUNDATION_MATRIX_DRIFT");
    const coverage = tableRows(documents.get("IMPLEMENTATION.md")!, "Skill Migration Coverage");
    if (!sameMembers(skillNames(coverage), names)) findings.push("FOUNDATION_COVERAGE_DRIFT");
    for (const row of coverage) {
      const name = skillNames([row])[0];
      if (row.length !== 3 || !["deferred", "retained", "no-runtime", "migrated"].includes(row[1]) || !row[2]?.includes(`](../../../skills/${name}/SKILL.md)`)) {
        findings.push(`FOUNDATION_INVALID_COVERAGE ${name}`);
      }
      // A migrated row must point to concrete behavior evidence in addition to its Skill contract.
      if (row[1] === "migrated" && !/\[Behavior evidence\]\([^)]+\)/.test(row[2] ?? "")) findings.push(`FOUNDATION_MIGRATION_EVIDENCE_MISSING ${name}`);
      const target = matrix.find((entry) => entry[0] === row[0])?.[2] ?? "";
      const expectedStatuses = target === "No script/runtime" ? ["no-runtime"] : target.includes("TypeScript") ? ["deferred", "migrated"] : ["retained"];
      if (!expectedStatuses.includes(row[1])) findings.push(`FOUNDATION_ALLOCATION_COVERAGE_DRIFT ${name}`);
    }
    const spec = documents.get("SPEC.md")!;
    const headings = [...spec.matchAll(/^### ((?:REQ|VER)-FOUNDATION-[A-Z0-9-]+)$/gm)].map((match) => match[1]);
    const required = Object.entries({ GOV: 5, LANG: 6, COMMON: 7 }).flatMap(([group, count]) => Array.from({ length: count }, (_, i) => `REQ-FOUNDATION-${group}-${String(i + 1).padStart(2, "0")}`));
    const scenarios = Object.entries({ COMMON: 7, GOVERNANCE: 5, TOOLING: 5, HELPERS: 6, XP: 6, "VM-CONTROL": 8, "VM-CLIENT": 7, GUIDES: 5, SITE: 6 }).flatMap(([group, count]) => Array.from({ length: count }, (_, i) => `VER-FOUNDATION-${group}-${String(i + 1).padStart(2, "0")}`));
    for (const id of [...required, ...scenarios]) {
      if (headings.filter((heading) => heading === id).length !== 1) findings.push(`FOUNDATION_ID_DRIFT ${id}`);
    }
    if (!sameMembers(headings.filter((id) => /^REQ-FOUNDATION-(?:GOV|LANG|COMMON)-/.test(id)), required) || !sameMembers(headings.filter((id) => /^VER-FOUNDATION-(?!REQUIREMENT-)/.test(id)), scenarios)) findings.push("FOUNDATION_SCENARIO_SET_DRIFT");
    findings.push(...checkSpec(join(repoRoot, TOPIC, "SPEC.md"), repoRoot));
    for (const path of ["AGENTS.md", `${TOPIC}/IMPLEMENTATION.md`]) {
      const commands = new Set([...load(path).matchAll(/^(?:bun|go) .+$/gm)].map((match) => match[0]));
      for (const command of VALIDATION_COMMANDS) if (!commands.has(command)) findings.push(`FOUNDATION_LOCAL_COMMAND_DRIFT ${path} ${command}`);
    }
    const pkg = JSON.parse(load("package.json")) as { scripts?: Record<string, string> };
    if (!sameMembers(pkg.scripts?.check?.split(/\s*&&\s*/) ?? [], CHECK_COMMANDS)) findings.push("FOUNDATION_CHECK_WIRING_DRIFT");
    for (const scope of ["repo", "skills"]) if (pkg.scripts?.[`test:${scope}`] !== `bun run bin/test_runner.ts --scope ${scope}`) findings.push(`FOUNDATION_TEST_WIRING_DRIFT ${scope}`);
    const workflow = Bun.YAML.parse(load(".github/workflows/ci.yml")) as Workflow;
    const job = workflow.jobs?.checks;
    const steps = job?.steps ?? [];
    if (!workflow.on || !("push" in workflow.on) || !("pull_request" in workflow.on) || !sameMembers(job?.strategy?.matrix?.os ?? [], ["ubuntu-latest", "macos-latest"]) || job?.["runs-on"] !== "${{ matrix.os }}") findings.push("FOUNDATION_CI_PLATFORM_DRIFT");
    if (job?.strategy?.matrix?.exclude !== undefined || job?.strategy?.matrix?.include !== undefined || job?.if !== undefined || job?.["continue-on-error"] !== undefined || job?.permissions !== undefined) findings.push("FOUNDATION_CI_JOB_BYPASS");
    if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) findings.push("FOUNDATION_CI_PERMISSION_DRIFT");
    const bunSetup = steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    if (bunSetup.length !== 1 || bunSetup[0].with?.["bun-version"] !== "latest") findings.push("FOUNDATION_CI_RUNTIME_DRIFT");
    const commands = steps.flatMap((step) => step.run?.split("\n").map((line) => line.trim()) ?? []);
    for (const command of VALIDATION_COMMANDS) if (!commands.includes(command)) findings.push(`FOUNDATION_CI_COMMAND_DRIFT ${command}`);
    for (const step of steps.filter((step) => step.run?.split("\n").some((line) => VALIDATION_COMMANDS.includes(line.trim())))) {
      if (step.if !== undefined || step["continue-on-error"] !== undefined) findings.push("FOUNDATION_CI_STEP_BYPASS");
    }
    if (commands.indexOf("bun install --frozen-lockfile") > commands.indexOf("bun run check")) findings.push("FOUNDATION_CI_INSTALL_ORDER_DRIFT");
  } catch (error) {
    findings.push(`FOUNDATION_INPUT_ERROR ${String(error)}`);
  }
  return findings;
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length) {
    console.error("usage: foundation_contract_check.ts");
    return args.length === 1 && args[0] === "--help" ? 0 : 2;
  }
  const findings = check();
  for (const finding of findings) console.log(`FINDING ${finding}`);
  if (findings.length) return 1;
  console.log("PASS foundation contracts: membership, allocation, coverage, scenarios, and CI agree");
  return 0;
}

if (import.meta.main) process.exitCode = main();
