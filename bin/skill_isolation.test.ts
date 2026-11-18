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
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";

import { publicSkills } from "./public_skill_boundary_check.ts";
import { gitEnvironment } from "./repo_util.ts";

const repoRoot = resolve(import.meta.dir, "..");
setDefaultTimeout(30_000);

type CommandResult = { code: number; stdout: string; stderr: string };
type ScriptInventory = {
  portable: string[];
  remoteNative: string[];
  support: string[];
  test: string[];
  retired: string[];
};

const SCRIPT_INVENTORY: Record<string, ScriptInventory> = {
  "buzzer-audio-preview": {
    portable: ["scripts/buzzer_preview.ts"],
    remoteNative: [],
    support: [],
    test: [],
    retired: [],
  },
  "cvm-imagegen": {
    portable: ["scripts/image_gen.py"],
    remoteNative: [],
    support: [],
    test: ["scripts/test_image_gen.py"],
    retired: [],
  },
  "docs-no-revision-markers": { portable: [], remoteNative: [], support: [], test: [], retired: [] },
  "dst-dedicated-server": {
    portable: ["scripts/dst_mods_from_modoverrides.ts", "scripts/dst_snapshot.ts"],
    remoteNative: ["scripts/dst_collect_remote.sh"],
    support: ["scripts/dst_common.ts", "scripts/mod_parser.ts"],
    test: [],
    retired: [],
  },
  "firmware-display-preview": {
    portable: ["scripts/fb_to_png.ts"],
    remoteNative: [],
    support: [],
    test: [],
    retired: [],
  },
  "git-remote-troubleshoot": { portable: [], remoteNative: [], support: [], test: [], retired: [] },
  "git-sync": { portable: [], remoteNative: [], support: [], test: [], retired: [] },
  "linux-server-init": { portable: [], remoteNative: [], support: [], test: [], retired: [] },
  "markdown-doc-style": { portable: [], remoteNative: [], support: [], test: [], retired: [] },
  "tavily-hikari-infra": {
    portable: [],
    remoteNative: ["scripts/tavily-hikari-infra"],
    support: [],
    test: [],
    retired: [],
  },
  "xp-infra": {
    portable: ["scripts/xp-infra", "scripts/xp-infra-audit-local"],
    remoteNative: [
      "scripts/xp-infra-audit-remote",
      "scripts/xp-infra-audit-vless-remote",
      "scripts/xp-infra-inventory-remote",
      "scripts/xp-infra-port-remote",
    ],
    support: [
      "scripts/audit.ts",
      "scripts/cli.ts",
      "scripts/input.ts",
      "scripts/network.ts",
      "scripts/policy.ts",
      "scripts/preflight.ts",
      "scripts/process.ts",
    ],
    test: [],
    retired: ["scripts/xp-infra-compose-image-check"],
  },
};

type RemoteNativeContract = {
  prerequisiteMarkers: string[];
  interpreters: Record<string, "sh" | "bash">;
};

const REMOTE_NATIVE_CONTRACTS: Record<string, RemoteNativeContract> = {
  "dst-dedicated-server": {
    prerequisiteMarkers: ["OpenSSH locally", "an already trusted host key", "POSIX `sh`"],
    interpreters: { "scripts/dst_collect_remote.sh": "sh" },
  },
  "tavily-hikari-infra": {
    prerequisiteMarkers: ["SSH aliases", "operator's SSH configuration"],
    interpreters: { "scripts/tavily-hikari-infra": "bash" },
  },
  "xp-infra": {
    prerequisiteMarkers: ["OpenSSH provides transport", "inspected Linux node needs no Bun installation", "timeout"],
    interpreters: {
      "scripts/xp-infra-audit-remote": "sh",
      "scripts/xp-infra-audit-vless-remote": "sh",
      "scripts/xp-infra-inventory-remote": "sh",
      "scripts/xp-infra-port-remote": "sh",
    },
  },
};

function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    env: gitEnvironment({ ...process.env, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function runWithInput(command: string[], cwd: string, input: string, env: Record<string, string | undefined> = {}): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    env: gitEnvironment({ ...process.env, ...env }),
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
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

function scriptInventoryFiles(name: string): string[] {
  const sourceRoot = join(repoRoot, "skills", name);
  return trackedSkillFiles(name)
    .map((file) => relative(sourceRoot, join(repoRoot, file)))
    .filter((file) => file.startsWith(`scripts${sep}`))
    .sort();
}

function assertScriptInventory(): void {
  for (const name of publicSkills()) {
    const inventory = SCRIPT_INVENTORY[name];
    if (!inventory) throw new Error(`missing script inventory for ${name}`);
    const expected = [inventory.portable, inventory.remoteNative, inventory.support, inventory.test, inventory.retired].flat().sort();
    expect(new Set(expected).size, `duplicate script inventory entries for ${name}`).toBe(expected.length);
    expect(scriptInventoryFiles(name), `unclassified tracked scripts for ${name}`).toEqual(expected);
  }
}

function assertNoCrossSkillReferences(): void {
  const names = publicSkills();
  const findings: string[] = [];
  for (const name of names) {
    const sourceRoot = join(repoRoot, "skills", name);
    for (const file of trackedSkillFiles(name)) {
      const relativeFile = relative(sourceRoot, join(repoRoot, file));
      const content = readFileSync(join(repoRoot, file), "utf8");
      for (const other of names) {
        if (other === name) continue;
        const markers = [`skills/${other}/`, `skills\\${other}\\`, `../${other}/`, `..\\${other}\\`];
        if (markers.some((marker) => content.includes(marker))) findings.push(`${name}/${relativeFile} -> ${other}`);
      }
    }
  }
  expect(findings, "cross-Skill helper/test references").toEqual([]);
}

function portableScriptInventory(): string[] {
  return publicSkills().flatMap((name) => SCRIPT_INVENTORY[name].portable.map((file) => `${name}/${file}`)).sort();
}

function assertRemoteNativeContracts(roots: Map<string, string>): void {
  for (const name of publicSkills()) {
    const files = SCRIPT_INVENTORY[name].remoteNative;
    const contract = REMOTE_NATIVE_CONTRACTS[name];
    if (files.length === 0) {
      expect(contract, `unexpected remote/native contract for ${name}`).toBeUndefined();
      continue;
    }
    expect(contract, `missing remote/native contract for ${name}`).toBeDefined();
    if (!contract) continue;
    expect(Object.keys(contract.interpreters).sort(), `remote/native inventory drift for ${name}`).toEqual(files);
    const root = roots.get(name)!;
    const skill = readFileSync(join(root, "SKILL.md"), "utf8");
    for (const marker of contract.prerequisiteMarkers) expect(skill, `${name} prerequisite documentation`).toContain(marker);
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      const interpreter = contract.interpreters[file];
      const shebang = interpreter === "bash" ? "#!/usr/bin/env bash\n" : "#!/bin/sh\n";
      expect(source.startsWith(shebang), `${name}/${file} interpreter`).toBe(true);
      expect(source, `${name}/${file} has caller-relative source dependency`).not.toMatch(/(?:^|\n|[;&|])\s*(?:source|\.)\s+(?:["']?(?:\.{1,2}[\\/]|[^/"'$\s]))/m);
      expectSuccess(run([interpreter, "-n", join(root, file)], root), `${name}/${file} syntax`);
    }
  }
}

function assertNoSymlinkAncestors(path: string): void {
  let current = resolve(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`symbolic link is not a public Skill source ancestor: ${path}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertSafeSourcePath(sourceRoot: string, relativePath: string): string {
  const target = resolve(sourceRoot, relativePath);
  if (target !== sourceRoot && !target.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error(`public Skill path escapes source: ${relativePath}`);
  }
  if (lstatSync(sourceRoot).isSymbolicLink()) {
    throw new Error(`symbolic link is not a public Skill directory: ${sourceRoot}`);
  }
  let current = sourceRoot;
  for (const component of relativePath.split(/[\\/]+/)) {
    if (!component || component === ".") continue;
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`symbolic link is not a public Skill file: ${relativePath}`);
    }
  }
  return target;
}

function copyFiles(sourceRoot: string, destination: string, files: string[], boundaryRoot = sourceRoot): void {
  assertSafeSourcePath(boundaryRoot, relative(boundaryRoot, sourceRoot));
  for (const relativePath of files) {
    const source = assertSafeSourcePath(sourceRoot, relativePath);
    const entry = lstatSync(source);
    if (!entry.isFile()) throw new Error(`public Skill file is not regular: ${relativePath}`);
    const target = join(destination, relative(sourceRoot, source));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    chmodSync(target, entry.mode & 0o777);
  }
}

function copyListedSkill(name: string, destinationRoot: string): string {
  const sourceRoot = join(repoRoot, "skills", name);
  assertNoSymlinkAncestors(repoRoot);
  assertSafeSourcePath(repoRoot, relative(repoRoot, sourceRoot));
  const destination = destinationRoot;
  const files = trackedSkillFiles(name).map((file) => relative(sourceRoot, join(repoRoot, file)));
  if (files.length === 0) throw new Error(`no tracked files for ${name}`);
  copyFiles(sourceRoot, destination, files, repoRoot);
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

test("public Skills run from isolated single-directory exports", async () => {
  const workspaces: string[] = [];
  try {
    assertScriptInventory();
    assertNoCrossSkillReferences();
    const roots = new Map<string, string>();
    const executedPortable = new Set<string>();
    for (const name of publicSkills()) {
      const workspace = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "skill-isolation-"));
      workspaces.push(workspace);
      roots.set(name, copyListedSkill(name, workspace));
    }
    for (const [name, root] of roots) {
      const skill = readFileSync(join(root, "SKILL.md"), "utf8");
      expect(skill).toContain(`name: ${name}`);
      expect(skill).toMatch(/^description:/m);
    }
    assertRemoteNativeContracts(roots);

    const buzzer = roots.get("buzzer-audio-preview")!;
    const buzzerOutput = join(buzzer, "output");
    expectSuccess(runBun(buzzer, "scripts/buzzer_preview.ts", ["--in", "assets/score.example.json", "--out-dir", buzzerOutput]), "buzzer preview");
    executedPortable.add("buzzer-audio-preview/scripts/buzzer_preview.ts");
    expect(readFileSync(join(buzzerOutput, "score.example.mid")).subarray(0, 4).toString()).toBe("MThd");
    expect(readFileSync(join(buzzerOutput, "score.example.wav")).subarray(0, 4).toString()).toBe("RIFF");

    const cvm = roots.get("cvm-imagegen")!;
    const dryRun = run(["python3", "scripts/image_gen.py", "generate", "--prompt", "isolated", "--out", join(cvm, "output.png"), "--dry-run"], cvm, {
      AGENT_IMAGEGEN_SYSTEM_PATH: join(cvm, "tests/fixtures/system_image_gen.py"),
    });
    expectSuccess(dryRun, "CVM dry-run with fixture");
    executedPortable.add("cvm-imagegen/scripts/image_gen.py");
    const missingFallback = run(["python3", "scripts/image_gen.py", "generate", "--prompt", "isolated", "--out", join(cvm, "missing.png"), "--dry-run"], cvm, {
      AGENT_IMAGEGEN_SYSTEM_PATH: "",
    });
    expect(missingFallback.code).toBe(1);
    expect(missingFallback.stderr).toContain("imagegen fallback script not found");

    const dst = roots.get("dst-dedicated-server")!;
    const snapshot = runBun(dst, "scripts/dst_snapshot.ts", ["--no-local", "--no-remote", "--out", "snapshot.md"]);
    expectSuccess(snapshot, "DST snapshot");
    executedPortable.add("dst-dedicated-server/scripts/dst_snapshot.ts");
    expect(readFileSync(join(dst, "snapshot.md"), "utf8")).toContain("# DST snapshot");
    mkdirSync(join(dst, "cluster/Master"), { recursive: true });
    writeFileSync(join(dst, "cluster/Master/modoverrides.lua"), 'return {["workshop-1"]={enabled=true}}');
    const mods = runBun(dst, "scripts/dst_mods_from_modoverrides.ts", ["--cluster-dir", "cluster"]);
    expectSuccess(mods, "DST mod summary");
    executedPortable.add("dst-dedicated-server/scripts/dst_mods_from_modoverrides.ts");
    expect(mods.stdout).toContain("enabled_ids: 1");

    const firmware = roots.get("firmware-display-preview")!;
    writeFileSync(join(firmware, "framebuffer.bin"), Buffer.from([0, 255]));
    expectSuccess(runBun(firmware, "scripts/fb_to_png.ts", ["--format", "gray8", "--width", "2", "--height", "1", "--in", "framebuffer.bin", "--out", "preview.png"]), "framebuffer preview");
    executedPortable.add("firmware-display-preview/scripts/fb_to_png.ts");
    expect(readFileSync(join(firmware, "preview.png")).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const gitSync = roots.get("git-sync")!;
    expectSuccess(run([process.execPath, "test", "tests/detached_alignment_contract.test.ts"], gitSync), "Git alignment contract");

    const tavily = roots.get("tavily-hikari-infra")!;
    const tavilyMode = lstatSync(join(repoRoot, "skills/tavily-hikari-infra/scripts/tavily-hikari-infra")).mode & 0o777;
    expect(tavilyMode).toBe(0o755);
    const tavilyFixtureBin = join(tavily, "fixture-bin");
    mkdirSync(tavilyFixtureBin, { recursive: true });
    const tavilyFixtureSsh = join(tavilyFixtureBin, "ssh");
    writeFileSync(tavilyFixtureSsh, '#!/bin/sh\n[ "$1" = "-G" ] || exit 1\ncase "$2" in primary|standby) ;; *) exit 1 ;; esac\nprintf "%s\\n" "hostname fixture.invalid" "port 22" "user operator"\n');
    chmodSync(tavilyFixtureSsh, 0o755);
    expectSuccess(run([join(tavily, "scripts/tavily-hikari-infra"), "inventory"], tavily, {
      HOME: tavily,
      PATH: [tavilyFixtureBin, "/usr/bin", "/bin"].join(delimiter),
      TAVILY_HOSTS_FILE: join(tavily, "references/hosts.txt.example"),
    }), "Tavily inventory");

    const xp = roots.get("xp-infra")!;
    expectSuccess(run([process.execPath, join(xp, "scripts/xp-infra"), "--help"], xp), "XP help");
    expect(lstatSync(join(xp, "scripts/xp-infra-audit-local")).mode & 0o777).toBe(0o755);
    const auditLocal = await runWithInput([join(xp, "scripts/xp-infra-audit-local"), "public-health"], xp, '{"status":"ok","xray":{"status":"up"}}', {
      PATH: dirname(process.execPath),
    });
    expectSuccess(auditLocal, "XP local public-health wrapper");
    expect(auditLocal.stdout).toContain("public_health=true");
    executedPortable.add("xp-infra/scripts/xp-infra-audit-local");
    const policyConfig = join(xp, "policy-fixture");
    mkdirSync(policyConfig, { recursive: true });
    writeFileSync(join(policyConfig, "hosts.txt"), "fixture-node\n");
    writeFileSync(join(policyConfig, "deployment-policy.yaml"), `schema_version: 1
owner_confirmed: true
geo:
  enabled: true
  origin: https://api.country.is
  owner_authorized_third_party_lookup: true
public_hostname:
  zone: example.test
defaults:
  cloudflare_tunnel: true
  cloudflare_ddns: true
  ip_geo_enrichment: true
  managed_default_vless: true
  managed_default_ss2022: false
  direct_docker: false
  vless_port: automatic_preflight
node_overrides: {}
`);
    const policy = run([process.execPath, join(xp, "scripts/xp-infra"), "policy", "check"], xp, {
      XP_INFRA_CONFIG_DIR: policyConfig,
      PATH: "/usr/bin:/bin",
    });
    expectSuccess(policy, "XP offline policy check");
    expect(policy.stdout).toBe("policy: OK\n");
    executedPortable.add("xp-infra/scripts/xp-infra");
    expect([...executedPortable].sort()).toEqual(portableScriptInventory());
  } finally {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  }
});

test("single-directory exporter rejects symbolic links", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "skill-isolation-link-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    const outside = join(root, "outside");
    mkdirSync(source, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: example\n---\n");
    symlinkSync(join(source, "SKILL.md"), join(source, "linked.md"));
    expect(() => copyFiles(source, destination, ["SKILL.md", "linked.md"])).toThrow("symbolic link");
    symlinkSync(outside, join(source, "nested"));
    writeFileSync(join(outside, "escaped.md"), "outside");
    expect(() => copyFiles(source, destination, ["nested/escaped.md"])).toThrow("symbolic link");
    symlinkSync(source, join(root, "source-link"));
    expect(() => copyFiles(join(root, "source-link"), destination, ["SKILL.md"])).toThrow("symbolic link");
    const boundary = join(root, "boundary");
    const external = join(root, "external");
    mkdirSync(boundary, { recursive: true });
    mkdirSync(join(external, "example"), { recursive: true });
    writeFileSync(join(external, "example/SKILL.md"), "---\nname: example\n---\n");
    symlinkSync(external, join(boundary, "skills"));
    expect(() => copyFiles(boundary, destination, ["skills/example/SKILL.md"])).toThrow("symbolic link");
    const logicalRoot = join(root, "logical");
    const realParent = join(root, "real-parent");
    mkdirSync(logicalRoot, { recursive: true });
    mkdirSync(join(realParent, "example"), { recursive: true });
    writeFileSync(join(realParent, "example/SKILL.md"), "---\nname: example\n---\n");
    symlinkSync(realParent, join(logicalRoot, "link"));
    expect(() => copyFiles(join(logicalRoot, "link/example"), destination, ["SKILL.md"], logicalRoot)).toThrow("symbolic link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
