import { expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { publicSkills } from "./public_skill_boundary_check.ts";

const repoRoot = resolve(import.meta.dir, "..");
setDefaultTimeout(30_000);

type CommandResult = { code: number; stdout: string; stderr: string };

function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function trackedSkillFiles(name: string): string[] {
  const result = run(["git", "ls-files", "--stage", "--", `skills/${name}`], repoRoot);
  if (result.code !== 0) throw new Error(`git ls-files failed for ${name}: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^(\d{6})\s+\S+\s+\d+\t(.+)$/.exec(line);
    if (!match) throw new Error(`unexpected Git index entry: ${line}`);
    if (match[1] === "120000") throw new Error(`symbolic link is not a public Skill file: ${match[2]}`);
    return match[2];
  });
}

function copyFiles(sourceRoot: string, destination: string, files: string[]): void {
  for (const relativePath of files) {
    const source = join(sourceRoot, relativePath);
    const entry = lstatSync(source);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not a public Skill file: ${relativePath}`);
    if (!entry.isFile()) throw new Error(`public Skill file is not regular: ${relativePath}`);
    const target = join(destination, relative(sourceRoot, source));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    chmodSync(target, entry.mode & 0o777);
  }
}

function copyListedSkill(name: string, destinationRoot: string): string {
  const sourceRoot = join(repoRoot, "skills", name);
  const destination = join(destinationRoot, name);
  const files = trackedSkillFiles(name).map((file) => relative(sourceRoot, join(repoRoot, file)));
  if (files.length === 0) throw new Error(`no tracked files for ${name}`);
  copyFiles(sourceRoot, destination, files);
  if (!existsSync(join(destination, "SKILL.md"))) throw new Error(`missing SKILL.md for ${name}`);
  if (!existsSync(sourceRoot)) throw new Error(`missing source Skill: ${name}`);
  return destination;
}

function runBun(root: string, script: string, args: string[], env: Record<string, string | undefined> = {}): CommandResult {
  return run([process.execPath, script, ...args], root, env);
}

function expectSuccess(result: CommandResult, label: string): void {
  expect(result.code, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

test("public Skills run from isolated single-directory exports", () => {
  const workspace = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "skill-isolation-"));
  try {
    const roots = new Map(publicSkills().map((name) => [name, copyListedSkill(name, workspace)]));
    for (const [name, root] of roots) {
      const skill = readFileSync(join(root, "SKILL.md"), "utf8");
      expect(skill).toContain(`name: ${name}`);
      expect(skill).toMatch(/^description:/m);
    }

    const buzzer = roots.get("buzzer-audio-preview")!;
    const buzzerOutput = join(buzzer, "output");
    expectSuccess(runBun(buzzer, "scripts/buzzer_preview.ts", ["--in", "assets/score.example.json", "--out-dir", buzzerOutput]), "buzzer preview");
    expect(readFileSync(join(buzzerOutput, "score.example.mid")).subarray(0, 4).toString()).toBe("MThd");
    expect(readFileSync(join(buzzerOutput, "score.example.wav")).subarray(0, 4).toString()).toBe("RIFF");

    const cvm = roots.get("cvm-imagegen")!;
    const dryRun = run(["python3", "scripts/image_gen.py", "generate", "--prompt", "isolated", "--out", join(cvm, "output.png"), "--dry-run"], cvm, {
      AGENT_IMAGEGEN_SYSTEM_PATH: join(cvm, "tests/fixtures/system_image_gen.py"),
    });
    expectSuccess(dryRun, "CVM dry-run with fixture");
    const missingFallback = run(["python3", "scripts/image_gen.py", "generate", "--prompt", "isolated", "--out", join(cvm, "missing.png"), "--dry-run"], cvm, {
      AGENT_IMAGEGEN_SYSTEM_PATH: "",
    });
    expect(missingFallback.code).toBe(1);
    expect(missingFallback.stderr).toContain("imagegen fallback script not found");

    const dst = roots.get("dst-dedicated-server")!;
    const snapshot = runBun(dst, "scripts/dst_snapshot.ts", ["--no-local", "--no-remote", "--out", "snapshot.md"]);
    expectSuccess(snapshot, "DST snapshot");
    expect(readFileSync(join(dst, "snapshot.md"), "utf8")).toContain("# DST snapshot");
    mkdirSync(join(dst, "cluster/Master"), { recursive: true });
    writeFileSync(join(dst, "cluster/Master/modoverrides.lua"), 'return {["workshop-1"]={enabled=true}}');
    const mods = runBun(dst, "scripts/dst_mods_from_modoverrides.ts", ["--cluster-dir", "cluster"]);
    expectSuccess(mods, "DST mod summary");
    expect(mods.stdout).toContain("enabled_ids: 1");

    const firmware = roots.get("firmware-display-preview")!;
    writeFileSync(join(firmware, "framebuffer.bin"), Buffer.from([0, 255]));
    expectSuccess(runBun(firmware, "scripts/fb_to_png.ts", ["--format", "gray8", "--width", "2", "--height", "1", "--in", "framebuffer.bin", "--out", "preview.png"]), "framebuffer preview");
    expect(readFileSync(join(firmware, "preview.png")).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const gitSync = roots.get("git-sync")!;
    expectSuccess(run([process.execPath, "test", "tests/detached_alignment_contract.test.ts"], gitSync), "Git alignment contract");

    const tavily = roots.get("tavily-hikari-infra")!;
    const tavilyMode = lstatSync(join(repoRoot, "skills/tavily-hikari-infra/scripts/tavily-hikari-infra")).mode & 0o777;
    expect(tavilyMode).toBe(0o755);
    expectSuccess(run([join(tavily, "scripts/tavily-hikari-infra"), "inventory"], tavily, {
      TAVILY_HOSTS_FILE: join(tavily, "references/hosts.txt.example"),
    }), "Tavily inventory");

    const xp = roots.get("xp-infra")!;
    expectSuccess(run([process.execPath, join(xp, "scripts/xp-infra"), "--help"], xp), "XP help");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("single-directory exporter rejects symbolic links", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "skill-isolation-link-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: example\n---\n");
    symlinkSync(join(source, "SKILL.md"), join(source, "linked.md"));
    expect(() => copyFiles(source, destination, ["SKILL.md", "linked.md"])).toThrow("symbolic link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
