import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../scripts/preflight.ts";

// GNU dd fullblock, /proc token handling and native shells are verified on Linux.
// Fake command adapters replace service/Docker inventory, never the shell checks.
const native = process.platform === "linux" ? describe : describe.skip;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "xp-native-")); dirs.push(dir);
  mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "proc/99"), { recursive: true });
  writeFileSync(join(dir, "proc/99/cmdline"), "xray\0run\0"); symlinkSync("/usr/bin/xray", join(dir, "proc/99/exe"));
  writeFileSync(join(dir, "proc/99/stat"), `99 (xray) ${["S", ...Array(18).fill("0"), "12345", "0"].join(" ")}\n`);
  const tool = (name: string, source: string) => { const path = join(dir, "bin", name); writeFileSync(path, "#!/bin/sh\nset -eu\n" + source); chmodSync(path, 0o755); };
  tool("curl", `printf '%s\\n' curl >> "$XP_FIXTURE/calls"; printf 204`);
  tool("sudo", `printf '%s\\n' "sudo $*" >> "$XP_FIXTURE/calls"
[ "$XP_MODE" != deny-sudo ] || exit 1
[ "$XP_MODE" != direct ] || exit 1
[ "$XP_MODE" != container-drift ] || exit 1
[ "$XP_MODE" != token-drift ] || exit 1
shift
case "$1" in
  test) exit 0 ;;
  sh)
    case "$3" in
      *pidof*)
        n=0; [ ! -f "$XP_FIXTURE/pid-count" ] || n=$(cat "$XP_FIXTURE/pid-count")
        n=$((n + 1)); printf %s "$n" > "$XP_FIXTURE/pid-count"
        if [ "$XP_MODE" = pid-drift ] && [ "$n" -gt 1 ]; then printf 124; else printf 123; fi ;;
      *stat_file*)
        n=0; [ ! -f "$XP_FIXTURE/start-count" ] || n=$(cat "$XP_FIXTURE/start-count")
        n=$((n + 1)); printf %s "$n" > "$XP_FIXTURE/start-count"
        if [ "$XP_MODE" = start-drift ] && [ "$n" -gt 1 ]; then printf 457; else printf 456; fi ;;
      *'! -e'*) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  docker) shift; exec "$XP_FIXTURE/bin/docker" "$@" ;;
  *) exit 1 ;;
esac`);
  tool("docker", `printf '%s\\n' "docker $*" >> "$XP_FIXTURE/calls"
[ "$1" != --context ] || shift 2
case "$1" in
  inspect)
    case "$3" in
      *'.Id'*)
        n=0; [ ! -f "$XP_FIXTURE/id-count" ] || n=$(cat "$XP_FIXTURE/id-count")
        n=$((n + 1)); printf %s "$n" > "$XP_FIXTURE/id-count"
        if [ "$XP_MODE" = container-drift ] && [ "$n" -gt 2 ]; then printf '%064d' 1; else printf '%s' "$XP_CONTAINER"; fi ;;
      *Running*) printf true ;;
      *StartedAt*) printf 2026-01-01T00:00:00Z ;;
      *) exit 1 ;;
    esac ;;
  exec)
    shift
    if [ "$1" = -e ]; then
      shift 3
      n=0; [ ! -f "$XP_FIXTURE/token-count" ] || n=$(cat "$XP_FIXTURE/token-count")
      n=$((n + 1)); printf %s "$n" > "$XP_FIXTURE/token-count"
      if [ "$XP_MODE" = token-drift ] && [ "$n" -gt 1 ]; then
        sed 's/12345/12346/' "$XP_FIXTURE/proc/99/stat" > "$XP_FIXTURE/stat-next"
        mv "$XP_FIXTURE/stat-next" "$XP_FIXTURE/proc/99/stat"
      fi
      XP_INFRA_PROCESS_ROOT="$XP_FIXTURE/proc" exec "$@"
    else shift; exec "$@"; fi ;;
  *) exit 1 ;;
esac`);
  return { dir, env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, XP_FIXTURE: dir, XP_MODE: mode, XP_CONTAINER: "a".repeat(64) } };
}
async function run(mode: string, container = false, allow = false) {
  const f = fixture(mode);
  // Relocate only the private config path; execute the retained probe unchanged.
  const source = readFileSync(join(import.meta.dir, "../scripts/xp-infra-audit-vless-remote"), "utf8").replace("env_file=/etc/xp/xp.env", `env_file='${f.dir}/xp.env'`);
  const args = container ? ["container", "a".repeat(64), "2026-01-01T00:00:00Z", "", "", "99:12345"] : ["host", "", "", "123", "456", ""];
  const child = Bun.spawn(["sh", "-s", "--", "fixture-ep.example.test", "4443", String(allow), ...args], { env: f.env, stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const calls = readFileSync(join(f.dir, "calls"), "utf8");
  return { code, out, err, calls };
}
test("remote probe rejects malformed arguments on every supported host", async () => {
  const source = readFileSync(join(import.meta.dir, "../scripts/xp-infra-audit-vless-remote"), "utf8");
  const invalidCases = [
    ["fixture-ep.example.test/invalid", "4443", "false", "host", "", "", "123", "456", ""],
    ["fixture-ep.example.test", "4443/tcp", "false", "host", "", "", "123", "456", ""],
    ["fixture-ep.example.test", "4443", "maybe", "host", "", "", "123", "456", ""],
    ["fixture-ep.example.test", "4443", "false", "unknown", "", "", "123", "456", ""],
  ];
  for (const args of invalidCases) {
    const child = Bun.spawn(["sh", "-s", "--", ...args], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: new Blob([source]), stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, out, err }).toEqual({ code: 2, out: "", err: "" });
  }
});
native("VER-FOUNDATION-XP-03 isolated Linux native probe", () => {
  test("native preflight collects kernel bounds and rejects changing listener snapshots", async () => {
    for (const [drift, container] of [[false, false], [true, false], [false, true], [true, true]]) {
      const f = fixture("bootstrap");
      writeFileSync(join(f.dir, "bin/sudo"), `#!/bin/sh
set -eu
shift
if [ "$1" = sh ] && [ "$2" = -c ]; then
  case "$3" in
    *docker_path=*) if [ "$XP_DOCKER" = true ]; then printf %s "$XP_FIXTURE/bin/docker"; else printf absent; fi; exit 0 ;;
    *'/run/docker.sock'*) printf absent; exit 0 ;;
  esac
fi
exec "$@"
`); chmodSync(join(f.dir, "bin/sudo"), 0o755);
      writeFileSync(join(f.dir, "bin/ss"), `#!/bin/sh
set -eu
n=0; [ ! -f "$XP_FIXTURE/ss-count" ] || n=$(cat "$XP_FIXTURE/ss-count")
n=$((n + 1)); printf %s "$n" > "$XP_FIXTURE/ss-count"
port=22
if [ "$XP_DRIFT" = true ] && [ "$n" -gt 1 ]; then port=23; fi
printf 'LISTEN 0 128 0.0.0.0:%s 0.0.0.0:* users:(("sshd",pid=7,fd=3))\\n' "$port"
`); chmodSync(join(f.dir, "bin/ss"), 0o755);
      writeFileSync(join(f.dir, "bin/docker"), `#!/bin/sh
set -eu
[ -z "\${DOCKER_HOST:-}\${DOCKER_CONTEXT:-}\${DOCKER_CONFIG:-}" ] || exit 1
[ "$1" = --context ] && [ "$2" = default ] || exit 1
shift 2
case "$1" in
  ps) if [ "$2" = --format ]; then printf '%s\\n' 'fixture-container ghcr.io/example/xp:fixture'; else printf fixture-container; fi ;;
  port) : ;;
  inspect)
    case "$3" in
      *'.Id}} {{.State.StartedAt}}'*) printf '%s %s true' "$XP_CONTAINER" 2026-01-01T00:00:00Z ;;
      *Config.User*) printf 1000 ;;
      *CapDrop*|*CapAdd*) printf '[]' ;;
      *) exit 1 ;;
    esac ;;
  exec)
    shift 2
    if [ "$1" = sh ] && [ "$2" = -c ]; then
      case "$3" in
        *XP_DATA_DIR*) printf %s "$XP_FIXTURE/data"; exit 0 ;;
        *XP_XRAY_API_ADDR*) printf 127.0.0.1:10085; exit 0 ;;
        *legacy_path=*) printf '{}'; exit 0 ;;
      esac
    fi
    exec "$@" ;;
  *) exit 1 ;;
esac
`); chmodSync(join(f.dir, "bin/docker"), 0o755);
      const source = readFileSync(join(import.meta.dir, "../scripts/xp-infra-port-remote"), "utf8").replace("env_file=/etc/xp/xp.env", `env_file='${f.dir}/xp.env'`);
      const child = Bun.spawn(["sh", "-s"], { env: { ...f.env, XP_DRIFT: String(drift), XP_DOCKER: String(container), DOCKER_HOST: "tcp://fixture.invalid:2375", DOCKER_CONTEXT: "untrusted-fixture", DOCKER_CONFIG: "/nonexistent-fixture" }, stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (drift) expect(code).not.toBe(0);
      else { expect({ code, out, err }).toMatchObject({ code: 0 }); expect(preflight(out, "fixture-node")).toBeGreaterThan(0); expect(out).toContain("occupied_ports=22"); }
    }
  }, 20000);
  test("host identity is revalidated around successful loopback request", async () => { const result = await run("host"); expect(result.code).toBe(0); expect(result.out).toBe("vless_ingress=true\n"); expect(result.calls).toContain("curl"); });
  test.each(["pid-drift", "start-drift"])("host identity change fails: %s", async mode => { const result = await run(mode); expect(result.code).not.toBe(0); expect(result.out).not.toContain("vless_ingress=true"); });
  test("host permission failure cannot downgrade to Docker", async () => { const result = await run("deny-sudo"); expect(result.code).not.toBe(0); expect(result.calls).not.toContain("docker"); });
  test("sudo Docker follows native token scan", async () => { const result = await run("sudo-container", true); expect(result.code).toBe(0); expect(result.out).toContain("vless_ingress=true"); expect(result.calls).toContain("sudo -n docker"); });
  test("direct Docker needs explicit override", async () => {
    const denied = await run("direct", true, false); expect(denied.code).not.toBe(0); expect(denied.calls).not.toContain("curl");
    const allowed = await run("direct", true, true); expect(allowed.code).toBe(0); expect(allowed.out).toContain("vless_ingress=true");
  });
  test.each(["container-drift", "token-drift"])("container identity change fails: %s", async mode => { const result = await run(mode, true, true); expect(result.code).not.toBe(0); expect(result.out).not.toContain("vless_ingress=true"); });
  test("selected runtime environment avoids secret spooling and rejects duplicate public keys", async () => {
    const f = fixture("host");
    const envPath = join(f.dir, "proc/99/environ");
    writeFileSync(envPath, "XP_NODE_NAME=fixture\0XP_ADMIN_TOKEN=<SECRET_CANARY>\0OTHER=value\0");
    const source = readFileSync(join(import.meta.dir, "../scripts/xp-infra-audit-remote"), "utf8");
    const body = source.slice(source.indexOf("raw_env_payload() {"), source.indexOf("\nstrict_bool_value()"));
    const sudo = join(f.dir, "bin/sudo"); writeFileSync(sudo, '#!/bin/sh\nshift\nexec "$@"\n'); chmodSync(sudo, 0o755);
    const script = `set -eu\n${body.replace('/proc/$runtime_pid/environ', envPath)}\nmode=host\nhost_xp_pid=99\n${readFileSync(join(import.meta.dir, "../scripts/xp-infra-audit-remote"), "utf8").slice(source.indexOf("bounded_output() ("), source.indexOf("\ndirect_docker_host_environment_absent()"))}\nMAX_RAW_BYTES=65536\nREAD_ERROR_SENTINEL=__READ_FAILED__\nraw_env_payload XP_NODE_NAME __END__`;
    async function selected() {
      const child = Bun.spawn(["sh", "-s"], { env: f.env, stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
      const out = await new Response(child.stdout).text(); const code = await child.exited; return { out, code };
    }
    const good = await selected(); expect(good.code).toBe(0); expect(good.out).toBe("fixture__END__"); expect(good.out).not.toContain("SECRET_CANARY");
    writeFileSync(envPath, "XP_NODE_NAME=fixture\0XP_NODE_NAME=other\0");
    expect((await selected()).out).toContain("__READ_FAILED__");
    expect(source).not.toContain('tr "\\\\000" "\\\\n" < "$env_file" > "$env_dump"');
  });
});
