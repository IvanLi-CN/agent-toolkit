import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
import { main as snapshotMain, MAX_LOCAL_DIRECTORY_ENTRIES, MAX_REMOTE_OUTPUT_BYTES, redactOperationalText, redactSensitiveText, safeTail } from "../scripts/dst_snapshot.ts";

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
    expect(redactSensitiveText("Authorization Bearer fixture-secret")).toBe("Authorization [REDACTED]");
    expect(redactSensitiveText("Authorization: Basic fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText('api_key="prefix\\"LEAK"')).toBe("api_key=[REDACTED]");
    expect(redactSensitiveText('{"token":"json-secret", "api_key": "other-secret"}')).not.toMatch(/json-secret|other-secret/);
    expect(redactSensitiveText("api_token=abc,SECRET_TAIL")).toBe("api_token=[REDACTED]");
    expect(redactSensitiveText("api_key=value with fixture-secret")).toBe("api_key=[REDACTED]");
    expect(redactSensitiveText("password fixture secret with spaces")).toBe("password [REDACTED]");
    const multilineToken = ["token", "=", '"', "first-line\nsecond-line", '"'].join("");
    expect(redactSensitiveText(multilineToken)).toBe("token=[REDACTED]");
    expect(redactSensitiveText("api_key=[REDACTED] token raw-secret")).toBe("api_key=[REDACTED] token [REDACTED]");
    const mixedSecrets = ["passphrase", "=", "fixture-secret", " pwd ", "fixture-secret"].join("");
    expect(redactSensitiveText(mixedSecrets)).toBe("passphrase=[REDACTED] pwd [REDACTED]");
    expect(redactOperationalText("permission denied: foo\\..\\private\\fixture-secret")).toContain("<redacted-path>");
  });

  test("does not expose a secret that crosses the bounded log tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-tail-boundary-"));
    try {
      const log = join(root, "client_log.txt");
      await writeFile(log, `api_key=${"x".repeat(300_000)}fixture-secret\nvisible-line\n`);
      const tail = await safeTail(log, 80);
      expect(tail).not.toContain("fixture-secret");
      expect(tail).toContain("visible-line");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects cluster path traversal before opening SSH", () => {
    expect(() => parseArgs(["--host", "fixture-host", "--user", "fixture-user", "--cluster", "../escape"], {})).toThrow(/single path segment/);
    expect(() => parseArgs(["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture\\escape"], {})).toThrow(/single path segment/);
    expect(() => parseArgs(["--host", "fixture-host", "--user", "fixture-user", "--cluster", "safe\n## forged heading"], {})).toThrow(/single path segment/);
    expect(() => parseArgs(["--host", "-oProxyCommand=touch /tmp/pwned", "--user", "fixture-user", "--cluster", "fixture"], {})).toThrow(/invalid SSH token/);
    expect(() => parseArgs(["--host", "fixture-host", "--user", "-oProxyCommand=touch /tmp/pwned", "--cluster", "fixture"], {})).toThrow(/invalid SSH token/);
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

    expect(parseModOverrides('return { ["workshop-400"] = { configuration_options = { enabled = true }, enabled = false } }')).toEqual([
      { id: "400", state: "false" },
    ]);
    expect(parseModOverrides(`return {
  ["workshop-500"] = {
    configuration_options =
    {
      enabled = false,
    },
    enabled = true,
  },
}`)).toEqual([{ id: "500", state: "true" }]);

    expect(parseModOverrides(`return {
  ["workshop-550"] = { configuration_options =
    { ["workshop-999"] = { enabled = true } },
    enabled = false,
  },
}`)).toEqual([{ id: "550", state: "false" }]);

    expect(parseModOverrides(`return {
  ["workshop-600"] = {
    configuration_options = {
      ["workshop-999"] = { enabled = true },
    },
    enabled = false,
  },
}`)).toEqual([{ id: "600", state: "false" }]);
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
      expect(report).toContain("<cluster-1>");
      expect(report).toContain("<cluster-2>");
      expect(report).not.toContain(local);
      expect(report).not.toContain("secret-fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not treat an option-like relative local directory as an ls flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-local-option-"));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(root, "-R"));
      await writeFile(join(root, "outside-secret.txt"), "should not be listed");
      process.chdir(root);
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", "-R", "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("## Local");
      expect(report).not.toContain("outside-secret.txt");
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds local directory entry scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-local-limit-"));
    try {
      const local = join(root, "client");
      await mkdir(local, { recursive: true });
      await Promise.all(Array.from({ length: MAX_LOCAL_DIRECTORY_ENTRIES + 10 }, (_, index) => writeFile(join(local, `entry-${String(index).padStart(4, "0")}.txt`), "")));
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      expect(await readFile(output, "utf8")).toContain(`Directory entry scan truncated at ${MAX_LOCAL_DIRECTORY_ENTRIES} entries.`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow a symlinked client log", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-symlink-"));
    try {
      const local = join(root, "client");
      await mkdir(local, { recursive: true });
      const secret = join(root, "private-key.txt");
      await writeFile(secret, "PRIVATE_KEY_MUST_NOT_APPEAR\n");
      await symlink(secret, join(local, "client_log.txt"));
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).not.toContain("PRIVATE_KEY_MUST_NOT_APPEAR");
      expect(report).not.toContain("client_log.txt (tail 80)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remote mod collection refuses symlinked shard files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-symlink-"));
    try {
      const home = join(root, "home");
      const cluster = join(home, ".klei", "DoNotStarveTogether", "fixture", "Master");
      await mkdir(cluster, { recursive: true });
      const outside = join(root, "outside.lua");
      await writeFile(outside, '["workshop-999"] = { enabled = true }\n');
      await symlink(outside, join(cluster, "modoverrides.lua"));
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_mods_remote_collect.sh"), "fixture", "Master"], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(status).toBe(0);
      expect(stdout).toContain("MISSING");
      expect(stdout).not.toContain("workshop-999");

      const traversal = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_mods_remote_collect.sh"), "../../outside", "Master"], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      expect(await traversal.exited).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remote mod collection keeps a valid file bound across macOS and Linux stat layouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-valid-"));
    try {
      const home = join(root, "home");
      const shard = join(home, ".klei", "DoNotStarveTogether", "fixture", "Master");
      await mkdir(shard, { recursive: true });
      await writeFile(join(shard, "modoverrides.lua"), '["workshop-123"] = { configuration_options = { password = "fixture-secret", enabled = false }, enabled = true }\n');
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_mods_remote_collect.sh"), "fixture", "Master"], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("PRESENT ");
      expect(stdout).toContain("workshop-123");
      expect(stdout).toContain("enabled = true");
      expect(stdout).not.toContain("configuration_options");
      expect(stdout).not.toContain("fixture-secret");
      expect(stdout).not.toContain(home);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remote mod collection rejects a same-size in-place rewrite after reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-mutation-"));
    try {
      const home = join(root, "home");
      const shard = join(home, ".klei", "DoNotStarveTogether", "fixture", "Master");
      await mkdir(shard, { recursive: true });
      const original = '["workshop-123"] = { enabled = true }\n';
      const mutation = '["workshop-456"] = { enabled = true }\n';
      expect(new TextEncoder().encode(original).length).toBe(new TextEncoder().encode(mutation).length);
      const target = join(shard, "modoverrides.lua");
      await writeFile(target, original);
      const bin = join(root, "bin");
      await mkdir(bin);
      const realHead = Bun.which("head");
      if (realHead === null) throw new Error("head is required for this regression test");
      const wrapper = join(bin, "head");
      await writeFile(wrapper, `#!/bin/sh\n"$REAL_HEAD" "$@"\nstatus=$?\nif [ "$status" -eq 0 ]; then printf '%s' "$MUTATION" > "$TARGET"; fi\nexit "$status"\n`);
      await chmod(wrapper, 0o755);
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_mods_remote_collect.sh"), "fixture", "Master"], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_HEAD: realHead, TARGET: target, MUTATION: mutation },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("changed during collection");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remote snapshot refuses a symlinked Klei root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-root-"));
    try {
      const home = join(root, "home");
      const outside = join(root, "outside");
      await mkdir(home, { recursive: true });
      await mkdir(join(outside, "DoNotStarveTogether", "Cluster_secret", "Master"), { recursive: true });
      await writeFile(join(outside, "DoNotStarveTogether", "Cluster_secret", "cluster.ini"), "cluster_password=must-not-appear\n");
      await symlink(outside, join(home, ".klei"));
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_snapshot_remote.sh")], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(status).toBe(0);
      expect(stdout).toContain("Klei data");
      expect(stdout).not.toContain("Cluster_secret");
      expect(stdout).not.toContain("must-not-appear");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remote snapshot enumerates direct clusters with a bounded walk", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-clusters-"));
    try {
      const home = join(root, "home");
      const cluster = join(home, ".klei", "DoNotStarveTogether", "Cluster_fixture");
      await mkdir(join(cluster, "Master"), { recursive: true });
      await writeFile(join(cluster, "cluster.ini"), "cluster_password=fixture-secret\n");
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_snapshot_remote.sh")], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(status).toBe(0);
      expect(stdout).toContain("#### Cluster: <cluster>");
      expect(stdout).toContain("- cluster.ini: present (contains cluster_password; do not paste)");
      expect(stdout).not.toContain("fixture-secret");
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
    cat >/dev/null
    data='["workshop-100"] = { enabled = true, configuration_options = { enabled = false } }'
    printf 'PRESENT %s\\n%s' "\${#data}" "$data"
    ;;
  *Caves*) cat >/dev/null; printf 'MISSING\\n' ;;
  *) cat >/dev/null; exit 1 ;;
esac
`);
      await chmod(fakeSsh, 0o755);
      const env = { ...process.env, PATH: `${root}:${previousPath ?? ""}` } as Record<string, string>;
      const result = await runTool(join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"), ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster", "--shard", "both"], env);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("## fixture-cluster / Master");
      expect(result.stdout).toContain("enabled_ids: 100");
      expect(result.stdout).toContain("## fixture-cluster / Caves");
      expect(result.stdout).toContain("modoverrides.lua: missing (modoverrides.lua)");
      expect(result.stdout).not.toContain("configuration_options");

      const leakedPath = ["/home", "fixture-user", "private"].join("/");
      await writeFile(fakeSsh, `#!/bin/sh\ncase "$*" in\n  *"echo ok"*) exit 0 ;;\n  *) cat >/dev/null; echo 'denied ${leakedPath} api_key=fixture-secret' >&2; exit 1 ;;\nesac\n`);
      await chmod(fakeSsh, 0o755);
      const failed = await runTool(join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"), ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster"], env);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("denied");
      expect(failed.stderr).toContain("api_key=[REDACTED]");
      expect(failed.stderr).not.toContain("fixture-secret");
      expect(failed.stderr).not.toContain(leakedPath);

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
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a completed shard summary when the next shard fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-partial-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) exit 0 ;;
  *Master*) cat >/dev/null; data='["workshop-100"] = { enabled = true }'; printf 'PRESENT %s\\n%s' "\${#data}" "$data" ;;
  *Caves*) cat >/dev/null; echo 'caves unavailable' >&2; exit 1 ;;
  *) cat >/dev/null; exit 1 ;;
esac
`);
      await chmod(fakeSsh, 0o755);
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster", "--shard", "both"],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}` } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("## fixture-cluster / Master");
      expect(result.stdout).toContain("enabled_ids: 100");
      expect(result.stdout).not.toContain("## fixture-cluster / Caves");
      expect(result.stderr).toContain("caves unavailable");
    } finally {
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
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}` } as Record<string, string>,
      );
      expect(result.status).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("Remote SSH failed");
      expect(report).toContain("configured SSH target");
      expect(report).not.toContain("fixture-user@fixture-host");
    } finally {
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
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}` } as Record<string, string>,
      );
      expect(result.status).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("api_key=[REDACTED]");
      expect(report).not.toContain("fixture-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts arbitrary paths and IPv4/IPv6 addresses from operational diagnostics", () => {
    const diagnostic = "denied /workspace/private/key /srv/fixture/My Secret/token ../relative/private/key \\\\server\\share\\private via 192.0.2.8, [2001:db8::7], and ::ffff:192.0.2.9";
    const redacted = redactOperationalText(diagnostic);
    expect(redacted).not.toContain("/workspace/private/key");
    expect(redacted).not.toContain("../relative/private/key");
    expect(redacted).not.toContain("\\\\server\\share\\private");
    expect(redacted).not.toContain("192.0.2.8");
    expect(redacted).not.toContain("192.0.2.9");
    expect(redacted).not.toContain("2001:db8::7");
    expect(redacted).toContain("<redacted-path>");
    expect(redacted).toContain("<redacted-address>");
    expect(redacted).not.toContain("My Secret");
  });

  test("redacts relative and UNC paths after assignment delimiters", () => {
    const diagnostic = String.raw`file=..\private\key path:\\server\share\private`;
    const redacted = redactOperationalText(diagnostic);
    expect(redacted).not.toContain("..\\private\\key");
    expect(redacted).not.toContain("\\\\server\\share\\private");
    expect(redacted).toContain("<redacted-path>");
  });

  test("redacts snapshot publication errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-publish-error-"));
    const previousPath = process.env.PATH;
    try {
      const output = join(root, "publication-secret", "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--no-local", "--no-remote", "--out", output],
        { ...process.env, PATH: previousPath ?? "" } as Record<string, string>,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("publication-secret");
      expect(result.stderr).not.toContain(".dst-snapshot-tmp-");
      expect(result.stderr).toContain("<redacted-path>");
    } finally {
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
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}` } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      expect(await readFile(output, "utf8")).toContain("output limit");
    } finally {
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
      expect(results.sort()).toEqual([0, 0]);
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

    const missing = new TextEncoder().encode("MISSING\n");
    await expect(parseRemoteResponseStream("fixture-cluster", "Master", "fixture/Master/modoverrides.lua", byteStream([missing]))).resolves.toMatchObject({
      present: false,
      filePath: "fixture/Master/modoverrides.lua",
    });
  });

  test("times out a remote response stream that never produces bytes", async () => {
    const hanging = new ReadableStream<Uint8Array>({ start() {} });
    await expect(parseRemoteResponseStream("fixture-cluster", "Master", "fixture", hanging, 10)).rejects.toThrow(/timed out/);
  });
});
