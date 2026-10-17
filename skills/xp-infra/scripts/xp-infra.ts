#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  effectivePolicy,
  interpretPortPreflight,
  isCloudflareAddress,
  normalizeBasic,
  normalizePublicHealth,
  parseInventory,
  parseKeyValueRecords,
  parseRestrictedYaml,
  validatePolicyDocument,
  validatePublicTarget,
  ValidationError,
  type PolicyDefinition,
  type ValidatedPublicTarget,
} from "./xp-infra-core.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR);
const REF_DIR = join(SKILL_DIR, "references");
const SSH_CONNECT_TIMEOUT_SECS = 10;
const PORT_PREFLIGHT_EXEC_TIMEOUT_MS = 60_000;
const REMOTE_COMMAND_TIMEOUT_MS = 60_000;
const MAX_AUDIT_RESPONSE_BYTES = 65_536;
const PUBLIC_NETWORK_TIMEOUT_MS = 20_000;

type Paths = { configDir: string; hostsFile: string; policyFile: string };
type ProcessOptions = { input?: Blob; timeoutMs?: number; maxBuffer?: number };
type ProcessResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
type PolicyContext = { inventory: string[]; policy: PolicyDefinition };

const DNS_LOOKUP_SCRIPT = [
  "import { lookup } from 'node:dns/promises';",
  "const hostname = process.argv[1];",
  "if (!hostname) process.exit(2);",
  "const addresses = await lookup(hostname, { all: true, verbatim: true });",
  "process.stdout.write(JSON.stringify(addresses));",
].join("\n");

function die(message: string): never {
  throw new ValidationError(message);
}

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? value : fallback;
}

function configurationPaths(): Paths {
  let configDir = process.env.XP_INFRA_CONFIG_DIR ?? "";
  if (!configDir) {
    const configHome = envOrDefault("XDG_CONFIG_HOME", process.env.HOME ? join(process.env.HOME, ".config") : "");
    if (!configHome) die("set XP_INFRA_CONFIG_DIR or HOME before using xp-infra");
    configDir = join(configHome, "xp-infra");
  }
  return {
    configDir,
    hostsFile: envOrDefault("XP_HOSTS_FILE", join(configDir, "hosts.txt")),
    policyFile: envOrDefault("XP_POLICY_FILE", join(configDir, "deployment-policy.yaml")),
  };
}

async function readText(path: string, missingMessage: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    die(missingMessage + ": " + path);
  }
}

async function readHosts(paths: Paths): Promise<string[]> {
  return parseInventory(await readText(paths.hostsFile, "missing hosts file"));
}

async function loadPolicyContext(paths: Paths): Promise<PolicyContext> {
  const inventory = await readHosts(paths);
  const policyText = await readText(paths.policyFile, "missing deployment policy");
  let document: unknown;
  try {
    document = parseRestrictedYaml(policyText);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    die("deployment policy is invalid");
  }
  return { inventory, policy: validatePolicyDocument(document, inventory) };
}

async function runProcess(command: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const processHandle = Bun.spawn({
    cmd: command,
    stdin: options.input,
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: options.maxBuffer ?? MAX_AUDIT_RESPONSE_BYTES,
  });
  const timeoutMs = options.timeoutMs ?? REMOTE_COMMAND_TIMEOUT_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      processHandle.kill("SIGTERM");
      killTimer = setTimeout(() => processHandle.kill("SIGKILL"), 1000);
      resolve("timeout");
    }, timeoutMs);
  });
  const exited = processHandle.exited.then(() => "exited" as const);
  await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  await processHandle.exited;
  if (killTimer) clearTimeout(killTimer);
  const [stdout, stderr] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
  return { stdout, stderr, exitCode: processHandle.exitCode ?? 1, timedOut };
}

async function runInteractive(command: string[]): Promise<number> {
  const processHandle = Bun.spawn({ cmd: command, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await processHandle.exited;
  return processHandle.exitCode ?? 1;
}

function requireCommand(command: string): void {
  if (!Bun.which(command)) die(command + " is required");
}

function printProcessFailure(result: ProcessResult): never {
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) die("remote command timed out");
  die("remote command failed with exit " + result.exitCode);
}

async function sshConfig(host: string, key: string): Promise<string> {
  const result = await runProcess(["ssh", "-G", host], { timeoutMs: SSH_CONNECT_TIMEOUT_SECS * 1000 });
  if (result.exitCode !== 0 || result.timedOut) return "";
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === key) return parts[1] ?? "";
  }
  return "";
}

async function requireRegisteredHost(paths: Paths, host: string): Promise<void> {
  const inventory = await readHosts(paths);
  if (!inventory.includes(host)) die("host is not registered in " + paths.hostsFile);
}

async function requireOperatorAccount(paths: Paths, host: string): Promise<void> {
  await requireRegisteredHost(paths, host);
  const user = await sshConfig(host, "user");
  if (user === "root" || user === "xp") die("refusing SSH alias " + host + ": configure a non-root operator account");
}

async function sshCommand(paths: Paths, host: string, args: string[], input?: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<ProcessResult> {
  await requireOperatorAccount(paths, host);
  const remoteCommand = args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const command = ["ssh", ...(input === undefined ? ["-n"] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=" + SSH_CONNECT_TIMEOUT_SECS, host, remoteCommand];
  return runProcess(command, { input: input === undefined ? undefined : new Blob([input]), timeoutMs });
}

async function runRemoteProbe(paths: Paths, host: string, script: string, args: string[] = [], timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<string> {
  const result = await sshCommand(paths, host, ["sh", "-s", "--", ...args], script, timeoutMs);
  if (result.exitCode !== 0 || result.timedOut) printProcessFailure(result);
  return result.stdout;
}

function usage(paths: Paths): void {
  console.log([
    "xp-infra: read-only ops helper for xp self-hosted nodes (ssh-alias only)",
    "",
    "Usage:",
    "  xp-infra inventory",
    "  xp-infra policy check",
    "  xp-infra port preflight <host>",
    "  xp-infra audit <host>",
    "  xp-infra status <host>",
    "  xp-infra logs <host> [--tail N]",
    "  xp-infra version <host>",
    "  xp-infra tunnel <host> [--ui|--metrics] [--local-port PORT]",
    "",
    "Notes:",
    "  - Hosts are SSH aliases from " + paths.hostsFile,
    "  - Policy is read from " + paths.policyFile,
    "  - Public references/*.example files are templates only",
    "  - Connection details live in ~/.ssh/config",
    "  - This tool is intentionally read-only (no restarts/uploads)",
  ].join("\n"));
}

const INVENTORY_PROBE = [
  "set -eu",
  "if [ -f /etc/os-release ]; then",
  "  . /etc/os-release",
  "  echo \"os_pretty=${PRETTY_NAME:-}\"",
  "  echo \"os_id=${ID:-}\"",
  "  echo \"os_version=${VERSION_ID:-}\"",
  "else",
  "  echo \"os_pretty=$(uname -s)\"",
  "  echo \"os_id=\"",
  "  echo \"os_version=\"",
  "fi",
  "svc_mgr=unknown",
  "if command -v rc-service >/dev/null 2>&1; then svc_mgr=openrc",
  "elif command -v systemctl >/dev/null 2>&1; then svc_mgr=systemd",
  "fi",
  "echo \"svc_mgr=$svc_mgr\"",
  "xp_bin=\"\"",
  "if [ -x /usr/local/bin/xp ]; then xp_bin=/usr/local/bin/xp",
  "elif command -v xp >/dev/null 2>&1; then xp_bin=$(command -v xp)",
  "fi",
  "if [ -n \"$xp_bin\" ]; then",
  "  echo \"xp_present=yes\"",
  "  echo \"xp_bin=$xp_bin\"",
  "  echo \"xp_version=$($xp_bin --version 2>/dev/null || $xp_bin -V 2>/dev/null || echo unknown)\"",
  "else",
  "  echo \"xp_present=no\"",
  "  echo \"xp_bin=\"",
  "  echo \"xp_version=\"",
  "fi",
  "ui_listen=no",
  "metrics_listen=no",
  "if command -v ss >/dev/null 2>&1; then",
  "  ss -ltn 2>/dev/null | grep -q \":62416\" && ui_listen=yes || true",
  "  ss -ltn 2>/dev/null | grep -q \":10085\" && metrics_listen=yes || true",
  "elif command -v netstat >/dev/null 2>&1; then",
  "  netstat -ltn 2>/dev/null | grep -q \":62416\" && ui_listen=yes || true",
  "  netstat -ltn 2>/dev/null | grep -q \":10085\" && metrics_listen=yes || true",
  "fi",
  "echo \"ui_listen=$ui_listen\"",
  "echo \"metrics_listen=$metrics_listen\"",
  "",
].join("\n");

const STATUS_PROBE = [
  "set -eu",
  "if command -v rc-service >/dev/null 2>&1; then",
  "  sudo -n rc-service xp status",
  "elif command -v systemctl >/dev/null 2>&1; then",
  "  sudo -n systemctl status xp --no-pager",
  "else",
  "  echo \"unknown service manager (need rc-service or systemctl)\" >&2",
  "  exit 2",
  "fi",
  "",
].join("\n");

const VERSION_PROBE = [
  "set -eu",
  "if [ -x /usr/local/bin/xp ]; then",
  "  /usr/local/bin/xp --version",
  "elif command -v xp >/dev/null 2>&1; then",
  "  xp --version",
  "else",
  "  echo \"xp: missing\"",
  "  exit 1",
  "fi",
  "",
].join("\n");

async function cmdInventory(paths: Paths, args: string[]): Promise<number> {
  if (args.length !== 0) die("usage: xp-infra inventory");
  const hosts = await readHosts(paths);
  const allowed = new Set(["os_pretty", "os_id", "os_version", "svc_mgr", "xp_present", "xp_bin", "xp_version", "ui_listen", "metrics_listen"]);
  for (const host of hosts) {
    const hostname = await sshConfig(host, "hostname");
    const port = await sshConfig(host, "port");
    const user = await sshConfig(host, "user");
    console.log("== " + host + " ==");
    console.log("ssh: user=" + (user || "?") + " host=" + (hostname || "?") + " port=" + (port || "?"));
    try {
      const records = parseKeyValueRecords(await runRemoteProbe(paths, host, INVENTORY_PROBE), "inventory probe", allowed);
      console.log("os: " + String(records.os_pretty || "unknown"));
      console.log("svc_mgr: " + String(records.svc_mgr || "unknown"));
      console.log("xp_present: " + String(records.xp_present || "unknown"));
      if (records.xp_version) console.log("xp_version: " + String(records.xp_version));
      console.log("listen: ui_62416=" + String(records.ui_listen || "unknown") + " metrics_10085=" + String(records.metrics_listen || "unknown"));
    } catch {
      console.log("probe: FAILED");
    }
    console.log("");
  }
  return 0;
}

async function cmdPolicy(paths: Paths, args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== "check") die("usage: xp-infra policy check");
  await loadPolicyContext(paths);
  console.log("policy: OK");
  return 0;
}

async function cmdPort(paths: Paths, args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "preflight" || !args[1]) die("usage: xp-infra port preflight <host>");
  requireCommand("ssh");
  const context = await loadPolicyContext(paths);
  const host = args[1];
  await requireRegisteredHost(paths, host);
  effectivePolicy(context.policy, host, context.inventory);
  const script = await readText(join(SCRIPT_DIR, "xp-infra-port-preflight-remote"), "missing port preflight probe");
  const prefix = envOrDefault("XP_CONTAINER_IMAGE_PREFIX", "ghcr.io/example/xp");
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) die("XP_CONTAINER_IMAGE_PREFIX is invalid");
  const raw = await runRemoteProbe(paths, host, script, [prefix], PORT_PREFLIGHT_EXEC_TIMEOUT_MS);
  console.log(String(interpretPortPreflight(raw, host)));
  return 0;
}

async function readRemoteFile(name: string): Promise<string> {
  return readText(join(SCRIPT_DIR, name), "missing audit probe");
}

function recordValue(records: Record<string, string>, key: string): string {
  return records[key] ?? "";
}

function checkExpected(key: string, expected: string, actual: string): boolean {
  if (actual === expected) {
    console.log("PASS " + key);
    return true;
  }
  console.log("FAIL " + key + " expected=" + expected + " actual=" + (actual || "missing"));
  return false;
}

function checkTrue(key: string, actual: string): boolean {
  if (actual === "true") {
    console.log("PASS " + key);
    return true;
  }
  console.log("FAIL " + key);
  return false;
}

async function resolvePublicTarget(target: string, path: string): Promise<ValidatedPublicTarget> {
  return validatePublicTarget(target, path, async (hostname) => {
    const result = await runProcess([process.execPath, "-e", DNS_LOOKUP_SCRIPT, hostname], {
      timeoutMs: PUBLIC_NETWORK_TIMEOUT_MS,
      maxBuffer: MAX_AUDIT_RESPONSE_BYTES,
    });
    if (result.timedOut) die("public target DNS lookup timed out");
    if (result.exitCode !== 0) die("public target DNS lookup failed");
    let addresses: Array<{ address: string; family: number }>;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      addresses = parsed as Array<{ address: string; family: number }>;
    } catch {
      die("public target DNS lookup returned invalid data");
    }
    return addresses.map((address) => ({ address: address.address, family: address.family }));
  });
}

type CurlResult = { body: string; headers: string; status: number };

function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function parseCurlHeaders(output: string): { headers: string; body: string; status: number } {
  const separators = [...output.matchAll(/\r?\n\r?\n/g)];
  const separator = separators.at(-1);
  if (!separator || separator.index === undefined) die("public probe returned malformed headers");
  const headerEnd = separator.index + separator[0].length;
  const headers = output.slice(0, separator.index);
  const headerLines = headers.split(/\r?\n/);
  let statusLine = "";
  for (const line of headerLines) {
    if (/^HTTP\/\S+\s+[0-9]{3}/.test(line)) statusLine = line;
  }
  const statusMatch = statusLine?.match(/^HTTP\/\S+\s+([0-9]{3})/);
  if (!statusMatch) die("public probe returned no HTTP status");
  return { headers, body: output.slice(headerEnd), status: Number(statusMatch[1]) };
}

async function curlJson(target: ValidatedPublicTarget): Promise<CurlResult> {
  requireCommand("curl");
  const result = await runProcess([
    "curl", "-fsS", "--noproxy", "*", "--max-time", "15", "--max-filesize", String(MAX_AUDIT_RESPONSE_BYTES),
    "-D", "-", "--resolve", target.resolve, "--", target.target,
  ], { timeoutMs: 20_000, maxBuffer: MAX_AUDIT_RESPONSE_BYTES });
  if (result.exitCode !== 0 || result.timedOut) die("public health probe failed");
  const response = parseCurlHeaders(result.stdout);
  if (!isSuccessfulHttpStatus(response.status)) die("public health probe returned an unsuccessful HTTP status");
  return response;
}

async function curlStatus(target: ValidatedPublicTarget): Promise<string> {
  requireCommand("curl");
  const result = await runProcess([
    "curl", "-sS", "--noproxy", "*", "--max-time", "15", "--resolve", target.resolve,
    "-o", "/dev/null", "-w", "%{http_code}", "--", target.target,
  ], { timeoutMs: 20_000, maxBuffer: 16 });
  return result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : "";
}

async function curlText(url: string): Promise<string> {
  requireCommand("curl");
  const result = await runProcess([
    "curl", "-fsS", "--noproxy", "*", "--max-time", "15", "--max-filesize", String(MAX_AUDIT_RESPONSE_BYTES), "-D", "-", "--", url,
  ], { timeoutMs: 20_000, maxBuffer: MAX_AUDIT_RESPONSE_BYTES });
  if (result.exitCode !== 0 || result.timedOut) die("Cloudflare IP ranges request failed");
  const response = parseCurlHeaders(result.stdout);
  if (!isSuccessfulHttpStatus(response.status) || !response.body.trim()) die("Cloudflare IP ranges response is incomplete");
  return response.body;
}

function hasHeader(headers: string, name: string, expected?: string): boolean {
  const normalizedName = name.toLowerCase();
  return headers.split(/\r?\n/).some((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0 || line.slice(0, separator).toLowerCase() !== normalizedName) return false;
    return expected === undefined || line.slice(separator + 1).trim().toLowerCase() === expected.toLowerCase();
  });
}

function splitResolve(resolve: string): { host: string; port: string } {
  const first = resolve.indexOf(":");
  const second = resolve.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) die("public probe returned an invalid resolved target");
  return { host: resolve.slice(0, first), port: resolve.slice(first + 1, second) };
}

async function cmdAudit(paths: Paths, args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) die("usage: xp-infra audit <host>");
  const host = args[0];
  const context = await loadPolicyContext(paths);
  const flags = effectivePolicy(context.policy, host, context.inventory);
  requireCommand("ssh");
  requireCommand("curl");
  const remoteScript = await readRemoteFile("xp-infra-audit-remote");
  const basicRaw = await runRemoteProbe(paths, host, remoteScript, [String(flags.direct_docker), String(flags.managed_default_vless)]);
  const basic = normalizeBasic(basicRaw);
  let failed = 0;
  const privateDockerException = flags.direct_docker && !flags.cloudflare_tunnel && !flags.managed_default_vless;
  if (privateDockerException) {
    if (recordValue(basic, "runtime_mode") !== "container") {
      console.error("FAIL private_docker_runtime_mode");
      failed = 1;
    }
    console.log("SKIP public_hostname_convention (approved private-node exception)");
  } else {
    const expectedApiHost = recordValue(basic, "node_name") + "-xp." + flags.public_hostname_zone;
    const expectedAccessHost = recordValue(basic, "node_name") + "-ep." + flags.public_hostname_zone;
    if (recordValue(basic, "node_name_valid") === "true" && recordValue(basic, "api_host") === expectedApiHost && recordValue(basic, "access_host") === expectedAccessHost) console.log("PASS public_hostname_convention");
    else {
      console.log("FAIL public_hostname_convention");
      failed = 1;
    }
  }

  let publicHealth = "";
  let gotCloudflareTunnel = recordValue(basic, "cloudflare_tunnel");
  if (recordValue(basic, "public_health_target") && !privateDockerException) {
    const publicTarget = await resolvePublicTarget(recordValue(basic, "public_health_target"), "/api/health");
    const publicResponse = await curlJson(publicTarget);
    const publicResult = normalizePublicHealth(publicResponse.body);
    publicHealth = publicResult.public_health;
    if (flags.cloudflare_tunnel) gotCloudflareTunnel = "false";
    const cloudflareRanges = flags.cloudflare_tunnel ? (await curlText("https://www.cloudflare.com/ips-v4")) + "\n" + (await curlText("https://www.cloudflare.com/ips-v6")) : "";
    if (flags.cloudflare_tunnel && recordValue(basic, "tunnel_declaration") === "aligned" && isCloudflareAddress(publicTarget.address, cloudflareRanges) && hasHeader(publicResponse.headers, "server", "cloudflare") && hasHeader(publicResponse.headers, "cf-ray") && publicHealth === "true") gotCloudflareTunnel = "true";
  }

  let gotLocalCanary = "";
  let gotVlessIngress = recordValue(basic, "vless_ingress");
  let gotXrayPublicListener = recordValue(basic, "xray_public_listener");
  if (flags.managed_default_vless) gotVlessIngress = "false";
  const canaryTargetText = recordValue(basic, "canary_local_target");
  if (canaryTargetText && flags.managed_default_vless) {
    const canaryTarget = await resolvePublicTarget(canaryTargetText, "/generate_204");
    const canaryConnection = splitResolve(canaryTarget.resolve);
    const vlessScript = await readRemoteFile("xp-infra-audit-vless-remote");
    const localResult = parseKeyValueRecords(await runRemoteProbe(paths, host, vlessScript, [
      canaryConnection.host,
      canaryConnection.port,
      String(flags.direct_docker),
      recordValue(basic, "runtime_mode"),
      recordValue(basic, "container_identity"),
      recordValue(basic, "container_started_at"),
      recordValue(basic, "host_xray_pid"),
      recordValue(basic, "host_xray_starttime"),
      recordValue(basic, "container_xray_token"),
    ]), "VLESS audit response", new Set(["vless_ingress"]));
    gotLocalCanary = String(localResult.vless_ingress ?? "");
  }
  const vlessTargetText = recordValue(basic, "vless_public_target");
  if (vlessTargetText && flags.managed_default_vless) {
    const vlessTarget = await resolvePublicTarget(vlessTargetText, "/generate_204");
    const publicStatus = await curlStatus(vlessTarget);
    if (gotLocalCanary === "true" && publicStatus === "204") gotVlessIngress = "true";
    else {
      gotVlessIngress = "false";
      gotXrayPublicListener = "false";
    }
  }

  if (!checkExpected("cloudflare_tunnel", String(flags.cloudflare_tunnel), gotCloudflareTunnel)) failed = 1;
  if (flags.cloudflare_ddns) {
    if (recordValue(basic, "cloudflare_ddns_enabled") === "true") {
      if (!checkExpected("cloudflare_ddns", "true", recordValue(basic, "cloudflare_ddns"))) failed = 1;
    } else if (!checkExpected("cloudflare_ddns", "true", "false")) failed = 1;
  } else if (!checkExpected("cloudflare_ddns", "false", recordValue(basic, "cloudflare_ddns_enabled"))) failed = 1;
  if (!checkExpected("ip_geo_enrichment", String(flags.ip_geo_enrichment), recordValue(basic, "ip_geo_enrichment"))) failed = 1;
  if (!checkExpected("managed_default_vless", String(flags.managed_default_vless), recordValue(basic, "managed_default_vless"))) failed = 1;
  if (!checkExpected("managed_default_ss2022", String(flags.managed_default_ss2022), recordValue(basic, "managed_default_ss2022"))) failed = 1;
  if (!checkTrue("xp_service", recordValue(basic, "xp_service"))) failed = 1;
  if (!checkTrue("xray_service", recordValue(basic, "xray_service"))) failed = 1;
  if (flags.cloudflare_tunnel) {
    if (!checkTrue("cloudflared_service", recordValue(basic, "cloudflared_service"))) failed = 1;
    const declaration = recordValue(basic, "tunnel_declaration");
    if (declaration === "aligned") console.log("PASS tunnel_declaration");
    else {
      console.log("FAIL tunnel_declaration_" + (declaration === "missing" ? "missing" : "mismatch"));
      failed = 1;
    }
  } else console.log("SKIP cloudflared_service (approved Tunnel exception)");
  if (!checkTrue("cluster_sync", recordValue(basic, "cluster_sync"))) failed = 1;
  if (flags.managed_default_vless) {
    if (!checkTrue("xray_public_listener", gotXrayPublicListener)) failed = 1;
    if (!checkTrue("canary_enabled", recordValue(basic, "canary_enabled"))) failed = 1;
    if (!checkTrue("canary_certificate", recordValue(basic, "canary_certificate"))) failed = 1;
    if (!checkTrue("local_canary", gotLocalCanary)) failed = 1;
    if (!checkTrue("vless_ingress", gotVlessIngress)) failed = 1;
  } else {
    console.log("SKIP canary_enabled (approved VLESS exception)");
    console.log("SKIP canary_certificate (approved VLESS exception)");
    console.log("SKIP local_canary (approved VLESS exception)");
    console.log("SKIP vless_ingress (approved VLESS exception)");
  }
  if (!checkTrue("local_health", recordValue(basic, "local_health"))) failed = 1;
  if (!checkTrue("xray_runtime", recordValue(basic, "xray_runtime"))) failed = 1;
  if (!privateDockerException && !checkTrue("public_health", publicHealth || recordValue(basic, "public_health"))) failed = 1;
  else if (privateDockerException) console.log("SKIP public_health (approved private-node exception)");
  const role = recordValue(basic, "cluster_role");
  if (role === "leader" || role === "follower") console.log("PASS cluster_role=" + role);
  else {
    console.log("FAIL cluster_role");
    failed = 1;
  }
  if (failed) {
    console.error("audit: FAILED (" + host + "); do not declare deployment complete");
    return 1;
  }
  console.log("audit: OK (" + host + ")");
  return 0;
}

async function cmdStatus(paths: Paths, args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) die("missing <host>");
  const result = await sshCommand(paths, args[0], ["sh", "-s"], STATUS_PROBE, REMOTE_COMMAND_TIMEOUT_MS);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0 || result.timedOut) return result.exitCode || 1;
  process.stdout.write(result.stdout);
  return 0;
}

async function cmdLogs(paths: Paths, args: string[]): Promise<number> {
  const host = args[0];
  if (!host) die("missing <host>");
  let tail = 200;
  if (args.length === 3 && args[1] === "--tail") {
    if (!/^[1-9][0-9]*$/.test(args[2] ?? "") || Number(args[2]) > 10_000) die("--tail requires a number between 1 and 10000");
    tail = Number(args[2]);
  } else if (args.length !== 1) die("unknown arg");
  const script = [
    "set -eu",
    "tail_lines=$1",
    "if command -v rc-service >/dev/null 2>&1; then",
    "  if ! sudo -n true 2>/dev/null; then",
    "    echo 'xp logs unavailable: sudo -n is required for OpenRC diagnostics' >&2",
    "    exit 1",
    "  elif sudo -n test -f /var/log/xp.log; then",
    "    sudo -n tail -n \"$tail_lines\" /var/log/xp.log",
    "  else",
    "    echo 'xp logs unavailable: this OpenRC service has no persistent /var/log/xp.log; returning health instead' >&2",
    "    curl -fsS http://127.0.0.1:62416/api/health",
    "  fi",
    "elif command -v systemctl >/dev/null 2>&1; then",
    "  sudo -n journalctl -u xp --no-pager -n \"$tail_lines\"",
    "else",
    "  echo \"unknown service manager (need rc-service or systemctl)\" >&2",
    "  exit 2",
    "fi",
    "",
  ].join("\n");
  const result = await sshCommand(paths, host, ["sh", "-s", "--", String(tail)], script);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0 || result.timedOut) return result.exitCode || 1;
  process.stdout.write(result.stdout);
  return 0;
}

async function cmdVersion(paths: Paths, args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) die("missing <host>");
  const result = await sshCommand(paths, args[0], ["sh", "-s"], VERSION_PROBE);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0 || result.timedOut) return result.exitCode || 1;
  process.stdout.write(result.stdout);
  return 0;
}

async function remoteSshdValue(paths: Paths, host: string, key: string): Promise<string> {
  const script = [
    "set -eu",
    "sudo -n sshd -T 2>/dev/null | awk -v key=\"$1\" '$1 == key { print $2; exit }'",
    "",
  ].join("\n");
  try {
    const result = await sshCommand(paths, host, ["sh", "-s", "--", key], script);
    return result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function cmdTunnel(paths: Paths, args: string[]): Promise<number> {
  const host = args[0];
  if (!host) die("missing <host>");
  let mode: "ui" | "metrics" = "ui";
  let localPort = 0;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ui") mode = "ui";
    else if (arg === "--metrics") mode = "metrics";
    else if (arg === "--local-port") {
      const value = args[++index] ?? "";
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 65535) die("--local-port requires a number between 1 and 65535");
      localPort = Number(value);
    } else die("unknown arg: " + arg);
  }
  await requireOperatorAccount(paths, host);
  const remotePort = mode === "ui" ? 62416 : 10085;
  if (!localPort) localPort = remotePort;
  if (Bun.which("lsof")) {
    const result = await runProcess(["lsof", "-nP", "-iTCP:" + localPort, "-sTCP:LISTEN"], { timeoutMs: 5000, maxBuffer: 4096 });
    if (result.exitCode === 0) console.error("warn: local port " + localPort + " is already in use; choose another with --local-port");
  }
  if (await remoteSshdValue(paths, host, "allowtcpforwarding") === "no") die("SSH server disallows TCP forwarding (AllowTcpForwarding no). See " + join(REF_DIR, "runbook.md") + " for how to enable it safely.");
  console.error("tunnel: localhost:" + localPort + " -> " + host + ":127.0.0.1:" + remotePort);
  console.error("press Ctrl+C to stop");
  return runInteractive(["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=" + SSH_CONNECT_TIMEOUT_SECS, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", localPort + ":127.0.0.1:" + remotePort, host, "-N"]);
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  try {
    const paths = configurationPaths();
    const command = args[0] ?? "";
    const rest = args.slice(1);
    switch (command) {
      case "inventory": return await cmdInventory(paths, rest);
      case "policy": return await cmdPolicy(paths, rest);
      case "port": return await cmdPort(paths, rest);
      case "audit": return await cmdAudit(paths, rest);
      case "status": return await cmdStatus(paths, rest);
      case "logs": return await cmdLogs(paths, rest);
      case "version": return await cmdVersion(paths, rest);
      case "tunnel": return await cmdTunnel(paths, rest);
      case "help":
      case "-h":
      case "--help":
      case "":
        usage(paths);
        return 0;
      default:
        die("unknown command: " + command);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("error: " + message);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
