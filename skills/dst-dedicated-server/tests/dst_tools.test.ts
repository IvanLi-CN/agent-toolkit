import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_MOD_OVERRIDE_BYTES,
  parseRemoteResponseStream,
  parseModOverrides,
  parseArgs,
  renderDiff,
  renderSummary,
  type ShardSummary,
} from "../scripts/dst_mods_from_modoverrides.ts";
import { main as snapshotMain, MAX_LOCAL_DIRECTORY_ENTRIES, MAX_LOCAL_LOG_LISTING_ENTRIES, MAX_REMOTE_OUTPUT_BYTES, redactOperationalText, redactSensitiveText, safeTail } from "../scripts/dst_snapshot.ts";
import { spawnSupervised, SUPERVISOR_UNKNOWN_TARGET_STATUS } from "../scripts/process_supervisor.ts";

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

describe.serial("DST local Bun tooling", () => {
  test("uses an error envelope for CLI parse failures", async () => {
    const env = { ...process.env } as Record<string, string>;
    const snapshot = await runTool(join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"), ["--unknown"], env);
    expect(snapshot.status).toBe(2);
    expect(snapshot.stderr).toStartWith("error: Unknown arg: --unknown");

    const mods = await runTool(join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"), ["--unknown"], env);
    expect(mods.status).toBe(2);
    expect(mods.stderr).toStartWith("error: Unknown arg: --unknown");
  });

  test("redacts bearer, basic, and escaped quoted secrets completely", () => {
    expect(redactSensitiveText("Authorization: Bearer fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText("Authorization: Bearer : fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText("Authorization Bearer fixture-secret")).toBe("Authorization [REDACTED]");
    expect(redactSensitiveText("Authorization: Basic fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText("Authorization: Basic = fixture-secret")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText("Basic fixture-secret")).not.toContain("fixture-secret");
    expect(redactSensitiveText("pass phrase: fixture-secret")).not.toContain("fixture-secret");
    expect(redactSensitiveText("-----BEGIN PRIVATE KEY-----\nMIIEfixture-secret\n-----END PRIVATE KEY-----")).not.toContain("fixture-secret");
    expect(redactSensitiveText("-----BEGIN PRIVATE KEY-----\nMIIEtruncated-fixture-secret\nvisible-after-truncation")).toBe("[REDACTED]");
    expect(redactSensitiveText("[api_key]=fixture-secret")).not.toContain("fixture-secret");
    expect(redactSensitiveText("api_key%3Dfixture-secret")).not.toContain("fixture-secret");
    expect(redactSensitiveText("password: |\n  fixture-secret\nnext: visible")).not.toContain("fixture-secret");
    expect(redactSensitiveText("api_\u001b[31mkey=fixture-secret")).not.toContain("fixture-secret");
    expect(redactSensitiveText("api_key=\n  fixture-secret\nvisible=ok")).not.toContain("fixture-secret");
    expect(redactSensitiveText('{"api_keys": [\n  "json-secret"\n], "nested": {"token": "nested-secret"}}')).not.toMatch(/json-secret|nested-secret/);
    expect(redactSensitiveText('api_key="prefix\\"LEAK"')).toBe("api_key=[REDACTED]");
    expect(redactSensitiveText('{"token":"json-secret", "api_key": "other-secret"}')).not.toMatch(/json-secret|other-secret/);
    expect(redactSensitiveText("api_token=abc,SECRET_TAIL")).toBe("api_token=[REDACTED]");
    expect(redactSensitiveText("api_key=value with fixture-secret")).toBe("api_key=[REDACTED]");
    expect(redactSensitiveText("password fixture secret with spaces")).toBe("password [REDACTED]");
    const multilineToken = ["token", "=", '"', "first-line\nsecond-line", '"'].join("");
    expect(redactSensitiveText(multilineToken)).toBe("token=[REDACTED]");
    expect(redactSensitiveText("api_key=[REDACTED] token raw-secret")).toBe("api_key=[REDACTED] token [REDACTED]");
    expect(redactSensitiveText("api_key=q7Kp9Zx4\nq7Kp9Zx4")).not.toContain("q7Kp9Zx4");
    expect(redactOperationalText("[api_key]=fixture-secret,SECRET_TAIL")).not.toContain("SECRET_TAIL");
    expect(redactOperationalText("api_key%3Dfixture-secret&SECRET_TAIL")).not.toContain("SECRET_TAIL");
    expect(redactSensitiveText("Cookie: sessionid=fixture-secret")).not.toContain("fixture-secret");
    expect(redactSensitiveText("Set-Cookie: session_id=fixture-secret")).not.toContain("fixture-secret");
    const additionalSecretNames = [
      ["SIGNING", "_KEY"].join(""),
      ["ENCRYPTION", "_KEY"].join(""),
      ["DATABASE", "_URL"].join(""),
      ["MONGO", "_URI"].join(""),
    ];
    for (const name of additionalSecretNames) {
      expect(redactSensitiveText(`${name}=fixture-secret`)).not.toContain("fixture-secret");
    }
    expect(redactSensitiveText('{"bearer": "json-bearer-secret", "basic": "json-basic-secret"}')).not.toMatch(/json-bearer-secret|json-basic-secret/);
    expect(redactSensitiveText("token={\n  \"value\": \"fixture-secret\"")).not.toContain("fixture-secret");
    const mixedSecrets = ["passphrase", "=", "fixture-secret", " pwd ", "fixture-secret"].join("");
    expect(redactSensitiveText(mixedSecrets)).toBe("passphrase=[REDACTED] pwd [REDACTED]");
    expect(redactOperationalText("permission denied: foo\\..\\private\\fixture-secret")).toContain("<redacted-path>");
    expect(redactOperationalText("provider credentials fixture-secret")).not.toContain("fixture-secret");
    expect(redactOperationalText("access_token fixture-access-token-secret")).not.toContain("fixture-access-token-secret");
    expect(redactOperationalText("accessToken fixture-camel-token-secret")).not.toContain("fixture-camel-token-secret");
    expect(redactOperationalText("JWT fixture-jwt-secret")).not.toContain("fixture-jwt-secret");
    const rawJwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "fixture_signature-secret-01"].join(".");
    expect(redactSensitiveText(rawJwt)).toBe("[REDACTED JWT]");
  });

  test("does not expose a secret that crosses the bounded log tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-tail-boundary-"));
    try {
      const log = join(root, "client_log.txt");
      await writeFile(log, `api_key=${"x".repeat(300_000)}fixture-secret\nvisible-line\n`);
      const tail = await safeTail(log, 80);
      expect(tail).not.toContain("fixture-secret");
      expect(tail).toContain("[REDACTED: bounded log tail begins mid-record]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts a multiline secret continuation when the bounded tail begins mid-record", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-tail-block-boundary-"));
    try {
      const log = join(root, "client_log.txt");
      await writeFile(log, `password: |\n  ${"x".repeat(300_000)}\n  fixture-secret\nvisible-line\n`);
      const tail = await safeTail(log, 80);
      expect(tail).toContain("[REDACTED: bounded log tail begins mid-record]");
      expect(tail).not.toContain("fixture-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts a multiline secret whose header falls outside the line tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-tail-line-boundary-"));
    try {
      const log = join(root, "client_log.txt");
      const continuation = Array.from({ length: 100 }, (_, index) => `  fixture-line-${index}`).join("\n");
      await writeFile(log, `password: |\n${continuation}\n  fixture-secret\nvisible-line\n`);
      const tail = await safeTail(log, 80);
      expect(tail).not.toContain("fixture-secret");
      expect(tail).toContain("[REDACTED]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts a PEM body when the bounded tail begins mid-record", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-tail-pem-boundary-"));
    try {
      const log = join(root, "client_log.txt");
      const body = Array.from({ length: 6_000 }, (_, index) => `MIIE${String(index).padStart(4, "0")}${"A".repeat(56)}`).join("\n");
      await writeFile(log, `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nvisible-line\n`);
      const tail = await safeTail(log, 80);
      expect(tail).toContain("[REDACTED: bounded log tail begins mid-record]");
      expect(tail).not.toContain("MIIE0000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not block on a FIFO passed to safeTail", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-fifo-"));
    try {
      const fifo = join(root, "client_log.txt");
      const maker = Bun.spawn(["mkfifo", fifo], { stdout: "pipe", stderr: "pipe" });
      expect(await maker.exited).toBe(0);
      const result = await Promise.race([safeTail(fifo, 80), Bun.sleep(500).then(() => "timed out")]);
      expect(result).toBe("");
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

  test("escapes cluster and file labels before rendering Markdown", () => {
    const summary = renderSummary("<img src=x onerror=alert(1)>", {
      shard: "Master",
      present: false,
      filePath: "<script>alert(1)</script>",
      mods: [],
    });
    expect(summary).not.toContain("<img");
    expect(summary).not.toContain("<script>");
    expect(summary).toContain("&lt;img");
    expect(summary).toContain("&lt;script");
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

  test("ignores braces and enabled assignments inside Lua strings and comments", () => {
    const source = `return {
  ["workshop-401"] = { title = "}", note = "enabled = false", enabled = true }, -- enabled = false
  ["workshop-402"] = { title = "-- not a comment", enabled = false },
}`;
    expect(parseModOverrides(source)).toEqual([
      { id: "401", state: "true" },
      { id: "402", state: "false" },
    ]);
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
      await writeFile(join(local, "aws-prod-secret-key-SECRET_CANARY.pem"), "private\n");
      await writeFile(join(local, "password"), "private\n");
      await writeFile(join(local, ".env"), "private\n");
      await writeFile(join(local, "id_rsa"), "private\n");
      await writeFile(join(local, "private.key"), "private\n");
      await writeFile(join(local, "auth.json"), "private\n");
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("## Local");
      expect(report).toContain("cluster.ini: present (contains cluster_password; do not paste)");
      expect(report).toContain("cluster_token.txt: present (redacted)");
      expect(report).toContain("line-09999");
      expect(report).not.toContain("early-log-marker");
      expect(report).not.toContain("fixture-secret");
      expect(report).not.toContain("aws-prod-secret-key-SECRET_CANARY.pem");
      expect(report).not.toMatch(/(^|\s)password(\s|$)/m);
      expect(report).not.toMatch(/(^|\s)\.env(\s|$)/m);
      expect(report).not.toMatch(/(^|\s)id_rsa(\s|$)/m);
      expect(report).not.toMatch(/(^|\s)private\.key(\s|$)/m);
      expect(report).not.toMatch(/(^|\s)auth\.json(\s|$)/m);
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

  test("escapes filesystem names before inserting them into the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-name-escape-"));
    try {
      const local = join(root, "client");
      await mkdir(local, { recursive: true });
      await writeFile(join(local, "log<svg>\n- forged [link](url).txt"), "");
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("&lt;svg&gt;");
      expect(report).not.toContain("<svg>");
      expect(report).not.toContain("\n- forged [link]");
      expect(report).not.toContain("[link](url)");
      expect(report).toContain("&#91;link&#93;&#40;url&#41;");
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

  test("keeps the known log listing at the historical 200-line bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-log-list-limit-"));
    try {
      const local = join(root, "client");
      await mkdir(local, { recursive: true });
      await Promise.all(Array.from({ length: MAX_LOCAL_LOG_LISTING_ENTRIES + 5 }, (_, index) => writeFile(join(local, `server-log-${String(index).padStart(3, "0")}.txt`), "")));
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--local-dir", local, "--no-remote", "--out", output])).toBe(0);
      const report = await readFile(output, "utf8");
      const listing = report.split("### Known log files (first 200 lines of listing)\n\n")[1]?.split("### client_log.txt")[0] ?? "";
      expect(listing).toContain("server-log-000.txt");
      expect(listing).toContain(`server-log-${String(MAX_LOCAL_LOG_LISTING_ENTRIES - 1).padStart(3, "0")}.txt`);
      expect(listing).not.toContain(`server-log-${String(MAX_LOCAL_LOG_LISTING_ENTRIES).padStart(3, "0")}.txt`);
      expect(listing.match(/server-log-\d{3}\.txt/g)?.length).toBe(MAX_LOCAL_LOG_LISTING_ENTRIES);
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
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("symlink");
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
      const realPerl = Bun.which("perl");
      if (realPerl === null) throw new Error("perl is required for this regression test");
      const wrapper = join(bin, "perl");
      await writeFile(wrapper, `#!/bin/sh\n"$REAL_PERL" "$@"\nstatus=$?\nif [ "$status" -eq 0 ]; then printf '%s' "$MUTATION" > "$TARGET"; fi\nexit "$status"\n`);
      await chmod(wrapper, 0o755);
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_mods_remote_collect.sh"), "fixture", "Master"], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_PERL: realPerl, TARGET: target, MUTATION: mutation },
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

  test("remote snapshot keeps custom os-release metadata out of the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-os-release-"));
    try {
      const home = join(root, "home");
      const osRelease = join(root, "os-release");
      const privateHostname = ["prod-db", "internal"].join(".");
      const secretHost = ["secret", "host"].join("-");
      await mkdir(home, { recursive: true });
      await writeFile(osRelease, `NAME=${privateHostname}\nID=opensuse-${secretHost}\nVERSION_ID=1.2.3.4.5\nBUILD_HOST=${secretHost}\n`);
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_snapshot_remote.sh")], {
        env: { ...process.env, HOME: home, AGENT_TOOLKIT_DST_OS_RELEASE_FILE: osRelease }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(status).toBe(0);
      expect(stdout).toContain("ID: <redacted>");
      expect(stdout).toContain("VERSION_ID: <redacted>");
      expect(stdout).not.toContain(privateHostname);
      expect(stdout).not.toContain(secretHost);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remote snapshot ignores symlinked cluster files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-file-symlink-"));
    try {
      const home = join(root, "home");
      const cluster = join(home, ".klei", "DoNotStarveTogether", "Cluster_fixture", "Master");
      const outside = join(root, "outside-secret.txt");
      await mkdir(cluster, { recursive: true });
      await writeFile(outside, "outside-secret");
      await symlink(outside, join(cluster, "server.ini"));
      await symlink(outside, join(join(home, ".klei", "DoNotStarveTogether", "Cluster_fixture"), "cluster.ini"));
      const child = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "dst_snapshot_remote.sh")], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(status).toBe(0);
      expect(stdout).toContain("#### Cluster: <cluster>");
      expect(stdout).not.toContain("cluster.ini: present");
      expect(stdout).not.toContain("server.ini:");
      expect(stdout).not.toContain("outside-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves remote selection, missing shard resources, and failed SSH diagnostics", { timeout: 90_000 }, async () => {
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
      await writeFile(fakeSsh, `#!/bin/sh\ncase "$*" in\n  *"echo ok"*) exit 0 ;;\n  *) cat >/dev/null; echo 'denied [forged](javascript:alert(1)) ${leakedPath} api_key=fixture-secret' >&2; exit 1 ;;\nesac\n`);
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
      expect(snapshot).not.toContain("[forged](javascript:alert(1))");
      expect(snapshot).toContain("api_key=&#91;REDACTED&#93;");
      expect(snapshot).not.toContain("fixture-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a completed shard summary when the next shard fails", { timeout: 90_000 }, async () => {
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

  test("reports a failed snapshot SSH check without attempting a remote operation", { timeout: 30_000 }, async () => {
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

  test("fails a snapshot when the supervisor exits before recording SSH status", { timeout: 30_000 }, async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-status-missing-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*)
    supervisor_pid="$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d '[:space:]')"
    case "$supervisor_pid" in
      ''|*[!0-9]*)
        ancestor="$PPID"
        attempts=0
        while [ "$attempts" -lt 16 ]; do
          case "$ancestor" in ''|*[!0-9]*) break ;; esac
          command_line="$(ps -o command= -p "$ancestor" 2>/dev/null || true)"
          case "$command_line" in *agent-toolkit-supervisor*) supervisor_pid="$ancestor"; break ;; esac
          next_ancestor="$(ps -o ppid= -p "$ancestor" 2>/dev/null | tr -d '[:space:]')"
          [ "$next_ancestor" = "$ancestor" ] && break
          ancestor="$next_ancestor"
          attempts=$((attempts + 1))
        done
        ;;
    esac
    case "$supervisor_pid" in ''|*[!0-9]*) exit 97 ;; esac
    sleep 0.5
    kill -KILL "$supervisor_pid" 2>/dev/null || true
    while :; do sleep 1; done
    ;;
  *) cat >/dev/null; exit 0 ;;
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
      const report = await readFile(output, "utf8");
      expect(report).toContain("supervisor exited before recording the SSH result");
      expect(report).not.toContain("Remote SSH failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts local setup paths from modoverrides failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-mods-path-redaction-"));
    const privateTmp = join(root, "private-tmp");
    try {
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster", "--shard", "Master"],
        { ...process.env, TMPDIR: privateTmp } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(privateTmp);
      expect(result.stderr).toContain("<redacted-path>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips remote collection only when SSH is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-no-ssh-"));
    try {
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--no-local", "--host", "fixture-host", "--user", "fixture-user", "--out", output],
        { ...process.env, PATH: root } as Record<string, string>,
      );
      expect(result.status).toBe(0);
      const report = await readFile(output, "utf8");
      expect(report).toContain("ssh not found on this machine");
      expect(report).not.toContain("Remote SSH connectivity check could not be started");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts sensitive values from successful remote snapshot output", { timeout: 30_000 }, async () => {
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

  test("renders untrusted remote report text without Markdown or HTML injection", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-markdown-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) exit 0 ;;
  *) printf '# forged heading\\n<img src=x onerror=alert(1)>\\n[forged](https://example.test)\\napi_key=fixture-secret\\n' ;;
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
      expect(report).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(report).not.toContain("<img src=x onerror=alert(1)>");
      expect(report).not.toContain("[forged](https://example.test)");
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
    const privateHostname = ["secret", "internal", "example"].join(".");
    expect(redactOperationalText(`Could not resolve hostname ${privateHostname}`)).not.toContain(privateHostname);
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

  test("rejects an oversized remote snapshot before writing unbounded output", { timeout: 90_000 }, async () => {
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

  test("preserves the output-limit diagnostic when cleanup acknowledgement fails", { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-limit-cleanup-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      const fakePs = join(root, "ps");
      const trigger = join(root, "fail-process-scan");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *echo*ok*) exit 0 ;;
  *) sleep 0.5; touch "$AGENT_TOOLKIT_TEST_PS_FAIL"; head -c $(( ${MAX_REMOTE_OUTPUT_BYTES} + 1 )) /dev/zero ;;
esac
`);
      await writeFile(fakePs, `#!/bin/sh
if [ -e "$AGENT_TOOLKIT_TEST_PS_FAIL" ]; then printf 'malformed process row\\n'; exit 0; fi
exec /bin/ps "$@"
`);
      await chmod(fakeSsh, 0o755);
      await chmod(fakePs, 0o755);
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}`, AGENT_TOOLKIT_TEST_PS_FAIL: trigger } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      const report = await readFile(output, "utf8");
      expect(report).toContain("output limit");
      expect(report).toContain("cleanup could not be verified");
      expect(report).not.toContain("command could not be started");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when an SSH result cannot be recorded", { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-connectivity-cleanup-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      const fakePs = join(root, "ps");
      const trigger = join(root, "fail-process-scan");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) sleep 0.5; touch "$AGENT_TOOLKIT_TEST_PS_FAIL"; echo "fixture SSH connectivity denied" >&2; exit 1 ;;
  *) cat >/dev/null; exit 0 ;;
esac
`);
      await writeFile(fakePs, `#!/bin/sh
if [ -e "$AGENT_TOOLKIT_TEST_PS_FAIL" ]; then printf 'malformed process row\\n'; exit 0; fi
exec /bin/ps "$@"
`);
      await chmod(fakeSsh, 0o755);
      await chmod(fakePs, 0o755);
      const output = join(root, "snapshot.md");
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_snapshot.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--no-local", "--out", output],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}`, AGENT_TOOLKIT_TEST_PS_FAIL: trigger } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      const report = await readFile(output, "utf8");
      expect(report).toContain("supervisor exited before recording the SSH result");
      expect(report).not.toContain("Remote SSH failed");
      expect(report).not.toContain("command could not be started");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a remote command result cannot be recorded", { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-remote-command-cleanup-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      await writeFile(fakeSsh, `#!/bin/sh
case "$*" in
  *"echo ok"*) exit 0 ;;
  *)
    cat >/dev/null
    supervisor_pid="$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d '[:space:]')"
    case "$supervisor_pid" in
      ''|*[!0-9]*)
        ancestor="$PPID"
        attempts=0
        while [ "$attempts" -lt 16 ]; do
          case "$ancestor" in ''|*[!0-9]*) break ;; esac
          command_line="$(ps -o command= -p "$ancestor" 2>/dev/null || true)"
          case "$command_line" in *agent-toolkit-supervisor*) supervisor_pid="$ancestor"; break ;; esac
          next_ancestor="$(ps -o ppid= -p "$ancestor" 2>/dev/null | tr -d '[:space:]')"
          [ "$next_ancestor" = "$ancestor" ] && break
          ancestor="$next_ancestor"
          attempts=$((attempts + 1))
        done
        ;;
    esac
    case "$supervisor_pid" in ''|*[!0-9]*) exit 97 ;; esac
    sleep 0.5
    kill -KILL "$supervisor_pid" 2>/dev/null || true
    while :; do sleep 1; done
    ;;
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
      const report = await readFile(output, "utf8");
      expect(report).toContain("supervisor exited before recording the remote collection result");
      expect(report).not.toContain("Remote collection command failed");
      expect(report).not.toContain("command could not be started");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an SSH failure when mods cleanup acknowledgement fails", { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-mods-cleanup-"));
    const previousPath = process.env.PATH;
    try {
      const fakeSsh = join(root, "ssh");
      const fakePs = join(root, "ps");
      const trigger = join(root, "fail-process-scan");
      await writeFile(fakeSsh, `#!/bin/sh
cat >/dev/null
sleep 0.5
touch "$AGENT_TOOLKIT_TEST_PS_FAIL"
echo "fixture SSH denied" >&2
exit 1
`);
      await writeFile(fakePs, `#!/bin/sh
if [ -e "$AGENT_TOOLKIT_TEST_PS_FAIL" ]; then printf 'malformed process row\\n'; exit 0; fi
exec /bin/ps "$@"
`);
      await chmod(fakeSsh, 0o755);
      await chmod(fakePs, 0o755);
      const result = await runTool(
        join(import.meta.dir, "..", "scripts", "dst_mods_from_modoverrides.ts"),
        ["--host", "fixture-host", "--user", "fixture-user", "--cluster", "fixture-cluster", "--shard", "Master"],
        { ...process.env, PATH: `${root}:${previousPath ?? ""}`, AGENT_TOOLKIT_TEST_PS_FAIL: trigger } as Record<string, string>,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture SSH denied");
      expect(result.stderr).toContain("supervisor_cleanup_unverified");
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

  test("cleans stale snapshot temp directories on the next publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-temp-cleanup-"));
    try {
      const tempRoot = join(root, ".agent-toolkit-dst-snapshot-tmp");
      await mkdir(tempRoot, { mode: 0o700 });
      await writeFile(join(tempRoot, ".owner"), "agent-toolkit-dst-snapshot-v1\n");
      const stale = join(tempRoot, ".dst-snapshot-tmp-stale");
      await mkdir(stale);
      await writeFile(join(stale, ".owner"), "agent-toolkit-dst-snapshot-v1\n");
      const old = new Date(Date.now() - 20 * 60 * 1000);
      await utimes(stale, old, old);
      const ownerless = join(tempRoot, ".dst-snapshot-tmp-ownerless");
      await mkdir(ownerless);
      await writeFile(join(ownerless, "partial.md"), "interrupted");
      await utimes(ownerless, old, old);
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--no-local", "--no-remote", "--out", output])).toBe(0);
      expect(await readdir(tempRoot)).not.toContain(".dst-snapshot-tmp-stale");
      expect(await readdir(tempRoot)).not.toContain(".dst-snapshot-tmp-ownerless");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an ownerless empty snapshot temp root after interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-temp-root-recovery-"));
    try {
      const tempRoot = join(root, ".agent-toolkit-dst-snapshot-tmp");
      await mkdir(tempRoot, { mode: 0o700 });
      const output = join(root, "snapshot.md");
      expect(await snapshotMain(["--no-local", "--no-remote", "--out", output])).toBe(0);
      expect(await readFile(join(tempRoot, ".owner"), "utf8")).toBe("agent-toolkit-dst-snapshot-v1\n");
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

    const privateCluster = "password=fixture-secret";
    try {
      await parseRemoteResponseStream(privateCluster, "Master", "fixture/Master/modoverrides.lua", byteStream([new TextEncoder().encode("CLUSTER_MISSING\n")]));
      throw new Error("expected CLUSTER_MISSING to fail");
    } catch (error) {
      expect(String(error)).toContain("remote cluster not found");
      expect(String(error)).not.toContain(privateCluster);
      expect(String(error)).not.toContain("fixture-secret");
    }
  });

  test("times out a remote response stream that never produces bytes", async () => {
    const hanging = new ReadableStream<Uint8Array>({ start() {} });
    await expect(parseRemoteResponseStream("fixture-cluster", "Master", "fixture", hanging, 10)).rejects.toThrow(/timed out/);
  });

  test("publishes reports across processes while claiming the snapshot owner marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-process-concurrent-"));
    try {
      const output = join(root, "snapshot.md");
      const script = join(import.meta.dir, "..", "scripts", "dst_snapshot.ts");
      const env = { ...process.env } as Record<string, string>;
      const results = await Promise.all([
        runTool(script, ["--no-local", "--no-remote", "--out", output], env),
        runTool(script, ["--no-local", "--no-remote", "--out", output], env),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([0, 0]);
      expect(await readFile(output, "utf8")).toContain("# DST snapshot");
      expect((await readdir(root)).filter((entry) => entry.startsWith(".dst-snapshot-tmp-")).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans a detached supervisor directory after its parent exits", { timeout: 30_000 }, async () => {
    if (process.platform === "win32") return;
    const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith(".agent-toolkit-dst-supervisor-")));
    const markerRoot = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-parent-"));
    const marker = join(markerRoot, "descendant.pid");
    const finished = join(markerRoot, "finished");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "scripts", "process_supervisor.ts")).href;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `import { readFile } from "node:fs/promises"; import { spawnSupervised } from ${JSON.stringify(moduleUrl)}; await spawnSupervised(["sh", "-c", "sleep 30 & printf '%s\\n' \\\"$!\\\" > \\\"${marker}\\\"; printf done > \\\"${finished}\\\"; exit 0"]); for (let attempt = 0; attempt < 40; attempt += 1) { try { if ((await readFile(${JSON.stringify(finished)}, "utf8")).trim() === "done") break; } catch {} await Bun.sleep(5); } process.exit(0);`,
    ], { stdout: "pipe", stderr: "pipe" });
    try {
      expect(await child.exited).toBe(0);
      let leftovers: string[] = [];
      let descendantPid: number | undefined;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await Bun.sleep(250);
        leftovers = (await readdir(tmpdir())).filter((entry) => entry.startsWith(".agent-toolkit-dst-supervisor-") && !before.has(entry));
        try {
          descendantPid = Number((await readFile(marker, "utf8")).trim());
        } catch {
          // The child may exit before the target writes its marker.
        }
        if (leftovers.length === 0 && descendantPid !== undefined) break;
      }
      expect(leftovers).toEqual([]);
      expect(Number.isInteger(descendantPid)).toBe(true);
      for (let attempt = 0; attempt < 30 && descendantPid !== undefined && isAlive(descendantPid); attempt += 1) {
        await Bun.sleep(100);
      }
      expect(descendantPid === undefined ? false : isAlive(descendantPid)).toBe(false);
    } finally {
      await rm(markerRoot, { recursive: true, force: true });
    }
  });

  test("kills a target process group after its leader exits", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-group-"));
    const marker = join(root, "descendant.pid");
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    let descendantPid: number | undefined;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      supervised = await spawnSupervised([
        "sh",
        "-c",
        "sleep 30 & printf '%s\\n' \"$!\" > \"$1\"; exit 0",
        "agent-toolkit-supervised-target",
        marker,
      ]);
      expect(await supervised.exited).toBe(0);
      descendantPid = Number((await readFile(marker, "utf8")).trim());
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(isAlive(descendantPid)).toBe(true);
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(true);
      await supervised.wrapperExited;
      for (let attempt = 0; attempt < 30 && isAlive(descendantPid); attempt += 1) await Bun.sleep(100);
      expect(isAlive(descendantPid)).toBe(false);
    } finally {
      if (supervised !== undefined) {
        supervised.child.kill("SIGKILL");
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      if (descendantPid !== undefined && isAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* The descendant may have exited. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("starts the cleanup acknowledgement deadline when stopping", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    try {
      supervised = await spawnSupervised(["sh", "-c", "sleep 30"]);
      await Bun.sleep(5_500);
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(true);
      await supervised.wrapperExited;
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
    }
  });

  test("fails closed when the supervisor exits before recording target status", { timeout: 30_000 }, async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-unknown-status-"));
    const marker = join(root, "target-child.pid");
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    let targetChildPid: number | undefined;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      supervised = await spawnSupervised(["sh", "-c", "sleep 30 & printf '%s\\n' \"$!\" > \"$1\"; wait", "agent-toolkit-supervised-target", marker]);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const value = Number((await readFile(marker, "utf8")).trim());
          if (Number.isInteger(value) && value > 0) {
            targetChildPid = value;
            break;
          }
        } catch {
          // The target may still be writing its child marker.
        }
        await Bun.sleep(25);
      }
      expect(targetChildPid).toBeDefined();
      expect(isAlive(targetChildPid!)).toBe(true);
      supervised.child.kill("SIGKILL");
      expect(await supervised.exited).toBe(SUPERVISOR_UNKNOWN_TARGET_STATUS);
      expect(await supervised.waitForCleanupAcknowledged()).toBe(false);
      await supervised.wrapperExited.catch(() => undefined);
      for (let attempt = 0; attempt < 40 && isAlive(targetChildPid!); attempt += 1) await Bun.sleep(25);
      expect(isAlive(targetChildPid!)).toBe(false);
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      if (targetChildPid !== undefined && isAlive(targetChildPid)) {
        try { process.kill(targetChildPid, "SIGKILL"); } catch { /* The target may already be gone. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow a cleanup acknowledgement symlink", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const prefix = ".agent-toolkit-dst-supervisor-ack-";
    const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)));
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-ack-canary-"));
    const canary = join(root, "canary");
    await writeFile(canary, "sentinel\n", "utf8");
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    try {
      supervised = await spawnSupervised(["sh", "-c", "sleep 30"]);
      const ackRoot = (await readdir(tmpdir())).find((entry) => entry.startsWith(prefix) && !before.has(entry));
      expect(ackRoot).toBeString();
      await symlink(canary, join(tmpdir(), ackRoot!, "done"));
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(false);
      await supervised.wrapperExited;
      expect(await readFile(canary, "utf8")).toBe("sentinel\n");
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose the cleanup acknowledgement path to the target", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-ack-env-"));
    const marker = join(root, "target-saw-ack-path");
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    try {
      supervised = await spawnSupervised([
        "sh",
        "-c",
        "if [ -n \"$AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH\" ]; then printf forged > \"$1\"; fi; sleep 30",
        "agent-toolkit-supervised-target",
        marker,
      ]);
      expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(true);
      await supervised.wrapperExited;
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans a descendant that leaves the target process group", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const setsidCheck = Bun.spawnSync(["sh", "-c", "command -v setsid"], { stdout: "ignore", stderr: "ignore" });
    if (setsidCheck.exitCode !== 0) return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-independent-group-"));
    const marker = join(root, "detached.pid");
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    let detachedPid: number | undefined;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      supervised = await spawnSupervised([
        "sh",
        "-c",
        "setsid sh -c 'trap \"\" TERM; sleep 30' & detached=$!; printf '%s\\n' \"$detached\" > \"$1\"; while :; do sleep 1; done",
        "agent-toolkit-supervised-target",
        marker,
      ]);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          detachedPid = Number((await readFile(marker, "utf8")).trim());
          break;
        } catch {
          await Bun.sleep(25);
        }
      }
      expect(Number.isInteger(detachedPid)).toBe(true);
      expect(detachedPid === undefined ? false : isAlive(detachedPid)).toBe(true);
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(true);
      await supervised.wrapperExited;
      for (let attempt = 0; attempt < 30 && detachedPid !== undefined && isAlive(detachedPid); attempt += 1) await Bun.sleep(100);
      expect(detachedPid === undefined ? false : isAlive(detachedPid)).toBe(false);
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      if (detachedPid !== undefined && isAlive(detachedPid)) {
        try { process.kill(detachedPid, "SIGKILL"); } catch { /* The detached process may have exited. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans an orphaned group after its captured leader exits during termination", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const setsidCheck = Bun.spawnSync(["sh", "-c", "command -v setsid"], { stdout: "ignore", stderr: "ignore" });
    if (setsidCheck.exitCode !== 0) return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-orphaned-group-"));
    const controllerScript = join(root, "controller.sh");
    const leaderScript = join(root, "leader.sh");
    const childScript = join(root, "child.sh");
    const leaderMarker = join(root, "leader.pid");
    const childMarker = join(root, "child.pid");
    await writeFile(childScript, "#!/bin/sh\ntrap ':' TERM\nsleep 30\n", "utf8");
    await chmod(childScript, 0o755);
    await writeFile(leaderScript, "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$1\"\ntrap 'sh \"$3\" & printf \"%s\\n\" \"$!\" > \"$2\"; exit 0' TERM\nwhile :; do :; done\n", "utf8");
    await chmod(leaderScript, 0o755);
    await writeFile(controllerScript, "#!/bin/sh\nsetsid \"$1\" \"$2\" \"$3\" \"$4\" & leader=\"$!\"\ntrap 'kill -TERM \"$leader\" 2>/dev/null || true; exit 0' TERM\nwhile kill -0 \"$leader\" 2>/dev/null; do :; done\n", "utf8");
    await chmod(controllerScript, 0o755);
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    let descendantPid: number | undefined;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      supervised = await spawnSupervised(["sh", controllerScript, leaderScript, leaderMarker, childMarker, childScript]);
      let leaderPid: number | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          leaderPid = Number((await readFile(leaderMarker, "utf8")).trim());
          break;
        } catch {
          await Bun.sleep(25);
        }
      }
      expect(Number.isInteger(leaderPid)).toBe(true);
      expect(leaderPid === undefined ? false : isAlive(leaderPid)).toBe(true);
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(true);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          descendantPid = Number((await readFile(childMarker, "utf8")).trim());
          break;
        } catch {
          await Bun.sleep(25);
        }
      }
      expect(Number.isInteger(descendantPid)).toBe(true);
      await supervised.wrapperExited;
      for (let attempt = 0; attempt < 30 && descendantPid !== undefined && isAlive(descendantPid); attempt += 1) await Bun.sleep(100);
      expect(descendantPid === undefined ? false : isAlive(descendantPid)).toBe(false);
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      if (descendantPid !== undefined && isAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* The descendant may have exited. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when detached descendant enumeration is truncated", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const setsidCheck = Bun.spawnSync(["sh", "-c", "command -v setsid"], { stdout: "ignore", stderr: "ignore" });
    if (setsidCheck.exitCode !== 0) return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-descendant-cap-"));
    const pidFile = join(root, "descendants.pid");
    const readyFile = join(root, "ready");
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    let descendantPids: number[] = [];
    try {
      supervised = await spawnSupervised([
        "sh",
        "-c",
        "i=0; while [ \"$i\" -lt 1025 ]; do setsid sleep 30 & printf '%s\\n' \"$!\" >> \"$1\"; i=$((i + 1)); done; printf ready > \"$2\"; while :; do sleep 1; done",
        "agent-toolkit-supervised-target",
        pidFile,
        readyFile,
      ]);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        try {
          descendantPids = (await readFile(pidFile, "utf8")).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
          if (descendantPids.length >= 1025 && (await readFile(readyFile, "utf8")).trim() === "ready") break;
        } catch {
          // The target may still be spawning its detached children.
        }
        await Bun.sleep(25);
      }
      expect(descendantPids.length).toBeGreaterThanOrEqual(1025);
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(false);
      await supervised.wrapperExited;
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      try {
        descendantPids = (await readFile(pidFile, "utf8")).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
      } catch {
        // The target may have exited before writing its full PID list.
      }
      for (const pid of descendantPids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* The detached process may have exited. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when detached descendant enumeration cannot scan processes", { timeout: 90_000 }, async () => {
    if (process.platform === "win32") return;
    const procRoot = await lstat("/proc").catch(() => undefined);
    if (!procRoot?.isDirectory()) return;
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-dst-supervisor-descendant-scan-failure-"));
    const ps = join(root, "ps");
    const trigger = join(root, "trigger");
    const previousPath = process.env.PATH;
    const previousFailurePath = process.env.AGENT_TOOLKIT_TEST_PS_FAIL;
    let supervised: Awaited<ReturnType<typeof spawnSupervised>> | undefined;
    try {
      await writeFile(ps, `#!/bin/sh
if [ -e "$AGENT_TOOLKIT_TEST_PS_FAIL" ]; then exit 1; fi
exec /bin/ps "$@"
`);
      await chmod(ps, 0o755);
      process.env.PATH = `${root}:${previousPath ?? ""}`;
      process.env.AGENT_TOOLKIT_TEST_PS_FAIL = trigger;
      supervised = await spawnSupervised(["sh", "-c", "while [ ! -e \"$1\" ]; do sleep 0.01; done; sleep 30", "agent-toolkit-supervised-target", trigger]);
      await writeFile(trigger, "fail scan\n");
      supervised.child.kill("SIGTERM");
      expect(await supervised.waitForCleanupAcknowledged()).toBe(false);
      await supervised.wrapperExited;
    } finally {
      if (supervised !== undefined) {
        try { supervised.child.kill("SIGKILL"); } catch { /* The supervisor may already be gone. */ }
        await supervised.wrapperExited.catch(() => undefined);
        await supervised.cleanup();
      }
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousFailurePath === undefined) delete process.env.AGENT_TOOLKIT_TEST_PS_FAIL;
      else process.env.AGENT_TOOLKIT_TEST_PS_FAIL = previousFailurePath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
