#!/usr/bin/env bun
/**
 * One-shot control plane for native Incus agent VMs.
 *
 * The process handles one JSON request from stdin and emits one JSON response.
 * It intentionally has no listener, worker thread, or background loop.
 */

import { Database } from "bun:sqlite";
import { dlopen } from "bun:ffi";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, ftruncateSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statfsSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = 4;
export const MEMORY_SETTLE_SECONDS = 45;
export const GUEST_READINESS_BUDGET_SECONDS = 300;
export const GUEST_READINESS_DIAGNOSTIC_SECONDS = 120;
export const DIAGNOSTIC_COMMAND_TIMEOUT_SECONDS = 5;
export const DIAGNOSTIC_LOG_LIMIT = 8192;
export const DIAGNOSTIC_LOG_TRUNCATION_MARKER = "\n[TRUNCATED BY DIAGNOSTIC LIMIT]";
export const DIAGNOSTIC_MESSAGE_LIMIT = 4096;
export const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const RAW_DIAGNOSTIC_CAPTURE_LIMIT = 1024 * 1024;
export const DEFAULT_CONFIG_PATH = "/etc/agent-vm-native/config.json";
export const DEFAULT_TIMER_DIR = "/etc/systemd/system";
export const REQUIRED_ENVIRONMENT_FIELDS = [
  "project", "profile", "image_alias", "image_fingerprint", "network", "network_acl", "pool",
  "host_address", "port_start", "port_end", "vm_ip_start", "vm_ip_end", "gateway_ip", "storage_path",
  "state_db", "timer_dir",
] as const;
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const SESSION_ID_RE = /^[A-Za-z0-9_.:@/-]{1,160}$/;
export const PORT_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const TASK_TIMER_RE = /^[a-z0-9][a-z0-9-]{0,47}-g[0-9]+$/;

type Dict = Record<string, any>;
type IntegerValue = number | bigint;
const JSON_FLOAT = Symbol("json-float");
type JsonFloat = { readonly value: number; readonly raw: string; readonly [JSON_FLOAT]: true };
type NativeBarrierWaiter = { exclusive: boolean; grant: (release: () => void) => void };
type NativeBarrierState = { activeReaders: number; writerActive: boolean; waiters: NativeBarrierWaiter[] };
const nativeBarrierStates = new Map<string, NativeBarrierState>();
const nativeWriterIntentPaths = new Set<string>();

function nativeBarrierRelease(path: string, state: NativeBarrierState, exclusive: boolean): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (exclusive) state.writerActive = false;
    else state.activeReaders -= 1;
    if (state.writerActive || state.activeReaders > 0) return;
    const next = state.waiters[0];
    if (!next) {
      if (nativeBarrierStates.get(path) === state) nativeBarrierStates.delete(path);
      return;
    }
    if (next.exclusive) {
      state.waiters.shift();
      state.writerActive = true;
      next.grant(nativeBarrierRelease(path, state, true));
      return;
    }
    while (state.waiters[0] && !state.waiters[0].exclusive) {
      const reader = state.waiters.shift()!;
      state.activeReaders += 1;
      reader.grant(nativeBarrierRelease(path, state, false));
    }
  };
}

async function acquireNativeBarrier(path: string, exclusive: boolean): Promise<() => void> {
  const state = nativeBarrierStates.get(path) ?? { activeReaders: 0, writerActive: false, waiters: [] };
  nativeBarrierStates.set(path, state);
  return new Promise<() => void>((resolve) => {
    const grant = (release: () => void): void => resolve(release);
    if (exclusive) {
      if (!state.writerActive && state.activeReaders === 0 && state.waiters.length === 0) {
        state.writerActive = true;
        grant(nativeBarrierRelease(path, state, true));
      } else state.waiters.push({ exclusive: true, grant });
    } else if (!state.writerActive && !state.waiters.some((waiter) => waiter.exclusive)) {
      state.activeReaders += 1;
      grant(nativeBarrierRelease(path, state, false));
    } else state.waiters.push({ exclusive: false, grant });
  });
}

export const GUEST_GROWTH_SCRIPT = `
import { existsSync, readFileSync, statfsSync } from "node:fs";
const NATIVE_TIMEOUT_MS = 45_000;
function text(bytes) { return new TextDecoder().decode(bytes).trim(); }
function run(args) { const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: NATIVE_TIMEOUT_MS, killSignal: "SIGKILL" }); if (result.exitCode !== 0) throw new Error(text(result.stderr) || "native command failed"); return text(result.stdout); }
const root = Bun.argv[2] || "";
const rootPath = (path) => root ? root.replace(/\\/$/, "") + path : path;
const rootMount = rootPath("/");
const source = run(["realpath", run(["findmnt", "-n", "-o", "SOURCE", rootMount])]);
const fstype = run(["findmnt", "-n", "-o", "FSTYPE", rootMount]);
const name = source.split("/").at(-1);
const partition = rootPath("/sys/class/block/" + name + "/partition");
if (!existsSync(partition) || !["ext4", "xfs"].includes(fstype)) throw new Error("automatic growth supports a direct ext4/xfs root partition only");
const number = readFileSync(partition, "utf8").trim();
const parent = run(["lsblk", "-n", "-o", "PKNAME", source]);
if (!parent || parent.includes("/")) throw new Error("ambiguous root disk");
const disk = "/dev/" + parent;
const requested = BigInt(Bun.argv[1] || "0") * 1024n ** 3n;
const size = BigInt(run(["blockdev", "--getsize64", disk]));
if (size < requested) throw new Error("guest virtual disk size is stale");
const beforeStats = statfsSync(rootMount, { bigint: true });
const before = beforeStats.blocks * beforeStats.frsize;
const grown = Bun.spawnSync(["growpart", disk, number], { stdout: "pipe", stderr: "pipe", timeout: NATIVE_TIMEOUT_MS, killSignal: "SIGKILL" });
const grownOut = text(grown.stdout);
if (grown.exitCode !== 0 && !(grown.exitCode === 1 && grownOut.includes("NOCHANGE"))) throw new Error("growpart failed: " + text(grown.stderr));
run(fstype === "ext4" ? ["resize2fs", source] : ["xfs_growfs", rootMount]);
const afterStats = statfsSync(rootMount, { bigint: true });
const after = afterStats.blocks * afterStats.frsize;
if (after <= before && after * 100n < size * 85n) throw new Error("root filesystem did not grow");
const safe = (value) => { if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("guest capacity exceeds safe reporting range"); return Number(value); };
console.log(JSON.stringify({ virtual_bytes: safe(size), filesystem_before: safe(before), filesystem_bytes: safe(after), filesystem: fstype }));
`;

export class ControlError extends Error {
  readonly code: string;
  readonly detail: unknown;
  readonly rawDetail: unknown;

  constructor(code: string, message: string, detail: unknown = undefined) {
    const safeMessage = boundedDiagnosticText(String(message), DIAGNOSTIC_MESSAGE_LIMIT);
    super(safeMessage);
    this.name = "ControlError";
    this.code = code;
    this.rawDetail = detail;
    Object.defineProperty(this, "rawDetail", { enumerable: false });
    this.message = safeMessage;
    this.detail = detail === undefined ? undefined : redactDiagnosticValue(detail);
  }

  asDict(): Dict {
    const value: Dict = { code: this.code, message: boundedDiagnosticText(this.message, DIAGNOSTIC_MESSAGE_LIMIT) };
    if (this.detail !== undefined) value.detail = redactDiagnosticValue(this.detail);
    return value;
  }
}

export class GuestWaitTimeout extends ControlError {
  constructor(detail: unknown = undefined) {
    super("guest_wait_timeout", "Incus readiness wait expired", detail);
    this.name = "GuestWaitTimeout";
  }
}

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SENSITIVE_FIELD_RE = /(?:password|passwd|passphrase|secret|token|authorization|private[_ -]?key|public[_ -]?key|api[_ -]?key|access[_ -]?key|client[_ -]?secret|credentials?)/i;
const SECRET_LABEL = "(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|secret|token|authorization|private[_ -]?key|public[_ -]?key|api[_ -]?key|access[_ -]?key|client[_ -]?secret|credentials?)(?:[_-][A-Za-z0-9]+)*";
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 _-]*PRIVATE KEY-----/gi;
const AUTH_SCHEME_RE = /(['\"]?\bauthorization\b['\"]?\s*(?:[:=]\s*)?['\"]?(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi;
const AUTH_BASIC_RE = /(\bbasic\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_DOUBLE_RE = new RegExp(`(['\\\"]?\\b${SECRET_LABEL}\\b['\\\"]?\\s*[:=]\\s*)\\"[^\\"\\r\\n]*\\"`, "gi");
const SECRET_SINGLE_RE = new RegExp(`(['\\\"]?\\b${SECRET_LABEL}\\b['\\\"]?\\s*[:=]\\s*)'[^'\\r\\n]*'`, "gi");
const SECRET_TOKEN_RE = new RegExp(`(['\\\"]?\\b${SECRET_LABEL}\\b['\\\"]?\\s*[:=]\\s*)([^\\s,;}}\\]\\\\\\"']+)`, "gi");
const SSHPASS_RE = /(\bsshpass\b[ \t]+-p)[^\r\n]*/gi;
const URL_CREDENTIAL_RE = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi;
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

function redactDiagnosticText(rawInput: string): string {
  let redacted = rawInput.replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]");
  redacted = redacted.replace(AUTH_SCHEME_RE, "$1[REDACTED]");
  redacted = redacted.replace(AUTH_BASIC_RE, "$1[REDACTED]");
  redacted = redacted.replace(SECRET_DOUBLE_RE, "$1\"[REDACTED]\"");
  redacted = redacted.replace(SECRET_SINGLE_RE, "$1'[REDACTED]'");
  redacted = redacted.replace(SECRET_TOKEN_RE, "$1[REDACTED]");
  redacted = redacted.replace(SSHPASS_RE, "$1 [REDACTED]");
  redacted = redacted.replace(URL_CREDENTIAL_RE, "$1[REDACTED]$3");
  return redacted.replace(BEARER_RE, "$1[REDACTED]");
}

function boundedDiagnosticText(rawInput: string, limit: number): string {
  const redacted = redactDiagnosticText(rawInput);
  if (redacted.length <= limit) return redacted;
  return redacted.slice(0, Math.max(0, limit - DIAGNOSTIC_LOG_TRUNCATION_MARKER.length)) + DIAGNOSTIC_LOG_TRUNCATION_MARKER;
}

function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED]";
  if (typeof value === "string") return boundedDiagnosticText(value, DIAGNOSTIC_LOG_LIMIT);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry, depth + 1));
  if (isDict(value)) {
    const result: Dict = Object.create(null);
    for (const [key, child] of Object.entries(value)) setOwn(result, key, SENSITIVE_FIELD_RE.test(key) ? "[REDACTED]" : redactDiagnosticValue(child, depth + 1));
    return result;
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateSuccessEnvelope(response: Dict, action: string, sessionId: string | undefined, operationId: string | undefined): Dict {
  if (response.ok !== true || response.protocol !== PROTOCOL_VERSION || response.action !== action || response.session_id !== (sessionId ?? null) || !isDict(response.result) || typeof response.server_time !== "string") {
    throw new ControlError("invalid_response", "control success envelope is malformed");
  }
  if (!hasOwn(response, "operation_id") || response.operation_id !== (operationId ?? null)) {
    throw new ControlError("invalid_response", "control success envelope operation identity is invalid");
  }
  if (!hasOwn(response, "generation")) {
    throw new ControlError("invalid_response", "control success envelope generation is invalid");
  }
  if (response.generation !== null) {
    try { if (integerBigInt(response.generation, "generation") < 0n) throw new Error("negative"); }
    catch { throw new ControlError("invalid_response", "control success envelope generation is invalid"); }
  }
  if (action === "status" && sessionId !== undefined && (!hasOwn(response.result, "generation") || !sameInteger(response.generation, response.result.generation))) {
    throw new ControlError("invalid_response", "status success envelope generation is inconsistent");
  }
  if (response.outcome !== "success" && response.outcome !== "replayed") throw new ControlError("invalid_response", "control success envelope outcome is invalid");
  return response;
}

function setOwn(value: Dict, key: string, child: unknown): void {
  Object.defineProperty(value, key, { configurable: true, enumerable: true, writable: true, value: child });
}

function jsonFloat(raw: string): JsonFloat {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new SyntaxError("non-finite JSON number");
  const result = Object.create(null) as JsonFloat;
  Object.defineProperties(result, {
    value: { configurable: false, enumerable: false, writable: false, value },
    raw: { configurable: false, enumerable: false, writable: false, value: raw },
    [JSON_FLOAT]: { configurable: false, enumerable: false, writable: false, value: true },
  });
  return Object.freeze(result);
}

function isJsonFloat(value: unknown): value is JsonFloat {
  return isDict(value) && (value as Record<PropertyKey, unknown>)[JSON_FLOAT] === true && typeof value.value === "number" && typeof value.raw === "string";
}

function pythonFloatText(value: number): string {
  if (!Number.isFinite(value)) return "null";
  if (Object.is(value, -0)) return "-0.0";
  const raw = Math.abs(value).toString();
  const [mantissa, exponentText] = raw.split(/[eE]/, 2);
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = mantissa.split(".", 2);
  let digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) digits = "0";
  const scale = exponent - fraction.length;
  const adjustedExponent = digits.length + scale - 1;
  const sign = value < 0 ? "-" : "";
  if (adjustedExponent < -4 || adjustedExponent >= 16) {
    const significant = digits.replace(/0+$/, "") || "0";
    const suffix = adjustedExponent >= 0 ? `+${adjustedExponent}` : `-${String(-adjustedExponent).padStart(2, "0")}`;
    return `${sign}${significant[0]}${significant.length > 1 ? `.${significant.slice(1)}` : ""}e${suffix}`;
  }
  const decimalPosition = digits.length + scale;
  let fixed: string;
  if (decimalPosition <= 0) fixed = `0.${"0".repeat(-decimalPosition)}${digits}`;
  else if (decimalPosition >= digits.length) fixed = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  else fixed = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  if (!fixed.includes(".")) fixed += ".0";
  return sign + fixed;
}

function jsonFloatText(value: JsonFloat): string {
  return pythonFloatText(value.value);
}

function dictArray(value: unknown, code: string, message: string): Dict[] {
  if (!Array.isArray(value) || value.some((entry) => !isDict(entry))) throw new ControlError(code, message);
  return value as Dict[];
}

function inventoryString(value: unknown, code: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ControlError(code, `${field} is invalid`);
  return value;
}

function nativeDeviceMap(value: unknown, code: string, field: string): Dict {
  if (!isDict(value)) throw new ControlError(code, `${field} is unavailable`);
  for (const [name, device] of Object.entries(value)) {
    inventoryString(name, code, `${field} name`);
    if (!isDict(device) || typeof device.type !== "string" || device.type.length === 0) throw new ControlError(code, `${field} contains an invalid device record`);
  }
  return value;
}

function nativeDeviceMaps(value: unknown, code: string): { devices: Dict; expanded_devices: Dict } {
  if (!isDict(value)) throw new ControlError(code, "native instance record is unavailable");
  return {
    devices: nativeDeviceMap(value.devices, code, "native devices"),
    expanded_devices: nativeDeviceMap(value.expanded_devices, code, "expanded native devices"),
  };
}

function nativeProxyNames(value: unknown, code: string): Set<string> {
  const maps = nativeDeviceMaps(value, code);
  const names = new Set<string>();
  for (const devices of [maps.devices, maps.expanded_devices]) for (const [name, device] of Object.entries(devices)) if (device.type === "proxy") names.add(name);
  return names;
}

function inventoryAddress(value: unknown, code: string, field: string, allowSentinel = true): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ControlError(code, `${field} is invalid`);
  if (allowSentinel && (value === "" || value === "none" || value === "auto")) return undefined;
  const parts = value.split("/");
  if (parts.length > 2 || !parts[0]) throw new ControlError(code, `${field} is invalid`);
  const address = parts[0]!;
  const family = isIP(address);
  if (!family) throw new ControlError(code, `${field} is invalid`);
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[1]!)) throw new ControlError(code, `${field} prefix is invalid`);
    const prefix = Number(parts[1]);
    if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new ControlError(code, `${field} prefix is invalid`);
  }
  return family === 6 ? address.toLowerCase() : address;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function jsonValue(value: unknown): unknown {
  if (isJsonFloat(value)) return value;
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isDict(value)) {
    const result: Dict = Object.create(null);
    for (const key of Object.keys(value).sort(compareUnicodeCodePoints)) {
      if (value[key] !== undefined) setOwn(result, key, jsonValue(value[key]));
    }
    return result;
  }
  return value;
}

/** Stable JSON keeps operation digests independent of object insertion order. */
export function stableJson(value: unknown): string {
  const normalized = jsonValue(value);
  if (isJsonFloat(normalized)) return jsonFloatText(normalized);
  if (typeof normalized === "bigint") return normalized.toString(10);
  if (typeof normalized === "number" && (Object.is(normalized, -0) || !Number.isInteger(normalized))) return pythonFloatText(normalized);
  if (Array.isArray(normalized)) return `[${normalized.map(stableJson).join(",")}]`;
  if (isDict(normalized)) {
    return `{${Object.keys(normalized).sort(compareUnicodeCodePoints).map((key) => `${JSON.stringify(key)}:${stableJson(normalized[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(normalized);
  if (result === undefined) return "null";
  return result;
}

function emitJson(value: unknown): string {
  return stableJson(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asciiJsonString(value: string): string {
  let result = '"';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f) result += JSON.stringify(character).slice(1, -1);
    else if (point <= 0xffff) result += `\\u${point.toString(16).padStart(4, "0")}`;
    else {
      const adjusted = point - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      result += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  }
  return `${result}"`;
}

/** Match the Python controller's sorted, spaced JSON request digest. */
function requestDigest(request: Dict): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "boolean") return String(value).toLowerCase();
    if (typeof value === "bigint") return value.toString(10);
    if (isJsonFloat(value)) return jsonFloatText(value);
    if (typeof value === "number") return Object.is(value, -0) || !Number.isInteger(value) ? pythonFloatText(value) : JSON.stringify(value) ?? "null";
    if (typeof value === "string") return asciiJsonString(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(", ")}]`;
    if (isDict(value)) return `{${Object.keys(value).sort(compareUnicodeCodePoints).map((key) => `${asciiJsonString(key)}: ${canonical(value[key])}`).join(", ")}}`;
    return "null";
  };
  return sha256(canonical(request));
}

function integerBigInt(value: unknown, field: string, code = "invalid_request"): bigint {
  if (isJsonFloat(value)) throw new ControlError(code, `${field} must be an integer`);
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new ControlError(code, `${field} must be an integer`);
}

function integerForJson(value: unknown): IntegerValue {
  const integer = integerBigInt(value, "integer");
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}

function integerText(value: unknown): string {
  return integerBigInt(value, "integer").toString(10);
}

function sameInteger(left: unknown, right: unknown): boolean {
  try { return integerBigInt(left, "integer") === integerBigInt(right, "integer"); }
  catch { return false; }
}

function numberFromInteger(value: unknown, field: string, minimum: number, maximum: number): number;
function numberFromInteger(value: unknown, field: string, minimum?: number, maximum?: number): IntegerValue;
function numberFromInteger(value: unknown, field: string, minimum?: number, maximum?: number): IntegerValue {
  const integer = integerBigInt(value, field);
  if (minimum !== undefined && integer < BigInt(minimum)) throw new ControlError("invalid_request", `${field} must be >= ${minimum}`);
  if (maximum !== undefined && integer > BigInt(maximum)) throw new ControlError("invalid_request", `${field} must be <= ${maximum}`);
  return integerForJson(integer);
}

function maxIntegerValue(...values: unknown[]): IntegerValue {
  let maximum = 0n;
  for (const value of values) {
    const current = integerBigInt(value, "integer");
    if (current > maximum) maximum = current;
  }
  return integerForJson(maximum);
}

function bigintFromInteger(value: unknown, field: string, minimum = 0n): bigint {
  let result: bigint;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === "string" && /^-?[0-9]+$/.test(value)) result = BigInt(value);
  else throw new ControlError("config_invalid", `${field} must be an integer`);
  if (result < minimum) throw new ControlError("config_invalid", `${field} must be >= ${minimum}`);
  return result;
}

function nativeDecimalInteger(value: unknown, field: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new ControlError("resource_unverified", `${field} is not a decimal integer`);
}

function requiredString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0) throw new ControlError("invalid_request", `${field} must be a non-empty string`);
  if (pattern && !pattern.test(value)) throw new ControlError("invalid_request", `${field} contains unsupported characters`);
  return value;
}

function portProtocol(value: unknown): "tcp" | "udp" {
  if (typeof value !== "string" || (value !== "tcp" && value !== "udp")) throw new ControlError("invalid_request", "port_protocol must be tcp or udp");
  return value;
}

function requiredOwn(request: Dict, field: string): unknown {
  if (!hasOwn(request, field)) throw new ControlError("invalid_request", `${field} is required`);
  return request[field];
}

function configString(value: unknown, field: string, pattern?: RegExp): string {
  try { return requiredString(value, field, pattern); }
  catch (error) { if (error instanceof ControlError && error.code === "invalid_request") throw new ControlError("config_invalid", error.message, error.detail); throw error; }
}

function configInteger(value: unknown, field: string, minimum?: number, maximum?: number): IntegerValue {
  try { return numberFromInteger(value, field, minimum, maximum); }
  catch (error) { if (error instanceof ControlError && error.code === "invalid_request") throw new ControlError("config_invalid", error.message, error.detail); throw error; }
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ControlError("invalid_request", `${field} must be a JSON boolean`);
  return value;
}

function ratio(value: unknown, name: string): { numerator: bigint; denominator: bigint; text: string; diagnosticText: string } {
  if (!isJsonFloat(value) && typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
    throw new ControlError("config_invalid", `${name} must be a finite number at least one`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new ControlError("config_invalid", `${name} must be a finite number at least one`);
  const text = isJsonFloat(value) ? jsonFloatText(value) : String(value);
  const match = /^(?<sign>-?)(?<digits>(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(?:[eE](?<exponent>[+-]?[0-9]+))?$/.exec(text);
  if (!match || match.groups?.sign === "-") throw new ControlError("config_invalid", `${name} must be a finite number at least one`);
  const digits = match.groups?.digits ?? "";
  const exponent = Number(match.groups?.exponent ?? "0");
  if (!Number.isSafeInteger(exponent)) throw new ControlError("config_invalid", `${name} must be a finite number at least one`);
  const [whole, fraction = ""] = digits.split(".");
  const mantissa = BigInt(`${whole || "0"}${fraction}`);
  const scale = exponent - fraction.length;
  const denominator = scale >= 0 ? 1n : 10n ** BigInt(-scale);
  const numerator = scale >= 0 ? mantissa * 10n ** BigInt(scale) : mantissa;
  if (numerator < denominator) throw new ControlError("config_invalid", `${name} must be a finite number at least one`);
  const result = { numerator, denominator, text } as { numerator: bigint; denominator: bigint; text: string; diagnosticText: string };
  Object.defineProperty(result, "diagnosticText", { configurable: false, enumerable: false, writable: false, value: isJsonFloat(value) ? value.raw : String(value) });
  return result;
}

function floorRatio(value: bigint, multiplier: { numerator: bigint; denominator: bigint }): bigint {
  return (value * multiplier.numerator) / multiplier.denominator;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ControlError("resource_unverified", "CT resource metric is unavailable", { metric: path });
  }
}

function parseTime(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (typeof value !== "string") throw new ControlError("invalid_time", `invalid timestamp: ${String(value)}`);
  const parsed = new Date(value.replace(/Z$/, "+00:00"));
  if (Number.isNaN(parsed.getTime())) throw new ControlError("invalid_time", `invalid timestamp: ${value}`);
  return parsed;
}

export function isoTime(value: Date = new Date()): string {
  return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString().replace(/Z$/, "+00:00");
}

function nowMs(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8Strict(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function parseJson(raw: string): unknown {
  let index = 0;
  const fail = (): never => { throw new SyntaxError(`invalid JSON at byte ${index}`); };
  const skipWhitespace = (): void => { while (/[ \t\r\n]/.test(raw[index] ?? "")) index += 1; };
  const parseString = (): string => {
    if (raw[index] !== '"') return fail();
    const start = index;
    index += 1;
    while (index < raw.length) {
      const character = raw[index]!;
      if (character === "\\") { index += 2; continue; }
      if (character === '"') { index += 1; return JSON.parse(raw.slice(start, index)) as string; }
      if (character < " ") return fail();
      index += 1;
    }
    return fail();
  };
  const parseNumber = (): IntegerValue | JsonFloat => {
    const matcher = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    matcher.lastIndex = index;
    const token = matcher.exec(raw)?.[0];
    if (!token) return fail();
    index += token.length;
    if (!token.includes(".") && !/[eE]/i.test(token)) return integerForJson(BigInt(token));
    const number = Number(token);
    if (!Number.isFinite(number)) return fail();
    return jsonFloat(token);
  };
  const parseValue = (): unknown => {
    skipWhitespace();
    const character = raw[index];
    if (character === '"') return parseString();
    if (character === "{") {
      const object: Dict = Object.create(null);
      index += 1;
      skipWhitespace();
      if (raw[index] === "}") { index += 1; return object; }
      while (true) {
        skipWhitespace();
        const key = parseString();
        skipWhitespace();
        if (raw[index] !== ":") return fail();
        index += 1;
        setOwn(object, key, parseValue());
        skipWhitespace();
        if (raw[index] === "}") { index += 1; return object; }
        if (raw[index] !== ",") return fail();
        index += 1;
      }
    }
    if (character === "[") {
      const array: unknown[] = [];
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") { index += 1; return array; }
      while (true) {
        array.push(parseValue());
        skipWhitespace();
        if (raw[index] === "]") { index += 1; return array; }
        if (raw[index] !== ",") return fail();
        index += 1;
      }
    }
    if (raw.startsWith("true", index)) { index += 4; return true; }
    if (raw.startsWith("false", index)) { index += 5; return false; }
    if (raw.startsWith("null", index)) { index += 4; return null; }
    if (character === "-" || (character !== undefined && /[0-9]/.test(character))) return parseNumber();
    return fail();
  };
  const value = parseValue();
  skipWhitespace();
  if (index !== raw.length) return fail();
  return value;
}

function ipv4ToInt(value: string): number {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) throw new ControlError("config_invalid", `invalid IPv4 address: ${value}`);
  return parts.reduce((result, part) => result * 256 + Number(part), 0);
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 255)).join(".");
}

function parseListenPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) throw new ControlError("port_inventory_unverified", "unrecognized ss output");
    const match = /:(\d+)$/.exec(fields[4] ?? "");
    if (!match) throw new ControlError("port_inventory_unverified", "unrecognized socket endpoint");
    ports.add(Number(match[1]));
  }
  return ports;
}

export class CTResources {
  private unsigned(value: string, metric: string, positive = false): number {
    if (!/^[0-9]+$/.test(value.trim())) throw new ControlError("resource_unverified", "CT resource metric is invalid", { metric });
    const number = Number(value);
    if (!Number.isSafeInteger(number) || (positive && number === 0)) throw new ControlError("resource_unverified", "CT resource metric is invalid", { metric });
    return number;
  }

  cpu(): number {
    let capacity: number;
    try { capacity = availableParallelism(); } catch { throw new ControlError("resource_unverified", "CT CPU capacity is unavailable"); }
    const fields = readText("/sys/fs/cgroup/cpu.max").trim().split(/\s+/);
    if (fields.length !== 2) throw new ControlError("resource_unverified", "invalid CT CPU quota");
    const period = this.unsigned(fields[1] ?? "", "cpu.max period", true);
    if (fields[0] !== "max") capacity = Math.min(capacity, Math.floor(this.unsigned(fields[0] ?? "", "cpu.max quota", true) / period));
    return capacity;
  }

  private lxcfsMeminfo(): Dict | undefined {
    const mounts: string[][] = [];
    for (const line of readText("/proc/self/mountinfo").split(/\r?\n/)) {
      const [before, separator, after] = line.split(" - ");
      const left = (before ?? "").trim().split(/\s+/);
      const right = (after ?? "").trim().split(/\s+/);
      if (separator !== undefined && left.length >= 6 && right.length >= 2 && left[4] === "/proc/meminfo") mounts.push(right.slice(0, 2));
    }
    if (mounts.length !== 1 || mounts[0]?.[0] !== "fuse.lxcfs" || mounts[0]?.[1] !== "lxcfs") return undefined;
    const values: Dict = {};
    for (const line of readText("/proc/meminfo").split(/\r?\n/)) {
      const [name, value] = line.split(":", 2);
      if (name !== "MemTotal" && name !== "MemAvailable") continue;
      const fields = (value ?? "").trim().split(/\s+/);
      if (name in values || fields.length !== 2 || fields[1] !== "kB") throw new ControlError("resource_unverified", "invalid LXCfs memory metric", { metric: name });
      values[name] = this.unsigned(fields[0] ?? "", name) * 1024;
    }
    const total = values.MemTotal as number | undefined;
    const available = values.MemAvailable as number | undefined;
    if (total === undefined || available === undefined || total <= 0 || available < 0 || available > total) throw new ControlError("resource_unverified", "LXCfs memory metrics are missing or inconsistent");
    return values;
  }

  memory(): Dict {
    const rawLimit = readText("/sys/fs/cgroup/memory.max").trim();
    const lxcfs = this.lxcfsMeminfo();
    const sources: string[] = [];
    let limit: number;
    let available: number;
    if (rawLimit === "max") {
      if (!lxcfs) throw new ControlError("resource_unverified", "unlimited CT cgroup requires a verified LXCfs memory view");
      limit = lxcfs.MemTotal;
      available = lxcfs.MemAvailable;
    } else {
      limit = this.unsigned(rawLimit, "memory.max", true);
      const current = this.unsigned(readText("/sys/fs/cgroup/memory.current"), "memory.current");
      const entries = readText("/sys/fs/cgroup/memory.stat").split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((fields) => fields[0] === "inactive_file");
      if (entries.length !== 1 || entries[0]?.length !== 2) throw new ControlError("resource_unverified", "inactive_file memory metric is missing or duplicated");
      const inactive = this.unsigned(entries[0]?.[1] ?? "", "inactive_file");
      if (inactive > current) throw new ControlError("resource_unverified", "CT memory accounting is inconsistent");
      available = Math.min(limit, Math.max(0, limit - current + inactive));
      sources.push("cgroup-v2");
      if (lxcfs) {
        limit = Math.min(limit, lxcfs.MemTotal);
        available = Math.min(available, lxcfs.MemAvailable, limit);
      }
    }
    if (lxcfs) sources.push("lxcfs");
    return { scope: "ct-memory", sources, limit_bytes: limit, available_bytes: available, threshold_bytes: Math.max(1024 ** 3, Math.ceil(limit / 10)) };
  }
}

function currentOwnerUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

type ProtectedStats = { isFile(): boolean; isDirectory(): boolean; mode: number | bigint; uid: number };

function validateProtectedStat(path: string, stats: ProtectedStats, kind: "file" | "directory"): void {
  const expected = kind === "file" ? stats.isFile() : stats.isDirectory();
  const mode = Number(stats.mode);
  if (!expected || (mode & 0o022) !== 0 || (kind === "file" && (mode & 0o111) !== 0)) throw new ControlError("config_invalid", `${kind} path has unsafe type or mode`);
  const owner = currentOwnerUid();
  if (owner !== undefined && stats.uid !== owner) throw new ControlError("config_invalid", `${kind} path is not owned by the control user`);
}

function validateProtectedFile(path: string): void {
  const resolved = resolve(path);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new ControlError("config_invalid", "configuration path must be a regular file and cannot be a symlink");
  realpathSync(resolved); // Resolve parent aliases such as macOS /tmp without following the final file.
  validateProtectedStat(resolved, stats, "file");
  const noFollow = (constants as any).O_NOFOLLOW ?? 0;
  const fd = openSync(resolved, constants.O_RDONLY | noFollow);
  try { validateProtectedStat(resolved, fstatSync(fd), "file"); } finally { closeSync(fd); }
}

export function validateProtectedDirectory(path: string): void {
  const resolved = resolve(path);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new ControlError("config_invalid", "timer directory must be a real directory and cannot be a symlink");
  realpathSync(resolved); // Resolve parent aliases such as macOS /tmp without following the final directory.
  validateProtectedStat(resolved, stats, "directory");
  const noFollow = (constants as any).O_NOFOLLOW ?? 0;
  const directoryFlag = (constants as any).O_DIRECTORY ?? 0;
  const fd = openSync(resolved, constants.O_RDONLY | noFollow | directoryFlag);
  try { validateProtectedStat(resolved, fstatSync(fd), "directory"); } finally { closeSync(fd); }
}

export function readJsonFile(path: string): Dict {
  try {
    validateProtectedFile(path);
    const noFollow = (constants as any).O_NOFOLLOW ?? 0;
    const fd = openSync(resolve(path), constants.O_RDONLY | noFollow);
    let bytes: Uint8Array;
    try { validateProtectedStat(path, fstatSync(fd), "file"); bytes = readFileSync(fd); } finally { closeSync(fd); }
    const value = parseJson(decodeUtf8Strict(bytes));
    if (!isDict(value)) throw new Error("root");
    return value;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlError("config_missing", `configuration not found: ${path}`);
    throw new ControlError("config_invalid", `cannot read configuration: ${path}`);
  }
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): Dict {
  const raw = readJsonFile(path);
  if ("backing_probes" in raw) throw new ControlError("config_invalid", "external storage probes are unsupported; remove backing_probes");
  const config: Dict = {
    initial_lease_seconds: 1800, renew_seconds: 900, max_lease_seconds: 7200, cache_seconds: 86400,
    cpu_budget: 0, memory_budget_mib: 0, cpu_overcommit_ratio: 4, memory_overcommit_ratio: 4,
    create_cost_bytes: 4 * 1024 ** 3, resume_cost_bytes: 1024 ** 3, resize_cost_bytes: 1024 ** 3,
    required_guest_tools: ["bun", "python3", "sshd", "rsync", "docker", "growpart"], timer_dir: DEFAULT_TIMER_DIR,
    ...raw,
  };
  const missing = REQUIRED_ENVIRONMENT_FIELDS.filter((field) => !(field in raw) || raw[field] === null || raw[field] === "");
  if (missing.length) throw new ControlError("config_missing", "required environment configuration is missing", { fields: missing });
  for (const field of ["project", "profile", "image_alias", "image_fingerprint", "network", "network_acl", "pool"]) configString(config[field], field);
  if (typeof config.image_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(config.image_fingerprint)) throw new ControlError("config_invalid", "image_fingerprint must be a 64-character lowercase hex fingerprint");
  config.port_start = configInteger(config.port_start, "port_start", 1024, 65535);
  config.port_end = configInteger(config.port_end, "port_end", config.port_start, 65535);
  for (const field of ["initial_lease_seconds", "renew_seconds", "max_lease_seconds", "cache_seconds"]) config[field] = configInteger(config[field], field, 1);
  if (config.renew_seconds > config.max_lease_seconds) throw new ControlError("config_invalid", "renew_seconds exceeds max_lease_seconds");
  for (const field of ["cpu_budget", "memory_budget_mib"]) config[field] = configInteger(config[field], field, 0);
  for (const field of ["create_cost_bytes", "resume_cost_bytes", "resize_cost_bytes"]) config[field] = bigintFromInteger(config[field], field);
  config.cpu_overcommit_ratio = ratio(config.cpu_overcommit_ratio, "cpu_overcommit_ratio");
  config.memory_overcommit_ratio = ratio(config.memory_overcommit_ratio, "memory_overcommit_ratio");
  for (const field of ["host_address", "vm_ip_start", "vm_ip_end", "gateway_ip"]) configString(config[field], field);
  const host = ipv4ToInt(config.host_address);
  const vmStart = ipv4ToInt(config.vm_ip_start);
  const vmEnd = ipv4ToInt(config.vm_ip_end);
  const gateway = ipv4ToInt(config.gateway_ip);
  if (vmStart > vmEnd) throw new ControlError("config_invalid", "vm_ip_start must not exceed vm_ip_end");
  config.host_address = intToIpv4(host);
  config.vm_ip_start = intToIpv4(vmStart);
  config.vm_ip_end = intToIpv4(vmEnd);
  config.gateway_ip = intToIpv4(gateway);
  config.network_acl = configString(config.network_acl, "network_acl", PORT_NAME_RE);
  config.storage_path = configString(config.storage_path, "storage_path");
  config.state_db = configString(config.state_db, "state_db");
  config.timer_dir = configString(config.timer_dir, "timer_dir");
  if (!Array.isArray(config.required_guest_tools) || !config.required_guest_tools.every((item: unknown) => typeof item === "string" && item.length > 0)) throw new ControlError("config_invalid", "required_guest_tools must be a list of strings");
  try { validateProtectedDirectory(config.timer_dir); } catch (error) { if (error instanceof ControlError) throw error; throw new ControlError("config_invalid", "timer directory cannot be verified"); }
  return config;
}

type CompletedProcess = { args: string[]; returncode: number; stdout: Uint8Array; stderr: Uint8Array; stdoutTruncated?: boolean };
type RunOptions = { inputData?: Uint8Array | string; timeout?: number; check?: boolean };
type BoundedOptions = { timeout?: number; stdoutLimit?: number; stderrLimit?: number; check?: boolean };

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, tail: boolean, signal?: AbortSignal, redactTail = false): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let seen = 0;
  let truncated = false;
  let rawTruncated = false;
  const cancel = (): void => { void reader.cancel(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) break;
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      seen += chunk.length;
      if (!tail) {
        const available = Math.max(0, Math.min(limit - retained, chunk.length));
        if (available) chunks.push(chunk.slice(0, available));
        retained += available;
        if (seen > limit) truncated = true;
      } else if (redactTail) {
        const available = Math.max(0, Math.min(RAW_DIAGNOSTIC_CAPTURE_LIMIT - retained, chunk.length));
        if (available) chunks.push(chunk.slice(0, available));
        retained += available;
        if (seen > RAW_DIAGNOSTIC_CAPTURE_LIMIT) rawTruncated = true;
      } else if (limit > 0) {
        chunks.push(chunk.slice());
        retained += chunk.length;
        while (retained > limit && chunks.length) {
          const excess = retained - limit;
          const first = chunks[0]!;
          if (first.length <= excess) { chunks.shift(); retained -= first.length; }
          else { chunks[0] = first.slice(excess); retained -= excess; }
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const output = new Uint8Array(chunks.reduce((size, entry) => size + entry.length, 0));
  let offset = 0;
  for (const entry of chunks) { output.set(entry, offset); offset += entry.length; }
  if (redactTail) {
    if (rawTruncated) return { bytes: encode(DIAGNOSTIC_LOG_TRUNCATION_MARKER).slice(0, Math.max(0, limit)), truncated: true };
    const redacted = encode(redactDiagnosticText(decode(output)));
    return { bytes: redacted.slice(Math.max(0, redacted.length - limit)), truncated: redacted.length > limit };
  }
  return { bytes: output.slice(Math.max(0, output.length - limit)), truncated: tail ? seen > limit : truncated };
}

let killNative: ((pid: number, signal: number) => number) | undefined;
function nativeKill(pid: number, signal: number): boolean {
  try {
    killNative ??= (dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { kill: { args: ["int", "int"], returns: "int" } }).symbols.kill as (pid: number, signal: number) => number);
    return killNative(pid, signal) === 0;
  } catch { return false; }
}

function killProcessGroup(pid: number, signal: number): boolean {
  return nativeKill(-pid, signal);
}

function processGroupMembers(pgid: number): { members: number[]; complete: boolean } {
  const members: number[] = [];
  let complete = true;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const raw = readFileSync(`/proc/${entry}/stat`, "utf8");
        const closeParen = raw.lastIndexOf(")");
        const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
        if (closeParen < 0 || fields.length < 3) throw new Error("invalid process stat");
        if (fields[0] !== "Z" && Number(fields[2]) === pgid) members.push(Number(entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        complete = false;
      }
    }
  } catch { return { members: [], complete: false }; }
  return { members, complete };
}

function killProcessGroupMembers(pgid: number): { killed: boolean; error: string | null } {
  let cleanupError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { members, complete } = processGroupMembers(pgid);
    if (!complete) return { killed: false, error: "process_group_inspection_failed" };
    if (!members.length) return { killed: true, error: cleanupError };
    for (const member of members) {
      if (!nativeKill(member, 9)) cleanupError = "PermissionError";
    }
  }
  const final = processGroupMembers(pgid);
  return final.complete && !final.members.length
    ? { killed: true, error: cleanupError }
    : { killed: false, error: cleanupError ?? "process_group_members_remain" };
}

export class CommandRunner {
  async run(argv: readonly string[], options: RunOptions = {}): Promise<CompletedProcess> {
    const result = await this.runBounded(argv, { timeout: options.timeout ?? 60, stdoutLimit: COMMAND_OUTPUT_LIMIT, stderrLimit: 4000, check: options.check ?? true, inputData: options.inputData });
    if (result.stdoutTruncated) throw new ControlError("command_output_truncated", `command stdout exceeded retained limit: ${argv[0]}`, { limit: COMMAND_OUTPUT_LIMIT });
    return result;
  }

  async runBounded(argv: readonly string[], options: BoundedOptions & { inputData?: Uint8Array | string } = {}): Promise<CompletedProcess> {
    if (!argv.length) throw new ControlError("invalid_request", "command argv cannot be empty");
    let processHandle: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      processHandle = Bun.spawn([...argv], { stdin: options.inputData !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlError("command_missing", `command not found: ${argv[0]}`);
      throw error;
    }
    const readAbort = new AbortController();
    const stdoutPromise = readBounded(processHandle.stdout, options.stdoutLimit ?? DIAGNOSTIC_LOG_LIMIT, false, readAbort.signal);
    const stderrPromise = readBounded(processHandle.stderr, options.stderrLimit ?? 4000, true, readAbort.signal, true);
    const timeoutMs = (options.timeout ?? 60) * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const exit = processHandle.exited;
    const timeout = new Promise<"timeout">((resolveTimeout) => { timeoutHandle = setTimeout(() => { resolveTimeout("timeout"); }, timeoutMs); });
    const inputPromise = (async (): Promise<unknown> => {
      if (options.inputData === undefined || !processHandle.stdin) return undefined;
      const input = typeof options.inputData === "string" ? encode(options.inputData) : options.inputData;
      try {
        await processHandle.stdin.write(input);
        processHandle.stdin.end();
      } catch (error) {
        // A child may close stdin intentionally; keep draining and reaping it.
        return error;
      }
      return undefined;
    })();
    const communication = Promise.all([inputPromise, stdoutPromise, stderrPromise, exit]);
    try {
      const outcome = await Promise.race([communication.then((value) => ({ kind: "complete" as const, value })), timeout.then(() => ({ kind: "timeout" as const }))]);
      if (outcome.kind === "timeout") {
        const groupKilled = killProcessGroup(processHandle.pid, 9);
        const fallback = killProcessGroupMembers(processHandle.pid);
        let processGroupKilled = groupKilled || fallback.killed;
        let processGroupCleanupError = fallback.error;
        try { processHandle.kill("SIGKILL"); } catch { /* The leader may already be gone. */ }
        const reaped = await Promise.race([exit.then(() => true), sleep(1000).then(() => false)]);
        readAbort.abort();
        try { processHandle.stdin?.end(); } catch { /* The pipe may already be closed. */ }
        await Promise.race([Promise.allSettled([inputPromise, stdoutPromise, stderrPromise, exit]), sleep(1000)]);
        if (!processGroupKilled && !processGroupCleanupError) processGroupCleanupError = "process_group_kill_failed";
        throw new ControlError("command_timeout", `command timed out: ${argv[0]}`, { reaped, process_group_killed: processGroupKilled, process_group_cleanup_error: processGroupCleanupError });
      }
      const [, stdout, stderr, returncode] = outcome.value;
      const result: CompletedProcess = { args: [...argv], returncode, stdout: stdout.bytes, stderr: stderr.bytes, stdoutTruncated: stdout.truncated };
      if ((options.check ?? true) && returncode !== 0) throw new ControlError("command_failed", `command failed (${returncode}): ${argv[0]}`, { returncode, stderr: decode(stderr.bytes).trim().slice(-4000) });
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

function quotePath(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}

export class IncusClient {
  constructor(readonly runner: CommandRunner, readonly config: Dict) {}

  get prefix(): string[] {
    return ["incus", "--project", String(this.config.project)];
  }

  async call(args: readonly string[], options: RunOptions = {}): Promise<CompletedProcess> {
    const result = await this.runner.run([...this.prefix, ...args], { ...options, timeout: options.timeout ?? 60 });
    if (result.stdoutTruncated) throw new ControlError("command_output_truncated", "Incus command output was truncated", { limit: COMMAND_OUTPUT_LIMIT });
    return result;
  }

  async json(args: readonly string[], timeout = 60): Promise<unknown> {
    const result = await this.call([...args, "--format", "json"], { timeout });
    try {
      return parseJson(decodeUtf8Strict(result.stdout));
    } catch {
      throw new ControlError("incus_invalid_output", "Incus returned invalid JSON");
    }
  }

  async listInstances(): Promise<Dict[]> {
    const value = await this.json(["list"]);
    const instances = dictArray(value, "native_inventory_unverified", "Incus list output contains an invalid instance record");
    for (const instance of instances) inventoryString(instance.name, "native_inventory_unverified", "instance name");
    return instances;
  }

  async instanceInfo(name: string, options: { timeout?: number; bounded?: boolean } = {}): Promise<Dict> {
    const value = await this.query(`/1.0/instances/${quotePath(name)}/state`, options);
    if (!isDict(value)) throw new ControlError("incus_invalid_output", "Incus info output is not an object");
    return value;
  }

  async init(image: string, name: string, metadata: Dict = {}): Promise<void> {
    const args = ["init", image, name, "--vm", "--profile", String(this.config.profile), "--config", "boot.autostart=false"];
    for (const [key, value] of Object.entries(metadata)) args.push("--config", `${key}=${String(value)}`);
    await this.call(args);
  }

  async start(name: string): Promise<void> {
    await this.call(["start", name], { timeout: 120 });
  }

  async wait(name: string, condition: string, seconds: number): Promise<void> {
    let result: CompletedProcess;
    try {
      result = await this.call(["wait", name, condition, "--timeout", String(seconds), "--interval", "1"], { timeout: seconds, check: false });
    } catch (error) {
      if (error instanceof ControlError && error.code === "command_timeout") throw new GuestWaitTimeout({ transport_timeout: true });
      throw error;
    }
    if (result.returncode === 0) return;
    const stderr = decode(result.stderr).trim();
    const detail = { returncode: result.returncode, stderr: stderr.slice(-4000) };
    if (/(?:timed?\s*out|timeout)/i.test(stderr)) throw new GuestWaitTimeout(detail);
    throw new ControlError("command_failed", `command failed (${result.returncode}): incus`, detail);
  }

  async stop(name: string, force = true): Promise<void> {
    await this.call(["stop", name, ...(force ? ["--force"] : [])], { timeout: 8 });
  }

  async delete(name: string): Promise<void> {
    await this.call(["delete", name, "--force"], { timeout: 120 });
  }

  async configSet(name: string, key: string, value: string): Promise<void> {
    await this.call(["config", "set", name, `${key}=${value}`]);
  }

  async configShow(name: string): Promise<Dict> {
    const value = await this.query(`/1.0/instances/${quotePath(name)}`);
    if (!isDict(value)) throw new ControlError("incus_invalid_output", "Incus config output is not an object");
    return value;
  }

  async networkForwards(): Promise<Dict[]> {
    const value = await this.json(["network", "forward", "list", String(this.config.network)]);
    return dictArray(value, "incus_invalid_output", "Incus network forward output contains an invalid record");
  }

  async query(path: string, options: { project?: string; timeout?: number; bounded?: boolean } = {}): Promise<unknown> {
    const queryPath = `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(options.project ?? String(this.config.project))}`;
    const result = options.bounded
      ? await this.runner.runBounded(["incus", "query", queryPath], { timeout: options.timeout ?? 30, stdoutLimit: DIAGNOSTIC_LOG_LIMIT, stderrLimit: 4000 })
      : await this.runner.run(["incus", "query", queryPath], { timeout: options.timeout ?? 30 });
    if (options.bounded && result.stdoutTruncated) throw new ControlError("incus_invalid_output", "query output was truncated");
    try {
      return parseJson(decodeUtf8Strict(result.stdout));
    } catch {
      throw new ControlError("incus_invalid_output", "Incus query did not return JSON");
    }
  }

  async instanceLog(name: string, timeout = DIAGNOSTIC_COMMAND_TIMEOUT_SECONDS): Promise<string> {
    const result = await this.runner.runBounded([...this.prefix, "info", name, "--show-log"], { timeout, stdoutLimit: DIAGNOSTIC_LOG_LIMIT, stderrLimit: 4000 });
    return decode(result.stdout) + (result.stdoutTruncated ? DIAGNOSTIC_LOG_TRUNCATION_MARKER : "");
  }

  async deviceSet(name: string, device: string, key: string, value: string): Promise<void> {
    const info = await this.configShow(name);
    const devices = nativeDeviceMaps(info, "mapping_unverified").devices;
    if (!hasOwn(devices, device)) await this.call(["config", "device", "override", name, device, `${key}=${value}`]);
    else await this.call(["config", "device", "set", name, device, `${key}=${value}`]);
  }

  async deviceAdd(name: string, device: string, deviceType: string, properties: Dict): Promise<void> {
    const args = ["config", "device", "add", name, device, deviceType];
    for (const [key, value] of Object.entries(properties)) args.push(`${key}=${String(value)}`);
    await this.call(args);
  }

  async deviceRemove(name: string, device: string): Promise<void> {
    await this.call(["config", "device", "remove", name, device]);
  }

  async exec(name: string, argv: readonly string[], options: RunOptions = {}): Promise<CompletedProcess> {
    return this.call(["exec", name, "--", ...argv], { ...options, timeout: options.timeout ?? 60 });
  }
}

function dbInteger(value: unknown): number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "number") return value;
  return value as number;
}

const TASK_FIELDS = new Set([
  "task_id", "session_id", "generation", "state", "instance_name", "vm_ip", "ssh_host_port", "lease_expires_at",
  "inactive_since", "cleanup_after", "created_at", "updated_at", "last_error", "image_fingerprint", "resources_json",
  "reservation_bytes", "previous_generation", "resource_reservation_json",
]);
const PORT_FIELDS = new Set(["task_id", "generation", "port_name", "protocol", "host_port", "vm_port", "device_name", "state", "created_at"]);

export class StateStore {
  readonly path: string;
  readonly db: Database;
  private depth = 0;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || (typeof process.geteuid === "function" && parent.uid !== process.geteuid()) || (parent.mode & 0o77) !== 0) throw new ControlError("state_path_unsafe", "state parent must be a private owned directory");
    try {
      if (lstatSync(path).isSymbolicLink()) throw new ControlError("state_path_unsafe", "state database cannot be a symlink");
    } catch (error) {
      if (error instanceof ControlError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db = new Database(path, { safeIntegers: true });
    try { chmodPrivate(path); } catch { /* SQLite may create the file lazily. */ }
    this.db.run("PRAGMA busy_timeout=10000");
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=FULL");
    this.db.run("PRAGMA foreign_keys=ON");
    this.schema();
  }

  private schema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, state TEXT NOT NULL,
        instance_name TEXT NOT NULL UNIQUE, vm_ip TEXT, ssh_host_port INTEGER, lease_expires_at TEXT,
        inactive_since TEXT, cleanup_after TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
        image_fingerprint TEXT NOT NULL, resources_json TEXT NOT NULL DEFAULT '{}', reservation_bytes INTEGER NOT NULL DEFAULT 0,
        previous_generation INTEGER, resource_reservation_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS ports (
        task_id TEXT NOT NULL, generation INTEGER NOT NULL, port_name TEXT NOT NULL, protocol TEXT NOT NULL,
        host_port INTEGER NOT NULL, vm_port INTEGER NOT NULL, device_name TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (task_id, port_name, protocol), UNIQUE (host_port, protocol),
        FOREIGN KEY (task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, action TEXT NOT NULL, session_id TEXT, generation INTEGER,
        response_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, task_id TEXT, session_id TEXT, generation INTEGER,
        outcome TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  transaction<T>(callback: () => T): T {
    const outer = this.depth === 0;
    if (outer) this.db.run("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const value = callback();
      if (outer) this.db.run("COMMIT");
      return value;
    } catch (error) {
      if (outer) this.db.run("ROLLBACK");
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  private row(sql: string, args: readonly unknown[] = []): Dict | undefined {
    const row = (this.db.query(sql) as any).get(...args as any[]) as Dict | null;
    return row ?? undefined;
  }

  private rows(sql: string, args: readonly unknown[] = []): Dict[] {
    return (this.db.query(sql) as any).all(...args as any[]) as Dict[];
  }

  getTask(key: { sessionId?: string; taskId?: string }): Dict | undefined {
    if ((key.sessionId === undefined) === (key.taskId === undefined)) throw new Error("provide exactly one task lookup key");
    return key.sessionId !== undefined ? this.row("SELECT * FROM tasks WHERE session_id = ?", [key.sessionId]) : this.row("SELECT * FROM tasks WHERE task_id = ?", [key.taskId]);
  }

  listTasks(): Dict[] { return this.rows("SELECT * FROM tasks ORDER BY created_at"); }

  putTask(task: Dict): void {
    const fields = [...TASK_FIELDS].filter((field) => task[field] !== undefined);
    const defaults: Dict = { resources_json: "{}", reservation_bytes: 0n, resource_reservation_json: "{}" };
    const values = fields.map((field) => task[field] ?? defaults[field] ?? null);
    this.transaction(() => {
      this.db.run(`INSERT INTO tasks (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")}) ON CONFLICT(task_id) DO UPDATE SET ${fields.filter((field) => field !== "task_id" && field !== "created_at").map((field) => `${field}=excluded.${field}`).join(",")}`, ...values);
    });
  }

  updateTask(taskId: string, changes: Dict = {}): Dict {
    if (!Object.keys(changes).length) {
      const task = this.getTask({ taskId });
      if (!task) throw new ControlError("task_missing", `task not found: ${taskId}`);
      return task;
    }
    const updated = { ...changes, updated_at: isoTime() };
    for (const field of Object.keys(updated)) if (!TASK_FIELDS.has(field)) throw new Error(`invalid task field: ${field}`);
    this.transaction(() => (this.db as any).run(`UPDATE tasks SET ${Object.keys(updated).map((field) => `${field} = ?`).join(", ")} WHERE task_id = ?`, ...Object.values(updated), taskId));
    const task = this.getTask({ taskId });
    if (!task) throw new ControlError("task_missing", `task not found: ${taskId}`);
    return task;
  }

  getPorts(taskId: string, state?: string): Dict[] {
    return state === undefined ? this.rows("SELECT * FROM ports WHERE task_id = ? ORDER BY port_name, protocol", [taskId]) : this.rows("SELECT * FROM ports WHERE task_id = ? AND state = ? ORDER BY port_name, protocol", [taskId, state]);
  }

  getPort(taskId: string, portName: string, protocol: string): Dict | undefined { return this.row("SELECT * FROM ports WHERE task_id = ? AND port_name = ? AND protocol = ?", [taskId, portName, protocol]); }

  putPort(port: Dict): void {
    const fields = [...PORT_FIELDS];
    this.transaction(() => (this.db as any).run(`INSERT INTO ports (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")}) ON CONFLICT(task_id,port_name,protocol) DO UPDATE SET ${fields.filter((field) => !["task_id", "port_name", "protocol", "created_at"].includes(field)).map((field) => `${field}=excluded.${field}`).join(",")}`, ...fields.map((field) => port[field])));
  }

  updatePort(taskId: string, portName: string, protocol: string, changes: Dict): void {
    for (const field of Object.keys(changes)) if (!PORT_FIELDS.has(field)) throw new Error(`invalid port field: ${field}`);
    if (!Object.keys(changes).length) return;
    this.transaction(() => (this.db as any).run(`UPDATE ports SET ${Object.keys(changes).map((field) => `${field} = ?`).join(", ")} WHERE task_id = ? AND port_name = ? AND protocol = ?`, ...Object.values(changes), taskId, portName, protocol));
  }

  removePort(taskId: string, portName: string, protocol: string): void { this.transaction(() => (this.db as any).run("DELETE FROM ports WHERE task_id = ? AND port_name = ? AND protocol = ?", taskId, portName, protocol)); }

  occupiedPorts(protocol?: string): Set<number> {
    const rows = protocol === undefined ? this.rows("SELECT host_port FROM ports WHERE state != 'removed'") : this.rows("SELECT host_port FROM ports WHERE protocol = ? AND state != 'removed'", [protocol]);
    return new Set(rows.map((row) => Number(row.host_port)));
  }

  operation(operationId: string): Dict | undefined {
    const row = this.row("SELECT response_json FROM operations WHERE operation_id = ?", [operationId]);
    return row ? parseJson(String(row.response_json)) as Dict : undefined;
  }

  recordOperation(operationId: string, action: string, sessionId: string | undefined, generation: unknown, response: Dict): void {
    this.transaction(() => (this.db as any).run("INSERT OR REPLACE INTO operations(operation_id,action,session_id,generation,response_json,created_at) VALUES (?,?,?,?,?,?)", operationId, action, sessionId ?? null, generation ?? null, stableJson(response), isoTime()));
  }

  audit(action: string, outcome: string, detail?: unknown, taskId?: string, sessionId?: string, generation?: unknown): void {
    this.transaction(() => (this.db as any).run("INSERT INTO audit(action,task_id,session_id,generation,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?)", action, taskId ?? null, sessionId ?? null, generation ?? null, outcome, detail === undefined ? null : stableJson(detail), isoTime()));
  }

  getMeta(key: string): string | undefined { const row = this.row("SELECT value FROM meta WHERE key = ?", [key]); return row ? String(row.value) : undefined; }

  setMeta(key: string, value: string): void { this.transaction(() => (this.db as any).run("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)); }
}

function chmodPrivate(path: string): void {
  const fd = openSync(path, constants.O_WRONLY);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
}

let flockNative: ((fd: number, operation: number) => number) | undefined;
function flock(fd: number, operation: number): void {
  flockNative ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: ["int", "int"], returns: "int" } }).symbols.flock as (fd: number, operation: number) => number;
  if (flockNative(fd, operation) !== 0) throw new Error("flock failed");
}

async function withFileLock<T>(path: string, callback: () => T | Promise<T>, blocking = true, shared = false): Promise<T> {
  const release = acquireFileLock(path, blocking, shared);
  try { return await callback(); } finally { release(); }
}

function acquireFileLock(path: string, blocking = true, shared = false): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const noFollow = (constants as any).O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | noFollow, 0o600);
  try {
    try { flock(fd, (shared ? 1 : 2) | (blocking ? 0 : 4)); } catch (error) {
      closeSync(fd);
      if (!blocking) throw new ControlError("object_busy", "resource is being changed");
      throw new ControlError("lock_failed", "native lock could not be acquired");
    }
  } catch (error) {
    try { closeSync(fd); } catch { /* The descriptor is already closed. */ }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { flock(fd, 8); } catch { /* The descriptor is being closed. */ }
    closeSync(fd);
  };
}

function acquireWriterIntent(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const noFollow = (constants as any).O_NOFOLLOW ?? 0;
  const path = join(directory, `native-writer-${randomUUID()}`);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  const token = randomUUID();
  const writeMarker = (value: string): void => {
    const bytes = Buffer.from(value, "utf8");
    ftruncateSync(fd, 0);
    writeSync(fd, bytes, 0, bytes.length, 0);
  };
  try {
    // Publish a pending marker before taking the lock. Readers treat this
    // state as active, so a marker cannot be reclaimed in the pre-flock gap.
    writeMarker(`pending ${process.pid} ${token}\n`);
    fsyncSync(fd);
    flock(fd, 2);
    writeMarker(`ready__ ${process.pid} ${token}\n`);
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* The descriptor is already closed. */ }
    try { unlinkSync(path); } catch { /* The marker may not have been created. */ }
    throw new ControlError("lock_failed", "native writer intent could not be acquired");
  }
  nativeWriterIntentPaths.add(path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    nativeWriterIntentPaths.delete(path);
    try { flock(fd, 8); } catch { /* The descriptor is being closed. */ }
    closeSync(fd);
    try { unlinkSync(path); } catch { /* Marker cleanup is best effort. */ }
  };
}

function hasWriterIntent(directory: string): boolean {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let active = false;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith("native-writer-")) continue;
    const path = join(directory, name);
    if (nativeWriterIntentPaths.has(path)) { active = true; continue; }
    const noFollow = (constants as any).O_NOFOLLOW ?? 0;
    let fd: number | undefined;
    let stale = false;
    try {
      fd = openSync(path, constants.O_RDWR | noFollow);
      const marker = String(readFileSync(fd, "utf8"));
      if (marker.startsWith("pending ")) {
        const pid = Number(marker.split(/\s+/, 3)[1]);
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(pid, 0); active = true; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") active = true;
            else { try { flock(fd, 2 | 4); stale = true; } catch { active = true; } }
          }
        } else active = true;
      } else if (marker.startsWith("ready__ ")) {
        try { flock(fd, 2 | 4); stale = true; } catch { active = true; }
      } else active = true;
    } catch { active = true; }
    finally { if (fd !== undefined) closeSync(fd); }
    if (stale) try { unlinkSync(path); } catch { /* Another process may have reclaimed it. */ }
  }
  return active;
}

export class SystemdManager {
  constructor(readonly runner: CommandRunner, readonly config: Dict, readonly enabled = true) {
    if (enabled) {
      try { validateProtectedDirectory(String(config.timer_dir)); } catch (error) {
        if (error instanceof ControlError) throw error;
        throw new ControlError("config_invalid", "timer directory cannot be verified");
      }
    }
  }

  private get timerDir(): string { return String(this.config.timer_dir); }

  static timerUnit(taskId: string, generation: IntegerValue): string {
    if (!TASK_ID_RE.test(taskId) || integerBigInt(generation, "generation") < 1n) throw new ControlError("invalid_timer", "invalid task timer identity");
    return `agent-vm-native-expire-${taskId}-g${integerText(generation)}.timer`;
  }

  static instanceName(taskId: string, generation: IntegerValue): string { return `${taskId}-g${integerText(generation)}`; }

  private async systemctl(...args: string[]): Promise<void> { if (this.enabled) await this.runner.run(["systemctl", ...args], { timeout: 30 }); }

  async scheduleExpiry(taskId: string, generation: IntegerValue, expiresAt: string): Promise<string> {
    const unit = SystemdManager.timerUnit(taskId, generation);
    const date = parseTime(expiresAt);
    if (!date) throw new ControlError("lease_missing", "active task has no lease expiry");
    const content = `[Unit]\nDescription=Expire native agent VM lease\nAfter=agent-vm-native-reconcile.service\n\n[Timer]\nOnCalendar=${date.toISOString().replace("T", " ").replace(".000Z", " UTC")}\nPersistent=yes\nAccuracySec=1s\nRandomizedDelaySec=0\nUnit=agent-vm-native-expire@${SystemdManager.instanceName(taskId, generation)}.service\n\n[Install]\nWantedBy=timers.target\n`;
    if (this.enabled) {
      mkdirSync(this.timerDir, { recursive: true, mode: 0o755 });
      const tempDir = mkdtempSync(join(this.timerDir, ".agent-vm-timer-"));
      const temp = join(tempDir, unit);
      writeFileSync(temp, content, { mode: 0o600 });
      const fd = openSync(temp, constants.O_WRONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, join(this.timerDir, unit));
      try { rmdirSync(tempDir); } catch { /* Directory cleanup is best effort. */ }
      await this.systemctl("daemon-reload");
      await this.systemctl("enable", "--now", unit);
      await this.systemctl("restart", unit);
    }
    return unit;
  }

  async removeExpiry(taskId: string, generation: IntegerValue): Promise<string> {
    const unit = SystemdManager.timerUnit(taskId, generation);
    const path = join(this.timerDir, unit);
    try {
      await this.systemctl("disable", "--now", unit);
    } catch (error) {
      if (!(error instanceof ControlError) || error.code !== "command_failed" || !this.enabled) throw error;
      let probe: CompletedProcess;
      try {
        probe = await this.runner.run(["systemctl", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "FragmentPath", "-p", "UnitFileState"], { timeout: 10, check: false });
      } catch { throw error; }
      const properties: Dict = {};
      for (const line of decode(probe.stdout).split(/\r?\n/)) { const index = line.indexOf("="); if (index >= 0) properties[line.slice(0, index)] = line.slice(index + 1); }
      let pathExists = false;
      try { lstatSync(path); pathExists = true; } catch (pathError) { if ((pathError as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((probe.returncode !== 0 && probe.returncode !== 1) || stableJson(properties) !== stableJson({ LoadState: "not-found", ActiveState: "inactive", FragmentPath: "", UnitFileState: "" }) || pathExists) throw error;
    }
    if (this.enabled) { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await this.systemctl("daemon-reload"); }
    return unit;
  }

  async enablePeriodicUnits(): Promise<void> { await this.systemctl("daemon-reload"); await this.systemctl("enable", "--now", "agent-vm-native-age-gc.timer"); await this.systemctl("enable", "agent-vm-native-reconcile.service"); }
  async retryCleanup(taskId: string, generation: IntegerValue): Promise<void> { await this.systemctl("start", "--no-block", `agent-vm-native-expire@${SystemdManager.instanceName(taskId, generation)}.service`); }
}

export class Control {
  static readonly WRITE_ACTIONS = new Set(["acquire", "renew", "release", "destroy", "restart", "resize", "port-add", "port-remove", "drain-enter", "drain-exit", "admin-reconcile", "admin-gc"]);
  static readonly SESSION_ACTIONS = new Set(["status", "acquire", "renew", "release", "destroy", "restart", "resize", "ssh-info", "port-add", "port-list", "port-remove"]);
  static readonly ACTIVE_STATES = new Set(["preparing", "active"]);
  static readonly TRANSITION_STATES = new Set(["preparing", "closing", "deleting"]);
  readonly config: Dict;
  readonly runner: CommandRunner;
  readonly store: StateStore;
  readonly incus: IncusClient;
  readonly systemd: SystemdManager;
  readonly resources: CTResources;
  private readonly clock: () => Date;
  private readonly sleepFor: (milliseconds: number) => Promise<void>;
  private readonly lockPath: string;
  private readonly which: (command: string) => string | null;
  private readonly nativeLockState = new Map<string, number>();
  private expectedVmIp: string | undefined;

  constructor(config: Dict, options: { runner?: CommandRunner; store?: StateStore; systemd?: SystemdManager; clock?: () => Date; sleep?: (milliseconds: number) => Promise<void>; resources?: CTResources; which?: (command: string) => string | null } = {}) {
    this.config = { ...config };
    this.runner = options.runner ?? new CommandRunner();
    this.store = options.store ?? new StateStore(String(this.config.state_db));
    this.incus = new IncusClient(this.runner, this.config);
    this.systemd = options.systemd ?? new SystemdManager(this.runner, this.config);
    this.clock = options.clock ?? (() => new Date());
    this.sleepFor = options.sleep ?? sleep;
    this.resources = options.resources ?? new CTResources();
    this.which = options.which ?? ((command) => Bun.which(command));
    this.lockPath = join(dirname(this.store.path), "control.lock");
  }

  now(): Date { return this.clock(); }

  private async globalLock<T>(callback: () => T | Promise<T>): Promise<T> { return withFileLock(this.lockPath, callback, true); }

  private async objectLock<T>(identity: string, callback: () => T | Promise<T>, blocking = true): Promise<T> {
    return withFileLock(join(dirname(this.store.path), "locks", sha256(identity)), callback, blocking);
  }

  private async nativeBarrier<T>(callback: () => T | Promise<T>, exclusive = false): Promise<T> {
    const lockPath = join(dirname(this.store.path), "locks", sha256("native:barrier"));
    const turnstilePath = join(dirname(this.store.path), "locks", sha256("native:barrier:turnstile"));
    const lockDirectory = dirname(turnstilePath);
    const releaseWriter = exclusive ? acquireWriterIntent(lockDirectory) : undefined;
    try {
      while (true) {
        const releaseGate = acquireFileLock(turnstilePath, true, false);
        let releaseLocal: (() => void) | undefined;
        let releaseNative: (() => void) | undefined;
        let blockedByWriter = false;
        try {
          blockedByWriter = !exclusive && hasWriterIntent(lockDirectory);
          if (!blockedByWriter) {
            releaseLocal = await acquireNativeBarrier(lockPath, exclusive);
            releaseNative = acquireFileLock(lockPath, true, !exclusive);
            releaseGate();
            return await callback();
          }
        } finally {
          releaseNative?.();
          releaseLocal?.();
          releaseGate();
        }
        if (blockedByWriter) await Bun.sleep(5);
      }
    } finally {
      releaseWriter?.();
    }
  }

  private async nativeLock<T>(task: Dict, callback: () => T | Promise<T>): Promise<T> {
    const identity = String(task.session_id);
    const depth = this.nativeLockState.get(identity) ?? 0;
    if (depth > 0) {
      this.nativeLockState.set(identity, depth + 1);
      try { return await callback(); } finally { this.nativeLockState.set(identity, depth); }
    }
    return this.objectLock(`native:${identity}`, async () => {
      this.nativeLockState.set(identity, 1);
      try { return await callback(); } finally { this.nativeLockState.delete(identity); }
    });
  }

  async dispatch(request: Dict): Promise<Dict> {
    if (!isDict(request)) throw new ControlError("invalid_request", "request must be an object");
    const action = requiredString(requiredOwn(request, "action"), "action");
    let session = hasOwn(request, "session_id") ? request.session_id : undefined;
    if (action === "timer-expire") {
      const task = this.store.getTask({ taskId: String(requiredOwn(request, "task_id")) });
      session = task?.session_id ?? "missing-timer";
      if (requiredOwn(request, "protocol") !== PROTOCOL_VERSION) throw new ControlError("protocol_mismatch", "unsupported timer protocol");
      await this.expirePreempt(request);
    }
    const identity = Control.SESSION_ACTIONS.has(String(action)) || action === "timer-expire" ? `session:${String(session)}` : "admin";
    return this.objectLock(identity, async () => {
      if (Control.WRITE_ACTIONS.has(String(action))) {
        const operationId = requiredString(request.operation_id, "operation_id", SESSION_ID_RE);
        return this.objectLock(`operation:${operationId}`, () => this.dispatchLocked(request));
      }
      return this.dispatchLocked(request);
    });
  }

  private async expirePreempt(request: Dict): Promise<void> {
    const taskId = requiredString(requiredOwn(request, "task_id"), "task_id", TASK_ID_RE);
    const generation = numberFromInteger(requiredOwn(request, "generation"), "generation", 1);
    let task = this.store.getTask({ taskId });
    if (!task || !sameInteger(task.generation, generation)) return;
    const expiry = parseTime(task.lease_expires_at);
    if (!Control.ACTIVE_STATES.has(String(task.state)) || (expiry && expiry.getTime() > this.now().getTime())) return;
    await this.nativeLock(task, async () => {
      task = await this.nativeBarrier(() => this.globalLock(() => this.store.transaction(() => {
          const current = this.store.getTask({ taskId });
          if (!current || !sameInteger(current.generation, generation)) return undefined;
          const currentExpiry = parseTime(current.lease_expires_at);
          if (!Control.ACTIVE_STATES.has(String(current.state)) || (currentExpiry && currentExpiry.getTime() > this.now().getTime())) return undefined;
          const inactive = parseTime(current.inactive_since) ?? new Date(Math.min(this.now().getTime(), currentExpiry?.getTime() ?? this.now().getTime()));
          return this.store.updateTask(taskId, {
            state: "closing", lease_expires_at: null, inactive_since: isoTime(inactive),
            cleanup_after: isoTime(new Date(inactive.getTime() + Number(this.config.cache_seconds) * 1000)),
          });
        })));
    });
    if (!task) return;
    try {
      await this.objectLock(`cleanup:${task.session_id}`, async () => {
        const current = await this.cleanupCurrent(task as Dict);
        if (!current) return;
        const [errors, completed] = await this.cleanupTask(current);
        if (errors.length) this.store.updateTask(String(task?.task_id), { last_error: stableJson({ errors, completed }) });
      });
    } catch (error) {
      const detail = error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name };
      this.store.updateTask(task.task_id, { last_error: stableJson(detail) });
    }
  }

  private async dispatchLocked(request: Dict): Promise<Dict> {
    if (!isDict(request)) throw new ControlError("invalid_request", "request must be an object");
    if (requiredOwn(request, "protocol") !== PROTOCOL_VERSION) throw new ControlError("protocol_mismatch", `protocol must be ${PROTOCOL_VERSION}`);
    const action = requiredString(requiredOwn(request, "action"), "action");
    const sessionId = Control.SESSION_ACTIONS.has(action) ? requiredString(requiredOwn(request, "session_id"), "session_id", SESSION_ID_RE) : !hasOwn(request, "session_id") || request.session_id === undefined || request.session_id === null ? undefined : requiredString(request.session_id, "session_id", SESSION_ID_RE);
    let operationId: string | undefined;
    if (hasOwn(request, "operation_id") && request.operation_id !== null && request.operation_id !== undefined) operationId = requiredString(request.operation_id, "operation_id", SESSION_ID_RE);
    let digest: string | undefined;
    if (Control.WRITE_ACTIONS.has(action)) {
      operationId = requiredString(requiredOwn(request, "operation_id"), "operation_id", SESSION_ID_RE);
      digest = requestDigest(request);
      const cached = this.store.operation(operationId);
      if (cached) {
        if (cached._request_digest !== digest) throw new ControlError("operation_conflict", "operation ID belongs to a different request");
        if (cached.outcome === "pending") throw new ControlError("operation_incomplete", "previous execution has an uncertain outcome; inspect status and reconcile before another mutation", { operation_id: operationId });
        if (cached.outcome === "error") {
          const error = cached.error;
          throw new ControlError(error.code, error.message, error.detail);
        }
        const response: Dict = { ...cached, server_time: isoTime(this.now()), outcome: "replayed" };
        delete response._request_digest;
        if (sessionId) {
          const task = this.store.getTask({ sessionId });
          response.current_state = task ? this.stateSummary(task) : null;
          if (action === "renew" && task && this.stateSummary(task).effective_lease) await this.scheduleExpiry(task);
        }
        return validateSuccessEnvelope(response, action, sessionId, operationId);
      }
      numberFromInteger(requiredOwn(request, "generation"), "generation", 0);
      if (action !== "renew") await this.globalLock(() => this.store.recordOperation(operationId!, action, sessionId, request.generation, { outcome: "pending", _request_digest: digest }));
    }
    try {
      const result = await this.dispatchAction(action, request, sessionId);
      const response: Dict = { ok: true, protocol: PROTOCOL_VERSION, server_time: isoTime(this.now()), action, session_id: sessionId ?? null, generation: action === "status" ? result.generation ?? null : request.generation ?? null, operation_id: operationId ?? null, outcome: "success", result };
      const validated = validateSuccessEnvelope(response, action, sessionId, operationId);
      await this.globalLock(() => {
        if (operationId && Control.WRITE_ACTIONS.has(action) && action !== "renew") this.store.recordOperation(operationId, action, sessionId, request.generation, { ...response, _request_digest: digest });
        if (sessionId) this.store.audit(action, "ok", result, undefined, sessionId, request.generation);
      });
      return validated;
    } catch (error) {
      if (error instanceof ControlError) {
        await this.globalLock(() => {
          if (operationId && Control.WRITE_ACTIONS.has(action)) {
            const saved = this.store.operation(operationId);
            if (!saved || saved.outcome !== "success") this.store.recordOperation(operationId, action, sessionId, request.generation, { outcome: "error", error: error.asDict(), _request_digest: digest });
          }
          if (sessionId) this.store.audit(action, "error", error.asDict(), undefined, sessionId, request.generation);
        });
      }
      throw error;
    }
  }

  private async dispatchAction(action: string, request: Dict, sessionId: string | undefined): Promise<Dict> {
    switch (action) {
      case "doctor": return this.doctor(request, sessionId);
      case "status": return this.status(request, sessionId as string);
      case "acquire": return this.acquire(request, sessionId as string);
      case "renew": return this.renew(request, sessionId as string);
      case "release": return this.release(request, sessionId as string);
      case "destroy": return this.destroy(request, sessionId as string);
      case "restart": return this.restart(request, sessionId as string);
      case "resize": return this.resize(request, sessionId as string);
      case "ssh-info": return this.sshInfo(request, sessionId as string);
      case "port-add": return this.portAdd(request, sessionId as string);
      case "port-list": return this.portList(request, sessionId as string);
      case "port-remove": return this.portRemove(request, sessionId as string);
      case "admin-status": return this.adminStatus(request, sessionId);
      case "drain-status": return this.drainStatus(request, sessionId);
      case "drain-enter": return this.drainEnter(request, sessionId);
      case "drain-exit": return this.drainExit(request, sessionId);
      case "admin-session-list": return this.adminSessionList(request, sessionId);
      case "admin-reconcile": return this.adminReconcile(request, sessionId);
      case "admin-gc": return this.adminGc(request, sessionId);
      case "timer-expire": return this.timerExpire(request, sessionId);
      case "timer-age-gc": return this.timerAgeGc(request, sessionId);
      case "timer-reconcile": return this.timerReconcile(request, sessionId);
      default: throw new ControlError("unknown_action", `unknown action: ${action}`);
    }
  }

  private taskForSession(sessionId: string): Dict {
    const task = this.store.getTask({ sessionId });
    if (!task || task.state === "absent") throw new ControlError("task_missing", "no VM lease exists for this session");
    return task;
  }

  private checkGeneration(task: Dict | undefined, request: Dict): void {
    if (!task) throw new ControlError("task_missing", "task not found");
    const generation = numberFromInteger(request.generation, "generation", 0);
    if (!sameInteger(generation, task.generation)) throw new ControlError("generation_mismatch", "request generation does not match current task generation", { current_generation: integerForJson(task.generation) });
  }

  private baseTask(sessionId: string, generation: IntegerValue): Dict {
    const taskId = `avm-${randomBytes(8).toString("hex")}`;
    const now = isoTime(this.now());
    return { task_id: taskId, session_id: sessionId, generation, state: "preparing", instance_name: `agent-vm-${taskId}`, vm_ip: null, ssh_host_port: null, lease_expires_at: null, inactive_since: null, cleanup_after: null, created_at: now, updated_at: now, last_error: null, image_fingerprint: this.config.image_fingerprint };
  }

  private async ownership(task: Dict): Promise<Dict> {
    const info = await this.incus.configShow(String(task.instance_name));
    nativeDeviceMaps(info, "mapping_unverified");
    const config = isDict(info.config) ? info.config : {};
    const expected = { "user.agent-vm.managed": "native-v1", "user.agent-vm.task": task.task_id, "user.agent-vm.session": task.session_id };
    const generations = new Set([String(task.generation)]);
    if (["preparing", "closing"].includes(String(task.state)) && task.previous_generation !== null && task.previous_generation !== undefined) generations.add(String(task.previous_generation));
    const valid = Object.entries(expected).every(([key, value]) => config[key] === value) && generations.has(String(config["user.agent-vm.generation"]));
    if (!valid) throw new ControlError("ownership_mismatch", "native instance identity differs from durable ownership; refusing mutation");
    return info;
  }

  private async assertNoNativeProxies(task: Dict, code = "cache_ineligible"): Promise<void> {
    const proxies = nativeProxyNames(await this.ownership(task), code);
    if (proxies.size) throw new ControlError(code, "native proxy mappings remain outside durable reservations", { device_names: [...proxies].sort(compareUnicodeCodePoints) });
  }

  private async nativeOperationCurrent(task: Dict): Promise<Dict> {
    const current = this.store.getTask({ taskId: String(task.task_id) });
    const expiry = current ? parseTime(current.lease_expires_at) : undefined;
    if (!current || !sameInteger(current.generation, task.generation) || current.instance_name !== task.instance_name || !["preparing", "active"].includes(String(current.state)) || !expiry || expiry.getTime() <= this.now().getTime()) throw new ControlError("lease_expired", "native operation was revoked before its effect");
    if (this.store.getMeta("draining") === "1") throw new ControlError("draining", "native effects are refused while draining");
    return current;
  }

  private async cleanupOperationCurrent(task: Dict, allowActive = false): Promise<Dict> {
    const current = this.store.getTask({ taskId: String(task.task_id) });
    const validState = current?.state === "closing" || (allowActive && current?.state === "active");
    if (!current || !sameInteger(current.generation, task.generation) || current.instance_name !== task.instance_name || !validState) throw new ControlError("stale_cleanup", "cleanup generation or state changed before its effect");
    return current;
  }

  private async deletionOperationCurrent(task: Dict): Promise<Dict> {
    const current = this.store.getTask({ taskId: String(task.task_id) });
    if (!current || !sameInteger(current.generation, task.generation) || current.instance_name !== task.instance_name || current.state !== "deleting") throw new ControlError("stale_cleanup", "deletion generation or state changed before its effect");
    return current;
  }

  private async nativeConfigSet(task: Dict, key: string, value: string): Promise<void> {
    await this.nativeLock(task, async () => {
      await this.nativeBarrier(async () => {
        const current = await this.nativeOperationCurrent(task);
        await this.ownership(current);
        await this.nativeOperationCurrent(current);
        await this.incus.configSet(String(current.instance_name), key, value);
      });
    });
  }

  private async nativeDeviceSet(task: Dict, device: string, key: string, value: string): Promise<void> {
    await this.nativeLock(task, async () => {
      await this.nativeBarrier(async () => {
        const current = await this.nativeOperationCurrent(task);
        await this.ownership(current);
        await this.nativeOperationCurrent(current);
        await this.incus.deviceSet(String(current.instance_name), device, key, value);
      });
    });
  }

  private async nativeGuestExec(task: Dict, argv: string[], options: RunOptions = {}, effect = true): Promise<CompletedProcess> {
    return this.nativeLock(task, async () => {
      const run = async (): Promise<CompletedProcess> => {
        const current = await this.nativeOperationCurrent(task);
        if (effect) await this.ownership(current);
        await this.nativeOperationCurrent(current);
        return this.incus.exec(String(current.instance_name), argv, options);
      };
      return effect ? this.nativeBarrier(run) : run();
    });
  }

  private async startInstance(task: Dict): Promise<void> { await this.nativeLock(task, async () => { await this.nativeBarrier(async () => { const current = await this.nativeOperationCurrent(task); await this.ownership(current); await this.nativeOperationCurrent(current); await this.incus.start(String(current.instance_name)); }); }); }
  private async stopInstance(task: Dict): Promise<void> { await this.nativeLock(task, async () => { await this.nativeBarrier(async () => { const current = await this.nativeOperationCurrent(task); await this.ownership(current); await this.nativeOperationCurrent(current); await this.incus.stop(String(current.instance_name), true); }); }); }

  private stateSummary(task: Dict): Dict {
    const result: Dict = { task_id: task.task_id, session_id: task.session_id, generation: integerForJson(task.generation), state: task.state, instance_name: task.instance_name, vm_ip: task.vm_ip, ssh_host_port: task.ssh_host_port === null ? null : Number(task.ssh_host_port), lease_expires_at: task.lease_expires_at, inactive_since: task.inactive_since, cleanup_after: task.cleanup_after };
    if (task.last_error) result.last_error = parseJson(String(task.last_error));
    result.ports = this.store.getPorts(String(task.task_id));
    result.resources = parseJson(String(task.resources_json || "{}"));
    result.resource_reservation = parseJson(String(task.resource_reservation_json || "{}"));
    const expiry = parseTime(task.lease_expires_at);
    result.effective_lease = task.state === "active" && Boolean(expiry && expiry.getTime() > this.now().getTime());
    return result;
  }

  private async runtimeSummary(task: Dict): Promise<Dict> {
    const result = this.stateSummary(task);
    result.guest_available = false;
    if (task.state === "absent") { result.native_status = "absent"; return result; }
    try {
      await this.ownership(task);
      result.native_status = String((await this.incus.instanceInfo(String(task.instance_name))).status);
      result.guest_available = result.effective_lease && result.native_status.toLowerCase() === "running";
      if (result.effective_lease && !result.guest_available) result.guest_error = { code: "guest_unavailable", cause: "unknown", message: "effective lease has no running guest; inspect before explicit restart" };
    } catch (error) {
      result.native_status = "unverified";
      result.guest_error = error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name };
    }
    return result;
  }

  private requestedResources(request: Dict, base: Dict, activeReuse = false): Dict {
    const target = { ...base };
    for (const [key, minimum, maximum] of [["cpu", 1, 16], ["memory_mib", 512, 65536], ["disk_gib", 20, 4096]] as const) if (request[key] !== undefined && request[key] !== null) target[key] = numberFromInteger(request[key], key, minimum, maximum);
    if (!activeReuse && target.disk_gib < base.disk_gib) throw new ControlError("resize_not_growth", "virtual disk cannot shrink", { current: base, requested: target });
    return target;
  }

  private ensureCapacityVerified(): Dict {
    let usage: { blocks: bigint; bfree: bigint; bavail: bigint; bsize: bigint };
    try {
      usage = statfsSync(String(this.config.storage_path), { bigint: true }) as unknown as typeof usage;
    } catch {
      throw new ControlError("capacity_unverified", "cannot measure CT Incus pool filesystem");
    }
    const totalBig = usage.blocks * usage.bsize;
    const freeBig = usage.bavail * usage.bsize;
    if (totalBig <= 0n || freeBig < 0n || freeBig > totalBig) throw new ControlError("capacity_unverified", "invalid CT filesystem capacity");
    const reportInteger = (value: bigint): IntegerValue => integerForJson(value);
    const lowMinimum = bigintFromInteger(this.config.disk_low_bytes ?? 10n * 1024n ** 3n, "disk_low_bytes");
    const targetMinimum = bigintFromInteger(this.config.disk_target_bytes ?? 20n * 1024n ** 3n, "disk_target_bytes");
    const low = lowMinimum > (totalBig * 15n) / 100n ? lowMinimum : (totalBig * 15n) / 100n;
    const target = targetMinimum > (totalBig * 25n) / 100n ? targetMinimum : (totalBig * 25n) / 100n;
    const layer: Dict = { label: "ct-filesystem", total: reportInteger(totalBig), free: reportInteger(freeBig), kind: "data", low: reportInteger(low), target: reportInteger(target) };
    if (target >= totalBig || low >= target) throw new ControlError("watermarks_unreachable", "configure reachable CT storage watermarks", layer);
    return { scope: "ct-filesystem", observed_at: isoTime(this.now()), layers: [layer] };
  }

  private storageHeadroom(requestCost = 0n): Dict {
    const facts = this.ensureCapacityVerified();
    facts.request_cost = requestCost;
    return facts;
  }

  private spaceSufficient(facts: Dict, cost: bigint, threshold: "low" | "target", excludeTaskId?: string): boolean {
    const reserved = this.store.listTasks().filter((task) => task.task_id !== excludeTaskId).reduce((total, task) => total + bigintFromInteger(task.reservation_bytes ?? 0n, "reservation_bytes"), 0n);
    return (facts.layers as Dict[]).every((layer) => BigInt(layer.free) - cost - reserved >= BigInt(layer[threshold]));
  }

  private async eligibleCache(snapshot: Dict): Promise<Dict> {
    const task = this.store.getTask({ taskId: String(snapshot.task_id) });
    if (!task || task.state !== "cached" || !task.inactive_since) throw new ControlError("cache_ineligible", "not an eligible stopped cache");
    if (!sameInteger(task.generation, snapshot.generation) || task.session_id !== snapshot.session_id) throw new ControlError("cache_ineligible", "cache ownership or generation changed");
    const expiry = parseTime(task.lease_expires_at);
    if (expiry && expiry.getTime() > this.now().getTime()) throw new ControlError("cache_ineligible", "cache still has an effective deadline");
    await this.assertNoNativeProxies(task);
    const state = await this.incus.instanceInfo(String(task.instance_name));
    if (String(state.status).toLowerCase() !== "stopped" || this.store.getPorts(String(task.task_id)).length) throw new ControlError("cache_ineligible", "cache is running or has unreclaimed mappings");
    return task;
  }

  private async deleteCache(task: Dict): Promise<void> {
    task = await this.eligibleCache(task);
    await this.globalLock(() => this.store.updateTask(String(task.task_id), { state: "deleting" }));
    try {
      await this.nativeLock(task, async () => {
        const current = await this.deletionOperationCurrent(task);
        await this.ownership(current);
        await this.nativeBarrier(async () => {
          await this.deletionOperationCurrent(current);
          await this.ownership(current);
          await this.incus.delete(String(current.instance_name));
        });
        if ((await this.incus.listInstances()).some((item) => item.name === current.instance_name)) throw new ControlError("cleanup_incomplete", "native deletion is not confirmed");
      });
    } catch (error) {
      this.store.updateTask(String(task.task_id), { last_error: stableJson(error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name }) });
      throw error;
    }
    await this.globalLock(() => this.store.updateTask(String(task.task_id), { state: "absent", vm_ip: null, ssh_host_port: null, lease_expires_at: null, inactive_since: null, cleanup_after: null, reservation_bytes: 0n, last_error: null }));
  }

  private async reclaimCapacity(requestCost: bigint, excludeTaskId?: string): Promise<string[]> {
    const facts = this.storageHeadroom(requestCost);
    if (await this.globalLock(() => this.spaceSufficient(facts, requestCost, "low", excludeTaskId))) return [];
    const candidates = this.store.listTasks().filter((task) => task.state === "cached" && task.inactive_since && task.task_id !== excludeTaskId).sort((left, right) => String(left.inactive_since).localeCompare(String(right.inactive_since)));
    const reclaimed: string[] = [];
    for (const task of candidates) {
      const currentFacts = this.storageHeadroom(requestCost);
      if (await this.globalLock(() => this.spaceSufficient(currentFacts, requestCost, "target", excludeTaskId))) break;
      try {
        await this.objectLock(`session:${task.session_id}`, () => this.deleteCache(task), false);
        reclaimed.push(String(task.task_id));
      } catch (error) {
        if (error instanceof ControlError && ["object_busy", "cache_ineligible"].includes(error.code)) continue;
        throw new ControlError("reclaim_failed", "exact cache reclamation failed", error instanceof ControlError ? error.asDict() : undefined);
      }
    }
    const finalFacts = this.storageHeadroom(requestCost);
    if (!await this.globalLock(() => this.spaceSufficient(finalFacts, requestCost, "low", excludeTaskId))) throw new ControlError("capacity_insufficient", "capacity remains insufficient after eligible reclaim", { storage: finalFacts, reclaimed });
    return reclaimed;
  }

  private async resourcePolicy(): Promise<Dict> {
    const cpuBudget = numberFromInteger(this.config.cpu_budget, "cpu_budget", 1);
    const memoryBudget = numberFromInteger(this.config.memory_budget_mib, "memory_budget_mib", 512);
    const cpuRatio = this.config.cpu_overcommit_ratio?.numerator ? this.config.cpu_overcommit_ratio : ratio(this.config.cpu_overcommit_ratio ?? 4, "cpu_overcommit_ratio");
    const memoryRatio = this.config.memory_overcommit_ratio?.numerator ? this.config.memory_overcommit_ratio : ratio(this.config.memory_overcommit_ratio ?? 4, "memory_overcommit_ratio");
    const cpuCapacity = this.resources.cpu();
    const memory = this.resources.memory();
    const base = { cpu: cpuBudget, memory_mib: memoryBudget };
    const capacity = { cpu: integerForJson(BigInt(cpuCapacity)), memory_mib: integerForJson(BigInt(memory.limit_bytes) / 1024n ** 2n) };
    if (integerBigInt(base.cpu, "cpu_budget") > integerBigInt(capacity.cpu, "cpu capacity") || integerBigInt(base.memory_mib, "memory_budget_mib") > integerBigInt(capacity.memory_mib, "memory capacity")) throw new ControlError("resource_budget_invalid", "base budget exceeds CT-visible capacity", { base, ct_capacity: capacity });
    const project = await this.incus.query(`/1.0/projects/${quotePath(String(this.config.project))}`, { project: "default" });
    if (!isDict(project) || !isDict(project.config)) throw new ControlError("resource_unverified", "project resource configuration cannot be inspected");
    const conflicts: Dict = {};
    for (const key of ["limits.cpu", "limits.memory"]) if (project.config[key]) conflicts[key] = project.config[key];
    if (Object.keys(conflicts).length) throw new ControlError("project_resource_limits_conflict", "project aggregate quotas count stopped caches; authorized deployment must remove them", { project: this.config.project, conflicting_limits: conflicts });
    const countLimits = this.instanceCountLimits(project.config);
    if (Object.keys(countLimits).length) throw new ControlError("project_instance_limits_conflict", "project instance quotas include stopped caches; authorized deployment must remove them", { project: this.config.project, conflicting_limits: countLimits, instance_count: (await this.incus.listInstances()).length });
    return { base, ratios: { cpu: cpuRatio.diagnosticText, memory_mib: memoryRatio.diagnosticText }, limits: { cpu: integerForJson(floorRatio(integerBigInt(base.cpu, "cpu_budget"), cpuRatio)), memory_mib: integerForJson(floorRatio(integerBigInt(base.memory_mib, "memory_budget_mib"), memoryRatio)) }, ct_capacity: capacity, memory: { ...memory, observed_at: isoTime(this.now()) } };
  }

  private allocationTotals(excludeTaskId?: string): Dict {
    const totals = { cpu: 0n, memory_mib: 0n };
    for (const task of this.store.listTasks()) {
      if (task.task_id === excludeTaskId || ["absent", "cached"].includes(String(task.state))) continue;
      try {
        const values = parseJson(String(task.resources_json || "{}")) as Dict;
        const reservation = parseJson(String(task.resource_reservation_json || "{}")) as Dict;
        for (const key of ["cpu", "memory_mib"]) {
          const current = integerBigInt(values[key], key);
          const reserved = reservation[key] === undefined ? 0n : integerBigInt(reservation[key], key);
          totals[key as "cpu" | "memory_mib"] += current > reserved ? current : reserved;
        }
      } catch {
        throw new ControlError("resource_unverified", "occupied object lacks verified resource sizes");
      }
    }
    return { cpu: integerForJson(totals.cpu), memory_mib: integerForJson(totals.memory_mib) };
  }

  private async runningInventoryGuard(): Promise<void> {
    const instances = await this.incus.listInstances();
    const records = new Map(this.store.listTasks().map((task) => [String(task.instance_name), task]));
    for (const instance of instances) if (String(instance.status).toLowerCase() !== "stopped") {
      const record = records.get(String(instance.name));
      if (!record || ["absent", "cached"].includes(String(record.state))) throw new ControlError("resource_unverified", "unaccounted running native instance blocks admission");
    }
  }

  private async resourceDiagnostics(): Promise<Dict> {
    try {
      const policy = await this.resourcePolicy();
      await this.runningInventoryGuard();
      const allocated = await this.globalLock(() => this.store.transaction(() => this.allocationTotals()));
      return { verified: true, ...policy, allocated_and_reserved: allocated, remaining: { cpu: integerForJson(integerBigInt(policy.limits.cpu, "cpu limit") - integerBigInt(allocated.cpu, "allocated cpu")), memory_mib: integerForJson(integerBigInt(policy.limits.memory_mib, "memory limit") - integerBigInt(allocated.memory_mib, "allocated memory")) }, memory_pressure: policy.memory.available_bytes < policy.memory.threshold_bytes };
    } catch (error) {
      return { verified: false, error: error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name } };
    }
  }

  private instanceCountLimits(config: Dict): Dict {
    const result: Dict = {};
    for (const key of ["limits.instances", "limits.virtual-machines"]) if (config[key] !== undefined && config[key] !== null && config[key] !== "") result[key] = config[key];
    return result;
  }

  private async instanceDiagnostics(): Promise<Dict> {
    try {
      const project = await this.incus.query(`/1.0/projects/${quotePath(String(this.config.project))}`, { project: "default" });
      if (!isDict(project) || !isDict(project.config)) throw new ControlError("resource_unverified", "project count configuration cannot be inspected");
      const limits = this.instanceCountLimits(project.config);
      const instances = await this.incus.listInstances();
      const running = instances.filter((item) => String(item.status).toLowerCase() === "running").length;
      const stopped = instances.filter((item) => String(item.status).toLowerCase() === "stopped").length;
      const cachedNames = new Set(this.store.listTasks().filter((task) => task.state === "cached").map((task) => String(task.instance_name)));
      const cached = instances.filter((item) => cachedNames.has(String(item.name)) && String(item.status).toLowerCase() === "stopped").length;
      return { verified: true, total: instances.length, running, stopped, cached, other: instances.length - running - stopped, limits, policy_compliant: Object.keys(limits).length === 0 };
    } catch (error) {
      return { verified: false, error: error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name } };
    }
  }

  private async defaultAdmissionDiagnostics(resources: Dict, capacity: Dict, instances: Dict): Promise<Dict> {
    const requested = { cpu: 2, memory_mib: 4096, disk_gib: 20 };
    const reasons: Dict[] = [];
    if (this.store.getMeta("draining") === "1") reasons.push({ code: "draining", message: "new leases are refused" });
    if (!resources.verified) reasons.push(resources.error);
    else {
      const exceeded = ["cpu", "memory_mib"].filter((key) => (resources.remaining as Dict)[key] < (requested as Dict)[key]);
      if (exceeded.length) reasons.push({ code: "resource_insufficient", dimensions: exceeded, requested, remaining: resources.remaining });
      if (resources.memory_pressure) reasons.push({ code: "memory_pressure", memory: resources.memory });
    }
    if (!instances.verified) reasons.push(instances.error);
    else if (!instances.policy_compliant && !reasons.some((reason) => reason.code === "project_instance_limits_conflict")) reasons.push({ code: "project_instance_limits_conflict", conflicting_limits: instances.limits });
    let reclaimRequired = false;
    if (capacity.error) reasons.push(capacity.error);
    else {
      reclaimRequired = !await this.globalLock(() => this.spaceSufficient(capacity, bigintFromInteger(this.config.create_cost_bytes, "create_cost_bytes"), "low"));
      if (reclaimRequired) reasons.push({ code: "disk_reclaim_required", message: "default creation needs capacity reclamation" });
    }
    return { requested, request_cost_bytes: this.config.create_cost_bytes, ready: reasons.length === 0, reasons, reclaim_required: reclaimRequired };
  }

  private async reserveResources(task: Dict, resources: Dict, memoryReduction = false): Promise<Dict> {
    let policy: Dict | undefined;
    if (memoryReduction) {
      const old = parseJson(String(task.resources_json)) as Dict;
      if (task.state !== "active" || stableJson(resources) !== stableJson(old) || Object.keys(parseJson(String(task.resource_reservation_json || "{}")) as Dict).length) throw new ControlError("resize_unverified", "memory reduction requires an intact current allocation");
    } else {
      policy = await this.resourcePolicy();
      if (policy.memory.available_bytes < policy.memory.threshold_bytes) throw new ControlError("memory_pressure", "CT memory headroom is below the admission threshold", policy.memory);
      await this.runningInventoryGuard();
    }
    return this.globalLock(() => this.store.transaction(() => {
      if (this.store.getMeta("draining") === "1") throw new ControlError("draining", "new leases and capacity changes are refused while draining");
      const current = this.store.getTask({ taskId: String(task.task_id) });
      if (task.state === "active") {
        if (!current || !sameInteger(current.generation, task.generation)) throw new ControlError("generation_mismatch", "reservation generation changed");
        this.requireActive(current);
      } else if (current && !["absent", "cached"].includes(String(current.state)) && integerBigInt(current.generation, "generation") + 1n !== integerBigInt(task.generation, "generation")) throw new ControlError("generation_mismatch", "allocation slot changed before reservation");
      const totals = this.allocationTotals(String(task.task_id));
      const projectedBig = { cpu: integerBigInt(totals.cpu, "allocated cpu") + integerBigInt(resources.cpu, "cpu"), memory_mib: integerBigInt(totals.memory_mib, "allocated memory") + integerBigInt(resources.memory_mib, "memory_mib") };
      const projected = { cpu: integerForJson(projectedBig.cpu), memory_mib: integerForJson(projectedBig.memory_mib) };
      const exceeded = policy ? ["cpu", "memory_mib"].filter((key) => (projectedBig as Dict)[key] > integerBigInt((policy.limits as Dict)[key], `${key} limit`)) : [];
      if (exceeded.length) throw new ControlError("resource_insufficient", `allocation ceiling exceeded: ${exceeded.join(", ")}`, { dimensions: exceeded, requested: resources, other_allocated: totals, projected, base: policy?.base, limits: policy?.limits });
      const record = { ...task, resource_reservation_json: stableJson(resources), resources_json: task.resources_json || stableJson(resources) };
      this.store.putTask(record);
      return record;
    }));
  }

  private async reserveNative(task: Dict, cost: bigint, inventory?: Set<number>, sshPort?: unknown): Promise<Dict> {
    const facts = this.storageHeadroom(cost);
    const nativeIps = inventory ? await this.nativeIps(String(task.instance_name)) : new Set<string>();
    return this.globalLock(() => this.store.transaction(() => {
      const current = this.store.getTask({ taskId: String(task.task_id) });
      if (!current || !sameInteger(current.generation, task.generation) || !["active", "preparing"].includes(String(current.state))) throw new ControlError("generation_mismatch", "reservation changed before native admission");
      const expiry = parseTime(current.lease_expires_at);
      if (!expiry || expiry.getTime() <= this.now().getTime()) throw new ControlError("lease_expired", "lease expired before native admission");
      if (this.store.getMeta("draining") === "1") throw new ControlError("draining", "native admission is drained");
      if (!this.spaceSufficient(facts, cost, "low", String(task.task_id))) throw new ControlError("capacity_insufficient", "concurrent disk reservation consumed headroom");
      const record: Dict = { ...current, reservation_bytes: cost };
      if (inventory) {
        if (task.vm_ip && nativeIps.has(String(task.vm_ip))) throw new ControlError("vm_ip_busy", "cached VM address conflicts with native inventory");
        record.vm_ip = task.vm_ip || this.allocateVmIp(nativeIps);
        record.ssh_host_port = this.allocatePort("tcp", sshPort, inventory);
      }
      this.store.putTask(record);
      if (inventory) this.store.putPort(this.newPort(record, "ssh", "tcp", Number(record.ssh_host_port), 22));
      return record;
    }));
  }

  private async cancelResourceReservation(previous: Dict): Promise<void> {
    await this.globalLock(() => this.store.transaction(() => {
      const current = this.store.getTask({ taskId: String(previous.task_id) });
      if (current && sameInteger(current.generation, previous.generation) && current.state === "active") this.store.updateTask(String(previous.task_id), { resource_reservation_json: previous.resource_reservation_json, reservation_bytes: previous.reservation_bytes });
    }));
  }

  private newPort(task: Dict, name: string, protocol: string, host: number, guest: number): Dict { return { task_id: task.task_id, generation: task.generation, port_name: name, protocol, host_port: host, vm_port: guest, device_name: `agent-vm-${task.task_id}-${name}-${protocol}`, state: "preparing", created_at: isoTime(this.now()) }; }

  private requireActive(task: Dict): void {
    if (task.state !== "active") throw new ControlError("task_not_active", "the VM lease is not active");
    const expiry = parseTime(task.lease_expires_at);
    if (!expiry || expiry.getTime() <= this.now().getTime()) throw new ControlError("lease_expired", "the VM lease has expired");
  }

  private async nativeResources(task: Dict): Promise<Dict> {
    const info = await this.ownership(task);
    const config = isDict(info.expanded_config) ? info.expanded_config : isDict(info.config) ? info.config : {};
    try {
      const cpu = nativeDecimalInteger(config["limits.cpu"], "limits.cpu");
      const memory = /^(\d+)(MiB|GiB)$/.exec(String(config["limits.memory"]));
      const devices = nativeDeviceMaps(info, "resource_unverified").expanded_devices;
      const disk = /^(\d+)GiB$/.exec(String(isDict(devices.root) ? devices.root.size : ""));
      if (cpu < 1n || !memory || !disk) throw new Error("size");
      const memoryMib = nativeDecimalInteger(memory[1], "limits.memory") * (memory[2] === "GiB" ? 1024n : 1n);
      const diskGib = nativeDecimalInteger(disk[1], "root.size");
      return { cpu: integerForJson(cpu), memory_mib: integerForJson(memoryMib), disk_gib: integerForJson(diskGib) };
    } catch { throw new ControlError("resource_unverified", "native CPU, memory or root size cannot be verified"); }
  }

  private async hostPorts(): Promise<Set<number>> { return parseListenPorts(decode((await this.runner.run(["ss", "-Hlnptu"], { timeout: 5 })).stdout)); }

  private async nativePorts(): Promise<Set<number>> {
    const ports = new Set<number>();
    const projects = await this.incus.query("/1.0/projects?recursion=1", { project: "default" });
    for (const project of dictArray(projects, "port_inventory_unverified", "project inventory contains an invalid record")) {
      const name = inventoryString(project.name, "port_inventory_unverified", "project name");
      const instances = await this.incus.query("/1.0/instances?recursion=1", { project: name });
      const networks = await this.incus.query("/1.0/networks?recursion=1", { project: name });
      for (const instance of dictArray(instances, "port_inventory_unverified", "instance inventory contains an invalid record")) {
        inventoryString(instance.name, "port_inventory_unverified", "instance name");
        const devices = nativeDeviceMaps(instance, "port_inventory_unverified").expanded_devices;
        for (const device of Object.values(devices)) {
          if (!isDict(device)) throw new ControlError("port_inventory_unverified", "instance device inventory contains an invalid record");
          if (typeof device.type !== "string") throw new ControlError("port_inventory_unverified", "instance device type is invalid");
          if (device.type === "proxy") {
            if (typeof device.listen !== "string") throw new ControlError("port_inventory_unverified", "proxy device listen endpoint is invalid");
            const listen = device.listen;
            if (listen.startsWith("tcp:") || listen.startsWith("udp:")) for (const port of this.portNumbers(listen.split(":").at(-1) ?? "")) ports.add(port);
          }
        }
      }
      for (const network of dictArray(networks, "port_inventory_unverified", "network inventory contains an invalid record")) {
        inventoryString(network.name, "port_inventory_unverified", "network name");
        if (typeof network.managed !== "boolean" || typeof network.type !== "string") throw new ControlError("port_inventory_unverified", "network inventory fields are invalid");
        if (!network.managed || network.type !== "bridge") continue;
        const forwards = await this.incus.query(`/1.0/networks/${quotePath(String(network.name))}/forwards?recursion=1`, { project: name });
        for (const forward of dictArray(forwards, "port_inventory_unverified", "network forward inventory contains an invalid record")) {
          if (!isDict(forward.config) || !Array.isArray(forward.ports) || forward.ports.some((item: unknown) => !isDict(item))) throw new ControlError("port_inventory_unverified", "network forward fields are invalid");
          const config = forward.config;
          if (config.target_address !== undefined && typeof config.target_address !== "string") throw new ControlError("port_inventory_unverified", "network forward target address is invalid");
          if (config.target_address) for (let port = Number(this.config.port_start); port <= Number(this.config.port_end); port += 1) ports.add(port);
          for (const item of forward.ports as Dict[]) for (const port of this.portNumbers(inventoryString(item.listen_port, "port_inventory_unverified", "forward listen_port"))) ports.add(port);
        }
      }
    }
    return ports;
  }

  private portNumbers(value: string): Set<number> {
    const result = new Set<number>();
    for (const part of value.split(",")) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!match) throw new ControlError("port_inventory_unverified", "unrecognized native port range");
      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      if (start < 1 || end < start || end > 65535) throw new ControlError("port_inventory_unverified", "invalid native port range");
      for (let port = start; port <= end; port += 1) result.add(port);
    }
    return result;
  }

  private ephemeralPorts(): Set<number> {
    try {
      const fields = readText("/proc/sys/net/ipv4/ip_local_port_range").trim().split(/\s+/).map(Number);
      if (fields.length !== 2 || !Number.isSafeInteger(fields[0]) || !Number.isSafeInteger(fields[1]) || fields[0] < 1 || fields[0] > fields[1] || fields[1] > 65535) throw new Error("range");
      const result = new Set<number>();
      for (let port = fields[0]; port <= fields[1]; port += 1) result.add(port);
      return result;
    } catch { throw new ControlError("port_inventory_unverified", "cannot inspect host ephemeral port range"); }
  }

  private async portInventory(): Promise<Set<number>> {
    const result = await this.hostPorts();
    for (const port of await this.nativePorts()) result.add(port);
    for (const port of this.ephemeralPorts()) result.add(port);
    return result;
  }

  private allocatePort(protocol: string, requested: unknown, inventory: Set<number>): number {
    if (!["tcp", "udp"].includes(protocol)) throw new ControlError("invalid_request", "protocol must be tcp or udp");
    const used = this.store.occupiedPorts(protocol);
    for (const port of inventory) used.add(port);
    if (requested !== undefined && requested !== null) {
      const port = numberFromInteger(requested, "host_port", Number(this.config.port_start), Number(this.config.port_end));
      if (used.has(port)) throw new ControlError("port_busy", "requested host port is occupied");
      return port;
    }
    for (let port = Number(this.config.port_start); port <= Number(this.config.port_end); port += 1) if (!used.has(port)) return port;
    throw new ControlError("port_exhausted", "no host port is available");
  }

  private allocatedVmIps(): Set<string> { return new Set(this.store.listTasks().filter((task) => task.vm_ip && task.state !== "absent").map((task) => String(task.vm_ip))); }

  private async nativeIps(ownName: string): Promise<Set<string>> {
    const used = new Set<string>();
    let ownMac: string | undefined;
    let ownIp: string | undefined;
    const projects = await this.incus.query("/1.0/projects?recursion=1", { project: "default" });
    for (const project of dictArray(projects, "vm_ip_unverified", "native project inventory contains an invalid record")) {
      const projectName = inventoryString(project.name, "vm_ip_unverified", "project name");
      const instances = await this.incus.query("/1.0/instances?recursion=1", { project: String(project.name) });
      for (const instance of dictArray(instances, "vm_ip_unverified", "native instance inventory contains an invalid record")) {
        const instanceName = inventoryString(instance.name, "vm_ip_unverified", "instance name");
        const maps = nativeDeviceMaps(instance, "vm_ip_unverified");
        for (const map of [maps.devices, maps.expanded_devices]) for (const device of Object.values(map)) {
          if (!isDict(device) || typeof device.type !== "string") throw new ControlError("vm_ip_unverified", "native device inventory contains an invalid record");
          for (const field of ["network", "parent", "hwaddr"]) if (device[field] !== undefined && typeof device[field] !== "string") throw new ControlError("vm_ip_unverified", "native device inventory field is invalid");
          for (const field of ["ipv4.address", "ipv6.address"]) if (device[field] !== undefined) inventoryAddress(device[field], "vm_ip_unverified", `native device ${field}`);
        }
        const devices = maps.expanded_devices;
        if (projectName === this.config.project && instanceName === ownName) {
          if (!isDict(devices.eth0)) throw new ControlError("vm_ip_unverified", "managed instance NIC inventory is unavailable");
          const nic = devices.eth0;
          const volatileMac = isDict(instance.config) ? instance.config["volatile.eth0.hwaddr"] : undefined;
          if (volatileMac !== undefined && typeof volatileMac !== "string") throw new ControlError("vm_ip_unverified", "managed instance hardware address is invalid");
          ownMac = nic.hwaddr ?? volatileMac;
          ownIp = inventoryAddress(nic["ipv4.address"], "vm_ip_unverified", "managed instance IPv4 address", false);
          if (!ownMac || !ownIp) throw new ControlError("vm_ip_unverified", "managed instance address inventory is incomplete");
          continue;
        }
        for (const device of Object.values(devices)) if (isDict(device) && (device.network === this.config.network || device.parent === this.config.network)) for (const field of ["ipv4.address", "ipv6.address"]) {
          const address = inventoryAddress(device[field], "vm_ip_unverified", `native device ${field}`);
          if (address) used.add(address);
        }
      }
    }
    const leases = await this.incus.query(`/1.0/networks/${quotePath(String(this.config.network))}/leases`, { project: "default" });
    for (const lease of dictArray(leases, "vm_ip_unverified", "network lease inventory contains an invalid record")) {
      const address = inventoryAddress(lease.address, "vm_ip_unverified", "lease address", false);
      if (!address) throw new ControlError("vm_ip_unverified", "lease address is invalid");
      if (lease.hwaddr !== undefined && typeof lease.hwaddr !== "string") throw new ControlError("vm_ip_unverified", "network lease hardware address is invalid");
      if (!(ownMac && String(lease.hwaddr ?? "").toLowerCase() === ownMac.toLowerCase() && address === ownIp)) used.add(address);
    }
    return used;
  }

  private allocateVmIp(nativeIps: Set<string>): string {
    const start = ipv4ToInt(String(this.config.vm_ip_start));
    const end = ipv4ToInt(String(this.config.vm_ip_end));
    const used = this.allocatedVmIps();
    for (const address of nativeIps) used.add(address);
    for (let value = start; value <= end; value += 1) { const candidate = intToIpv4(value); if (!used.has(candidate)) return candidate; }
    throw new ControlError("vm_ip_exhausted", "no VM private IP is available");
  }

  private isGuestWaitTimeout(error: ControlError): boolean {
    if (error instanceof GuestWaitTimeout || error.code === "guest_wait_timeout") return true;
    const detail = isDict(error.rawDetail) ? error.rawDetail : {};
    return error.code === "command_failed" && detail.returncode === 1 && typeof detail.stderr === "string" && /(?:timed?\s*out|timeout)/i.test(detail.stderr);
  }

  private diagnosticError(error: unknown): Dict {
    const detail: Dict = { type: error instanceof Error ? error.name : "Error" };
    if (error instanceof ControlError) {
      detail.code = error.code;
      if (error.code === "command_timeout" && isDict(error.detail)) for (const key of ["reaped", "process_group_killed", "process_group_cleanup_error"]) if (key in error.detail) detail[key] = error.detail[key];
    }
    return detail;
  }

  private diagnosticTimeout(deadline?: number): number {
    if (deadline === undefined) return DIAGNOSTIC_COMMAND_TIMEOUT_SECONDS;
    const remaining = deadline - nowMs();
    if (remaining <= 0) throw new ControlError("diagnostic_deadline", "shared readiness budget is exhausted");
    return Math.min(DIAGNOSTIC_COMMAND_TIMEOUT_SECONDS, remaining / 1000);
  }

  private parseCpuPsi(raw: string): Dict {
    const result: Dict = {};
    for (const line of raw.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (!fields[0] || !["some", "full"].includes(fields[0])) continue;
      const values: Dict = {};
      for (const field of fields.slice(1)) { const [name, value] = field.split("=", 2); if (name && value && Number.isFinite(Number(value))) values[name] = Number(value); }
      if (Object.keys(values).length) result[fields[0]] = values;
    }
    if (!Object.keys(result).length) throw new Error("CPU PSI data is missing");
    return result;
  }

  private redactStartupLog(rawInput: string): Dict {
    let raw = rawInput;
    const collectorTruncated = raw.endsWith(DIAGNOSTIC_LOG_TRUNCATION_MARKER);
    if (collectorTruncated) raw = raw.slice(0, -DIAGNOSTIC_LOG_TRUNCATION_MARKER.length);
    const redacted = redactDiagnosticText(raw);
    const truncated = collectorTruncated || redacted.length > DIAGNOSTIC_LOG_LIMIT;
    return { text: truncated ? redacted.slice(0, DIAGNOSTIC_LOG_LIMIT) : redacted, truncated };
  }

  private qemuSchedstat(pid: unknown): Dict {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 2) throw new Error("Incus did not report a valid QEMU pid");
    const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString().toLowerCase();
    if (!cmdline.includes("qemu")) throw new Error("reported process is not QEMU");
    const fields = readText(`/proc/${pid}/schedstat`).trim().split(/\s+/);
    if (fields.length < 2 || !fields.slice(0, 2).every((field) => /^\d+$/.test(field))) throw new Error("QEMU schedstat is invalid");
    return { pid, runtime_seconds: Number(fields[0]) / 1_000_000_000, runqueue_wait_seconds: Number(fields[1]) / 1_000_000_000 };
  }

  private async emitSlowStartDiagnostic(task: Dict, phase: string, started: number, readiness: Dict, deadline?: number): Promise<Dict> {
    const errors: Dict[] = [];
    const payload: Dict = { event: "agent-vm-slow-start", task_id: task.task_id, session_id: task.session_id, generation: integerForJson(task.generation), phase, elapsed_seconds: Math.round(Math.max(0, (nowMs() - started) / 1000) * 1000) / 1000, budget_seconds: GUEST_READINESS_BUDGET_SECONDS, stage_timings: { ...readiness.stage_timings }, readiness: { ...readiness }, native_status: {}, cpu_psi: {}, qemu_schedstat: {}, startup_log: {} };
    try {
      const info = await this.incus.instanceInfo(String(task.instance_name), { timeout: this.diagnosticTimeout(deadline), bounded: true });
      payload.native_status = Object.fromEntries(["status", "pid", "processes"].filter((key) => key in info).map((key) => [key, info[key]]));
      try { payload.qemu_schedstat = this.qemuSchedstat(info.pid); } catch (error) { errors.push({ source: "qemu_schedstat", ...this.diagnosticError(error) }); }
    } catch (error) { errors.push({ source: "native_status", ...this.diagnosticError(error) }); }
    try { payload.cpu_psi = this.parseCpuPsi(readText("/proc/pressure/cpu")); } catch (error) { errors.push({ source: "cpu_psi", ...this.diagnosticError(error) }); }
    try { payload.startup_log = this.redactStartupLog(await this.incus.instanceLog(String(task.instance_name), this.diagnosticTimeout(deadline))); } catch (error) { errors.push({ source: "startup_log", ...this.diagnosticError(error) }); }
    if (errors.length) payload.errors = errors;
    try { await this.globalLock(() => this.store.audit("boot-diagnostic", errors.length ? "partial" : "ok", payload, String(task.task_id), String(task.session_id), task.generation)); } catch (error) { (payload.errors ??= []).push({ source: "audit", ...this.diagnosticError(error) }); }
    try { process.stderr.write(`${emitJson(payload)}\n`); } catch (error) { (payload.errors ??= []).push({ source: "stderr", ...this.diagnosticError(error) }); }
    return payload;
  }

  private readinessTimeout(condition: string, started: number, readiness: Dict, diagnostic: Dict | undefined): never {
    const elapsed = Math.round(Math.max(0, (nowMs() - started) / 1000) * 1000) / 1000;
    readiness.elapsed_seconds = elapsed;
    readiness.diagnostic = { emitted: diagnostic !== undefined, phase: diagnostic?.phase ?? null, elapsed_seconds: diagnostic?.elapsed_seconds ?? null };
    throw new ControlError("guest_readiness_timeout", "guest readiness did not complete within the shared startup budget", { phase: condition, condition, elapsed_seconds: elapsed, budget_seconds: GUEST_READINESS_BUDGET_SECONDS, readiness });
  }

  private async waitGuestReady(task: Dict, stageTimings: Dict = {}): Promise<Dict> {
    const started = nowMs();
    const readiness: Dict = { budget_seconds: GUEST_READINESS_BUDGET_SECONDS, elapsed_seconds: 0, stage_timings: { ...stageTimings }, phases: {} };
    let diagnostic: Dict | undefined;
    const remaining = (condition: string): number => {
      const current = this.store.getTask({ taskId: String(task.task_id) });
      const expiry = current ? parseTime(current.lease_expires_at) : undefined;
      if (!current || !sameInteger(current.generation, task.generation) || !["preparing", "active"].includes(String(current.state)) || !expiry) throw new ControlError("lease_expired", "guest preparation was revoked");
      if (expiry.getTime() <= this.now().getTime()) throw new ControlError("lease_expired", "lease expired while waiting for guest readiness");
      const seconds = Math.floor(GUEST_READINESS_BUDGET_SECONDS - (nowMs() - started) / 1000);
      if (seconds < 1) this.readinessTimeout(condition, started, readiness, diagnostic);
      const leaseSeconds = (expiry.getTime() - this.now().getTime()) / 1000;
      if (leaseSeconds < 1) throw new ControlError("lease_expired", "lease expired while waiting for guest readiness");
      return Math.min(seconds, Math.floor(leaseSeconds));
    };
    const waitOnce = async (condition: string, seconds: number): Promise<void> => { await this.incus.wait(String(task.instance_name), condition, seconds); remaining(condition); };
    const failFast = (condition: string, error: ControlError): never => { const detail: Dict = isDict(error.detail) ? { ...error.detail } : { cause: error.asDict() }; detail.phase = condition; detail.readiness = readiness; throw new ControlError(error.code, error.message, detail); };
    for (const condition of ["agent", "ipv4"]) {
      const phaseStarted = nowMs();
      const firstSeconds = diagnostic === undefined ? Math.min(remaining(condition), Math.max(1, Math.floor(GUEST_READINESS_DIAGNOSTIC_SECONDS - (nowMs() - started) / 1000))) : remaining(condition);
      try {
        await waitOnce(condition, firstSeconds);
      } catch (error) {
        if (!(error instanceof ControlError) || !this.isGuestWaitTimeout(error)) throw error instanceof ControlError ? error : new ControlError("internal_error", (error as Error).name);
        if (diagnostic === undefined && (nowMs() - started) / 1000 < GUEST_READINESS_DIAGNOSTIC_SECONDS) {
          const boundarySeconds = Math.min(remaining(condition), Math.max(1, Math.floor(GUEST_READINESS_DIAGNOSTIC_SECONDS - (nowMs() - started) / 1000)));
          try { await waitOnce(condition, boundarySeconds); readiness.phases[condition] = { elapsed_seconds: Math.round((nowMs() - phaseStarted) / 1000 * 1000) / 1000, total_elapsed_seconds: Math.round((nowMs() - started) / 1000 * 1000) / 1000 }; continue; }
          catch (boundaryError) { if (!(boundaryError instanceof ControlError) || !this.isGuestWaitTimeout(boundaryError)) failFast(condition, boundaryError as ControlError); }
        }
        if (diagnostic === undefined) diagnostic = await this.emitSlowStartDiagnostic(task, condition, started, readiness, started + GUEST_READINESS_BUDGET_SECONDS * 1000);
        try { await waitOnce(condition, remaining(condition)); }
        catch (continuationError) { if (continuationError instanceof ControlError && this.isGuestWaitTimeout(continuationError)) this.readinessTimeout(condition, started, readiness, diagnostic); failFast(condition, continuationError as ControlError); }
      }
      readiness.phases[condition] = { elapsed_seconds: Math.round((nowMs() - phaseStarted) / 1000 * 1000) / 1000, total_elapsed_seconds: Math.round((nowMs() - started) / 1000 * 1000) / 1000 };
    }
    readiness.elapsed_seconds = Math.round((nowMs() - started) / 1000 * 1000) / 1000;
    readiness.diagnostic = { emitted: diagnostic !== undefined, phase: diagnostic?.phase ?? null, elapsed_seconds: diagnostic?.elapsed_seconds ?? null };
    return readiness;
  }

  private shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

  private async verifyGuestTools(task: Dict): Promise<void> {
    const configured = Array.isArray(this.config.required_guest_tools) ? this.config.required_guest_tools as string[] : [];
    const tools = [...new Set(["bun", ...configured])].map((tool) => this.shellQuote(tool)).join(" ");
    const script = `set -eu; for tool in ${tools}; do command -v "$tool" >/dev/null; done; if docker compose version >/dev/null 2>&1; then :; elif command -v docker-compose >/dev/null 2>&1; then :; else exit 1; fi`;
    await this.nativeGuestExec(task, ["sh", "-lc", script], {}, false);
  }

  private async guestIp(instanceName: string): Promise<string> {
    const info = await this.incus.instanceInfo(instanceName);
    const state = isDict(info.state) ? info.state : info;
    const network = isDict(state.network) ? state.network : {};
    const candidates: string[] = [];
    for (const [name, data] of Object.entries(network)) if (name !== "lo" && isDict(data) && Array.isArray(data.addresses)) for (const address of data.addresses.filter(isDict)) if (address.family === "inet" && typeof address.address === "string") candidates.push(address.address);
    if (!candidates.length) throw new ControlError("guest_ip_missing", "Incus did not report a guest IPv4 address");
    if (!this.expectedVmIp || !candidates.includes(this.expectedVmIp)) throw new ControlError("guest_ip_mismatch", "guest IPv4 address does not match the allocated fixed address", { expected: this.expectedVmIp, reported: candidates });
    return this.expectedVmIp;
  }

  private async installPublicKey(task: Dict, publicKey: unknown): Promise<void> {
    const key = requiredString(publicKey, "public_key");
    if (/[\r\n]/.test(key)) throw new ControlError("invalid_request", "public_key must contain one line");
    const fields = key.split(/\s+/);
    if (fields.length < 2 || !["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "ssh-rsa"].includes(fields[0] ?? "")) throw new ControlError("invalid_request", "public_key is not a supported SSH public key");
    await this.nativeGuestExec(task, ["sh", "-lc", "set -eu; umask 077; mkdir -p /root/.ssh; cat > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"], { inputData: `${key}\n` });
  }

  private async guestHostKey(instanceName: string): Promise<string> {
    const result = await this.incus.exec(instanceName, ["sh", "-lc", "cat /etc/ssh/ssh_host_ed25519_key.pub"]);
    const fields = decode(result.stdout).trim().split(/\s+/);
    if (fields.length < 2 || fields[0] !== "ssh-ed25519") throw new ControlError("guest_host_key_missing", "guest did not provide an ed25519 host key");
    return fields.slice(0, 2).join(" ");
  }

  private async configureNetwork(task: Dict, vmIp: string): Promise<void> {
    const settings = { "ipv4.address": vmIp, "security.mac_filtering": "true", "security.ipv4_filtering": "true", "security.ipv6_filtering": "true", "security.port_isolation": "true", "security.acls": String(this.config.network_acl), "security.acls.default.ingress.action": "allow", "security.acls.default.egress.action": "allow" };
    for (const [key, value] of Object.entries(settings)) await this.nativeDeviceSet(task, "eth0", key, value);
  }

  private async networkGuard(): Promise<void> {
    const name = requiredString(this.config.network_acl, "network_acl", PORT_NAME_RE);
    const project = await this.incus.query(`/1.0/projects/${quotePath(String(this.config.project))}`, { project: "default" });
    const projectConfig = isDict(project) && isDict(project.config) ? project.config : {};
    if (projectConfig["restricted.devices.proxy"] !== "allow") throw new ControlError("network_unverified", "Incus project does not allow managed proxy NAT devices");
    const acl = await this.incus.query(`/1.0/network-acls/${quotePath(name)}`, { project: "default" });
    if (!isDict(acl) || !isDict(acl.config) || acl.config["user.agent-vm.managed"] !== "native-v1") throw new ControlError("network_unverified", "isolation ACL ownership is not verified");
    const fields = ["action", "state", "source", "destination", "protocol", "source_port", "destination_port", "icmp_type", "icmp_code"];
    for (const [direction, rules] of Object.entries(this.isolationRules())) {
      const actual = dictArray(acl[direction], "network_unverified", `isolation ACL ${direction} contains an invalid rule`);
      const normalized = actual.map((value) => {
        if (Object.keys(value).some((key) => !fields.includes(key))) throw new ControlError("network_unverified", `isolation ACL ${direction} contains an unsupported field`);
        for (const key of fields) if (hasOwn(value, key) && typeof value[key] !== "string") throw new ControlError("network_unverified", `isolation ACL ${direction} contains an invalid ${key} field`);
        return Object.fromEntries(fields.map((key) => [key, value[key] ?? (key === "state" ? "enabled" : "")])) as Dict;
      });
      if (normalized.length !== rules.length) throw new ControlError("network_unverified", `isolation ACL ${direction} contains extra or missing rules`);
      (rules as Dict[]).forEach((rule: Dict, index: number) => {
        const expected = Object.fromEntries(fields.map((key) => [key, rule[key] ?? (key === "state" ? "enabled" : "")])) as Dict;
        if (stableJson(normalized[index]) !== stableJson(expected)) throw new ControlError("network_unverified", `isolation ACL ${direction} is not the exact managed rule set`);
      });
    }
  }

  private isolationRules(): Dict {
    const start = String(this.config.vm_ip_start);
    const end = String(this.config.vm_ip_end);
    return { ingress: [{ action: "drop", state: "enabled", source: `${start}-${end}` }], egress: [{ action: "drop", state: "enabled", destination: `${start}-${end}` }, { action: "drop", state: "enabled", destination: String(this.config.host_address) }, { action: "drop", state: "enabled", destination: String(this.config.gateway_ip), protocol: "tcp", destination_port: "22" }] };
  }

  private proxyProperties(task: Dict, port: Dict): Dict { return { type: "proxy", listen: `${port.protocol}:${this.config.host_address}:${port.host_port}`, connect: `${port.protocol}:${task.vm_ip}:${port.vm_port}`, nat: "true" }; }

  private async addProxy(task: Dict, port: Dict): Promise<void> {
    await this.nativeLock(task, async () => {
      const current = await this.nativeOperationCurrent(task);
      const info = await this.ownership(current);
      if (!isDict(info.devices) || !isDict(info.expanded_devices)) throw new ControlError("mapping_unverified", "native device maps are unavailable");
      const devices = info.devices;
      const native = devices[port.device_name];
      const expected = this.proxyProperties(current, port);
      if (native) { if (Object.entries(expected).some(([key, value]) => native[key] !== value)) throw new ControlError("ownership_mismatch", "native device does not match reservation"); return; }
      await this.nativeBarrier(async () => {
        const fenced = await this.nativeOperationCurrent(current);
        const fencedInfo = await this.ownership(fenced);
        await this.nativeOperationCurrent(fenced);
        if (!isDict(fencedInfo.devices) || !isDict(fencedInfo.expanded_devices)) throw new ControlError("mapping_unverified", "native device maps are unavailable before addition");
        const fencedNative = fencedInfo.devices[port.device_name];
        if (fencedNative) { if (Object.entries(expected).some(([key, value]) => fencedNative[key] !== value)) throw new ControlError("ownership_mismatch", "native device does not match reservation"); return; }
        if (port.device_name in fencedInfo.expanded_devices) throw new ControlError("mapping_unverified", "native device maps disagree before addition");
        await this.incus.deviceAdd(String(fenced.instance_name), String(port.device_name), "proxy", Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "type")));
      });
      const after = await this.ownership(current);
      if (!isDict(after.devices) || !isDict(after.expanded_devices)) throw new ControlError("mapping_unverified", "native device maps are unavailable after addition");
      const afterDevices = after.devices;
      if (Object.entries(expected).some(([key, value]) => afterDevices[port.device_name]?.[key] !== value)) throw new ControlError("mapping_unverified", "native proxy addition was not confirmed");
    });
  }

  private async conntrackDelete(port: Dict, task: Dict, cleanup = false, allowActiveCleanup = false): Promise<void> {
    if (!this.which("conntrack")) throw new ControlError("conntrack_unavailable", "conntrack-tools is required for exact flow withdrawal");
    const match = ["-p", String(port.protocol), "--orig-dst", String(this.config.host_address), "--dport", String(port.host_port), "--reply-src", String(task.vm_ip), "--reply-port-src", String(port.vm_port)];
    const result = await this.nativeBarrier(async () => {
      if (cleanup) await this.cleanupOperationCurrent(task, allowActiveCleanup); else await this.nativeOperationCurrent(task);
      return this.runner.run(["conntrack", "-D", ...match], { check: false, timeout: 2 });
    });
    if (result.returncode !== 0 && !(result.returncode === 1 && decode(result.stderr).includes("0 flow entries"))) throw new ControlError("conntrack_delete_failed", "exact conntrack deletion failed", { returncode: result.returncode, stderr: decode(result.stderr) });
    const remaining = await this.nativeBarrier(async () => {
      if (cleanup) await this.cleanupOperationCurrent(task, allowActiveCleanup); else await this.nativeOperationCurrent(task);
      return this.runner.run(["conntrack", "-L", ...match], { check: false, timeout: 2 });
    });
    if (remaining.returncode !== 0 || decode(remaining.stdout).trim().length) throw new ControlError("conntrack_unverified", "matching flows remain or cannot be inspected");
  }

  private async cleanupCurrent(task: Dict): Promise<Dict | undefined> {
    return this.globalLock(() => this.store.transaction(() => {
      const current = this.store.getTask({ taskId: String(task.task_id) });
      if (!current || !sameInteger(current.generation, task.generation) || current.state !== "closing" || current.instance_name !== task.instance_name) return undefined;
      return current;
    }));
  }

  private async cleanupTask(task: Dict): Promise<[string[], string[]]> { return this.nativeLock(task, () => this.cleanupTaskLocked(task)); }

  private async cleanupTaskLocked(task: Dict): Promise<[string[], string[]]> {
    const errors: string[] = [];
    const completed: string[] = [];
    let current = await this.cleanupCurrent(task);
    if (!current) return [["stale-cleanup:generation"], completed];
    task = current;
    let exists = true;
    try { exists = (await this.incus.listInstances()).some((item) => item.name === task.instance_name); } catch (error) { errors.push(`inventory:${error instanceof ControlError ? error.code : "error"}`); }
    if (exists) {
      try { await this.ownership(task); } catch (error) { return [[`ownership:${error instanceof ControlError ? error.code : "error"}`], completed]; }
    }
    for (const port of this.store.getPorts(String(task.task_id))) {
      current = await this.cleanupCurrent(task);
      if (!current) { errors.push("stale-cleanup:generation"); break; }
      task = current;
      try { if (exists) await this.removeProxy(task, port, true); } catch (error) { errors.push(`remove-proxy:${port.device_name}:${error instanceof ControlError ? error.code : "error"}`); }
      current = await this.cleanupCurrent(task);
      if (!current) { errors.push("stale-cleanup:generation"); break; }
      task = current;
      try { await this.conntrackDelete(port, task, true); completed.push(`withdraw:${port.device_name}`); } catch (error) { errors.push(`withdraw:${port.device_name}:${error instanceof ControlError ? error.code : "error"}`); }
    }
    if (exists) {
      current = await this.cleanupCurrent(task);
      if (!current) errors.push("stop:stale-cleanup");
      else {
        task = current;
        try {
          await this.ownership(task);
          if (String((await this.incus.instanceInfo(String(task.instance_name))).status).toLowerCase() !== "stopped") {
            await this.nativeBarrier(async () => {
              await this.cleanupOperationCurrent(task);
              await this.ownership(task);
              await this.incus.stop(String(task.instance_name), true);
            });
          }
          if (String((await this.incus.instanceInfo(String(task.instance_name))).status).toLowerCase() !== "stopped") throw new ControlError("stop_unverified", "native instance is not stopped");
          completed.push("verify-stop");
        } catch (error) { errors.push(`stop:${error instanceof ControlError ? error.code : "error"}`); }
      }
    } else completed.push("instance-absent");
    if (exists) {
      try {
        const proxies = nativeProxyNames(await this.ownership(task), "mapping_unverified");
        if (proxies.size) errors.push(`proxy-inventory:${[...proxies].sort(compareUnicodeCodePoints).join(",")}`);
      } catch (error) { errors.push(`proxy-inventory:${error instanceof ControlError ? error.code : "error"}`); }
    }
    return [errors, completed];
  }

  private async removeProxy(task: Dict, port: Dict, cleanup = false, allowActiveCleanup = false): Promise<void> {
    const current = cleanup ? await this.cleanupOperationCurrent(task, allowActiveCleanup) : await this.nativeOperationCurrent(task);
    const info = await this.ownership(current);
    if (!isDict(info.devices) || !isDict(info.expanded_devices)) throw new ControlError("mapping_unverified", "native device maps are unavailable");
    const devices = info.devices;
    const expandedBefore = info.expanded_devices;
    const native = devices[port.device_name];
    if (!native && port.device_name in expandedBefore) throw new ControlError("mapping_unverified", "native device maps disagree");
    if (native) {
      const expected = this.proxyProperties(current, port);
      if (Object.entries(expected).some(([key, value]) => native[key] !== value)) throw new ControlError("ownership_mismatch", "native mapping differs from its reservation");
      await this.nativeBarrier(async () => {
        const fenced = cleanup ? await this.cleanupOperationCurrent(current, allowActiveCleanup) : await this.nativeOperationCurrent(current);
        const fencedInfo = await this.ownership(fenced);
        if (!isDict(fencedInfo.devices) || !isDict(fencedInfo.expanded_devices)) throw new ControlError("mapping_unverified", "native device maps are unavailable before removal");
        const fencedNative = fencedInfo.devices[port.device_name];
        if (!fencedNative && port.device_name in fencedInfo.expanded_devices) throw new ControlError("mapping_unverified", "native device maps disagree before removal");
        if (fencedNative) {
          const fencedExpected = this.proxyProperties(fenced, port);
          if (Object.entries(fencedExpected).some(([key, value]) => fencedNative[key] !== value)) throw new ControlError("ownership_mismatch", "native mapping differs from its reservation");
        }
        if (!fencedNative) return;
        await this.incus.deviceRemove(String(fenced.instance_name), String(port.device_name));
      });
    }
    const after = await this.ownership(current);
    if (!isDict(after.devices) || !isDict(after.expanded_devices)) throw new ControlError("mapping_unverified", "native device maps are unavailable after removal");
    if (port.device_name in after.devices || port.device_name in after.expanded_devices) throw new ControlError("mapping_unverified", "native mapping is still present");
  }

  private async scheduleExpiry(task: Dict): Promise<void> {
    if (!task.lease_expires_at) throw new ControlError("lease_missing", "active task has no lease expiry");
    await this.systemd.scheduleExpiry(String(task.task_id), task.generation, String(task.lease_expires_at));
  }

  private async imageGuard(): Promise<void> {
    const fingerprint = String(this.config.image_fingerprint);
    let image: unknown;
    try { image = await this.incus.query(`/1.0/images/${quotePath(fingerprint)}`); } catch (error) { throw new ControlError("image_unavailable", "pinned VM image is unavailable", error instanceof ControlError ? error.asDict() : undefined); }
    if (!isDict(image) || image.fingerprint !== fingerprint || image.type !== "virtual-machine") throw new ControlError("image_unverified", "pinned image identity or VM type does not match");
  }

  private async requireWindow(task: Dict, minimumSeconds = GUEST_READINESS_BUDGET_SECONDS): Promise<void> {
    const expiry = parseTime(task.lease_expires_at);
    if (!expiry || (expiry.getTime() - this.now().getTime()) / 1000 < minimumSeconds) throw new ControlError("lease_window_short", "explicitly renew before starting a potentially slow operation");
  }

  async doctor(_request: Dict, _sessionId?: string): Promise<Dict> {
    const issues: string[] = [];
    let version: string | null = null;
    try { version = decode((await this.runner.run(["incus", "version"], { timeout: 15 })).stdout).trim(); await this.incus.listInstances(); } catch (error) { issues.push(error instanceof ControlError ? error.code : "internal_error"); }
    try { await this.imageGuard(); } catch (error) { issues.push(error instanceof ControlError ? error.code : "internal_error"); }
    let capacity: Dict;
    try { capacity = this.ensureCapacityVerified(); } catch (error) { issues.push(error instanceof ControlError ? error.code : "internal_error"); capacity = { error: error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name } }; }
    if (!this.which("conntrack")) issues.push("conntrack_missing");
    try { await this.networkGuard(); } catch (error) { issues.push(error instanceof ControlError ? error.code : "internal_error"); }
    if (this.systemd.enabled) {
      for (const unit of ["incus.service", "agent-vm-native-age-gc.timer"]) { const result = await this.runner.run(["systemctl", "is-active", "--quiet", unit], { timeout: 5, check: false }); if (result.returncode) issues.push(`unit_inactive:${unit}`); }
      for (const unit of ["agent-vm-native-expire@.service", "agent-vm-native-reconcile.service"]) if (!existsSync(join(String(this.config.timer_dir), unit))) issues.push(`unit_missing:${unit}`);
    }
    const resources = await this.resourceDiagnostics();
    const instances = await this.instanceDiagnostics();
    const admission = await this.defaultAdmissionDiagnostics(resources, capacity, instances);
    return { ready: issues.length === 0, issues, incus_version: version, capacity, resources, instances, default_admission: admission, admission_ready: issues.length === 0 && admission.ready, config: Object.fromEntries(["project", "profile", "image_fingerprint", "network", "pool", "host_address"].map((key) => [key, this.config[key]])) };
  }

  async status(_request: Dict, sessionId: string): Promise<Dict> {
    const task = this.store.getTask({ sessionId });
    const result = task ? await this.runtimeSummary(task) : { state: "absent", generation: 0, effective_lease: false, native_status: "absent", guest_available: false };
    const admission = await this.resourceDiagnostics();
    admission.instances = await this.instanceDiagnostics();
    return { ...result, admission };
  }

  async acquire(request: Dict, sessionId: string): Promise<Dict> {
    const existing = this.store.getTask({ sessionId });
    if (existing && existing.state === "active") {
      this.checkGeneration(existing, request);
      this.requireActive(existing);
      await this.ownership(existing);
      const resources = parseJson(String(existing.resources_json)) as Dict;
      const target = this.requestedResources(request, resources, true);
      if (stableJson(target) !== stableJson(resources)) throw new ControlError("resource_config_mismatch", "active lease configuration differs; use resize explicitly", { current: resources, requested: target, differences: Object.keys(resources).filter((key) => resources[key] !== target[key]) });
      return this.runtimeSummary(existing);
    }
    if (existing && !["absent", "cached"].includes(String(existing.state))) throw new ControlError("task_transition", "session slot is not available until reconciliation completes");
    const expected = existing ? integerBigInt(existing.generation, "generation") : 0n;
    if (!sameInteger(request.generation, expected)) throw new ControlError("generation_mismatch", "acquire requires the latest observed generation", { current_generation: integerForJson(expected) });
    if (this.store.getMeta("draining") === "1") throw new ControlError("draining", "new leases are refused");
    await this.networkGuard();
    const publicKey = requiredString(request.public_key, "public_key");
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey)) throw new ControlError("invalid_request", "acquire requires a single ed25519 public key");
    const cached = Boolean(existing && existing.state === "cached");
    if (!cached) await this.imageGuard();
    if (cached) {
      await this.assertNoNativeProxies(existing as Dict);
      if (String((await this.incus.instanceInfo(String(existing?.instance_name))).status).toLowerCase() !== "stopped" || this.store.getPorts(String(existing?.task_id)).length) throw new ControlError("cache_ineligible", "cached instance is not safely stopped");
    }
    const old = cached ? parseJson(String(existing?.resources_json)) as Dict : { cpu: 2, memory_mib: 4096, disk_gib: 20 };
    if (cached && stableJson(await this.nativeResources(existing as Dict)) !== stableJson(old)) throw new ControlError("resource_unverified", "cached native sizes differ from durable resource sizes");
    const resources = this.requestedResources(request, old);
    let cost = bigintFromInteger(cached ? this.config.resume_cost_bytes : this.config.create_cost_bytes, "resume_cost_bytes");
    if (cached && resources.disk_gib > old.disk_gib) cost += bigintFromInteger(this.config.resize_cost_bytes, "resize_cost_bytes");
    let task = this.baseTask(sessionId, expected + 1n);
    if (existing) Object.assign(task, { task_id: existing.task_id, instance_name: existing.instance_name, created_at: existing.created_at, vm_ip: cached ? existing.vm_ip : null });
    if (cached) Object.assign(task, { previous_generation: expected, inactive_since: existing?.inactive_since, cleanup_after: existing?.cleanup_after });
    task.resources_json = stableJson(cached ? old : resources);
    task.lease_expires_at = isoTime(new Date(this.now().getTime() + Number(this.config.initial_lease_seconds) * 1000));
    const reserved = cached ? Object.fromEntries(Object.keys(old).map((key) => [key, maxIntegerValue(old[key], resources[key])])) : resources;
    task = await this.reserveResources(task, reserved);
    let phase = "reservation";
    const completed: string[] = [];
    const stageTimings: Dict = {};
    let readiness: Dict | undefined;
    try {
      phase = "expiry-timer";
      await this.scheduleExpiry(task);
      const reclaimed = await this.reclaimCapacity(cost, String(task.task_id));
      task = await this.reserveNative(task, cost, await this.portInventory(), request.ssh_host_port);
      let guest: Dict = {};
      await this.nativeLock(task, async () => {
        if (cached) {
          phase = "native-generation";
          await this.nativeBarrier(async () => {
            await this.nativeOperationCurrent(task);
            await this.ownership(task);
            await this.incus.configSet(String(task.instance_name), "user.agent-vm.generation", String(task.generation));
          });
        } else {
          phase = "native-init";
          await this.nativeBarrier(async () => {
            await this.nativeOperationCurrent(task);
            await this.incus.init(String(this.config.image_fingerprint), String(task.instance_name), { "user.agent-vm.managed": "native-v1", "user.agent-vm.task": task.task_id, "user.agent-vm.session": sessionId, "user.agent-vm.generation": String(task.generation) });
          });
          await this.configureNetwork(task, String(task.vm_ip));
        }
        phase = "native-config";
        for (const [key, nativeKey, suffix] of [["cpu", "limits.cpu", ""], ["memory_mib", "limits.memory", "MiB"]] as const) if (!cached || resources[key] !== old[key]) { await this.nativeConfigSet(task, nativeKey, `${resources[key]}${suffix}`); completed.push(key); }
        if (!cached || resources.disk_gib !== old.disk_gib) { await this.nativeDeviceSet(task, "root", "size", `${resources.disk_gib}GiB`); completed.push("virtual_disk"); }
        if (stableJson(await this.nativeResources(task)) !== stableJson(resources)) throw new ControlError("resource_unverified", "native sizes differ from the session reservation");
        phase = "native-start";
        const nativeStarted = nowMs();
        await this.startInstance(task);
        stageTimings.native_start_seconds = Math.round((nowMs() - nativeStarted) / 1000 * 1000) / 1000;
        phase = "guest-readiness";
        readiness = await this.waitGuestReady(task, stageTimings);
        phase = "guest-post-check";
        const postCheckStarted = nowMs();
        this.expectedVmIp = String(task.vm_ip);
        await this.verifyGuestTools(task);
        await this.guestIp(String(task.instance_name));
        guest = await this.growGuestRoot(task, resources.disk_gib);
        completed.push("guest_filesystem");
        await this.installPublicKey(task, publicKey);
        stageTimings.post_check_seconds = Math.round((nowMs() - postCheckStarted) / 1000 * 1000) / 1000;
        phase = "access-exposure";
        await this.nativeOperationCurrent(task);
        const port = this.store.getPort(String(task.task_id), "ssh", "tcp");
        if (!port) throw new ControlError("mapping_unverified", "managed SSH reservation is missing");
        await this.addProxy(task, port);
        await this.nativeOperationCurrent(task);
      });
      task = await this.globalLock(() => this.store.transaction(() => {
        const current = this.store.getTask({ taskId: String(task.task_id) });
        if (!current || current.state !== "preparing" || (parseTime(current.lease_expires_at)?.getTime() ?? 0) <= this.now().getTime()) throw new ControlError("lease_expired", "preparation was revoked before commit");
        this.store.updatePort(String(task.task_id), "ssh", "tcp", { state: "active" });
        return this.store.updateTask(String(task.task_id), { state: "active", reservation_bytes: 0n, previous_generation: null, resource_reservation_json: "{}", resources_json: stableJson(resources), inactive_since: null, cleanup_after: null, last_error: null });
      }));
      return { ...(await this.runtimeSummary(task)), reclaimed, guest_filesystem: guest, readiness, stage_timings: stageTimings };
    } catch (error) {
      const controlError = error instanceof ControlError ? error : new ControlError("internal_error", (error as Error).name);
      let cleanup: Dict = { ok: false, error: { code: "not_attempted", message: "cleanup was not attempted" } };
      try { cleanup.result = await this.releaseTask(this.store.getTask({ taskId: String(task.task_id) }) ?? task); cleanup.ok = true; } catch (cleanupError) { cleanup.error = cleanupError instanceof ControlError ? cleanupError.asDict() : { code: "internal_error", message: (cleanupError as Error).name }; }
      const detail: Dict = isDict(controlError.detail) ? redactDiagnosticValue(controlError.detail) as Dict : { cause: controlError.asDict() };
      const failurePhase = detail.phase ?? phase;
      Object.assign(detail, { phase: failurePhase, operation_phase: phase, completed, requested: resources, cleanup });
      if (readiness) detail.readiness = readiness;
      this.store.updateTask(String(task.task_id), { last_error: stableJson({ code: "acquire_partial", ...detail, error: controlError.asDict() }) });
      throw new ControlError(controlError.code, controlError.message, detail);
    }
  }

  async renew(request: Dict, sessionId: string): Promise<Dict> {
    let task: Dict;
    let result: Dict;
    await this.globalLock(() => this.store.transaction(() => {
      task = this.taskForSession(sessionId);
      this.checkGeneration(task, request);
      this.requireActive(task);
      if (this.store.getMeta("draining") === "1") throw new ControlError("draining", "extensions are refused while draining");
      const currentExpiry = parseTime(task.lease_expires_at);
      if (!currentExpiry) throw new ControlError("lease_missing", "active task has no lease expiry");
      const expiry = new Date(Math.min(currentExpiry.getTime() + Number(this.config.renew_seconds) * 1000, this.now().getTime() + Number(this.config.max_lease_seconds) * 1000));
      task = this.store.updateTask(String(task.task_id), { lease_expires_at: isoTime(expiry) });
      result = this.stateSummary(task);
      const response = { ok: true, protocol: PROTOCOL_VERSION, server_time: isoTime(this.now()), action: "renew", session_id: sessionId, generation: request.generation, operation_id: request.operation_id, outcome: "success", result, _request_digest: requestDigest(request) };
      this.store.recordOperation(String(request.operation_id), "renew", sessionId, request.generation, response);
    }));
    await this.scheduleExpiry(task!);
    return result!;
  }

  async release(request: Dict, sessionId: string): Promise<Dict> {
    let task = this.taskForSession(sessionId);
    this.checkGeneration(task, request);
    return this.releaseTask(task);
  }

  private async releaseTask(inputTask: Dict): Promise<Dict> {
    const requestedState = inputTask.state;
    return this.objectLock(`cleanup:${inputTask.session_id}`, async () => {
      const current = this.store.getTask({ taskId: String(inputTask.task_id) });
      if (!current || !sameInteger(current.generation, inputTask.generation)) throw new ControlError("generation_mismatch", "cleanup generation changed");
      let task = current;
      if (["cached", "absent"].includes(String(task.state)) && requestedState !== "closing") return this.stateSummary(task);
      task = await this.nativeLock(task, () => this.nativeBarrier(() => this.globalLock(() => this.store.transaction(() => {
        const latest = this.store.getTask({ taskId: String(task.task_id) });
        if (!latest || !sameInteger(latest.generation, task.generation)) throw new ControlError("generation_mismatch", "cleanup generation changed");
        if (["cached", "absent"].includes(String(latest.state)) && requestedState !== "closing") return latest;
        const expiry = parseTime(latest.lease_expires_at);
        const inactive = parseTime(latest.inactive_since) ?? new Date(Math.min(this.now().getTime(), expiry?.getTime() ?? this.now().getTime()));
        return this.store.updateTask(String(latest.task_id), { state: "closing", lease_expires_at: null, inactive_since: isoTime(inactive), cleanup_after: isoTime(new Date(inactive.getTime() + Number(this.config.cache_seconds) * 1000)) });
      })), true));
      const [errors, completed] = await this.cleanupTask(task);
      if (errors.length) {
        this.store.updateTask(String(task.task_id), { last_error: stableJson({ errors, completed }) });
        await this.systemd.retryCleanup(String(task.task_id), task.generation);
        throw new ControlError("cleanup_incomplete", "entry/port reservations remain closed until reconciliation succeeds", errors);
      }
      await this.systemd.removeExpiry(String(task.task_id), task.generation);
      const absent = !(await this.incus.listInstances()).some((item) => item.name === task.instance_name);
      if (!absent && task.previous_generation !== null && task.previous_generation !== undefined) {
        await this.nativeLock(task, async () => {
          const current = await this.cleanupOperationCurrent(task);
          await this.ownership(current);
          await this.nativeBarrier(async () => {
            await this.cleanupOperationCurrent(current);
            await this.ownership(current);
            await this.incus.configSet(String(current.instance_name), "user.agent-vm.generation", String(current.generation));
          });
        });
      }
      const resources = absent ? {} : await this.nativeResources(task);
      task = await this.globalLock(() => this.store.transaction(() => {
        for (const port of this.store.getPorts(String(task.task_id))) this.store.removePort(String(task.task_id), String(port.port_name), String(port.protocol));
        return this.store.updateTask(String(task.task_id), { state: absent ? "absent" : "cached", ssh_host_port: null, reservation_bytes: 0n, last_error: null, previous_generation: null, resource_reservation_json: "{}", resources_json: stableJson(resources), vm_ip: absent ? null : task.vm_ip });
      }));
      return this.stateSummary(task);
    });
  }

  async destroy(request: Dict, sessionId: string): Promise<Dict> {
    let task = this.store.getTask({ sessionId });
    if (!task) throw new ControlError("task_missing", "no owned instance exists");
    this.checkGeneration(task, request);
    if (task.state === "absent") return this.stateSummary(task);
    if (task.state === "deleting") throw new ControlError("task_transition", "deletion requires reconciliation");
    if (task.state !== "cached") { await this.releaseTask(task); task = this.store.getTask({ taskId: String(task.task_id) })!; }
    if (task.state === "cached") await this.deleteCache(task);
    return this.stateSummary(this.store.getTask({ taskId: String(task.task_id) })!);
  }

  async restart(request: Dict, sessionId: string): Promise<Dict> {
    let task = this.taskForSession(sessionId);
    this.checkGeneration(task, request);
    this.requireActive(task);
    if (this.store.getMeta("draining") === "1") throw new ControlError("draining", "restart work is refused while draining");
    await this.ownership(task);
    await this.requireWindow(task);
    let phase = "native-stop";
    const stageTimings: Dict = {};
    let readiness: Dict | undefined;
    try {
      await this.stopInstance(task);
      phase = "native-start";
      const nativeStarted = nowMs();
      await this.startInstance(task);
      stageTimings.native_start_seconds = Math.round((nowMs() - nativeStarted) / 1000 * 1000) / 1000;
      phase = "guest-readiness";
      readiness = await this.waitGuestReady(task, stageTimings);
      phase = "guest-post-check";
      const postCheckStarted = nowMs();
      this.expectedVmIp = String(task.vm_ip);
      await this.guestIp(String(task.instance_name));
      await this.verifyGuestTools(task);
      stageTimings.post_check_seconds = Math.round((nowMs() - postCheckStarted) / 1000 * 1000) / 1000;
      task = await this.globalLock(() => this.store.transaction(() => { const current = this.store.getTask({ taskId: String(task.task_id) }); if (!current) throw new ControlError("task_missing", "task disappeared during restart"); this.checkGeneration(current, request); this.requireActive(current); return current; }));
      return { ...this.stateSummary(task), readiness, stage_timings: stageTimings };
    } catch (error) {
      const controlError = error instanceof ControlError ? error : new ControlError("internal_error", (error as Error).name);
      let cleanup: Dict = { ok: false, error: { code: "not_attempted", message: "cleanup was not attempted" } };
      try { const current = this.store.getTask({ taskId: String(task.task_id) }); if (!current) throw new ControlError("task_missing", "task disappeared during restart cleanup"); cleanup.result = await this.releaseTask(current); cleanup.ok = true; } catch (cleanupError) { cleanup.error = cleanupError instanceof ControlError ? cleanupError.asDict() : { code: "internal_error", message: (cleanupError as Error).name }; }
      const detail: Dict = isDict(controlError.detail) ? redactDiagnosticValue(controlError.detail) as Dict : { cause: controlError.asDict() };
      Object.assign(detail, { phase: detail.phase ?? phase, operation_phase: phase, cleanup });
      if (readiness) detail.readiness = readiness;
      this.store.updateTask(String(task.task_id), { last_error: stableJson({ code: "restart_partial", ...detail, error: controlError.asDict() }) });
      throw new ControlError(controlError.code, controlError.message, detail);
    }
  }

  private async guestBootId(task: Dict): Promise<string> {
    const state = await this.incus.query(`/1.0/instances/${quotePath(String(task.instance_name))}/state`);
    if (!isDict(state) || String(state.status).toLowerCase() !== "running") throw new ControlError("guest_unavailable", "live memory adjustment requires a running guest");
    const result = await this.nativeGuestExec(task, ["cat", "/proc/sys/kernel/random/boot_id"], { timeout: 15 }, false);
    const value = decode(result.stdout).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ControlError("resize_unverified", "guest boot identity is unavailable");
    return value;
  }

  private async resizeLiveMemory(task: Dict, request: Dict, old: Dict, target: Dict): Promise<Dict> {
    await this.requireWindow(task, 180);
    if (Object.keys(parseJson(String(task.resource_reservation_json || "{}")) as Dict).length) throw new ControlError("resize_incomplete", "a previous partial resize requires inspection and explicit restart recovery or release");
    if (stableJson(await this.nativeResources(task)) !== stableJson(old)) throw new ControlError("resize_unverified", "native configuration differs from the recorded allocation");
    const before = await this.guestBootId(task);
    if (stableJson(target) === stableJson(old)) return { applied: false, mode: "live-memory", plan: "unchanged", ...this.stateSummary(task) };
    const reserved = Object.fromEntries(Object.keys(old).map((key) => [key, maxIntegerValue(old[key], target[key])])) as Dict;
    await this.reserveResources(task, reserved, target.memory_mib < old.memory_mib);
    try {
      const current = this.store.getTask({ taskId: String(task.task_id) });
      this.checkGeneration(current, request);
      this.requireActive(current!);
    } catch (error) {
      await this.cancelResourceReservation(task);
      throw error;
    }
    const attempts: Dict[] = [];
    const applyMemory = async (): Promise<void> => {
      try { await this.nativeLock(task, () => this.nativeConfigSet(task, "limits.memory", `${target.memory_mib}MiB`)); attempts.push({ ok: true }); }
      catch (error) { const detail = error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name }; attempts.push({ ok: false, error: detail }); throw error; }
    };
    const completed: string[] = [];
    try {
      try { await applyMemory(); }
      catch (error) {
        const first = error instanceof ControlError ? error : new ControlError("internal_error", (error as Error).name);
        const detail = isDict(first.rawDetail) ? first.rawDetail : {};
        const stderr = typeof detail.stderr === "string" ? detail.stderr : "";
        const expected = new RegExp(`^Error: Failed updating memory limit: Failed setting memory to ${target.memory_mib}MiB \\(currently (?<current>\\d+)MiB\\) as it was taking too long$`).exec(stderr.trim());
        if (first.code !== "command_failed" || detail.returncode !== 1 || target.memory_mib >= old.memory_mib || !expected || Number(expected.groups?.current) <= target.memory_mib) throw first;
        let current = this.store.getTask({ taskId: String(task.task_id) });
        this.checkGeneration(current, request);
        this.requireActive(current!);
        await this.requireWindow(current!, MEMORY_SETTLE_SECONDS + 60);
        if (stableJson(parseJson(String(current?.resource_reservation_json || "{}"))) !== stableJson(reserved) || stableJson(await this.nativeResources(task)) !== stableJson(old) || await this.guestBootId(task) !== before) throw new ControlError("resize_unverified", "native rollback or guest continuity is unverified after balloon timeout");
        await this.reserveResources(task, reserved, true);
        await this.sleepFor(MEMORY_SETTLE_SECONDS * 1000);
        current = this.store.getTask({ taskId: String(task.task_id) });
        this.checkGeneration(current, request);
        this.requireActive(current!);
        await this.requireWindow(current!, 60);
        if (stableJson(parseJson(String(current?.resource_reservation_json || "{}"))) !== stableJson(reserved) || stableJson(await this.nativeResources(task)) !== stableJson(old) || await this.guestBootId(task) !== before) throw new ControlError("resize_unverified", "native rollback, reservation or guest continuity changed during balloon settlement");
        await this.reserveResources(task, reserved, true);
        await applyMemory();
      }
      completed.push("native_memory_update");
      if (stableJson(await this.nativeResources(task)) !== stableJson(target)) throw new ControlError("resize_unverified", "native memory configuration does not match the request");
      const after = await this.guestBootId(task);
      if (after !== before) throw new ControlError("resize_unverified", "guest boot identity changed during live adjustment");
      completed.push("guest_continuity");
      const committed = await this.globalLock(() => this.store.transaction(() => { const latest = this.store.getTask({ taskId: String(task.task_id) }); this.checkGeneration(latest, request); this.requireActive(latest!); return this.store.updateTask(String(task.task_id), { resources_json: stableJson(target), resource_reservation_json: "{}", last_error: null }); }));
      return { applied: true, mode: "live-memory", completed, native_attempts: attempts, verification: { source: "incus-live-update", configured_memory_mib: target.memory_mib, guest_boot_id: after }, ...this.stateSummary(committed) };
    } catch (error) {
      const controlError = error instanceof ControlError ? error : new ControlError("internal_error", (error as Error).name);
      const detail = { code: "resize_partial", mode: "live-memory", completed, requested: { ...target }, native_attempts: attempts, error: controlError.asDict() };
      await this.globalLock(() => this.store.transaction(() => { const current = this.store.getTask({ taskId: String(task.task_id) }); if (current && sameInteger(current.generation, task.generation)) this.store.updateTask(String(task.task_id), { last_error: stableJson(detail) }); }));
      throw new ControlError("resize_partial", "live memory adjustment is unverified; conservative allocation retained, no restart fallback", detail);
    }
  }

  private async growGuestRoot(task: Dict, diskGib: number): Promise<Dict> {
    const result = await this.nativeGuestExec(task, ["bun", "-e", GUEST_GROWTH_SCRIPT, String(diskGib)], { timeout: 120 });
    try {
      const value = parseJson(decodeUtf8Strict(result.stdout));
      if (!isDict(value) || typeof value.virtual_bytes !== "number" || value.virtual_bytes < diskGib * 1024 ** 3) throw new Error("report");
      return value;
    } catch { throw new ControlError("guest_resize_unverified", "guest capacity report is invalid"); }
  }

  async resize(request: Dict, sessionId: string): Promise<Dict> {
    const task = this.taskForSession(sessionId);
    this.checkGeneration(task, request);
    this.requireActive(task);
    await this.ownership(task);
    const old = parseJson(String(task.resources_json)) as Dict;
    const values = { cpu: request.cpu, memory_mib: request.memory_mib, disk_gib: request.disk_gib };
    const hasValue = (value: unknown): boolean => value !== undefined && value !== null;
    const hasCpu = hasValue(values.cpu);
    const hasMemory = hasValue(values.memory_mib);
    const hasDisk = hasValue(values.disk_gib);
    if (![hasCpu, hasMemory, hasDisk].some(Boolean)) throw new ControlError("invalid_request", "resize requires at least one resource");
    const target = this.requestedResources(request, old);
    const liveMemory = request.live_memory === undefined ? false : requireBoolean(request.live_memory, "live_memory");
    const allowRestart = request.allow_restart === undefined ? false : requireBoolean(request.allow_restart, "allow_restart");
    if (liveMemory) {
      if (!hasMemory || hasCpu || hasDisk || allowRestart) throw new ControlError("invalid_request", "live resize requires memory only and forbids restart allowance");
      return this.resizeLiveMemory(task, request, old, target);
    }
    const previousReservation = parseJson(String(task.resource_reservation_json || "{}")) as Dict;
    const recovering = Object.keys(previousReservation).length > 0;
    const needsRestart = stableJson(target) !== stableJson(old) || recovering;
    if (needsRestart && !allowRestart) return { applied: false, plan: "restart-required-for-resource-change", requested: target, ...this.stateSummary(task) };
    if (needsRestart && this.store.getMeta("draining") === "1") throw new ControlError("draining", "restart work is refused while draining");
    await this.requireWindow(task);
    const cost = target.disk_gib > old.disk_gib ? bigintFromInteger(this.config.resize_cost_bytes, "resize_cost_bytes") : 0n;
    let reclaimed: string[] = [];
    if (needsRestart) {
      const reserved = Object.fromEntries(Object.keys(old).map((key) => [key, maxIntegerValue(old[key], target[key], previousReservation[key] ?? 0)]));
      await this.reserveResources(task, reserved);
      try { reclaimed = await this.reclaimCapacity(cost, String(task.task_id)); await this.reserveNative(task, cost); } catch (error) { await this.cancelResourceReservation(task); throw error; }
    }
    const completed: string[] = [];
    let guest: Dict | undefined;
    let phase = "native-stop";
    const stageTimings: Dict = {};
    let readiness: Dict | undefined;
    try {
      if (needsRestart) await this.stopInstance(task);
      phase = "native-config";
      await this.nativeLock(task, async () => {
        for (const [key, nativeKey, suffix] of [["cpu", "limits.cpu", ""], ["memory_mib", "limits.memory", "MiB"]] as const) if (target[key] !== old[key] || recovering) { await this.nativeConfigSet(task, nativeKey, `${target[key]}${suffix}`); completed.push(key); }
        if (target.disk_gib > old.disk_gib) { await this.nativeDeviceSet(task, "root", "size", `${target.disk_gib}GiB`); const info = await this.ownership(task); const devices = nativeDeviceMaps(info, "resize_unverified").expanded_devices; if (!isDict(devices.root) || devices.root.size !== `${target.disk_gib}GiB`) throw new ControlError("resize_unverified", "native root size does not match request"); completed.push("virtual_disk"); }
      });
      if (needsRestart) { phase = "native-start"; const nativeStarted = nowMs(); await this.startInstance(task); stageTimings.native_start_seconds = Math.round((nowMs() - nativeStarted) / 1000 * 1000) / 1000; phase = "guest-readiness"; readiness = await this.waitGuestReady(task, stageTimings); }
      phase = "guest-post-check";
      const postCheckStarted = nowMs();
      if (stableJson(await this.nativeResources(task)) !== stableJson(target)) throw new ControlError("resize_unverified", "native resource sizes differ from the requested sizes");
      this.requireActive(task);
      this.expectedVmIp = String(task.vm_ip);
      await this.guestIp(String(task.instance_name));
      if (hasDisk) { guest = await this.growGuestRoot(task, target.disk_gib); completed.push("guest_filesystem"); }
      stageTimings.post_check_seconds = Math.round((nowMs() - postCheckStarted) / 1000 * 1000) / 1000;
      const committed = await this.globalLock(() => this.store.transaction(() => { const current = this.store.getTask({ taskId: String(task.task_id) }); this.checkGeneration(current, request); this.requireActive(current!); return this.store.updateTask(String(task.task_id), { resources_json: stableJson(target), reservation_bytes: 0n, resource_reservation_json: "{}", last_error: null }); }));
      return { applied: true, completed, guest_filesystem: guest, reclaimed, readiness, stage_timings: stageTimings, ...this.stateSummary(committed) };
    } catch (error) {
      const controlError = error instanceof ControlError ? error : new ControlError("internal_error", (error as Error).name);
      const cleanup: Dict = { performed: needsRestart, ok: true };
      if (needsRestart) try { cleanup.result = await this.releaseTask(this.store.getTask({ taskId: String(task.task_id) })!); } catch (cleanupError) { cleanup.ok = false; cleanup.error = cleanupError instanceof ControlError ? cleanupError.asDict() : { code: "internal_error", message: (cleanupError as Error).name }; }
      const detail: Dict = isDict(controlError.detail) ? redactDiagnosticValue(controlError.detail) as Dict : { cause: controlError.asDict() };
      Object.assign(detail, { phase, completed, requested: target, cleanup });
      if (readiness) detail.readiness = readiness;
      this.store.updateTask(String(task.task_id), { last_error: stableJson({ code: "resize_partial", ...detail, error: controlError.asDict() }) });
      throw new ControlError("resize_partial", "resize did not complete; inspect native and guest sizes before retrying", detail);
    }
  }

  async sshInfo(_request: Dict, sessionId: string): Promise<Dict> {
    const task = this.taskForSession(sessionId);
    this.requireActive(task);
    await this.ownership(task);
    const port = this.store.getPort(String(task.task_id), "ssh", "tcp");
    if (!port || port.state !== "active" || !sameInteger(port.generation, task.generation)) throw new ControlError("mapping_unverified", "managed SSH reservation is not active");
    const hostKey = await this.guestHostKey(String(task.instance_name));
    this.requireActive(this.store.getTask({ taskId: String(task.task_id) })!);
    return { task_id: task.task_id, generation: integerForJson(task.generation), host: this.config.host_address, port: Number(task.ssh_host_port), user: "root", host_key_alias: `agent-vm-${task.task_id}-g${integerText(task.generation)}`, host_key: hostKey };
  }

  async portAdd(request: Dict, sessionId: string): Promise<Dict> {
    const protocol = portProtocol(hasOwn(request, "port_protocol") ? request.port_protocol : "tcp");
    let task = this.taskForSession(sessionId);
    this.checkGeneration(task, request);
    this.requireActive(task);
    await this.ownership(task);
    const name = requiredString(request.name, "name", PORT_NAME_RE);
    if (name === "ssh") throw new ControlError("invalid_request", "ssh is reserved");
    const guest = numberFromInteger(request.vm_port, "vm_port", 1, 65535);
    const existing = this.store.getPort(String(task.task_id), name, String(protocol));
    if (existing) {
      if (existing.state !== "active") throw new ControlError("cleanup_incomplete", "port reservation is transitional");
      if (Number(existing.vm_port) !== guest || Number(request.host_port ?? existing.host_port) !== Number(existing.host_port)) throw new ControlError("port_exists", "existing mapping has different settings");
      task = await this.globalLock(() => this.store.transaction(() => { const current = this.store.getTask({ taskId: String(task.task_id) }); this.checkGeneration(current, request); this.requireActive(current!); return current!; }));
      try { await this.addProxy(task, existing); await this.globalLock(() => this.store.transaction(() => { const current = this.store.getTask({ taskId: String(task.task_id) }); this.checkGeneration(current, request); this.requireActive(current!); })); return this.store.getPort(String(task.task_id), name, String(protocol))!; }
      catch (error) {
        const current = this.store.getTask({ taskId: String(task.task_id) });
        const sameGeneration = Boolean(current && sameInteger(current.generation, existing.generation) && sameInteger(existing.generation, task.generation));
        let stale = !sameGeneration || !current || current.state !== "active";
        if (sameGeneration && current && current.state === "active") { const expiry = parseTime(current.lease_expires_at); stale = !expiry || expiry.getTime() <= this.now().getTime(); }
        if (stale && sameGeneration) try { await this.nativeLock(task, async () => { const latest = this.store.getTask({ taskId: String(task.task_id) }); if (latest && sameInteger(latest.generation, existing.generation) && latest.state !== "absent") { const currentPort = this.store.getPort(String(task.task_id), name, String(protocol)); if (!currentPort || sameInteger(currentPort.generation, existing.generation)) { const cleanupPort = currentPort ?? existing; await this.removeProxy(task, cleanupPort); await this.conntrackDelete(cleanupPort, task); if (currentPort) this.store.removePort(String(task.task_id), name, String(protocol)); } } }); } catch { const currentPort = this.store.getPort(String(task.task_id), name, String(protocol)); if (currentPort && sameInteger(currentPort.generation, existing.generation)) this.store.updatePort(String(task.task_id), name, String(protocol), { state: "closing" }); }
        throw error;
      }
    }
    const inventory = await this.portInventory();
    let port: Dict;
    await this.globalLock(() => this.store.transaction(() => { this.requireActive(this.store.getTask({ taskId: String(task.task_id) })!); const host = this.allocatePort(String(protocol), request.host_port, inventory); port = this.newPort(task, name, String(protocol), host, guest); this.store.putPort(port); }));
    try {
      await this.addProxy(task, port!);
      await this.globalLock(() => this.store.transaction(() => { const current = this.store.getTask({ taskId: String(task.task_id) }); this.checkGeneration(current, request); this.requireActive(current!); this.store.updatePort(String(task.task_id), name, String(protocol), { state: "active" }); }));
      return this.store.getPort(String(task.task_id), name, String(protocol))!;
    } catch (error) {
      try { await this.nativeLock(task, async () => { const current = this.store.getTask({ taskId: String(task.task_id) }); if (current && sameInteger(current.generation, port!.generation)) { await this.removeProxy(task, port!); await this.conntrackDelete(port!, task); const currentPort = this.store.getPort(String(task.task_id), name, String(protocol)); if (currentPort && sameInteger(currentPort.generation, port!.generation)) this.store.removePort(String(task.task_id), name, String(protocol)); } }); }
      catch { const currentPort = this.store.getPort(String(task.task_id), name, String(protocol)); if (currentPort && sameInteger(currentPort.generation, port!.generation)) this.store.updatePort(String(task.task_id), name, String(protocol), { state: "closing" }); }
      throw error;
    }
  }

  async portList(request: Dict, sessionId: string): Promise<Dict> {
    const task = this.taskForSession(sessionId);
    this.checkGeneration(task, request);
    this.requireActive(task);
    return { task_id: task.task_id, ports: this.store.getPorts(String(task.task_id)) };
  }

  async portRemove(request: Dict, sessionId: string): Promise<Dict> {
    const protocol = portProtocol(hasOwn(request, "port_protocol") ? request.port_protocol : "tcp");
    const task = this.taskForSession(sessionId);
    this.checkGeneration(task, request);
    this.requireActive(task);
    const name = requiredString(request.name, "name", PORT_NAME_RE);
    if (name === "ssh") throw new ControlError("invalid_request", "invalid project mapping");
    const port = this.store.getPort(String(task.task_id), name, String(protocol));
    if (port) { this.store.updatePort(String(task.task_id), name, String(protocol), { state: "closing" }); await this.nativeLock(task, async () => { await this.removeProxy(task, port, true, true); await this.conntrackDelete(port, task, true, true); this.store.removePort(String(task.task_id), name, String(protocol)); }); }
    return { task_id: task.task_id, name, protocol, removed: true };
  }

  async adminStatus(request: Dict, sessionId?: string): Promise<Dict> {
    const tasks = await Promise.all(this.store.listTasks().map((task) => this.runtimeSummary(task)));
    return { draining: this.store.getMeta("draining") === "1", tasks, doctor: await this.doctor(request, sessionId) };
  }

  async drainStatus(_request: Dict, _sessionId?: string): Promise<Dict> { return { draining: this.store.getMeta("draining") === "1" }; }
  async drainEnter(_request: Dict, _sessionId?: string): Promise<Dict> { await this.nativeBarrier(() => this.globalLock(() => this.store.setMeta("draining", "1")), true); return { draining: true }; }
  async drainExit(_request: Dict, _sessionId?: string): Promise<Dict> { await this.nativeBarrier(() => this.globalLock(() => this.store.setMeta("draining", "0")), true); return { draining: false }; }
  async adminSessionList(_request: Dict, _sessionId?: string): Promise<Dict> { return { tasks: await Promise.all(this.store.listTasks().map((task) => this.runtimeSummary(task))) }; }

  async adminReconcile(request: Dict, _sessionId?: string): Promise<Dict> {
    const apply = requireBoolean(hasOwn(request, "apply") ? request.apply : false, "reconcile apply");
    const actions: Dict[] = [];
    for (const snapshot of this.store.listTasks()) {
      try {
        await this.objectLock(`session:${snapshot.session_id}`, async () => {
          const task = this.store.getTask({ taskId: String(snapshot.task_id) });
          if (!task || task.state === "absent") return;
          const item: Dict = { task_id: task.task_id, action: "inspect" };
          if (task.state === "deleting") {
            item.action = "finish-delete";
            if (apply) {
              const expiry = parseTime(task.lease_expires_at);
              if (expiry && expiry.getTime() > this.now().getTime()) throw new ControlError("cache_ineligible", "deletion retry has an effective deadline");
              const exists = (await this.incus.listInstances()).some((native) => native.name === task.instance_name);
              if (exists) await this.nativeLock(task, async () => {
                const current = await this.deletionOperationCurrent(task);
                await this.assertNoNativeProxies(current);
                if (String((await this.incus.instanceInfo(String(current.instance_name))).status).toLowerCase() !== "stopped" || this.store.getPorts(String(current.task_id)).length) throw new ControlError("cache_ineligible", "deletion retry is not safely stopped");
                await this.nativeBarrier(async () => {
                  await this.deletionOperationCurrent(current);
                  await this.ownership(current);
                  await this.incus.delete(String(current.instance_name));
                });
              });
              if ((await this.incus.listInstances()).some((native) => native.name === task.instance_name)) throw new ControlError("cleanup_incomplete", "deletion is not confirmed");
              await this.globalLock(() => this.store.updateTask(String(task.task_id), { state: "absent", vm_ip: null, ssh_host_port: null, lease_expires_at: null, inactive_since: null, cleanup_after: null, reservation_bytes: 0n, resource_reservation_json: "{}", last_error: null }));
            }
          } else if (["closing", "preparing", "failed"].includes(String(task.state)) || (task.state === "active" && !this.stateSummary(task).effective_lease)) {
            item.action = "close-incomplete-or-expired";
            if (apply) await this.releaseTask(task);
          } else {
            await this.ownership(task);
            const status = String((await this.incus.instanceInfo(String(task.instance_name))).status).toLowerCase();
            if (task.state === "cached") { await this.assertNoNativeProxies(task); if (status !== "stopped") { item.action = "stop-unexpected-running-cache"; if (apply) await this.releaseTask({ ...task, state: "closing" }); } }
            else if (task.state === "active") {
              item.action = "rearm-current-expiry";
              if (status !== "running") throw new ControlError("state_mismatch", "active guest is not running");
              if (apply) { await this.scheduleExpiry(task); for (const port of this.store.getPorts(String(task.task_id))) if (["closing", "preparing"].includes(String(port.state))) { await this.nativeLock(task, async () => { await this.removeProxy(task, port, true, true); await this.conntrackDelete(port, task, true, true); this.store.removePort(String(task.task_id), String(port.port_name), String(port.protocol)); }); } }
            }
          }
          actions.push(item);
        }, false);
      } catch (error) { actions.push({ task_id: snapshot.task_id, error: error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name } }); }
    }
    return { dry_run: !apply, actions };
  }

  async adminGc(request: Dict, _sessionId?: string, ageFiltered = false): Promise<Dict> {
    const apply = requireBoolean(hasOwn(request, "apply") ? request.apply : false, "GC apply");
    const candidates: Dict[] = [];
    for (const snapshot of this.store.listTasks()) {
      try {
        await this.objectLock(`session:${snapshot.session_id}`, async () => {
          const task = this.store.getTask({ taskId: String(snapshot.task_id) });
          if (!task || task.state !== "cached" || !task.inactive_since || !sameInteger(task.generation, snapshot.generation)) return;
          if (ageFiltered) { const inactive = parseTime(task.inactive_since); if (!inactive || inactive.getTime() + Number(this.config.cache_seconds) * 1000 > this.now().getTime()) return; }
          const eligible = await this.eligibleCache(task);
          const candidate = { task_id: eligible.task_id, instance_name: eligible.instance_name, generation: integerForJson(eligible.generation), inactive_since: eligible.inactive_since };
          if (apply) await this.deleteCache(eligible);
          candidates.push(candidate);
        }, false);
      } catch (error) {
        if (error instanceof ControlError && ["cache_ineligible", "object_busy"].includes(error.code)) continue;
        candidates.push({ task_id: snapshot.task_id, error: error instanceof ControlError ? error.asDict() : { code: "internal_error", message: (error as Error).name } });
      }
    }
    return { dry_run: !apply, selection: ageFiltered ? "age" : "eligible", minimum_idle_seconds: ageFiltered ? this.config.cache_seconds : 0, candidates };
  }

  async timerExpire(request: Dict, _sessionId?: string): Promise<Dict> {
    const taskId = requiredString(request.task_id, "task_id", TASK_ID_RE);
    const generation = numberFromInteger(request.generation, "generation", 1);
    const task = this.store.getTask({ taskId });
    if (!task || !sameInteger(task.generation, generation)) return { task_id: taskId, reason: task ? "stale-generation" : "missing", action: "noop" };
    if (task.state === "closing") return this.releaseTask(task);
    if (!["active", "preparing"].includes(String(task.state))) return { action: "noop", reason: "inactive" };
    const expiry = parseTime(task.lease_expires_at);
    if (expiry && expiry.getTime() > this.now().getTime()) { await this.scheduleExpiry(task); return { action: "rearmed", reason: "not-expired" }; }
    return this.releaseTask(task);
  }

  async timerAgeGc(_request: Dict, sessionId?: string): Promise<Dict> { return this.adminGc({ apply: true }, sessionId, true); }
  async timerReconcile(_request: Dict, sessionId?: string): Promise<Dict> { return this.adminReconcile({ apply: true }, sessionId); }
}

export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export function parseRequestBytes(bytes: Uint8Array): Dict {
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new ControlError("request_too_large", "request exceeds 2 MiB");
  try {
    const value = parseJson(decodeUtf8Strict(bytes));
    if (!isDict(value)) throw new ControlError("invalid_request", "stdin JSON root must be an object");
    return value;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError("invalid_request", "stdin must contain one UTF-8 JSON object");
  }
}

async function requestFromStdin(): Promise<Dict> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes <= MAX_REQUEST_BYTES) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = MAX_REQUEST_BYTES + 1 - bytes;
      const chunk = item.value.slice(0, remaining);
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ControlError("request_too_large", "request exceeds 2 MiB");
      }
    }
  } finally {
    reader.releaseLock();
  }
  const rawBytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { rawBytes.set(chunk, offset); offset += chunk.length; }
  return parseRequestBytes(rawBytes);
}

function parseTimerArgs(argv: readonly string[]): Dict | undefined {
  if (argv.length === 2 && argv[0] === "--timer-expire") {
    const match = /^([a-z0-9][a-z0-9-]{0,47})-g([0-9]+)$/.exec(argv[1] ?? "");
    if (!match) throw new ControlError("invalid_timer", "invalid expiry timer instance");
    return { protocol: PROTOCOL_VERSION, action: "timer-expire", task_id: match[1], generation: integerForJson(BigInt(match[2]!)) };
  }
  if (argv.length === 1 && argv[0] === "--timer-age-gc") return { protocol: PROTOCOL_VERSION, action: "timer-age-gc" };
  if (argv.length === 1 && argv[0] === "--timer-reconcile") return { protocol: PROTOCOL_VERSION, action: "timer-reconcile" };
  return undefined;
}

export function writeProcessOutput(value: string): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(value, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite());
  });
}

export async function runMain(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  try {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const timerRequest = parseTimerArgs(argv);
    if (!timerRequest && argv.length) throw new ControlError("invalid_request", "unknown command-line arguments");
    const request = timerRequest ?? await requestFromStdin();
    const control = new Control(config);
    const response = await control.dispatch(request);
    await writeProcessOutput(`${emitJson(response)}\n`);
    control.store.close();
    return 0;
  } catch (error) {
    if (error instanceof ControlError) { await new Promise<void>((resolveWrite) => process.stderr.write(`${emitJson({ ok: false, error: error.asDict() })}\n`, () => resolveWrite())); return 2; }
    await new Promise<void>((resolveWrite) => process.stderr.write(`${emitJson({ ok: false, error: { code: "internal_error", message: error instanceof Error ? error.name : "Error" } })}\n`, () => resolveWrite()));
    return 3;
  }
}

if (import.meta.main) process.exit(await runMain());
