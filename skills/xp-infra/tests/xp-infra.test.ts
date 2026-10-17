import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import {
  effectivePolicy,
  isExactComposeImage,
  interpretPortPreflight,
  normalizeBasic,
  normalizePublicHealth,
  parseInventory,
  parseRestrictedYaml,
  parseStrictJson,
  parseTimestamp,
  isCloudflareAddress,
  validatePolicyDocument,
  validatePublicTarget,
} from "../scripts/xp-infra-core.ts";

const POLICY_TEXT = [
  "schema_version: 1",
  "owner_confirmed: true",
  "geo:",
  "  enabled: true",
  "  origin: https://api.country.is",
  "  owner_authorized_third_party_lookup: true",
  "public_hostname:",
  "  zone: example.test",
  "defaults:",
  "  cloudflare_tunnel: true",
  "  cloudflare_ddns: true",
  "  ip_geo_enrichment: true",
  "  managed_default_vless: true",
  "  managed_default_ss2022: false",
  "  direct_docker: false",
  "  vless_port: automatic_preflight",
  "node_overrides: {}",
  "",
].join("\n");

function validPolicy() {
  return validatePolicyDocument(parseRestrictedYaml(POLICY_TEXT), ["fixture-node"]);
}

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const VALID_XRAY_API_B64 = encodedJson({
  inbounds: [{ tag: "vless-vision-endpoint-1", receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 443 } }],
});

function records(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => key + "=" + value).join("\n") + "\n";
}

function validBasicRecords(): string {
  return records({
    xp_service: "true",
    xray_service: "true",
    cloudflared_service: "true",
    runtime_mode: "host",
    container_identity: "",
    container_started_at: "",
    container_xray_token: "",
    host_xray_pid: "123",
    host_xray_starttime: "456",
    ddns_enabled: "true",
    ddns_monitor_mode: "none",
    ddns_restart_mode: "",
    ddns_fast_interval: "30",
    ddns_monitored_interval: "300",
    ddns_unmonitored_interval: "60",
    ddns_state_json: JSON.stringify({ snapshot: { last_sync_at: "2024-12-31T23:59:30Z", status: "up", last_error: "" } }),
    geo_enabled: "true",
    geo_origin: "https://api.country.is",
    geo_response_json: JSON.stringify({ country: "JP" }),
    health_json: JSON.stringify({
      status: "ok",
      xray: { status: "up" },
      cloudflared: { status: "up" },
      vless_https_canary: { enabled: true, last_error: null, cert_not_after: "2025-02-01T00:00:00Z", bind: "127.0.0.1:10443" },
    }),
    cluster_json: JSON.stringify({ role: "leader" }),
    node_name: "fixture-node",
    api_base: "https://fixture-node-xp.example.test",
    access_host: "fixture-node-ep.example.test",
    cloudflare_enabled: "true",
    cloudflare_hostname: "",
    cloudflare_settings_json: JSON.stringify({ enabled: true, hostname: "fixture-node-xp.example.test" }),
    managed_default_state_json: JSON.stringify({ schema_version: 1, vless_endpoint_id: "endpoint-1", ss_endpoint_id: null }),
    sync_node_meta: "true",
    xray_public_ports: "443",
    xray_listener_pids: "123",
    xray_runtime_pid: "123",
    xray_api_b64: VALID_XRAY_API_B64,
  });
}

test("validates the public policy and merges only registered overrides", () => {
  const policy = validPolicy();
  expect(effectivePolicy(policy, "fixture-node", ["fixture-node"]).managed_default_vless).toBe(true);
  const unregistered = POLICY_TEXT.replace("node_overrides: {}", "node_overrides:\n  other-node:\n    owner_approved: true\n    reason: fixture");
  expect(() => validatePolicyDocument(parseRestrictedYaml(unregistered), ["fixture-node"])).toThrow("not registered");
});

test("rejects duplicate, incomplete, and broadened YAML policy constructs", () => {
  expect(() => parseRestrictedYaml("schema_version: 1\nschema_version: 1\n")).toThrow("duplicate YAML key");
  expect(() => parseRestrictedYaml("node_overrides: &defaults {}\n")).toThrow("unsupported YAML construct");
  expect(() => parseRestrictedYaml("---\nschema_version: 1\n")).toThrow("unsupported YAML document");
  expect(() => validatePolicyDocument(parseRestrictedYaml(POLICY_TEXT.replace("owner_confirmed: true", "owner_confirmed: false")), ["fixture-node"])).toThrow("owner_confirmed must be true");
  expect(() => validatePolicyDocument(parseRestrictedYaml(POLICY_TEXT.replace("node_overrides: {}", "node_overrides:")), ["fixture-node"])).toThrow("node_overrides must be a mapping");
  expect(() => parseInventory("fixture-node\nfixture-node\n")).toThrow("duplicate");
});

test("rejects duplicate JSON members and malformed normalized observations", () => {
  expect(() => parseStrictJson('{"status":"ok","status":"bad"}', "health_json")).toThrow("duplicate");
  expect(() => parseStrictJson('{"status":\u00a0"ok"}', "health_json")).toThrow("invalid");
  expect(() => parseStrictJson('{"status":"ok"}\u00a0', "health_json")).toThrow("invalid");
  expect(() => normalizePublicHealth('{"status":"ok","xray":{"status":"up"},"xray":{"status":"down"}}')).toThrow("duplicate");
  expect(() => normalizeBasic(validBasicRecords().replace("ddns_enabled=true", "ddns_enabled=maybe"), new Date("2025-01-01T00:00:00Z"))).toThrow("ddns_enabled is invalid");
  expect(() => normalizeBasic(validBasicRecords().replace("xray_public_ports=443", "xray_public_ports=443,443"), new Date("2025-01-01T00:00:00Z"))).toThrow("duplicates");
  expect(() => normalizeBasic(validBasicRecords().replace("runtime_mode=host", "runtime_mode=container"), new Date("2025-01-01T00:00:00Z"))).toThrow("container_identity");
});

test("rejects partial, normalized, and injected timestamps while preserving missing values", () => {
  expect(parseTimestamp("1")).toBeUndefined();
  expect(parseTimestamp("2025-01")).toBeUndefined();
  expect(parseTimestamp("12345")?.getTime()).toBeLessThan(new Date("2025-01-01T00:00:00Z").getTime());
  expect(parseTimestamp("20250101123045")?.toISOString()).toBe("2025-01-01T12:30:45.000Z");
  expect(parseTimestamp("01 Jan 2025 00:00:00 UTC")?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  expect(parseTimestamp("Jan  1 00:00:00 2025 GMT")?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  expect(parseTimestamp("20250230123045")).toBeUndefined();
  expect(parseTimestamp("2025-02-30")).toBeUndefined();
  expect(parseTimestamp("2025-01-01$(id)")).toBeUndefined();
  expect(parseTimestamp("01 Jan 2025 00:00:00+2500")).toBeUndefined();
  expect(parseTimestamp("01 Jan 2025 junk")).toBeUndefined();
  expect(parseTimestamp("2025-01-01T00:00:00.000000000Z")).toEqual(new Date("2025-01-01T00:00:00Z"));
  expect(() => normalizeBasic(validBasicRecords().replace("2024-12-31T23:59:30Z", "1"), new Date("2025-01-01T00:00:00Z"))).toThrow("last_sync_at is invalid");
  expect(() => normalizeBasic(validBasicRecords().replace("2025-02-01T00:00:00Z", "2025-02-30"), new Date("2025-01-01T00:00:00Z"))).toThrow("cert_not_after is invalid");
  const containerRecords = validBasicRecords()
    .replace("runtime_mode=host", "runtime_mode=container")
    .replace("container_identity=", "container_identity=" + "a".repeat(64))
    .replace("container_started_at=", "container_started_at=2025-01-01$(id)")
    .replace("host_xray_pid=123\n", "host_xray_pid=\n")
    .replace("host_xray_starttime=456\n", "host_xray_starttime=\n")
    .replace("container_xray_token=\n", "container_xray_token=123:456\n");
  expect(() => normalizeBasic(containerRecords, new Date("2025-01-01T00:00:00Z"))).toThrow("container_started_at is invalid");
});

test("preserves baseline YAML scalar spellings without reopening unsafe constructs", () => {
  expect(parseRestrictedYaml("schema_version: 01\n")).toEqual({ schema_version: 1 });
  expect(parseRestrictedYaml("schema_version: 0x1\n")).toEqual({ schema_version: 1 });
  expect(parseRestrictedYaml("schema_version: 010\n")).toEqual({ schema_version: 8 });
  expect(parseRestrictedYaml("schema_version: 08\n")).toEqual({ schema_version: "08" });
  expect(parseRestrictedYaml("owner_confirmed: yes\n")).toEqual({ owner_confirmed: true });
  expect(parseRestrictedYaml("owner_confirmed: ON\n")).toEqual({ owner_confirmed: true });
  expect(parseRestrictedYaml("owner_confirmed: off\n")).toEqual({ owner_confirmed: false });
  expect(parseRestrictedYaml("reason: 1.5\n")).toEqual({ reason: 1.5 });
  expect(parseRestrictedYaml("reason: fixture,\n")).toEqual({ reason: "fixture," });
  expect(parseRestrictedYaml("node_overrides:\n  fixture-node:\n    reason: fixture\n")).toEqual({
    node_overrides: { "fixture-node": { reason: "fixture" } },
  });
  expect(() => parseRestrictedYaml("node_overrides: &defaults {}\n")).toThrow("unsupported YAML construct");
  expect(() => parseRestrictedYaml("---\nschema_version: 1\n")).toThrow("unsupported YAML document");
});

test("preserves safe YAML quoted, flow-mapping, and block-scalar forms", () => {
  expect(parseRestrictedYaml("reason: \"fixture\\x2C\"\n")).toEqual({ reason: "fixture," });
  expect(parseRestrictedYaml("defaults: {cloudflare_tunnel: true, managed_default_ss2022: false}\n")).toEqual({
    defaults: { cloudflare_tunnel: true, managed_default_ss2022: false },
  });
  expect(parseRestrictedYaml("reason: |\n  approved exception\n")).toEqual({ reason: "approved exception\n" });
  expect(parseRestrictedYaml("reason: |\n approved exception\n")).toEqual({ reason: "approved exception\n" });
  expect(parseRestrictedYaml("reason: >\n  approved\n  exception\n")).toEqual({ reason: "approved exception\n" });
  expect(parseRestrictedYaml("reason: |-\n  approved\n")).toEqual({ reason: "approved" });
  expect(parseRestrictedYaml("reason: |\n  approved # remains data\n")).toEqual({ reason: "approved # remains data\n" });
  expect(() => parseRestrictedYaml("defaults: {cloudflare_tunnel: true, cloudflare_tunnel: false}\n")).toThrow("duplicate YAML key");
  expect(() => parseRestrictedYaml("defaults: [true, false]\n")).toThrow("unsupported YAML collection");
});

test("normalizes a valid observation without reading secrets", () => {
  const result = normalizeBasic(validBasicRecords(), new Date("2025-01-01T00:00:00Z"));
  expect(result.local_health).toBe("true");
  expect(result.cloudflare_tunnel).toBe("true");
  expect(result.managed_default_vless).toBe("true");
  expect(result.canary_local_target).toBe("https://fixture-node-ep.example.test:10443/generate_204");
  expect(result.vless_public_target).toBe("https://fixture-node-ep.example.test:443/generate_204");
  expect(result).not.toHaveProperty("admin_token");
});

test("requires managed VLESS ownership evidence instead of canary-only evidence", () => {
  const wrongTagApiB64 = encodedJson({
    inbounds: [{ tag: "vless-vision-other", receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 443 } }],
  });
  const wrongPortApiB64 = encodedJson({
    inbounds: [{ tag: "vless-vision-endpoint-1", receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 8443 } }],
  });
  expect(() => normalizeBasic(validBasicRecords().replace("xray_listener_pids=123", "xray_listener_pids=124"), new Date("2025-01-01T00:00:00Z"))).toThrow("verified Xray listener");
  expect(() => normalizeBasic(validBasicRecords().replace(`xray_api_b64=${VALID_XRAY_API_B64}`, "xray_api_b64="), new Date("2025-01-01T00:00:00Z"))).toThrow("readable Xray API inventory");
  expect(() => normalizeBasic(validBasicRecords().replace(VALID_XRAY_API_B64, wrongTagApiB64), new Date("2025-01-01T00:00:00Z"))).toThrow("absent from the Xray API inventory");
  expect(() => normalizeBasic(validBasicRecords().replace(VALID_XRAY_API_B64, wrongPortApiB64), new Date("2025-01-01T00:00:00Z"))).toThrow("not owned by its Xray inbound");
});

test("normalizes public health without accepting duplicate JSON members", () => {
  expect(normalizePublicHealth(JSON.stringify({ status: "ok", xray: { status: "up" } }))).toEqual({
    public_health: "true",
    public_health_json_ok: "true",
  });
  expect(normalizePublicHealth(JSON.stringify({ status: "degraded", xray: { status: "up" } }))).toEqual({
    public_health: "false",
    public_health_json_ok: "false",
  });
  expect(normalizePublicHealth(JSON.stringify({ status: "ok", xray: { status: "down" } }))).toEqual({
    public_health: "false",
    public_health_json_ok: "true",
  });
});

test("accepts exactly one expected compose image and ignores only blank lines", () => {
  expect(isExactComposeImage("\n  ghcr.io/example/xp:1.2.3  \n", "  ghcr.io/example/xp:1.2.3  ")).toBe(true);
  expect(isExactComposeImage("ghcr.io/example/xp:1.2.3\nghcr.io/example/xp:1.2.3\n", "ghcr.io/example/xp:1.2.3")).toBe(false);
  expect(isExactComposeImage("\n\t\n", "ghcr.io/example/xp:1.2.3")).toBe(false);
});

test("validates public targets against injected DNS evidence", async () => {
  const resolver = async (hostname: string) => {
    expect(hostname).toBe("api.example.test");
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const target = await validatePublicTarget("https://api.example.test/api/health", "/api/health", resolver);
  expect(target.resolve).toBe("api.example.test:443:93.184.216.34");
  await expect(validatePublicTarget("https://api.example.test/private", "/api/health", resolver)).rejects.toThrow("unsafe");
  await expect(validatePublicTarget("https://127.0.0.1/api/health", "/api/health", resolver)).rejects.toThrow("DNS hostname");
  await expect(validatePublicTarget("https://api.example.test/api/health", "/api/health", async () => [{ address: "192.0.2.10", family: 4 }])).rejects.toThrow("non-public");
  await expect(validatePublicTarget("https://api.example.test/api/health?redirect=1", "/api/health", resolver)).rejects.toThrow("unsafe");
  await expect(validatePublicTarget("https://:@api.example.test/api/health", "/api/health", resolver)).rejects.toThrow("unsafe");
  await expect(validatePublicTarget("https://a..example.com/api/health", "/api/health", resolver)).rejects.toThrow("unsafe");
});

test("validates every Cloudflare CIDR before matching", () => {
  expect(isCloudflareAddress("93.184.216.34", "93.184.216.0/24\nnot-a-cidr/garbage\n")).toBe(false);
  expect(isCloudflareAddress("93.184.216.34", "93.184.216.0/24\n93.184.217.0/24\n")).toBe(true);
  expect(isCloudflareAddress("2001:4860:4860:0:0:0:0:8888::", "2000::/3\n")).toBe(false);
  expect(isCloudflareAddress("2001:4860:4860::8888", "2000::/3\n")).toBe(true);
});

test("rejects non-boolean service and sync records", () => {
  expect(() => normalizeBasic(validBasicRecords().replace("xp_service=true", "xp_service=maybe"), new Date("2025-01-01T00:00:00Z"))).toThrow("xp_service is invalid");
  expect(() => normalizeBasic(validBasicRecords().replace("sync_node_meta=true", "sync_node_meta=maybe"), new Date("2025-01-01T00:00:00Z"))).toThrow("sync_node_meta is invalid");
});

test("interprets managed and bootstrap VLESS preflight records deterministically", () => {
  const unmanaged = records({
    state_b64: encodedJson({}),
    xray_ports: "",
    xray_listener_pids: "",
    xray_runtime_pid: "",
    xray_service: "inactive",
    xray_api_b64: "",
    occupied_ports: "443,8080",
    ephemeral_range: "40000 45000",
    reserved_ports: "8080-8082",
    unprivileged_port_start: "1024",
    xray_security: "1000 0",
  });
  const port = interpretPortPreflight(unmanaged, "fixture-node");
  expect(port).toBeGreaterThanOrEqual(1024);
  expect(port).not.toBe(443);
  expect(port).not.toBe(8080);

  const managed = records({
    state_b64: encodedJson({ schema_version: 1, vless_endpoint_id: "abc" }),
    xray_ports: "443",
    xray_listener_pids: "123",
    xray_runtime_pid: "123",
    xray_service: "active",
    xray_api_b64: encodedJson({ inbounds: [{ tag: "vless-vision-abc", receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 443 } }] }),
    occupied_ports: "",
    ephemeral_range: "40000 45000",
    reserved_ports: "",
    unprivileged_port_start: "1024",
    xray_security: "1000 0",
  });
  expect(interpretPortPreflight(managed, "fixture-node")).toBe(443);
  expect(() => interpretPortPreflight(managed.replace("xray_runtime_pid=123", "xray_runtime_pid=124"), "fixture-node")).toThrow("verified Xray listener");
});
