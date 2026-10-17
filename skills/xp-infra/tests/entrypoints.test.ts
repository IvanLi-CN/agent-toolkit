import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { expect, test } from "bun:test";

const SCRIPT_DIR = join(import.meta.dir, "../scripts");

type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

async function runWithOpenStdin(command: string[]): Promise<CommandResult> {
  const child = Bun.spawn({ cmd: command, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 1_000);
  await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode: child.exitCode ?? 1, stdout, stderr, timedOut };
}

async function run(command: string[], env: Record<string, string>): Promise<CommandResult> {
  const child = Bun.spawn({ cmd: command, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await child.exited;
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode: child.exitCode ?? 1, stdout, stderr, timedOut: false };
}

test("extensionless and TypeScript local entrypoints validate usage before reading open stdin", async () => {
  const cases = [
    { command: [join(SCRIPT_DIR, "xp-infra-audit-local")], exitCode: 1, text: "usage:" },
    { command: ["bun", join(SCRIPT_DIR, "xp-infra-audit-local.ts")], exitCode: 1, text: "usage:" },
    { command: [join(SCRIPT_DIR, "xp-infra-compose-image-check")], exitCode: 2, text: "usage:" },
    { command: ["bun", join(SCRIPT_DIR, "xp-infra-compose-image-check.ts")], exitCode: 2, text: "usage:" },
  ];
  for (const item of cases) {
    const result = await runWithOpenStdin(item.command);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(item.exitCode);
    expect(result.stderr).toContain(item.text);
  }
});

test("empty configuration variables retain the shell default paths", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "xp-infra-entrypoints-"));
  try {
    const configHome = join(root, "config");
    const configDir = join(configHome, "xp-infra");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "hosts.txt"), "fixture-node\n");
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const result = await run([join(SCRIPT_DIR, "xp-infra"), "inventory"], {
      ...env,
      HOME: "",
      XP_INFRA_CONFIG_DIR: "",
      XDG_CONFIG_HOME: configHome,
      XP_HOSTS_FILE: "",
      XP_POLICY_FILE: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("== fixture-node ==");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed audit fails when public JSON is healthy but Xray evidence is down", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "xp-infra-audit-"));
  try {
    const configDir = join(root, "config");
    const fakeBin = join(root, "bin");
    const containerIdentity = "a".repeat(64);
    const containerStartedAt = "2025-01-01 00:00:00 +0000";
    const xrayApiB64 = Buffer.from(JSON.stringify({
      inbounds: [{ tag: "vless-vision-endpoint-1", receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 443 } }],
    }), "utf8").toString("base64");
    await mkdir(configDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(configDir, "hosts.txt"), "fixture-node\n");
    await writeFile(join(configDir, "deployment-policy.yaml"), [
      "schema_version: 1",
      "owner_confirmed: true",
      "geo:",
      "  enabled: true",
      "  origin: https://api.country.is",
      "  owner_authorized_third_party_lookup: true",
      "public_hostname:",
      "  zone: example.com",
      "defaults:",
      "  cloudflare_tunnel: true",
      "  cloudflare_ddns: true",
      "  ip_geo_enrichment: true",
      "  managed_default_vless: true",
      "  managed_default_ss2022: false",
      "  direct_docker: false",
      "  vless_port: automatic_preflight",
      "node_overrides:",
      "  fixture-node:",
      "    owner_approved: true",
      "    reason: controlled audit fixture",
      "    defaults:",
      "      cloudflare_tunnel: false",
      "      direct_docker: true",
      "",
    ].join("\n"));
    await writeFile(join(fakeBin, "ssh"), [
      "#!/bin/sh",
      "set -eu",
      "if [ \"${1:-}\" = -G ]; then printf '%s\\n' 'user operator'; exit 0; fi",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -n) shift ;;",
      "    -o) shift 2 ;;",
      "    *) host=\"$1\"; shift; remote_command=\"${1:-}\"; break ;;",
      "  esac",
      "done",
      "eval \"set -- $remote_command\"",
      "if [ \"${1:-}\" = sh ] && [ \"${2:-}\" = -s ] && [ \"${3:-}\" = -- ] && [ \"${4:-}\" = true ] && [ \"${5:-}\" = true ]; then",
      "  cat <<'EOF'",
      "xp_service=true",
      "xray_service=true",
      "cloudflared_service=false",
      "runtime_mode=container",
      `container_identity=${containerIdentity}`,
      `container_started_at=${containerStartedAt}`,
      "container_xray_token=123:456",
      "host_xray_pid=",
      "host_xray_starttime=",
      "ddns_enabled=true",
      "ddns_monitor_mode=none",
      "ddns_restart_mode=",
      "ddns_fast_interval=30",
      "ddns_monitored_interval=300",
      "ddns_unmonitored_interval=60",
      "ddns_state_json={\"snapshot\":{\"last_sync_at\":\"2024-12-31T23:59:30Z\",\"status\":\"up\",\"last_error\":\"\"}}",
      "geo_enabled=true",
      "geo_origin=https://api.country.is",
      "geo_response_json={\"country\":\"JP\"}",
      "health_json={\"status\":\"ok\",\"xray\":{\"status\":\"down\"},\"cloudflared\":{\"status\":\"down\"},\"vless_https_canary\":{\"enabled\":true,\"last_error\":null,\"cert_not_after\":\"2030-01-01T00:00:00Z\",\"bind\":\"127.0.0.1:10443\"}}",
      "cluster_json={\"role\":\"leader\"}",
      "node_name=fixture-node",
      "api_base=https://example.com",
      "access_host=example.com",
      "cloudflare_enabled=false",
      "cloudflare_hostname=",
      "cloudflare_settings_json=",
      "managed_default_state_json={\"schema_version\":1,\"vless_endpoint_id\":\"endpoint-1\",\"ss_endpoint_id\":null}",
      "sync_node_meta=true",
      "xray_public_ports=443",
      "xray_listener_pids=123",
      "xray_runtime_pid=123",
      `xray_api_b64=${xrayApiB64}`,
      "EOF",
      "  exit 0",
      "fi",
      "if [ \"${1:-}\" = sh ] && [ \"${2:-}\" = -s ] && [ \"${3:-}\" = -- ] && [ \"${4:-}\" = example.com ] && [ \"${5:-}\" = 10443 ] && [ \"${6:-}\" = true ] && [ \"${7:-}\" = container ] && [ \"${8:-}\" = " + containerIdentity + " ] && [ \"${9:-}\" = '" + containerStartedAt + "' ]; then",
      "  printf '%s\\n' vless_ingress=true",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
    await writeFile(join(fakeBin, "curl"), [
      "#!/bin/sh",
      "set -eu",
      "case \"$*\" in",
      "  *'https://example.com/api/health'*) printf '%s\\r\\n\\r\\n%s' 'HTTP/1.1 200 OK' '{\"status\":\"ok\",\"xray\":{\"status\":\"down\"}}' ;;",
      "  *'/generate_204'*) printf '%s' 204 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"));
    await chmod(join(fakeBin, "ssh"), 0o755);
    await chmod(join(fakeBin, "curl"), 0o755);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const result = await run([join(SCRIPT_DIR, "xp-infra"), "audit", "fixture-node"], {
      ...env,
      PATH: `${fakeBin}:${env.PATH ?? ""}`,
      XP_INFRA_CONFIG_DIR: configDir,
      XP_HOSTS_FILE: "",
      XP_POLICY_FILE: "",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("FAIL public_health");
    expect(result.stderr).not.toContain("exit 97");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
