import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseModOverrides,
  renderDiff,
  renderSummary,
  type ShardSummary,
} from "../scripts/dst_mods_from_modoverrides.ts";
import { main as snapshotMain } from "../scripts/dst_snapshot.ts";

async function runTool(script: string, args: string[], env: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, script, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, stdout, stderr };
}

describe("DST local Bun tooling", () => {
  test("parses nested mod configuration without executing Lua and renders shard differences", () => {
    const source = `return {
  ["workshop-200"] = {
    configuration_options = {
      enabled = true,
    },
    enabled = false,
  },
  ["workshop-100"] = { enabled = true },
  ["workshop-300"] = {
    configuration_options = {
      enabled = false,
    },
  },
}`;
    const mods = parseModOverrides(source);
    expect(mods).toEqual([
      { id: "100", state: "true" },
      { id: "200", state: "false" },
      { id: "300", state: "unknown" },
    ]);
    const master: ShardSummary = { shard: "Master", present: true, filePath: "fixture/Master/modoverrides.lua", mods };
    const caves: ShardSummary = { shard: "Caves", present: true, filePath: "fixture/Caves/modoverrides.lua", mods: [{ id: "100", state: "false" }, { id: "400", state: "true" }] };
    const summary = renderSummary("cluster", master);
    expect(summary).toContain("enabled_ids: 100");
    expect(summary).toContain("disabled_ids: 200");
    expect(summary).toContain("unknown_ids: 300");
    expect(renderDiff("cluster", master, caves)).toContain("enabled_only_in_master: 100");
    expect(renderDiff("cluster", master, caves)).toContain("enabled_only_in_caves: 400");
    expect(renderDiff("cluster", master, caves)).toContain("disabled_only_in_master: 200");
    expect(renderDiff("cluster", master, caves)).toContain("disabled_only_in_caves: 100");
  });

  test("collects a bounded local snapshot without printing secret contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-local-"));
    try {
      const local = join(root, "client");
      const cluster = join(local, "Cluster_fixture");
      await mkdir(cluster, { recursive: true });
      await writeFile(join(local, "client_log.txt"), "safe line\ncluster_password=never-emit\n");
      await writeFile(join(cluster, "cluster.ini"), "cluster_password=secret-fixture\n");
      await writeFile(join(cluster, "cluster_token.txt"), "token-fixture\n");
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("## Local");
      expect(report).toContain("cluster.ini: present (contains cluster_password; do not paste)");
      expect(report).toContain("cluster_token.txt: present (redacted)");
      expect(report).not.toContain("never-emit");
      expect(report).not.toContain("secret-fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves remote selection, missing shard resources, and failed SSH diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) exit 0 ;;
  *Master*)
    data='["workshop-100"] = { enabled = true, configuration_options = { enabled = false } }'
    printf 'PRESENT %s\\n%s' "\${#data}" "$data"
    ;;
  *Caves*) printf 'MISSING\\n' ;;
  *) cat >/dev/null; exit 1 ;;
esac
`);
      await chmod(fakeSsh, 0o755);
      process.env.PATH = `${root}:${previousPath ?? ""}`;
      const env = { ...process.env, PATH: process.env.PATH } as Record<string, string>;
      const result = await runTool(join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"), ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster", "--shard", "both"], env);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("## fixture-cluster / Master");
      expect(result.stdout).toContain("enabled_ids: 100");
      expect(result.stdout).toContain("## fixture-cluster / Caves");
      expect(result.stdout).toContain("modoverrides.lua: missing");
      expect(result.stdout).not.toContain("configuration_options");

      await writeFile(fakeSsh, "#!/bin/sh\ncat >/dev/null\necho denied >&2\nexit 1\n");
      await chmod(fakeSsh, 0o755);
      const failed = await runTool(join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"), ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster"], env);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("denied");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a failed snapshot SSH check without attempting a remote operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-ssh-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, "#!/bin/sh\necho denied >&2\nexit 1\n");
      await chmod(fakeSsh, 0o755);
      process.env.PATH = `${root}:${previousPath ?? ""}`;
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("Remote SSH failed");
      expect(report).toContain("ssh fixture-user@fixture-host");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
