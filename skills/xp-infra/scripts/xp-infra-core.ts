import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new ValidationError(message);
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectKeys(value: JsonRecord): string[] {
  return Object.keys(value);
}

function expectRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) fail(`${name} must be a mapping`);
  return value;
}

function expectExactKeys(value: JsonRecord, name: string, allowed: readonly string[], required = allowed): void {
  const allowedSet = new Set(allowed);
  for (const key of objectKeys(value)) {
    if (!allowedSet.has(key)) fail(`unknown ${name} field: ${key}`);
  }
  for (const key of required) {
    if (!hasOwn(value, key)) fail(`${name}.${key} is missing`);
  }
}

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  if (quote !== null) fail("unterminated YAML scalar");
  return line;
}

function parseYamlScalar(rawValue: string, lineNumber: number): unknown {
  const value = rawValue.trim();
  if (!value) return Object.create(null) as JsonRecord;
  if (value === "{}") return Object.create(null) as JsonRecord;
  if (value === "[]") return [];
  if (value.startsWith("[") || value.startsWith("{") || value.endsWith(",")) {
    fail(`unsupported YAML collection at line ${lineNumber}`);
  }
  if (/^(?:---|\.\.\.)$/.test(value) || /^[&*!%@`]/.test(value)) {
    fail(`unsupported YAML construct at line ${lineNumber}`);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail(`YAML integer is out of range at line ${lineNumber}`);
    return number;
  }
  if (value === "null" || value === "~") return null;
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) fail(`invalid single-quoted YAML scalar at line ${lineNumber}`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) fail(`invalid double-quoted YAML scalar at line ${lineNumber}`);
    try {
      return JSON.parse(value) as string;
    } catch {
      fail(`invalid double-quoted YAML scalar at line ${lineNumber}`);
    }
  }
  if (value.includes("\n") || value.startsWith("|") || value.startsWith(">")) {
    fail(`unsupported YAML scalar at line ${lineNumber}`);
  }
  return value;
}

type YamlLine = { lineNumber: number; indent: number; content: string };

function parseYamlEntry(line: YamlLine): { key: string; value: string } {
  const separator = line.content.indexOf(":");
  if (separator <= 0) fail(`YAML line ${line.lineNumber} is not a mapping`);
  const key = line.content.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) fail(`invalid YAML mapping key at line ${line.lineNumber}`);
  return { key, value: line.content.slice(separator + 1) };
}

/**
 * Parse the deliberately small policy dialect. The policy has no sequences,
 * anchors, tags, aliases or multi-document stream, so accepting those would
 * silently widen the contract that the former safe YAML loader enforced.
 */
export function parseRestrictedYaml(text: string): unknown {
  if (text.length > 65536) fail("deployment policy is too large");
  const lines: YamlLine[] = [];
  for (const [index, rawLine] of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").entries()) {
    if (rawLine.includes("\0") || rawLine.includes("\t")) fail(`invalid YAML whitespace at line ${index + 1}`);
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    if (indent % 2 !== 0) fail(`YAML indentation must use pairs of spaces at line ${index + 1}`);
    const content = withoutComment.trim();
    if (content === "---" || content === "..." || content.startsWith("- ") || content === "-") {
      fail(`unsupported YAML document or sequence at line ${index + 1}`);
    }
    lines.push({ lineNumber: index + 1, indent, content });
  }
  if (lines.length === 0) return Object.create(null) as JsonRecord;
  if (lines[0]?.indent !== 0) fail("YAML root must start at indentation zero");

  const parseMap = (start: number, indent: number): { value: JsonRecord; next: number } => {
    const result = Object.create(null) as JsonRecord;
    let cursor = start;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!line) break;
      if (line.indent < indent) break;
      if (line.indent > indent) fail(`unexpected YAML indentation at line ${line.lineNumber}`);
      const entry = parseYamlEntry(line);
      if (hasOwn(result, entry.key)) fail(`duplicate YAML key ${entry.key}`);
      if (entry.value.trim() === "") {
        const nextLine = lines[cursor + 1];
        if (nextLine && nextLine.indent > indent) {
          const nested = parseMap(cursor + 1, nextLine.indent);
          result[entry.key] = nested.value;
          cursor = nested.next;
        } else {
          result[entry.key] = Object.create(null) as JsonRecord;
          cursor += 1;
        }
      } else {
        result[entry.key] = parseYamlScalar(entry.value, line.lineNumber);
        cursor += 1;
      }
    }
    return { value: result, next: cursor };
  };

  const parsed = parseMap(0, 0);
  if (parsed.next !== lines.length) fail(`invalid YAML near line ${lines[parsed.next]?.lineNumber ?? "unknown"}`);
  return parsed.value;
}

export function parseInventory(text: string): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawLine] of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").entries()) {
    const alias = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (!alias) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) fail(`invalid hosts inventory alias at line ${index + 1}`);
    if (seen.has(alias)) fail(`duplicate hosts inventory alias ${alias}`);
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases;
}

export type PolicyFlags = {
  cloudflare_tunnel: boolean;
  cloudflare_ddns: boolean;
  ip_geo_enrichment: boolean;
  managed_default_vless: boolean;
  managed_default_ss2022: boolean;
  direct_docker: boolean;
};

export type PolicyDefinition = {
  flags: PolicyFlags;
  publicHostnameZone: string;
  overrides: Record<string, Partial<PolicyFlags>>;
};

const POLICY_ROOT_KEYS = ["schema_version", "owner_confirmed", "geo", "public_hostname", "defaults", "node_overrides"] as const;
const DEFAULT_KEYS = [
  "cloudflare_tunnel",
  "cloudflare_ddns",
  "ip_geo_enrichment",
  "managed_default_vless",
  "managed_default_ss2022",
  "direct_docker",
  "vless_port",
] as const;
const OVERRIDE_KEYS = ["owner_approved", "reason", "defaults"] as const;

function expectBoolean(value: unknown, name: string): boolean {
  if (value !== true && value !== false) fail(`${name} must be boolean`);
  return value;
}

function expectDnsName(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)) fail(`${name} must be a valid DNS name`);
  return value;
}

export function validatePolicyDocument(document: unknown, inventory: readonly string[]): PolicyDefinition {
  const root = expectRecord(document, "policy root");
  expectExactKeys(root, "policy root", POLICY_ROOT_KEYS);
  if (root.schema_version !== 1) fail("schema_version must be 1");
  if (root.owner_confirmed !== true) fail("owner_confirmed must be true");

  const geo = expectRecord(root.geo, "geo");
  expectExactKeys(geo, "geo", ["enabled", "origin", "owner_authorized_third_party_lookup"]);
  if (geo.enabled !== true) fail("geo.enabled must be true");
  if (geo.origin !== "https://api.country.is") fail("geo.origin must be https://api.country.is");
  if (geo.owner_authorized_third_party_lookup !== true) fail("geo owner authorization must be true");

  const publicHostname = expectRecord(root.public_hostname, "public_hostname");
  expectExactKeys(publicHostname, "public_hostname", ["zone"]);
  const publicHostnameZone = expectDnsName(publicHostname.zone, "public_hostname.zone");

  const defaults = expectRecord(root.defaults, "defaults");
  expectExactKeys(defaults, "defaults", DEFAULT_KEYS);
  if (defaults.vless_port !== "automatic_preflight") fail("defaults.vless_port must be automatic_preflight");
  const flags: PolicyFlags = {
    cloudflare_tunnel: expectBoolean(defaults.cloudflare_tunnel, "defaults.cloudflare_tunnel"),
    cloudflare_ddns: expectBoolean(defaults.cloudflare_ddns, "defaults.cloudflare_ddns"),
    ip_geo_enrichment: expectBoolean(defaults.ip_geo_enrichment, "defaults.ip_geo_enrichment"),
    managed_default_vless: expectBoolean(defaults.managed_default_vless, "defaults.managed_default_vless"),
    managed_default_ss2022: expectBoolean(defaults.managed_default_ss2022, "defaults.managed_default_ss2022"),
    direct_docker: expectBoolean(defaults.direct_docker, "defaults.direct_docker"),
  };
  if (flags.cloudflare_tunnel !== true) fail("defaults.cloudflare_tunnel must be true");
  if (flags.cloudflare_ddns !== true) fail("defaults.cloudflare_ddns must be true");
  if (flags.ip_geo_enrichment !== true) fail("defaults.ip_geo_enrichment must be true");
  if (flags.managed_default_vless !== true) fail("defaults.managed_default_vless must be true");
  if (flags.managed_default_ss2022 !== false) fail("defaults.managed_default_ss2022 must be false");
  if (flags.direct_docker !== false) fail("defaults.direct_docker must be false");

  const overrideRoot = expectRecord(root.node_overrides, "node_overrides");
  const overrides: Record<string, Partial<PolicyFlags>> = Object.create(null) as Record<string, Partial<PolicyFlags>>;
  const allowedOverrideFields = new Set<keyof PolicyFlags>([
    "cloudflare_tunnel",
    "cloudflare_ddns",
    "ip_geo_enrichment",
    "managed_default_vless",
    "managed_default_ss2022",
    "direct_docker",
  ]);
  for (const [name, rawOverride] of Object.entries(overrideRoot)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("invalid node override name");
    if (!inventory.includes(name)) fail(`override ${name} is not registered in hosts inventory`);
    const override = expectRecord(rawOverride, `override ${name}`);
    expectExactKeys(override, `override ${name}`, OVERRIDE_KEYS, ["owner_approved", "reason"]);
    if (override.owner_approved !== true) fail(`override ${name} is not owner-approved`);
    if (typeof override.reason !== "string" || !override.reason.trim()) fail(`override ${name} requires a reason`);
    const rawDefaults = hasOwn(override, "defaults") ? expectRecord(override.defaults, `override ${name}.defaults`) : {};
    const values: Partial<PolicyFlags> = {};
    for (const [key, value] of Object.entries(rawDefaults)) {
      if (!allowedOverrideFields.has(key as keyof PolicyFlags)) fail(`override ${name} has unknown defaults: ${key}`);
      values[key as keyof PolicyFlags] = expectBoolean(value, `override ${name}.${key}`);
    }
    const privateDocker = values.cloudflare_tunnel === false && values.managed_default_vless === false;
    if (privateDocker && values.direct_docker !== true) {
      fail(`override ${name} disables public endpoints without direct_docker`);
    }
    overrides[name] = values;
  }
  return { flags, publicHostnameZone, overrides };
}

export function effectivePolicy(policy: PolicyDefinition, host: string, inventory: readonly string[]): PolicyFlags & { public_hostname_zone: string } {
  if (!inventory.includes(host)) fail(`host is not registered in hosts inventory: ${host}`);
  const override = policy.overrides[host] ?? {};
  return {
    ...policy.flags,
    ...override,
    public_hostname_zone: policy.publicHostnameZone,
  };
}

class StrictJsonParser {
  private readonly text: string;
  private readonly name: string;
  private index = 0;

  constructor(text: string, name: string) {
    this.text = text;
    this.name = name;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.invalid();
    return value;
  }

  private invalid(): never {
    fail(`invalid ${this.name}`);
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private parseValue(): unknown {
    const character = this.text[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "t" && this.take("true")) return true;
    if (character === "f" && this.take("false")) return false;
    if (character === "n" && this.take("null")) return null;
    if (character === "-" || /[0-9]/.test(character ?? "")) return this.parseNumber();
    return this.invalid();
  }

  private take(value: string): boolean {
    if (this.text.slice(this.index, this.index + value.length) !== value) return false;
    this.index += value.length;
    return true;
  }

  private parseObject(): JsonRecord {
    this.index += 1;
    const object = Object.create(null) as JsonRecord;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return object;
    }
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') return this.invalid();
      const key = this.parseString();
      if (typeof key !== "string" || hasOwn(object, key)) fail(`duplicate ${this.name} member ${String(key)}`);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") return this.invalid();
      this.index += 1;
      this.skipWhitespace();
      object[key] = this.parseValue();
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return object;
      }
      if (this.text[this.index] !== ",") return this.invalid();
      this.index += 1;
    }
    return this.invalid();
  }

  private parseArray(): unknown[] {
    this.index += 1;
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return array;
    }
    while (this.index < this.text.length) {
      this.skipWhitespace();
      array.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return array;
      }
      if (this.text[this.index] !== ",") return this.invalid();
      this.index += 1;
    }
    return this.invalid();
  }

  private parseString(): string {
    if (this.text[this.index] !== '"') return this.invalid();
    this.index += 1;
    let result = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') return result;
      if (character === "\\") {
        const escape = this.text[this.index++];
        switch (escape) {
          case '"': result += '"'; break;
          case "\\": result += "\\"; break;
          case "/": result += "/"; break;
          case "b": result += "\b"; break;
          case "f": result += "\f"; break;
          case "n": result += "\n"; break;
          case "r": result += "\r"; break;
          case "t": result += "\t"; break;
          case "u": {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return this.invalid();
            result += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default: return this.invalid();
        }
      } else {
        if (character < " ") return this.invalid();
        result += character;
      }
    }
    return this.invalid();
  }

  private parseNumber(): number {
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) return this.invalid();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return this.invalid();
    return value;
  }
}

export function parseStrictJson(text: string, name: string): unknown {
  if (text.length > 65536) fail(`${name} is too large`);
  return new StrictJsonParser(text, name).parse();
}

function parseJsonObject(value: string, name: string, required = false): JsonRecord | undefined {
  if (!value) {
    if (required) fail(`missing ${name}`);
    return undefined;
  }
  return expectRecord(parseStrictJson(value, name), `${name} is not an object`);
}

function nestedObject(object: JsonRecord, key: string, name: string): JsonRecord {
  if (!hasOwn(object, key) || object[key] === undefined) return Object.create(null) as JsonRecord;
  return expectRecord(object[key], name);
}

function explicitBoolean(value: string, name: string, defaultValue?: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized && defaultValue !== undefined) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  fail(`${name} is invalid`);
}

function boundedInterval(value: string, defaultValue: number): number {
  const parsed = /^-?[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return defaultValue;
  return Math.min(parsed, 3600);
}

export function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

export function auditNow(testEpoch?: string): Date {
  const value = testEpoch ?? process.env.XP_INFRA_TEST_NOW_EPOCH ?? process.env.TEST_NOW_EPOCH;
  if (value && /^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return new Date(seconds * 1000);
  }
  return new Date();
}

function apiBaseHost(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("api_base must be an HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    fail("api_base must be an HTTPS origin");
  }
  const host = parsed.hostname;
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  const authorityHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0] ?? "";
  if (!host || authorityHost !== authorityHost.toLowerCase() || host !== host.toLowerCase()) fail("api_base host must be lowercase");
  return host;
}

function validHost(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) && value.includes(".");
}

function validNodeName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(value);
}

function tunnelDeclaration(records: JsonRecord, apiHost: string): string {
  const cloudflareEnabled = explicitBoolean(String(records.cloudflare_enabled ?? ""), "cloudflare_enabled");
  const settings = parseJsonObject(String(records.cloudflare_settings_json ?? ""), "cloudflare_settings_json");
  if (settings) {
    const enabled = settings.enabled === true;
    const hostname = typeof settings.hostname === "string" ? settings.hostname : "";
    if (enabled && validHost(hostname) && hostname === apiHost) return "aligned";
    if (!enabled && !hostname) return "missing";
    return "mismatch";
  }
  const hostname = String(records.cloudflare_hostname ?? "");
  if (cloudflareEnabled && validHost(hostname) && hostname === apiHost) return "aligned";
  if (!cloudflareEnabled && !hostname) return "missing";
  return "mismatch";
}

function managedDefaults(records: JsonRecord): [boolean, boolean] {
  const state = parseJsonObject(String(records.managed_default_state_json ?? ""), "managed_default_state_json");
  if (!state) return [false, false];
  if (state.schema_version !== 1) fail("managed_default_state_json schema_version is unsupported");
  const vless = state.vless_endpoint_id;
  const ss = state.ss_endpoint_id;
  if (vless !== null && vless !== undefined && !(typeof vless === "string" && vless.length > 0)) fail("managed_default_state_json.vless_endpoint_id is invalid");
  if (ss !== null && ss !== undefined && !(typeof ss === "string" && ss.length > 0)) fail("managed_default_state_json.ss_endpoint_id is invalid");
  return [vless !== null && vless !== undefined, ss !== null && ss !== undefined];
}

function publicXrayPorts(value: string): number[] {
  if (!value) return [];
  const ports = value.split(",").map((entry) => {
    if (!/^[1-9][0-9]*$/.test(entry)) fail("xray_public_ports is invalid");
    const port = Number(entry);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("xray_public_ports is invalid");
    return port;
  });
  if (new Set(ports).size !== ports.length) fail("xray_public_ports contains duplicates");
  return ports;
}

function loopbackBindPort(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]*)$/);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port <= 65535 ? port : undefined;
}

const BASIC_REQUIRED_FIELDS = [
  "xp_service", "xray_service", "cloudflared_service", "runtime_mode",
  "container_identity", "container_started_at", "container_xray_token", "host_xray_pid", "host_xray_starttime",
  "ddns_enabled", "ddns_monitor_mode", "ddns_restart_mode", "ddns_fast_interval",
  "ddns_monitored_interval", "ddns_unmonitored_interval", "ddns_state_json",
  "geo_enabled", "geo_origin", "geo_response_json", "health_json", "cluster_json",
  "node_name", "api_base", "access_host", "cloudflare_enabled", "cloudflare_hostname",
  "cloudflare_settings_json", "managed_default_state_json", "sync_node_meta", "xray_public_ports",
] as const;

const BASIC_ALLOWED_FIELDS = new Set<string>([...BASIC_REQUIRED_FIELDS, "vless_ingress"]);

export function parseKeyValueRecords(text: string, name = "record stream", allowed?: ReadonlySet<string>): JsonRecord {
  const records = Object.create(null) as JsonRecord;
  for (const rawLine of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (!rawLine) continue;
    const separator = rawLine.indexOf("=");
    if (separator <= 0) fail(`invalid ${name} record`);
    const key = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) fail(`invalid ${name} record key`);
    if (hasOwn(records, key)) fail(`duplicate ${name} record ${key}`);
    if (allowed && !allowed.has(key)) fail(`unsupported ${name} record ${key}`);
    records[key] = value;
  }
  return records;
}

function requireRecordFields(records: JsonRecord, fields: readonly string[], name: string): void {
  for (const field of fields) if (!hasOwn(records, field)) fail(`missing ${name} record ${field}`);
}

export type BasicAudit = Record<string, string>;

export function normalizeBasic(text: string, now = auditNow()): BasicAudit {
  const records = parseKeyValueRecords(text, "audit response", BASIC_ALLOWED_FIELDS);
  requireRecordFields(records, BASIC_REQUIRED_FIELDS, "audit response");
  const health = parseJsonObject(String(records.health_json), "health_json", true) as JsonRecord;
  const cluster = parseJsonObject(String(records.cluster_json), "cluster_json", true) as JsonRecord;

  const ddnsEnabled = explicitBoolean(String(records.ddns_enabled), "ddns_enabled");
  const ddnsState = parseJsonObject(String(records.ddns_state_json), "ddns_state_json", ddnsEnabled) ?? Object.create(null) as JsonRecord;
  let snapshot = ddnsState.snapshot;
  if (ddnsEnabled) {
    if (!isRecord(snapshot)) fail("ddns_state_json.snapshot is not an object");
  } else if (!isRecord(snapshot)) {
    snapshot = Object.create(null) as JsonRecord;
  }
  const snapshotRecord = snapshot as JsonRecord;
  const fastUntil = parseTimestamp(snapshotRecord.fast_mode_until);
  const monitorMode = String(records.ddns_monitor_mode) || String(records.ddns_restart_mode);
  const interval = fastUntil && fastUntil.getTime() > now.getTime()
    ? boundedInterval(String(records.ddns_fast_interval), 30)
    : monitorMode && monitorMode !== "none"
      ? boundedInterval(String(records.ddns_monitored_interval), 300)
      : boundedInterval(String(records.ddns_unmonitored_interval), 60);
  const lastSync = parseTimestamp(snapshotRecord.last_sync_at);
  const age = lastSync ? (now.getTime() - lastSync.getTime()) / 1000 : Number.POSITIVE_INFINITY;
  const ddnsOk = ddnsEnabled && Boolean(lastSync) && lastSync!.getTime() <= now.getTime() && age <= interval * 2 + 60 && snapshotRecord.status === "up" && !String(snapshotRecord.last_error ?? "");

  const geoEnabled = explicitBoolean(String(records.geo_enabled), "geo_enabled", false);
  const geoOrigin = String(records.geo_origin) || "https://api.country.is";
  const geoResponse = parseJsonObject(String(records.geo_response_json), "geo_response_json", geoEnabled) ?? Object.create(null) as JsonRecord;
  const country = geoResponse.country;
  if (geoEnabled && !(typeof country === "string" && country.length > 0)) fail("geo_response_json.country is invalid");
  const geoOk = geoEnabled && geoOrigin === "https://api.country.is" && typeof country === "string" && country.length > 0;

  const apiBase = String(records.api_base);
  const apiHost = apiBaseHost(apiBase);
  const accessHost = String(records.access_host);
  if (!validHost(accessHost)) fail("access_host is invalid");
  if (accessHost !== accessHost.toLowerCase()) fail("access_host must be lowercase");
  const nodeName = String(records.node_name);
  const declaration = tunnelDeclaration(records, apiHost);
  const [vlessManaged, ssManaged] = managedDefaults(records);
  const publicPorts = publicXrayPorts(String(records.xray_public_ports));
  const runtimeMode = String(records.runtime_mode);
  if (runtimeMode !== "host" && runtimeMode !== "container") fail("runtime_mode is invalid");
  const containerIdentity = String(records.container_identity);
  const containerStartedAt = String(records.container_started_at);
  const containerXrayToken = String(records.container_xray_token);
  if (runtimeMode === "container") {
    if (!/^[0-9a-f]{64}$/.test(containerIdentity)) fail("container_identity is invalid");
    if (!parseTimestamp(containerStartedAt)) fail("container_started_at is invalid");
    if (String(records.host_xray_pid) || String(records.host_xray_starttime)) fail("container runtime has host Xray identity");
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(containerXrayToken)) fail("container_xray_token is invalid");
  } else {
    if (containerIdentity || containerStartedAt || containerXrayToken) fail("host runtime has container identity");
    if (!/^[1-9][0-9]*$/.test(String(records.host_xray_pid))) fail("host_xray_pid is invalid");
    if (!/^[1-9][0-9]*$/.test(String(records.host_xray_starttime))) fail("host_xray_starttime is invalid");
  }

  const xray = nestedObject(health, "xray", "health_json.xray");
  const cloudflared = nestedObject(health, "cloudflared", "health_json.cloudflared");
  const canary = nestedObject(health, "vless_https_canary", "health_json.vless_https_canary");
  const certificateExpiry = parseTimestamp(canary.cert_not_after);
  const certificateOk = canary.enabled === true && canary.last_error == null && Boolean(certificateExpiry && certificateExpiry.getTime() > now.getTime());
  const canaryPort = loopbackBindPort(canary.bind);
  const result: BasicAudit = Object.create(null) as BasicAudit;
  for (const key of ["xp_service", "xray_service", "cloudflared_service"]) result[key] = String(records[key]) === "true" ? "true" : "false";
  result.cloudflare_ddns_enabled = String(ddnsEnabled);
  result.cloudflare_ddns = String(ddnsOk);
  result.ip_geo_enrichment = String(geoOk);
  result.local_health = health.status === "ok" ? "true" : "false";
  result.xray_runtime = xray.status === "up" ? "true" : "false";
  result.cloudflare_tunnel = cloudflared.status === "up" ? "true" : "false";
  result.canary_enabled = canary.enabled === true ? "true" : "false";
  result.canary_certificate = certificateOk ? "true" : "false";
  result.cluster_role = String(cluster.role ?? "") || "missing";
  result.runtime_mode = runtimeMode;
  result.container_identity = containerIdentity;
  result.container_started_at = containerStartedAt;
  result["container_" + "xray_" + "token"] = containerXrayToken;
  result.host_xray_pid = String(records.host_xray_pid);
  result.host_xray_starttime = String(records.host_xray_starttime);
  result.node_name = nodeName;
  result.node_name_valid = validNodeName(nodeName) ? "true" : "false";
  result.api_host = apiHost;
  result.access_host = accessHost;
  result.cluster_sync = String(records.sync_node_meta) === "true" ? "true" : "false";
  result.tunnel_declaration = declaration;
  result.managed_default_vless = vlessManaged ? "true" : "false";
  result.managed_default_ss2022 = ssManaged ? "true" : "false";
  result.xray_public_listener = publicPorts.length === 1 ? "true" : "false";
  result.public_health_target = `${apiBase.replace(/\/$/, "")}/api/health`;
  if (canaryPort !== undefined) result.canary_local_target = `https://${accessHost}:${canaryPort}/generate_204`;
  if (vlessManaged && publicPorts.length === 1) result.vless_public_target = `https://${accessHost}:${publicPorts[0]}/generate_204`;
  return result;
}

export function normalizePublicHealth(text: string): Record<string, string> {
  const health = expectRecord(parseStrictJson(text, "public health json"), "public health is not an object");
  const xray = nestedObject(health, "xray", "public health.xray");
  return {
    public_health: health.status === "ok" && xray.status === "up" ? "true" : "false",
    public_health_json_ok: health.status === "ok" ? "true" : "false",
  };
}

export function emitRecords(records: Record<string, string>): string {
  return Object.entries(records).map(([key, value]) => `${key}=${value}`).join("\n");
}

export function isExactComposeImage(text: string, expectedImage: string): boolean {
  const images = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter((line) => !/^\s*$/.test(line));
  return images.length === 1 && images[0] === expectedImage;
}

export function decodeBase64Strict(value: string, name: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(`${name} is invalid`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(`${name} is invalid`);
  return new Uint8Array(bytes);
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail(`${name} is invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${name} is invalid`);
  return number;
}

function parsePortList(records: JsonRecord, key: string): number[] {
  const value = String(records[key] ?? "");
  if (!value) return [];
  const ports = value.split(",").map((entry) => parseInteger(entry, key, 1, 65535));
  if (new Set(ports).size !== ports.length) fail(`${key} contains duplicates`);
  return ports;
}

function parsePidList(records: JsonRecord, key: string): number[] {
  const value = String(records[key] ?? "");
  if (!value) return [];
  const pids = value.split(",").map((entry) => parseInteger(entry, key, 1, Number.MAX_SAFE_INTEGER));
  if (new Set(pids).size !== pids.length) fail(`${key} contains duplicates`);
  return pids;
}

type ProtoField = { field: number; wire: number; value: bigint | Uint8Array };

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;
  while (cursor < bytes.length && shift <= 63n) {
    const byte = bytes[cursor++] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
  fail("invalid Xray API protobuf");
}

function readProtoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const key = readVarint(bytes, cursor);
    cursor = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!field || (wire !== 0 && wire !== 2)) fail("unsupported Xray API protobuf wire type");
    if (wire === 0) {
      const value = readVarint(bytes, cursor);
      cursor = value.next;
      fields.push({ field, wire, value: value.value });
    } else {
      const lengthValue = readVarint(bytes, cursor);
      cursor = lengthValue.next;
      if (lengthValue.value > BigInt(bytes.length - cursor)) fail("invalid Xray API protobuf");
      const length = Number(lengthValue.value);
      fields.push({ field, wire, value: bytes.slice(cursor, cursor + length) });
      cursor += length;
    }
  }
  return fields;
}

function protoPort(inbound: JsonRecord): number {
  const typed = inbound.receiverSettings ?? inbound.receiver_settings;
  if (!isRecord(typed)) fail("managed VLESS endpoint has invalid Xray receiver settings");
  const typedName = typed.type ?? typed._TypedMessage_;
  if (typedName !== "xray.app.proxyman.ReceiverConfig") fail("managed VLESS endpoint has invalid Xray receiver settings");
  if (hasOwn(typed, "portList")) {
    if (typeof typed.portList !== "number" || !Number.isInteger(typed.portList) || typed.portList < 1 || typed.portList > 65535) fail("managed VLESS endpoint has invalid Xray receiver settings");
    return typed.portList;
  }
  if (typeof typed.value !== "string" || !typed.value) fail("managed VLESS endpoint has invalid Xray receiver settings");
  const receiverFields = readProtoFields(decodeBase64Strict(typed.value, "Xray receiver settings"));
  const portLists = receiverFields.filter((field) => field.field === 1 && field.wire === 2).map((field) => field.value).filter((value): value is Uint8Array => value instanceof Uint8Array);
  if (portLists.length !== 1) fail("managed VLESS endpoint has invalid Xray receiver settings");
  const rangeFields = readProtoFields(portLists[0]).filter((field) => field.field === 1 && field.wire === 2).map((field) => field.value).filter((value): value is Uint8Array => value instanceof Uint8Array);
  if (rangeFields.length === 0) fail("managed VLESS endpoint has invalid Xray receiver settings");
  const ports = rangeFields.map((range) => {
    const fields = readProtoFields(range);
    const from = fields.filter((field) => field.field === 1 && field.wire === 0).map((field) => field.value).filter((value): value is bigint => typeof value === "bigint");
    const to = fields.filter((field) => field.field === 2 && field.wire === 0).map((field) => field.value).filter((value): value is bigint => typeof value === "bigint");
    if (from.length !== 1 || to.length !== 1 || from[0] !== to[0] || from[0] < 1n || from[0] > 65535n) fail("managed VLESS endpoint has invalid Xray receiver settings");
    return Number(from[0]);
  });
  if (ports.length !== 1) fail("managed VLESS endpoint has invalid Xray receiver settings");
  return ports[0]!;
}

function parseReservedPorts(value: string): Array<[number, number]> {
  if (!value) return [];
  return value.split(",").map((entry) => {
    const parts = entry.split("-");
    if (parts.length > 2 || parts.some((part) => !part)) fail("invalid kernel reserved port range");
    const first = parseInteger(parts[0]!, "kernel reserved port range", 1, 65535);
    const last = parseInteger(parts[1] ?? parts[0]!, "kernel reserved port range", first, 65535);
    return [first, last];
  });
}

export function interpretPortPreflight(text: string, host: string): number {
  const records = parseKeyValueRecords(text, "preflight collector");
  const required = ["state_b64", "xray_ports", "xray_listener_pids", "xray_runtime_pid", "xray_service", "xray_api_b64", "occupied_ports", "ephemeral_range", "reserved_ports", "unprivileged_port_start", "xray_security"];
  requireRecordFields(records, required, "preflight collector");
  const stateValue = parseStrictJson(new TextDecoder().decode(decodeBase64Strict(String(records.state_b64), "state_b64")), "managed endpoint state");
  const state = expectRecord(stateValue, "managed endpoint state");
  let managed = false;
  let endpointId: string | undefined;
  if (Object.keys(state).length > 0) {
    if (state.schema_version !== 1 || !hasOwn(state, "vless_endpoint_id")) fail("unsupported managed endpoint state schema");
    const rawEndpoint = state.vless_endpoint_id;
    if (rawEndpoint !== null && !(typeof rawEndpoint === "string" && rawEndpoint.length > 0)) fail("invalid managed VLESS endpoint identity");
    managed = rawEndpoint !== null && rawEndpoint !== undefined;
    endpointId = managed ? String(rawEndpoint) : undefined;
  }
  const xrayPorts = parsePortList(records, "xray_ports");
  const listenerPids = parsePidList(records, "xray_listener_pids");
  const runtimePid = String(records.xray_runtime_pid);
  if (runtimePid && !/^[1-9][0-9]*$/.test(runtimePid)) fail("invalid Xray runtime PID");
  if (managed) {
    if (xrayPorts.length !== 1) fail("managed VLESS endpoint requires exactly one active public Xray listener");
    if (listenerPids.length !== 1 || runtimePid !== String(listenerPids[0])) fail("managed VLESS endpoint requires one verified Xray listener process");
    if (records.xray_service !== "active") fail("managed VLESS endpoint requires the target Xray service");
    if (!records.xray_api_b64) fail("managed VLESS endpoint requires a readable Xray API inventory");
    const api = parseStrictJson(new TextDecoder().decode(decodeBase64Strict(String(records.xray_api_b64), "Xray API inventory")), "Xray API inventory");
    const inbounds = Array.isArray(api) ? api : isRecord(api) && Array.isArray(api.inbounds) ? api.inbounds : undefined;
    if (!inbounds) fail("managed VLESS endpoint has invalid Xray API inventory");
    const tag = `vless-vision-${endpointId}`;
    const matches = inbounds.filter((item): item is JsonRecord => isRecord(item) && item.tag === tag);
    if (matches.length !== 1) fail("managed VLESS endpoint is absent from the Xray API inventory");
    const port = protoPort(matches[0]!);
    if (port !== xrayPorts[0]) fail("managed VLESS endpoint listener is not owned by its Xray inbound");
    return port;
  }
  if (xrayPorts.length !== 0) fail("public Xray listener exists without managed VLESS endpoint state");
  const occupied = new Set(parsePortList(records, "occupied_ports"));
  const ephemeral = String(records.ephemeral_range).split(/\s+/).filter(Boolean);
  if (ephemeral.length !== 2) fail("invalid kernel ephemeral port range");
  const ephemeralStart = parseInteger(ephemeral[0]!, "kernel ephemeral port range", 1, 65535);
  const ephemeralEnd = parseInteger(ephemeral[1]!, "kernel ephemeral port range", ephemeralStart, 65535);
  for (let port = ephemeralStart; port <= ephemeralEnd; port += 1) occupied.add(port);
  for (const [first, last] of parseReservedPorts(String(records.reserved_ports))) {
    for (let port = first; port <= last; port += 1) occupied.add(port);
  }
  const unprivilegedStart = parseInteger(String(records.unprivileged_port_start), "unprivileged port start", 0, 65535);
  const security = String(records.xray_security);
  let canBindPrivileged = false;
  if (security !== "unavailable") {
    const parts = security.split(/\s+/);
    if (parts.length !== 2 || !/^(?:0|[1-9][0-9]*)$/.test(parts[0]!) || !/^[0-9a-fA-F]+$/.test(parts[1]!)) fail("invalid Xray security record");
    canBindPrivileged = (BigInt(`0x${parts[1]}`) & (1n << 10n)) !== 0n;
  }
  const candidateStart = canBindPrivileged ? 1 : Math.max(unprivilegedStart, 1);
  const candidates: number[] = [];
  for (let port = candidateStart; port <= 65535; port += 1) if (!occupied.has(port)) candidates.push(port);
  if (!candidates.length) fail("no bindable VLESS bootstrap port");
  const offset = Number.parseInt(createHash("sha256").update(host).digest("hex").slice(0, 8), 16) % candidates.length;
  return candidates[offset]!;
}

type IpAddress = { family: 4 | 6; value: bigint; text: string };

function parseIp(value: string): IpAddress {
  const text = value.trim();
  const ipv4Parts = text.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^[0-9]+$/.test(part))) {
    const octets = ipv4Parts.map((part) => Number(part));
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      return { family: 4, value: (BigInt(octets[0]!) << 24n) | (BigInt(octets[1]!) << 16n) | (BigInt(octets[2]!) << 8n) | BigInt(octets[3]!), text };
    }
  }
  if (!text.includes(":") || text.includes("%")) fail(`invalid DNS address ${value}`);
  const pieces = text.toLowerCase().split("::");
  if (pieces.length > 2) fail(`invalid IPv6 address ${value}`);
  const expand = (part: string): string[] => {
    if (!part) return [];
    const result: string[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const parsed = parseIp(piece);
        if (parsed.family !== 4) fail(`invalid IPv6 address ${value}`);
        result.push(((Number(parsed.value >> 16n)).toString(16)), (Number(parsed.value & 0xffffn)).toString(16));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) fail(`invalid IPv6 address ${value}`);
        result.push(piece);
      }
    }
    return result;
  };
  const left = expand(pieces[0] ?? "");
  const right = expand(pieces[1] ?? "");
  const groups = pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8) fail(`invalid IPv6 address ${value}`);
  let number = 0n;
  for (const group of groups) number = (number << 16n) | BigInt(Number.parseInt(group, 16));
  return { family: 6, value: number, text };
}

function isLiteralIp(value: string): boolean {
  try {
    parseIp(value);
    return true;
  } catch {
    return false;
  }
}
function cidrContains(address: IpAddress, cidr: string): boolean {
  const separator = cidr.indexOf("/");
  const network = parseIp(cidr.slice(0, separator));
  const prefix = Number(cidr.slice(separator + 1));
  const bits = address.family === 4 ? 32n : 128n;
  if (network.family !== address.family || !Number.isInteger(prefix) || prefix < 0 || BigInt(prefix) > bits) return false;
  const mask = prefix === 0 ? 0n : ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(prefix))) - 1n);
  return (address.value & mask) === (network.value & mask);
}

const DENIED_NETWORKS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "192.88.99.0/24",
  "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20",
] as const;
const GLOBAL_IPV6 = "2000::/3";
const REACHABLE_EXCEPTIONS = [
  "192.0.0.9/32", "192.0.0.10/32", "64:ff9b::/96", "2001:1::1/128", "2001:1::2/128",
  "2001:1::3/128", "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28",
] as const;

function publicAddress(address: IpAddress): boolean {
  if (REACHABLE_EXCEPTIONS.some((network) => cidrContains(address, network))) return true;
  if (DENIED_NETWORKS.some((network) => cidrContains(address, network))) return false;
  return address.family === 4 || cidrContains(address, GLOBAL_IPV6);
}

export type ValidatedPublicTarget = { target: string; resolve: string; address: string; port: number };
export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

export async function validatePublicTarget(target: string, expectedPath: string, resolver: AddressResolver): Promise<ValidatedPublicTarget> {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    fail("public target is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== expectedPath || !parsed.hostname.includes(".")) fail("public target is unsafe");
  const host = parsed.hostname.toLowerCase();
  if (isLiteralIp(host)) fail("public target must use a DNS hostname");
  const addresses = await resolver(host);
  if (!addresses.length) fail("public target has no DNS evidence");
  const parsedAddresses = addresses.map((item) => parseIp(item.address));
  if (parsedAddresses.some((address) => !publicAddress(address))) fail("public target resolves to a non-public address");
  const first = parsedAddresses[0]!;
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("public target port is invalid");
  const addressForResolve = first.family === 6 ? `[${first.text}]` : first.text;
  return { target, resolve: `${host}:${port}:${addressForResolve}`, address: first.text, port };
}

export function isCloudflareAddress(address: string, rangesText: string): boolean {
  try {
    const parsed = parseIp(address);
    const ranges = rangesText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!ranges.length) return false;
    return ranges.every((range) => range.includes("/")) && ranges.some((range) => cidrContains(parsed, range));
  } catch {
    return false;
  }
}
