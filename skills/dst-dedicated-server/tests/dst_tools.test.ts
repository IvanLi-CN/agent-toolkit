import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_MOD_OVERRIDE_BYTES,
  parseRemoteResponseStream,
  parseModOverrides,
  parseArgs,
  renderDiff,
  renderSummary,
  type ShardSummary,
} from "../scripts/dst_mods_from_modoverrides.ts";
import { main as snapshotMain, MAX_REMOTE_OUTPUT_BYTES, redactSensitiveText } from "../scripts/dst_snapshot.ts";

async function runTool(script: string, args: string[], env: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, script, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, stdout, stderr };
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("DST local Bun tooling", () => {
  test("redacts bearer, basic, and escaped quoted secrets completely", () => {
    expect(redactSensitiveText("Authorization: Bearer fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText("Authorization: Basic fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText('api_key="prefix\\"LEAK"')).toBe("api_key=[REDACTED]");
  });

  test("rejects cluster path traversal before opening SSH", () => {
    expect(() => parseArgs(["--host", "fixture-host", "--user", "fixture-user", "--cluster", "../escape"], {})).toThrow(/single path segment/);
    expect(() => parseArgs(["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture\\escape"], {})).toThrow(/single path segment/);
  });

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
      const cluster = join(local, "profile", "Cluster_fixture");
      const directCluster = join(local, "Cluster_direct");
      await mkdir(cluster, { recursive: true });
      await mkdir(directCluster, { recursive: true });
      await Promise.all(Array.from({ length: 240 }, (_, index) => writeFile(join(local, `entry-${String(index).padStart(3, "0")}.txt`), "")));
      const logLines = Array.from({ length: 10_000 }, (_, index) => `line-${String(index).padStart(5, "0")}`);
      logLines[0] = "early-log-marker";
      logLines.push("api_key=fixture-secret");
      await writeFile(join(local, "client_log.txt"), `${logLines.join("\n")}\n`);
      await writeFile(join(cluster, "cluster.ini"), "cluster_password=secret-fixture\n");
      await writeFile(join(cluster, "cluster_token.txt"), "token-fixture\n");
      await writeFile(join(directCluster, "cluster_token.txt"), "token-fixture-direct\n");
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("## Local");
      expect(report).toContain("cluster.ini: present (contains cluster_password; do not paste)");
      expect(report).toContain("cluster_token.txt: present (redacted)");
      expect(report).toContain("line-09999");
      expect(report).not.toContain("early-log-marker");
      expect(report).not.toContain("fixture-secret");
      expect(report).toContain("api_key=[REDACTED]");
      expect(report).not.toContain("entry-239.txt");
      expect(report).toContain("Cluster_fixture");
      expect(report).toContain("Cluster_direct");
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

      await writeFile(fakeSsh, "#!/bin/sh\ncase \"$*\" in\n  *\"echo ok\"*) exit 0 ;;\n  *) cat >/dev/null; echo 'denied api_key=fixture-secret' >&2; exit 1 ;;\nesac\n");
      await chmod(fakeSsh, 0o755);
      const failed = await runTool(join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"), ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster"], env);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("denied");
      expect(failed.stderr).toContain("api_key=[REDACTED]");
      expect(failed.stderr).not.toContain("fixture-secret");

      const snapshotOutput = join(root, "remote-failure-snapshot.md");
      const snapshotResult = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", snapshotOutput],
        env,
      );
      expect(snapshotResult.status).toBe(1);
      const snapshot = await readFile(snapshotOutput, "utf8");
      expect(snapshot).toContain("Remote collection command failed");
      expect(snapshot).toContain("denied");
      expect(snapshot).toContain("api_key=[REDACTED]");
      expect(snapshot).not.toContain("fixture-secret");
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
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: process.env.PATH } as Record<string, string>,
      );
      expect(result.status).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("Remote SSH failed");
      expect(report).toContain("ssh fixture-user@fixture-host");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts sensitive values from successful remote snapshot output", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-redaction-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) exit 0 ;;
  *) printf '### Remote fixture\\napi_key=fixture-secret\\n' ;;
esac
`);
      await chmod(fakeSsh, 0o755);
      process.env.PATH = `${root}:${previousPath ?? ""}`;
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: process.env.PATH } as Record<string, string>,
      );
      expect(result.status).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("api_key=[REDACTED]");
      expect(report).not.toContain("fixture-secret");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an oversized remote snapshot before writing unbounded output", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-limit-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) exit 0 ;;
  *) head -c $(( ${MAX_REMOTE_OUTPUT_BYTES} + 1 )) /dev/zero ;;
esac
`);
      await chmod(fakeSsh, 0o755);
      process.env.PATH = `${root}:${previousPath ?? ""}`;
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: process.env.PATH } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      expect(await readFile(output, "utf8")).toContain("output limit");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes concurrent reports without partial writes or overwrites", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-publish-"));
    try {
      const output = join(root, "snapshot.md");
      const results = await Promise.all([
        snapshotMain(["--no-local", "--no-remote", "--out", output]),
        snapshotMain(["--no-local", "--no-remote", "--out", output]),
      ]);
      expect(results.sort()).toEqual([0, 2]);
      const report = await readFile(output, "utf8");
      expect(report).toContain("# DST snapshot");
      expect((await readdir(root)).filter((entry) => entry.startsWith(".dst-snapshot-tmp-")).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses large remote responses across arbitrary byte chunks", async () => {
    const source = [
      "return {",
      ...Array.from({ length: 1_200 }, (_, index) => `  [\"workshop-${100_000 + index}\"] = { enabled = ${index % 2 === 0 ? "true" : "false"} },`),
      "}",
    ].join("\n");
    const body = new TextEncoder().encode(source);
    const payload = new TextEncoder().encode(`PRESENT ${body.byteLength}\n`);
    const response = new Uint8Array(payload.byteLength + body.byteLength);
    response.set(payload);
    response.set(body, payload.byteLength);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < response.byteLength; offset += 7) chunks.push(response.slice(offset, offset + 7));
    const summary = await parseRemoteResponseStream("fixture-cluster", "Master", "fixture/Master/modoverrides.lua", byteStream(chunks));
    expect(summary.present).toBe(true);
    expect(summary.mods).toHaveLength(1_200);
    expect(summary.mods[0]).toEqual({ id: "100000", state: "true" });
    expect(summary.mods.at(-1)).toEqual({ id: "101199", state: "false" });
  });

  test("rejects truncated and trailing remote response bodies", async () => {
    const body = new TextEncoder().encode('["workshop-100"] = { enabled = true }');
    const header = new TextEncoder().encode(`PRESENT ${body.byteLength + 1}\n`);
    const truncated = new Uint8Array(header.byteLength + body.byteLength);
    truncated.set(header);
    truncated.set(body, header.byteLength);
    await expect(parseRemoteResponseStream("fixture-cluster", "Master", "fixture", byteStream([truncated]))).rejects.toThrow(/truncated/);

    const declared = new TextEncoder().encode(`PRESENT ${body.byteLength}\n`);
    const trailing = new Uint8Array(declared.byteLength + body.byteLength + 1);
    trailing.set(declared);
    trailing.set(body, declared.byteLength);
    trailing[trailing.length - 1] = 0x00;
    await expect(parseRemoteResponseStream("fixture-cluster", "Master", "fixture", byteStream([trailing]))).rejects.toThrow(/invalid response/);

    const oversized = new TextEncoder().encode(`PRESENT ${MAX_MOD_OVERRIDE_BYTES + 1}\n`);
    await expect(parseRemoteResponseStream("fixture-cluster", "Master", "fixture", byteStream([oversized]))).rejects.toThrow(/exceeds/);
  });
});
