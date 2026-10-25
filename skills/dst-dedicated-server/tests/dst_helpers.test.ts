import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMods } from "../scripts/mod_parser.ts";
import { decodeFiles, reportMods } from "../scripts/dst_mods_from_modoverrides.ts";

let root: string;
const scripts = new URL("../scripts/", import.meta.url).pathname;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dst-helpers-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function run(script: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, join(scripts, script), ...args], { cwd: root, env: { ...process.env, DST_HOST: "", DST_USER: "", DST_CLUSTER: "", DST_LOCAL_DIR: "", ...env } });
}
function cluster(path: string) {
  mkdirSync(join(path, "Master"), { recursive: true }); mkdirSync(join(path, "Caves"), { recursive: true });
  writeFileSync(join(path, "cluster.ini"), "cluster_password=SECRET_CLUSTER\n"); writeFileSync(join(path, "cluster_token.txt"), "SECRET_TOKEN");
  writeFileSync(join(path, "Master/modoverrides.lua"), 'return {["workshop-2"]={enabled=true,configuration_options={password="SECRET_OPTIONS"}},["workshop-10"]={enabled=false},["workshop-7"]={enabled=DEFAULT}}');
  writeFileSync(join(path, "Caves/modoverrides.lua"), 'return {["workshop-2"]={enabled=false},["workshop-11"]={enabled=true}}');
}
function fakeSsh(mode = "native") {
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  const path = join(bin, "ssh");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "$SSH_ARGS_FILE"\ncase "$SSH_TEST_MODE" in\nfail) echo SECRET_STDERR >&2; exit 255;;\nlarge) dd if=/dev/zero bs=1024 count=3125 2>/dev/null; exit 0;;\noversized-file) mkdir -p "$HOME/.klei/DoNotStarveTogether/Cluster_1/Master" "$HOME/.klei/DoNotStarveTogether/Cluster_1/Caves"; dd if=/dev/zero bs=1024 count=1025 of="$HOME/.klei/DoNotStarveTogether/Cluster_1/Master/modoverrides.lua" 2>/dev/null;;\nstall) exec sleep 30;;\nesac\nfor arg do command=$arg; done\nexec sh -c "$command"\n`);
  chmodSync(path, 0o755);
  if (mode === "no-head") {
    const head = join(bin, "head");
    writeFileSync(head, "#!/bin/sh\nprintf 'head must not be called\\n' >&2\nexit 127\n");
    chmodSync(head, 0o755);
  }
  return { PATH: `${bin}:${process.env.PATH}`, HOME: join(root, "remote"), SSH_ARGS_FILE: join(root, "ssh-args"), SSH_TEST_MODE: mode };
}
describe("VER-FOUNDATION-HELPERS-03: DST snapshots and local/remote reports", () => {
  test("local snapshot omits all log/config secrets and bounds directory output", () => {
    const local = join(root, "client"); cluster(join(local, "account/Cluster_1"));
    writeFileSync(join(local, "client_log.txt"), "SECRET_LOG cluster_token=SECRET\n");
    for (let i = 0; i < 220; i++) writeFileSync(join(local, `z-${i.toString().padStart(3, "0")}`), "");
    const out = join(root, "snapshot.md");
    const result = run("dst_snapshot.ts", ["--no-remote", "--local-dir", local, "--out", out]);
    expect(result.exitCode).toBe(0);
    const report = readFileSync(out, "utf8");
    expect(report).toContain("cluster.ini: present (redacted)"); expect(report).toContain("cluster_token.txt: present (redacted)");
    expect(report).toContain("Master/: present"); expect(report).toContain("client_log.txt: present (contents omitted)");
    expect(report).toContain("Skipped (--no-remote)"); expect(report).not.toContain("z-219"); expect(report).not.toContain("SECRET");
  });
  test("missing local resource, explicit skips, and missing host have defined outcomes", () => {
    const out = join(root, "missing.md");
    expect(run("dst_snapshot.ts", ["--no-remote", "--local-dir", join(root, "absent"), "--out", out]).exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("Local dir not found");
    expect(run("dst_snapshot.ts", ["--no-local", "--no-remote", "--out", out]).exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("Skipped (--no-local)");
    expect(run("dst_snapshot.ts", ["--no-local", "--out", out]).exitCode).toBe(2);
  });
  test("fake SSH failure produces a partial snapshot and a failed mod command without stderr leakage", () => {
    const env = fakeSsh("fail"), out = join(root, "partial.md");
    const result = run("dst_snapshot.ts", ["--host", "dst.example", "--no-local", "--out", out], env);
    expect(result.exitCode).toBe(0); expect(readFileSync(out, "utf8")).toContain("Remote SSH failed (exit 255)");
    const mods = run("dst_mods_from_modoverrides.ts", ["--host", "dst.example", "--user", "operator", "--cluster", "Cluster_1"], env);
    expect(mods.exitCode).toBe(2); expect(mods.stderr.toString()).toContain("Remote SSH failed");
    expect(readFileSync(out, "utf8") + mods.stderr.toString()).not.toContain("SECRET_STDERR");
    const args = readFileSync(join(root, "ssh-args"), "utf8");
    expect(args).toContain("BatchMode=yes"); expect(args).toContain("StrictHostKeyChecking=yes"); expect(args).toContain("operator@dst.example");
  });
  test("local mod summaries and numeric shard differences use only IDs and states", () => {
    const path = join(root, "Cluster_1"); cluster(path);
    const result = run("dst_mods_from_modoverrides.ts", ["--cluster-dir", path]);
    expect(result.exitCode).toBe(0);
    const text = result.stdout.toString();
    expect(text).toContain("- mods: 3"); expect(text).toContain("unknown_ids: 7");
    expect(text).toContain("enabled_only_in_master: 2"); expect(text).toContain("enabled_only_in_caves: 11");
    expect(text).toContain("disabled_only_in_master: 10"); expect(text).toContain("disabled_only_in_caves: 2"); expect(text).not.toContain("SECRET");
    const master = run("dst_mods_from_modoverrides.ts", ["--cluster-dir", path, "--shard", "master"]);
    expect(master.exitCode).toBe(0); expect(master.stdout.toString()).not.toContain("/ Caves");
  });
  test("native remote Shell via fake SSH agrees with local results and handles absent shards", () => {
    const env = fakeSsh(), path = join(env.HOME, ".klei/DoNotStarveTogether/Cluster_1"); cluster(path);
    const local = run("dst_mods_from_modoverrides.ts", ["--cluster-dir", path, "--cluster", "Cluster_1"]);
    const remote = run("dst_mods_from_modoverrides.ts", ["--host", "dst.example", "--user", "operator", "--cluster", "Cluster_1"], env);
    expect(remote.exitCode).toBe(0); expect(remote.stdout.toString()).toBe(local.stdout.toString());
    rmSync(join(path, "Caves/modoverrides.lua"));
    const missing = run("dst_mods_from_modoverrides.ts", [], { ...env, DST_HOST: "dst.example", DST_USER: "operator", DST_CLUSTER: "Cluster_1" });
    expect(missing.exitCode).toBe(0); expect(missing.stdout.toString()).toContain("modoverrides.lua: missing"); expect(missing.stdout.toString()).not.toContain("## Diff");
    const nonexistent = run("dst_mods_from_modoverrides.ts", ["--host", "dst.example", "--user", "operator", "--cluster", "Absent"], env);
    expect(nonexistent.exitCode).toBe(2);
  });
  test("native mod framing uses POSIX byte capping without head", () => {
    const env = fakeSsh("no-head"); cluster(join(env.HOME, ".klei/DoNotStarveTogether/Cluster_1"));
    const remote = run("dst_mods_from_modoverrides.ts", ["--host", "dst.example", "--user", "operator", "--cluster", "Cluster_1"], env);
    expect(remote.exitCode).toBe(0); expect(remote.stderr.toString()).toBe(""); expect(remote.stdout.toString()).toContain("- mods: 3");
  });
  test("native remote bounded size probe rejects oversized mod files", () => {
    const result = run("dst_mods_from_modoverrides.ts", ["--host", "dst.example", "--user", "operator", "--cluster", "Cluster_1"], fakeSsh("oversized-file"));
    expect(result.exitCode).toBe(2); expect(result.stderr.toString()).toContain("Remote SSH failed (exit 4)");
  });
  test("oversized SSH and files are bounded and malformed frames fail closed", () => {
    const oversized = run("dst_mods_from_modoverrides.ts", ["--host", "dst.example", "--user", "operator", "--cluster", "Cluster_1"], fakeSsh("large"));
    expect(oversized.exitCode).toBe(2); expect(oversized.stderr.toString()).toContain("exceeds 3145728 bytes");
    const path = join(root, "Cluster_1"); cluster(path); writeFileSync(join(path, "Master/modoverrides.lua"), " ".repeat(1_048_577));
    const local = run("dst_mods_from_modoverrides.ts", ["--cluster-dir", path]); expect(local.exitCode).toBe(2); expect(local.stdout.length).toBe(0);
    for (const frame of ["oops", "DSTMODS1\nMaster\t-1\n", "DSTMODS1\nCaves\tmissing\n", "DSTMODS1\nMaster\t9\nshort", "DSTMODS1\nMaster\tmissing\ntrailing"]) expect(() => decodeFiles(Buffer.from(frame), ["Master"])).toThrow();
  });
  test("unsupported shard/target/cluster options fail before SSH", () => {
    for (const args of [["--shard", "oops"], ["--host", "-option", "--user", "operator", "--cluster", "Cluster_1"], ["--host", "dst.example", "--user", "operator", "--cluster", "../other"], ["--host", "dst.example", "--user", "operator", "--cluster", "Cluster_1", "--out", "bad"]]) {
      const result = run("dst_mods_from_modoverrides.ts", args, fakeSsh()); expect(result.exitCode).toBe(2); expect(existsSync(join(root, "ssh-args"))).toBe(false);
    }
  });
  test("whole-command SSH timeout ends collection with a partial snapshot", () => {
    const out = join(root, "timed-out.md"), start = Date.now();
    const result = run("dst_snapshot.ts", ["--host", "dst.example", "--no-local", "--out", out], fakeSsh("stall"));
    expect(result.exitCode).toBe(0); expect(readFileSync(out, "utf8")).toContain("SSH collection timed out");
    expect(Date.now() - start).toBeLessThan(20_000);
  }, 22_000);
});
describe("VER-FOUNDATION-HELPERS-04: non-executable Lua subset", () => {
  test("nested tables, braces in strings/comments, long strings and unknown values", () => {
    const source = `-- ["workshop-999"]={enabled=true}\nreturn {
      ["workshop-20"] = {configuration_options={enabled=false, inner={text="} enabled=false", value=[=[{ }]=]}}, enabled=true},
      ['workshop-3'] = {enabled=false; configuration_options={enabled=true}},
      ["workshop-10"] = {enabled=DEFAULT},
      ["workshop-11"] = {},
      --[=[ { } ["workshop-999"]={enabled=true} ]=]
      ["workshop-9007199254740993"]={enabled=nil},
    };`;
    expect(parseMods(source)).toEqual([{ id: "3", enabled: "false" }, { id: "10", enabled: "unknown" }, { id: "11", enabled: "unknown" }, { id: "20", enabled: "true" }, { id: "9007199254740993", enabled: "unknown" }]);
    expect(parseMods('return {["workshop-1"]={configuration_options={enabled=true}}}')).toEqual([{ id: "1", enabled: "unknown" }]);
  });
  test("malformed/unsupported Lua is rejected without executing code or echoing config", () => {
    for (const source of ["", "return {", "return {} SECRET_OPTIONS", "local x = {}; return x", 'return {["workshop-1"]={enabled=true,enabled=false}}', 'return {["workshop-1"]=true}', "return {x=[=[unterminated}", "return {x='bad\\q'}", "return {x=1+2}", "return {x=function() end}", `return {x=os.execute("touch ${join(root, "executed")}")}`]) {
      expect(() => parseMods(source)).toThrow();
      try { parseMods(source); } catch (error) { expect(String(error)).not.toContain("SECRET_OPTIONS"); }
    }
    expect(existsSync(join(root, "executed"))).toBe(false);
    expect(() => parseMods(`return {x=${"{".repeat(65)}${"}".repeat(65)}}`)).toThrow("nesting");
  });
  test("empty table and missing shards have explicit output", () => {
    expect(reportMods(new Map([["Master", "return {}"], ["Caves", null]]), "Cluster_1")).toContain("enabled_ids: (none)");
  });
});
