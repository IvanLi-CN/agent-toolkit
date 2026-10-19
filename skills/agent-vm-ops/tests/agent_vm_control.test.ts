import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommandRunner,
  COMMAND_OUTPUT_LIMIT,
  Control,
  ControlError,
  CTResources,
  GUEST_GROWTH_SCRIPT,
  IncusClient,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  parseRequestBytes,
  StateStore,
  SystemdManager,
  loadConfig,
  validateProtectedDirectory,
  validateSystemdRuntime,
} from "../scripts/agent_vm_control.ts";

const GIB = 1024 ** 3;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestfixture";
const CONTROL_PATH = fileURLToPath(new URL("../scripts/agent_vm_control.ts", import.meta.url));
setDefaultTimeout(15_000);

type Dict = Record<string, any>;
type RunnerOptions = { inputData?: Uint8Array | string; timeout?: number; check?: boolean };
type ProcessResult = { args: string[]; returncode: number; stdout: Uint8Array; stderr: Uint8Array; stdoutTruncated?: boolean };
type GuestFixtureOptions = { fstype?: "ext4" | "xfs"; parent?: string; virtualBytes?: number; includeGrowpart?: boolean; delayCommand?: "findmnt" | "growpart" };
type GuestFixture = { root: string; bin: string; log: string; env: Record<string, string> };
type TestCallback = () => void | Promise<void>;

function linuxTest(name: string, callback: TestCallback): void {
  if (process.platform === "linux") test(name, callback);
  else test.skip(name, callback);
}

function result(args: readonly string[], stdout: string | Dict | Dict[] = "", returncode = 0, stderr = ""): ProcessResult {
  const text = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
  return { args: [...args], returncode, stdout: new TextEncoder().encode(text), stderr: new TextEncoder().encode(stderr) };
}

function createGuestFixture(base: string, options: GuestFixtureOptions = {}): GuestFixture {
  const root = join(base, "guest-root");
  const bin = join(base, "guest-bin");
  const log = join(base, "guest-commands.log");
  mkdirSync(join(root, "sys/class/block/vda1"), { recursive: true });
  mkdirSync(join(root, "dev"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "sys/class/block/vda1/partition"), "1\n");
  const writeCommand = (name: string, body: string): void => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const delayed = (name: string, body: string): string => options.delayCommand === name ? "exec sleep 1" : body;
  writeCommand("findmnt", delayed("findmnt", 'case "$*" in *SOURCE*) printf \'%s/dev/vda1\\n\' "$AGENT_GUEST_ROOT" ;; *FSTYPE*) printf \'%s\\n\' "$AGENT_GUEST_FSTYPE" ;; *) exit 2 ;; esac'));
  writeCommand("realpath", 'printf \'%s\\n\' "$1"');
  writeCommand("lsblk", 'printf \'%s\\n\' "$AGENT_GUEST_PARENT"');
  writeCommand("blockdev", 'printf \'%s\\n\' "$AGENT_GUEST_VIRTUAL_BYTES"');
  if (options.includeGrowpart !== false) writeCommand("growpart", delayed("growpart", 'printf \'growpart\\n\' >> "$AGENT_GUEST_LOG"; printf \'CHANGED\\n\''));
  writeCommand("resize2fs", 'printf \'resize2fs\\n\' >> "$AGENT_GUEST_LOG"');
  writeCommand("xfs_growfs", 'printf \'xfs_growfs\\n\' >> "$AGENT_GUEST_LOG"');
  return {
    root,
    bin,
    log,
    env: {
      AGENT_GUEST_ROOT: root,
      AGENT_GUEST_FSTYPE: options.fstype ?? "ext4",
      AGENT_GUEST_PARENT: options.parent ?? "vda",
      AGENT_GUEST_VIRTUAL_BYTES: String(options.virtualBytes ?? 2 * GIB),
      AGENT_GUEST_LOG: log,
    },
  };
}

function runGuestGrowth(guest: GuestFixture, diskGib: number, script = GUEST_GROWTH_SCRIPT, virtualBytes?: number): { exitCode: number; stdout: string; stderr: string } {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = Bun.spawnSync([process.execPath, "-e", script, String(diskGib), guest.root], {
    env: { ...inherited, ...guest.env, ...(virtualBytes === undefined ? {} : { AGENT_GUEST_VIRTUAL_BYTES: String(virtualBytes) }), PATH: `${guest.bin}:${inherited.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, stdout: new TextDecoder().decode(child.stdout), stderr: new TextDecoder().decode(child.stderr) };
}

class NativeCommands extends CommandRunner {
  readonly instances = new Map<string, Dict>();
  readonly calls: Array<{ args: string[]; options: RunnerOptions }> = [];
  failure: ((args: string[]) => boolean) | undefined;
  projectLimits: Dict = {};
  proxyAllowed = true;
  imageAvailable = true;
  imageType = "virtual-machine";
  guestToolsAvailable = true;
  waitTimeout = false;
  missingGuestTool: string | undefined;
  onWait: ((name: string, condition: string) => void) | undefined;
  onStart: ((name: string) => void) | undefined;
  onConfigSet: ((name: string, key: string, value: string) => void) | undefined;
  aclMalformedDirection: "ingress" | "egress" | undefined;
  aclMalformedEntries: unknown[] = [];
  guestFixture: GuestFixture | undefined;
  malformedInventory = false;
  malformedListRecord = false;
  invalidDeviceMaps = false;
  conntrackListOutput = "";

  configureGuest(root: string): void { this.guestFixture = createGuestFixture(root, { virtualBytes: 20 * GIB }); }

  override async run(argv: readonly string[], options: RunnerOptions = {}): Promise<ProcessResult> {
    const args = [...argv];
    this.calls.push({ args, options });
    if (this.failure?.(args)) throw new ControlError("command_failed", "injected native failure", { returncode: 1, stderr: "injected native failure" });
    if (this.waitTimeout && args[0] === "incus" && args.includes("wait")) return result(args, "", 1, "timeout");
    if (args[0] === "ss") return result(args);
    if (args[0] === "conntrack") return result(args, args[1] === "-L" ? this.conntrackListOutput : "");
    if (args[0] === "systemctl") return result(args);
    if (args[0] !== "incus") throw new Error(`unexpected command: ${args.join(" ")}`);
    if (args[1] === "query") return this.query(args);
    if (args[1] === "--project") return this.incus(args.slice(3));
    throw new Error(`unexpected incus command: ${args.join(" ")}`);
  }

  override async runBounded(argv: readonly string[], options: RunnerOptions = {}): Promise<ProcessResult> {
    return this.run(argv, options);
  }

  private query(args: string[]): ProcessResult {
    const url = new URL(args[2]!, "http://incus.test");
    const path = url.pathname;
    const project = url.searchParams.get("project") ?? "agents";
    if (path === "/1.0/projects") return result(args, [{ name: "agents" }, { name: "default" }]);
    if (path === "/1.0/projects/agents") return result(args, { config: { ...this.projectLimits, "restricted.devices.proxy": this.proxyAllowed ? "allow" : "block" } });
    if (path === "/1.0/projects/default") return result(args, { config: {} });
    if (path === "/1.0/network-acls/agent-vm-isolation") return result(args, this.acl());
    if (path.startsWith("/1.0/images/")) {
      if (!this.imageAvailable) throw new ControlError("command_failed", "image absent");
      return result(args, { fingerprint: path.split("/").at(-1), type: this.imageType });
    }
    if (path === "/1.0/instances") {
      const instances = project === "agents" ? [...this.instances.values()] : [];
      return result(args, this.malformedInventory && project === "agents" ? [...instances, "malformed-record"] as any : instances);
    }
    if (path === "/1.0/networks") return result(args, [{ managed: true, type: "bridge", name: "agentsbr0" }]);
    if (path.endsWith("/forwards")) return result(args, []);
    if (path.endsWith("/leases")) return result(args, []);
    if (path.startsWith("/1.0/instances/")) {
      const name = path.split("/")[3]!;
      const instance = this.instances.get(name);
      if (!instance) throw new ControlError("command_failed", "instance absent");
      if (path.endsWith("/state")) {
        return result(args, { status: instance.status, network: { eth0: { addresses: [{ family: "inet", address: instance.expanded_devices.eth0["ipv4.address"] }] } } });
      }
      return result(args, this.invalidDeviceMaps ? { ...instance, devices: null, expanded_devices: null } : instance);
    }
    throw new Error(`unexpected query: ${path}`);
  }

  private incus(command: string[]): ProcessResult {
    const verb = command[0];
    if (verb === "list") return result(["incus", ...command], this.malformedListRecord ? [...this.instances.values(), {}] : [...this.instances.values()]);
    if (verb === "init") {
      const image = command[1]!;
      const name = command[2]!;
      if (this.instances.has(name)) throw new Error("duplicate init");
      const config: Dict = { "boot.autostart": "false" };
      for (let index = 0; index < command.length; index += 1) if (command[index] === "--config") {
        const [key, value] = command[index + 1]!.split("=", 2);
        config[key!] = value;
      }
      this.instances.set(name, {
        name,
        image,
        status: "Stopped",
        config,
        expanded_config: config,
        devices: { eth0: { type: "nic", network: "agentsbr0", hwaddr: "00:16:3e:00:00:01" }, root: { type: "disk", size: "20GiB" } },
        expanded_devices: { eth0: { type: "nic", network: "agentsbr0", hwaddr: "00:16:3e:00:00:01" }, root: { type: "disk", size: "20GiB" } },
        boot_id: "00000000-0000-4000-8000-000000000001",
        guest_disk_bytes: 20 * GIB,
        agent_ready: false,
      });
      return result(["incus", ...command]);
    }
    if (["start", "stop", "delete"].includes(String(verb))) {
      const name = command[1]!;
      const instance = this.instances.get(name);
      if (!instance) throw new ControlError("command_failed", "instance absent");
      if (verb === "delete") this.instances.delete(name);
      else {
        instance.status = verb === "start" ? "Running" : "Stopped";
        instance.agent_ready = false;
        if (verb === "start") {
          instance.guest_disk_bytes = Number.parseInt(String(instance.expanded_devices.root.size), 10) * GIB;
          this.onStart?.(name);
        }
      }
      return result(["incus", ...command]);
    }
    if (verb === "wait") {
      const name = command[1]!;
      const condition = command[2]!;
      const instance = this.instances.get(name)!;
      this.onWait?.(name, condition);
      if (condition === "agent") instance.agent_ready = true;
      return result(["incus", ...command]);
    }
    if (command[0] === "config" && command[1] === "set") {
      const instance = this.instances.get(command[2]!)!;
      const [key, value] = command[3]!.split("=", 2);
      instance.config[key!] = value;
      instance.expanded_config[key!] = value;
      this.onConfigSet?.(command[2]!, key!, value!);
      return result(["incus", ...command]);
    }
    if (command[0] === "config" && command[1] === "device") return this.deviceCommand(command);
    if (verb === "exec") return this.exec(command);
    throw new Error(`unexpected incus command: ${command.join(" ")}`);
  }

  private deviceCommand(command: string[]): ProcessResult {
    const action = command[2]!;
    const name = command[3]!;
    const deviceName = command[4]!;
    const instance = this.instances.get(name)!;
    if (action === "remove") {
      delete instance.devices[deviceName];
      delete instance.expanded_devices[deviceName];
      return result(["incus", ...command]);
    }
    const properties = { ...(instance.expanded_devices[deviceName] ?? {}) };
    const start = action === "add" ? 6 : 5;
    if (action === "add") properties.type = command[5];
    for (const item of command.slice(start)) {
      const [key, value] = item.split("=", 2);
      properties[key!] = value;
    }
    instance.devices[deviceName] = { ...properties };
    instance.expanded_devices[deviceName] = { ...properties };
    return result(["incus", ...command]);
  }

  private exec(command: string[]): ProcessResult {
    const name = command[1]!;
    const instance = this.instances.get(name)!;
    if (!instance.agent_ready) throw new ControlError("command_failed", "VM agent is not ready");
    const guestArgs = command.slice(3);
    const joined = guestArgs.join(" ");
    if (joined.includes("ssh_host_ed25519_key.pub")) return result(["incus", ...command], KEY);
    if (guestArgs[0] === "cat" && guestArgs[1] === "/proc/sys/kernel/random/boot_id") return result(["incus", ...command], instance.boot_id);
    if (guestArgs[0] === "sh" && joined.includes("command -v")) {
      if (!this.guestToolsAvailable || (this.missingGuestTool && joined.includes(`'${this.missingGuestTool}'`))) throw new ControlError("command_failed", "required guest tool is missing", { returncode: 127, stderr: `${this.missingGuestTool ?? "bun"}: command not found` });
      return result(["incus", ...command]);
    }
    if (guestArgs[0] === "bun" && guestArgs[1] === "-e" && this.guestFixture) {
      const growth = runGuestGrowth(this.guestFixture, Number(instance.guest_disk_bytes) / GIB, guestArgs[2], instance.guest_disk_bytes);
      if (growth.exitCode !== 0) throw new ControlError("command_failed", "guest growth program failed", { returncode: growth.exitCode, stderr: growth.stderr.slice(-4000) });
      return result(["incus", ...command], growth.stdout);
    }
    if (guestArgs[0] === "bun") return result(["incus", ...command], { virtual_bytes: instance.guest_disk_bytes, filesystem_before: instance.guest_disk_bytes - 1024, filesystem_bytes: instance.guest_disk_bytes, filesystem: "ext4" });
    return result(["incus", ...command]);
  }

  private acl(): Dict {
    const start = "198.51.100.20";
    const end = "198.51.100.250";
    const value: Dict = {
      config: { "user.agent-vm.managed": "native-v1" },
      ingress: [{ action: "drop", state: "enabled", source: `${start}-${end}` }],
      egress: [
        { action: "drop", state: "enabled", destination: `${start}-${end}` },
        { action: "drop", state: "enabled", destination: "198.51.100.19" },
        { action: "drop", state: "enabled", destination: "198.51.100.1", protocol: "tcp", destination_port: "22" },
      ],
    };
    if (this.aclMalformedDirection) value[this.aclMalformedDirection] = [...value[this.aclMalformedDirection], ...this.aclMalformedEntries];
    return value;
  }
}

class Fixture {
  readonly root = mkdtempSync("/tmp/agent-vm-control-test-");
  readonly runner = new NativeCommands();
  readonly store: StateStore;
  readonly systemd: SystemdManager;
  readonly control: Control;
  now = new Date("2026-10-04T00:00:00.000Z");
  memoryAvailable = 24 * GIB;
  storageFree = 80 * GIB;
  storeClosed = false;
  readonly settleDelays: number[] = [];
  onSettle: ((milliseconds: number) => void) | undefined;
  readonly config: Dict;

  constructor() {
    mkdirSync(join(this.root, "systemd"), { recursive: true, mode: 0o755 });
    this.config = {
      project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64),
      network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19",
      port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1",
      initial_lease_seconds: 1800, renew_seconds: 900, max_lease_seconds: 7200, cache_seconds: 86400,
      create_cost_bytes: 4 * GIB, resume_cost_bytes: GIB, resize_cost_bytes: GIB, storage_path: this.root,
      cpu_budget: 4, memory_budget_mib: 16384, cpu_overcommit_ratio: 4, memory_overcommit_ratio: 4,
      required_guest_tools: ["bun", "python3", "sshd", "rsync", "docker"], state_db: join(this.root, "state.sqlite3"), timer_dir: join(this.root, "systemd"),
    };
    this.runner.configureGuest(this.root);
    this.store = StateStore.bootstrap(this.config.state_db);
    this.systemd = new SystemdManager(this.runner, this.config, false);
    const resources = { cpu: () => 16, memory: () => ({ scope: "ct-memory", sources: ["lxcfs"], limit_bytes: 32 * GIB, available_bytes: this.memoryAvailable, threshold_bytes: 4 * GIB }) };
    this.control = new Control(this.config, {
      runner: this.runner,
      store: this.store,
      systemd: this.systemd,
      resources: resources as unknown as CTResources,
      clock: () => this.now,
      sleep: async (milliseconds) => { this.settleDelays.push(milliseconds); this.onSettle?.(milliseconds); },
      which: (command) => command === "conntrack" ? "/usr/sbin/conntrack" : null,
    });
    (this.control as any).ensureCapacityVerified = () => ({ scope: "ct-filesystem", observed_at: this.now.toISOString(), layers: [{ label: "ct-filesystem", total: 100 * GIB, free: this.storageFree, kind: "data", low: 1 * GIB, target: 2 * GIB }] });
    (this.control as any).ephemeralPorts = () => new Set<number>();
  }

  close(): void { if (!this.storeClosed) { this.store.close(); this.storeClosed = true; } rmSync(this.root, { recursive: true, force: true }); }

  request(action: string, fields: Dict = {}, operation?: string, sessionId = "thread-a"): Dict {
    const task = this.store.getTask({ sessionId });
    return { protocol: PROTOCOL_VERSION, action, session_id: sessionId, generation: Number(task?.generation ?? 0), operation_id: operation ?? `op-${Math.random().toString(16).slice(2)}`, ...fields };
  }

  async call(action: string, fields: Dict = {}, operation?: string): Promise<Dict> {
    const response = await this.control.dispatch(this.request(action, fields, operation));
    return response.result;
  }

  async callFor(sessionId: string, action: string, fields: Dict = {}, operation?: string): Promise<Dict> {
    const response = await this.control.dispatch(this.request(action, fields, operation, sessionId));
    return response.result;
  }
}

const fixtures: Fixture[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.close(); });
function fixture(): Fixture { const value = new Fixture(); fixtures.push(value); return value; }

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  try { await action; throw new Error(`expected ${code}`); }
  catch (error) { if (error instanceof Error && error.message === `expected ${code}`) throw error; expect((error as ControlError).code).toBe(code); }
}

function balloonTimeout(target: number): ControlError {
  return new ControlError("command_failed", "balloon update timed out", { returncode: 1, stderr: `Error: Failed updating memory limit: Failed setting memory to ${target}MiB (currently 4096MiB) as it was taking too long` });
}

function expectSyncCode(action: () => unknown, code: string): void {
  try { action(); throw new Error(`expected ${code}`); }
  catch (error) { if (error instanceof Error && error.message === `expected ${code}`) throw error; expect((error as ControlError).code).toBe(code); }
}

function writeLegacyOperation(dbPath: string, response: Dict): void {
  const fixtureScript = join(import.meta.dir, "fixtures", "legacy_state_fixture.py");
  const responsePath = dbPath + ".response.json";
  writeFileSync(responsePath, JSON.stringify(response), { mode: 0o600 });
  try {
    const child = Bun.spawnSync(["python3", fixtureScript, dbPath, "@" + responsePath], { stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(`legacy fixture failed: ${new TextDecoder().decode(child.stderr)}`);
  } finally { rmSync(responsePath, { force: true }); }
}

async function collect(child: any): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exit = await child.exited;
  return { exit, stdout: await stdout, stderr: await stderr };
}

test("loads Bun and Python 3 as managed guest prerequisites", () => {
  const root = mkdtempSync("/tmp/agent-vm-config-test-");
  try {
    const config = { project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: root, state_db: join(root, "state.sqlite3"), timer_dir: root };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    expect(loadConfig(join(root, "config.json")).required_guest_tools).toEqual(["bun", "python3", "sshd", "rsync", "docker", "growpart"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails closed on missing or invalid environment config before native writes", () => {
  const root = mkdtempSync("/tmp/agent-vm-config-contract-test-");
  mkdirSync(join(root, "systemd"), { recursive: true, mode: 0o755 });
  const base: Dict = { project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: root, state_db: join(root, "state.sqlite3"), timer_dir: join(root, "systemd") };
  const required = ["project", "profile", "image_alias", "image_fingerprint", "network", "network_acl", "pool", "host_address", "port_start", "port_end", "vm_ip_start", "vm_ip_end", "gateway_ip", "storage_path", "state_db", "timer_dir"];
  const runner = new NativeCommands();
  try {
    expectSyncCode(() => loadConfig(join(root, "missing.json")), "config_missing");
    for (const field of required) {
      const config = { ...base };
      delete config[field];
      const path = join(root, `missing-${field}.json`);
      writeFileSync(path, JSON.stringify(config));
      expectSyncCode(() => loadConfig(path), "config_missing");
    }
    const invalid: Dict[] = [
      { ...base, image_fingerprint: "A".repeat(64) },
      { ...base, port_start: "20000" },
      { ...base, renew_seconds: 7201 },
      { ...base, cpu_overcommit_ratio: "0.99" },
      { ...base, required_guest_tools: ["bun", 7] },
      { ...base, vm_ip_start: "198.51.100.250", vm_ip_end: "198.51.100.20" },
    ];
    for (const [index, config] of invalid.entries()) {
      const path = join(root, `invalid-${index}.json`);
      writeFileSync(path, JSON.stringify(config));
      expectSyncCode(() => loadConfig(path), "config_invalid");
    }
    expect(runner.calls).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("requires protected canonical config and timer paths", () => {
  const root = mkdtempSync("/tmp/agent-vm-path-contract-test-");
  const timer = join(root, "systemd");
  mkdirSync(timer, { recursive: true, mode: 0o755 });
  const base: Dict = { project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: root, state_db: join(root, "state.sqlite3"), timer_dir: timer };
  const configPath = join(root, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify(base));
    chmodSync(configPath, 0o666);
    expectSyncCode(() => loadConfig(configPath), "config_invalid");
    chmodSync(configPath, 0o600);
    const link = join(root, "config-link.json");
    symlinkSync(configPath, link);
    expectSyncCode(() => loadConfig(link), "config_invalid");
    chmodSync(timer, 0o777);
    expectSyncCode(() => validateProtectedDirectory(timer), "config_invalid");
    chmodSync(timer, 0o755);
    for (const field of ["storage_path", "state_db", "timer_dir"]) {
      const relative = { ...base, [field]: field === "state_db" ? "state.sqlite3" : "." };
      const relativePath = join(root, `relative-${field}.json`);
      writeFileSync(relativePath, JSON.stringify(relative));
      expectSyncCode(() => loadConfig(relativePath), "config_invalid");
    }
    const alias = join(root, "alias");
    symlinkSync(root, alias);
    const aliased = { ...base, storage_path: alias, state_db: join(alias, "state.sqlite3"), timer_dir: join(alias, "systemd") };
    const aliasedPath = join(root, "aliased.json");
    writeFileSync(aliasedPath, JSON.stringify(aliased));
    expectSyncCode(() => loadConfig(aliasedPath), "config_invalid");
    expectSyncCode(() => StateStore.bootstrap(join(alias, "aliased-state.sqlite3")), "state_path_unsafe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validates systemd runtime and control script boundaries", () => {
  const root = mkdtempSync("/tmp/agent-vm-systemd-runtime-test-");
  const canonicalRoot = realpathSync(root);
  const bunPath = join(canonicalRoot, "bun");
  const controlPath = join(canonicalRoot, "agent_vm_control.ts");
  try {
    writeFileSync(bunPath, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(controlPath, "// isolated test entrypoint\n", { mode: 0o644 });
    validateSystemdRuntime({ bunPath, controlPath });
    chmodSync(controlPath, 0o666);
    expectSyncCode(() => validateSystemdRuntime({ bunPath, controlPath }), "config_invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepts scientific ratios and preserves large integer config and request values", () => {
  const root = mkdtempSync("/tmp/agent-vm-numeric-contract-test-");
  mkdirSync(join(root, "systemd"), { recursive: true, mode: 0o755 });
  const base: Dict = { project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: root, state_db: join(root, "state.sqlite3"), timer_dir: join(root, "systemd"), cpu_overcommit_ratio: 1e21, create_cost_bytes: "9007199254740993" };
  const configPath = join(root, "config.json");
  const raw = JSON.stringify(base).replace('"create_cost_bytes":"9007199254740993"', '"create_cost_bytes":9007199254740993');
  writeFileSync(configPath, raw);
  try {
    const config = loadConfig(configPath);
    expect(config.cpu_overcommit_ratio).toEqual({ numerator: 10n ** 21n, denominator: 1n, text: "1e+21" });
    expect(config.create_cost_bytes).toBe(9007199254740993n);

    const request = parseRequestBytes(new TextEncoder().encode('{"protocol":4,"action":"status","session_id":"large","generation":9007199254740993}'));
    expect(request.generation).toBe(9007199254740993n);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects invalid UTF-8 at both config and request boundaries", () => {
  const root = mkdtempSync("/tmp/agent-vm-utf8-contract-test-");
  const configPath = join(root, "config.json");
  try {
    writeFileSync(configPath, Uint8Array.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x22, 0x3a, 0xff, 0x7d]));
    expectSyncCode(() => loadConfig(configPath), "config_invalid");
    expectSyncCode(() => parseRequestBytes(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])), "invalid_request");
    expectSyncCode(() => parseRequestBytes(new Uint8Array(MAX_REQUEST_BYTES + 1)), "request_too_large");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uses the sixty-second default for generic and Incus commands while preserving explicit budgets", async () => {
  class CaptureRunner extends CommandRunner {
    readonly timeouts: Array<number | undefined> = [];

    override async runBounded(argv: readonly string[], options: RunnerOptions = {}): Promise<ProcessResult> {
      this.timeouts.push(options.timeout);
      return result(argv);
    }
  }
  const runner = new CaptureRunner();
  await runner.run(["true"]);
  const client = new IncusClient(runner, { project: "agents" });
  await client.call(["status"]);
  await client.exec("agent-vm-test", ["true"]);
  await client.call(["status"], { timeout: 7 });
  await client.exec("agent-vm-test", ["true"], { timeout: 8 });
  expect(runner.timeouts).toEqual([60, 60, 60, 7, 8]);
});

test("quotes every Incus API path segment without restoring encoded slashes", async () => {
  class CaptureRunner extends CommandRunner {
    readonly argv: string[][] = [];

    override async runBounded(argv: readonly string[], _options: RunnerOptions = {}): Promise<ProcessResult> {
      this.argv.push([...argv]);
      return result(argv, {});
    }
  }
  const runner = new CaptureRunner();
  await new IncusClient(runner, { project: "agents" }).instanceInfo("tenant/name");
  expect(runner.argv.at(-1)?.[2]).toContain("/1.0/instances/tenant%2Fname/state?project=agents");
  expect(runner.argv.at(-1)?.[2]).not.toContain("/1.0/instances/tenant/name/state");
});

test("rejects invalid identity, protocol, action and generation before native writes", async () => {
  const f = fixture();
  await expectCode(f.control.dispatch({ protocol: 3, action: "acquire", session_id: "thread-a", generation: 0, operation_id: "old-protocol", public_key: KEY }), "protocol_mismatch");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status" }), "invalid_request");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "not-an-action", session_id: "thread-a" }), "unknown_action");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "acquire", session_id: "thread-a", generation: 1, operation_id: "wrong-generation", public_key: KEY }), "generation_mismatch");
  expect(f.runner.calls).toHaveLength(0);
});

test("verifies real CT resource accounting and filesystem capacity inputs", () => {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/cpu.max": "200000 100000\n",
    "/sys/fs/cgroup/memory.max": String(8 * GIB),
    "/sys/fs/cgroup/memory.current": String(5 * GIB),
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file " + (1 * GIB) + "\n",
    "/proc/self/mountinfo": "36 25 0:32 / /proc/meminfo rw,relatime - proc proc rw\n",
  };
  const resources = new CTResources({ readText: (path) => files[path] ?? (() => { throw new Error("missing fixture: " + path); })(), availableParallelism: () => 8 });
  expect(resources.cpu()).toBe(2);
  expect(resources.memory()).toMatchObject({ scope: "ct-memory", sources: ["cgroup-v2"], limit_bytes: 8 * GIB, available_bytes: 4 * GIB });

  files["/sys/fs/cgroup/cpu.max"] = "max 100000\n";
  expect(resources.cpu()).toBe(8);
  files["/sys/fs/cgroup/memory.max"] = "max\n";
  files["/proc/self/mountinfo"] = "36 25 0:32 / /proc/meminfo rw,relatime - fuse.lxcfs lxcfs rw\n";
  files["/proc/meminfo"] = "MemTotal: 6144 kB\nMemAvailable: 4096 kB\n";
  expect(resources.memory()).toMatchObject({ sources: ["lxcfs"], limit_bytes: 6144 * 1024, available_bytes: 4096 * 1024 });

  files["/sys/fs/cgroup/memory.max"] = "8192";
  files["/sys/fs/cgroup/memory.stat"] = "inactive_file 1\ninactive_file 2\n";
  expectSyncCode(() => resources.memory(), "resource_unverified");
  files["/sys/fs/cgroup/memory.stat"] = "inactive_file 1\n";
  files["/sys/fs/cgroup/cpu.max"] = "broken";
  expectSyncCode(() => resources.cpu(), "resource_unverified");

  const f = fixture();
  const valid = new Control(f.config, { store: f.store, runner: f.runner, systemd: f.systemd, resources, statfs: () => ({ blocks: 100n * BigInt(GIB), bfree: 40n * BigInt(GIB), bavail: 30n * BigInt(GIB), bsize: 1n }) });
  expect((valid as any).ensureCapacityVerified().layers[0]).toMatchObject({ total: 100 * GIB, free: 30 * GIB });
  const invalid = new Control(f.config, { store: f.store, runner: f.runner, systemd: f.systemd, resources, statfs: () => ({ blocks: 100n, bfree: 40n, bavail: 101n, bsize: 1024n }) });
  expectSyncCode(() => (invalid as any).ensureCapacityVerified(), "capacity_unverified");
});

test("status envelope generation follows active and absent session state", async () => {
  const f = fixture();
  const absent = await f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status", session_id: "missing-session" });
  expect(absent.generation).toBe(0);
  expect(absent.generation).toBe(absent.result.generation);
  expect(absent.operation_id).toBeNull();
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status", session_id: "missing-session", generation: 1 }), "generation_mismatch");

  const acquired = await f.control.dispatch(f.request("acquire", { public_key: KEY }, "op-status-generation-acquire"));
  const active = await f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status", session_id: "thread-a" });
  expect(active.generation).toBe(acquired.result.generation);
  expect(active.generation).toBe(active.result.generation);
  expect(active.operation_id).toBeNull();
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status", session_id: "thread-a", generation: Number(active.generation) + 1 }), "generation_mismatch");
});

test("ssh-info binds the request, envelope, port and alias to one generation", async () => {
  const f = fixture();
  const acquired = await f.control.dispatch(f.request("acquire", { public_key: KEY }, "op-ssh-info-generation-acquire"));
  const generation = acquired.result.generation;
  const response = await f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "ssh-info", session_id: "thread-a", generation });
  expect(response.generation).toBe(generation);
  expect(response.result).toMatchObject({ generation, task_id: acquired.result.task_id, user: "root", host_key_alias: `agent-vm-${acquired.result.task_id}-g${generation}` });
  expect(response.result.port).toBe(acquired.result.ssh_host_port);
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "ssh-info", session_id: "thread-a", generation: generation + 1 }), "generation_mismatch");
});

test("success envelopes require a matching operation identity", async () => {
  const f = fixture();
  const request = f.request("acquire", { public_key: KEY }, "op-envelope-operation");
  await f.control.dispatch(request);
  const row = f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?").get("op-envelope-operation") as { response_json: string };
  const cached = JSON.parse(row.response_json) as Dict;

  delete cached.operation_id;
  (f.store.db as any).run("UPDATE operations SET response_json = ? WHERE operation_id = ?", JSON.stringify(cached), "op-envelope-operation");
  await expectCode(f.control.dispatch(request), "invalid_response");

  cached.operation_id = "different-operation";
  (f.store.db as any).run("UPDATE operations SET response_json = ? WHERE operation_id = ?", JSON.stringify(cached), "op-envelope-operation");
  await expectCode(f.control.dispatch(request), "invalid_response");

  cached.operation_id = "op-envelope-operation";
  cached.generation = 1;
  (f.store.db as any).run("UPDATE operations SET response_json = ? WHERE operation_id = ?", JSON.stringify(cached), "op-envelope-operation");
  await expectCode(f.control.dispatch(request), "invalid_response");

  const observed = await f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status", session_id: "thread-a", operation_id: "status-observation" });
  expect(observed.operation_id).toBe("status-observation");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status", session_id: "thread-a", operation_id: 7 }), "invalid_request");
});

test("treats prototype-sensitive JSON keys as data and requires own envelope fields", async () => {
  const f = fixture();
  const inheritedOnly = parseRequestBytes(new TextEncoder().encode('{"__proto__":{"protocol":4,"action":"drain-enter","operation_id":"proto-op","generation":0}}'));
  await expectCode(f.control.dispatch(inheritedOnly), "invalid_request");
  expect(f.store.getMeta("draining")).toBeUndefined();

  const raw = `{"protocol":4,"action":"acquire","session_id":"thread-a","generation":0,"operation_id":"op-proto-data","public_key":"${KEY}","__proto__":{"action":"drain-exit"},"metadata":{"__proto__":{"nested":1},"constructor":{"prototype":"legitimate"}}}`;
  const request = parseRequestBytes(new TextEncoder().encode(raw));
  expect(Object.keys(request)).toContain("__proto__");
  await f.control.dispatch(request);
  const conflict = parseRequestBytes(new TextEncoder().encode(raw.replace('"nested":1', '"nested":2')));
  await expectCode(f.control.dispatch(conflict), "operation_conflict");

  await expectCode(f.control.dispatch(parseRequestBytes(new TextEncoder().encode('{"protocol":4,"action":"status","__proto__":{"session_id":"thread-a"}}'))), "invalid_request");
  await expectCode(f.control.dispatch(parseRequestBytes(new TextEncoder().encode('{"protocol":4,"action":"drain-enter","operation_id":"missing-generation","__proto__":{"generation":0}}'))), "invalid_request");
});

test("invalid write generation requests do not poison durable state", async () => {
  const f = fixture();
  await expectCode(f.control.dispatch(parseRequestBytes(new TextEncoder().encode('{"protocol":4,"action":"drain-enter","operation_id":"invalid-generation-restart","__proto__":{"generation":0}}'))), "invalid_request");
  const reopened = new StateStore(f.config.state_db);
  expect(() => reopened.verifyRuntimeState()).not.toThrow();
  reopened.close();
});

test("preserves JSON float semantics and Python canonical numeric digests", async () => {
  const root = mkdtempSync("/tmp/agent-vm-numeric-boundary-test-");
  mkdirSync(join(root, "systemd"), { recursive: true, mode: 0o755 });
  try {
    const base: Dict = { project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: root, state_db: join(root, "state.sqlite3"), timer_dir: join(root, "systemd"), cpu_overcommit_ratio: 2e4 };
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(base).replace('"port_start":20000', '"port_start":20000.0'));
    expectSyncCode(() => loadConfig(configPath), "config_invalid");
    writeFileSync(configPath, JSON.stringify(base).replace('"cpu_overcommit_ratio":20000', '"cpu_overcommit_ratio":2e4'));
    expect(loadConfig(configPath).cpu_overcommit_ratio).toEqual({ numerator: 200000n, denominator: 10n, text: "20000.0" });

    const f = fixture();
    const raw = `{"protocol":4,"action":"acquire","session_id":"thread-a","generation":0,"operation_id":"op-float-digest","public_key":"${KEY}","metadata":{"small":1e-7,"whole":2e4,"one":1.0}}`;
    await f.control.dispatch(parseRequestBytes(new TextEncoder().encode(raw)));
    const journal = f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?").get("op-float-digest") as { response_json: string };
    const python = Bun.spawnSync(["python3", "-c", "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.loads(sys.argv[1]), ensure_ascii=True, sort_keys=True, separators=(\", \", \": \" )).encode(\"utf-8\")).hexdigest())", raw], { stdout: "pipe", stderr: "pipe" });
    if (python.exitCode !== 0) throw new Error(new TextDecoder().decode(python.stderr));
    expect(JSON.parse(journal.response_json)._request_digest).toBe(new TextDecoder().decode(python.stdout).trim());

    const equivalent = parseRequestBytes(new TextEncoder().encode(raw.replace("2e4", "20000.0")));
    expect((await f.control.dispatch(equivalent)).outcome).toBe("replayed");
    const integerConflict = parseRequestBytes(new TextEncoder().encode(raw.replace('"one":1.0', '"one":1')));
    await expectCode(f.control.dispatch(integerConflict), "operation_conflict");
    await expectCode(f.control.dispatch(parseRequestBytes(new TextEncoder().encode('{"protocol":4,"action":"drain-enter","operation_id":"float-generation","generation":0.0}'))), "invalid_request");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps SQLite integer reservations exact beyond the JS safe range", () => {
  const root = mkdtempSync("/tmp/agent-vm-sqlite-test-");
  const store = StateStore.bootstrap(join(root, "state.sqlite3"));
  try {
    const exact = 9007199254740993n;
    store.putTask({ task_id: "avm-exact", session_id: "exact", generation: 1, state: "active", instance_name: "agent-vm-exact", created_at: "2026-10-04T00:00:00+00:00", updated_at: "2026-10-04T00:00:00+00:00", image_fingerprint: "a".repeat(64), resources_json: "{}", reservation_bytes: exact, resource_reservation_json: "{}" });
    const task = store.getTask({ taskId: "avm-exact" });
    expect(typeof task?.reservation_bytes).toBe("bigint");
    expect(task?.reservation_bytes).toBe(exact);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fails closed for missing, empty, and invalid runtime state databases", () => {
  const root = mkdtempSync("/tmp/agent-vm-state-guard-test-");
  try {
    const missing = join(root, "missing", "state.sqlite3");
    expectSyncCode(() => new StateStore(missing), "state_missing");
    expect(existsSync(missing)).toBe(false);
    const empty = join(root, "empty.sqlite3");
    writeFileSync(empty, "", { mode: 0o600 });
    expectSyncCode(() => new StateStore(empty), "state_invalid");
    const invalid = join(root, "invalid.sqlite3");
    writeFileSync(invalid, "not a sqlite database", { mode: 0o600 });
    expectSyncCode(() => new StateStore(invalid), "state_invalid");
    const incomplete = join(root, "incomplete.sqlite3");
    const incompleteStore = StateStore.bootstrap(incomplete);
    incompleteStore.db.run("DROP TABLE audit");
    incompleteStore.close();
    expectSyncCode(() => new StateStore(incomplete), "state_invalid");
    const durable = join(root, "durable.sqlite3");
    const bootstrap = StateStore.bootstrap(durable);
    bootstrap.close();
    const runtime = new StateStore(durable);
    runtime.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects runtime state without canonical uniqueness and foreign-key contracts", () => {
  const root = mkdtempSync("/tmp/agent-vm-state-contract-test-");
  const path = join(root, "state.sqlite3");
  const db = new Database(path);
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  db.run("CREATE TABLE tasks (task_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, instance_name TEXT NOT NULL, vm_ip TEXT, ssh_host_port INTEGER, lease_expires_at TEXT, inactive_since TEXT, cleanup_after TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT, image_fingerprint TEXT NOT NULL, resources_json TEXT NOT NULL DEFAULT '{}', reservation_bytes INTEGER NOT NULL DEFAULT 0, previous_generation INTEGER, resource_reservation_json TEXT NOT NULL DEFAULT '{}')");
  db.run("CREATE TABLE ports (task_id TEXT NOT NULL, generation INTEGER NOT NULL, port_name TEXT NOT NULL, protocol TEXT NOT NULL, host_port INTEGER NOT NULL, vm_port INTEGER NOT NULL, device_name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (task_id, port_name, protocol))");
  db.run("CREATE TABLE operations (operation_id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, session_id TEXT, generation INTEGER, response_json TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.run("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, task_id TEXT, session_id TEXT, generation INTEGER, outcome TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL)");
  db.close();
  chmodSync(path, 0o600);
  try { expectSyncCode(() => new StateStore(path), "state_invalid"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects runtime state with unexpected SQLite triggers and views", () => {
  for (const [suffix, ddl] of [["trigger", "CREATE TRIGGER rogue AFTER INSERT ON meta BEGIN SELECT 1; END"], ["view", "CREATE VIEW rogue AS SELECT 1"]] as const) {
    const root = mkdtempSync(`/tmp/agent-vm-state-schema-${suffix}-`);
    const path = join(root, "state.sqlite3");
    const store = StateStore.bootstrap(path);
    store.db.run(ddl);
    store.close();
    try { expectSyncCode(() => new StateStore(path), "state_invalid"); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("rejects canonical runtime state with invalid task identity data", () => {
  const root = mkdtempSync("/tmp/agent-vm-state-data-test-");
  const path = join(root, "state.sqlite3");
  const store = StateStore.bootstrap(path);
  store.close();
  const db = new Database(path);
  db.run(
    "INSERT INTO tasks (task_id,session_id,generation,state,instance_name,vm_ip,ssh_host_port,lease_expires_at,inactive_since,cleanup_after,created_at,updated_at,last_error,image_fingerprint,resources_json,reservation_bytes,previous_generation,resource_reservation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ["avm-invalid", "invalid session", 1, "active", "agent-vm-avm-invalid", null, null, null, null, null, "2026-10-04T00:00:00+00:00", "2026-10-04T00:00:00+00:00", null, "a".repeat(64), "{}", 0, null, "{}"],
  );
  db.close();
  chmodSync(path, 0o600);
  try { expectSyncCode(() => new StateStore(path), "state_invalid"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("verifies state-dependent task, port, and operation invariants at runtime", () => {
  const root = mkdtempSync("/tmp/agent-vm-state-invariants-test-");
  const timestamp = "2026-10-04T00:00:00+00:00";
  const task = {
    task_id: "avm-valid",
    session_id: "valid-session",
    generation: 3,
    state: "active",
    instance_name: "agent-vm-avm-valid",
    vm_ip: "198.51.100.20",
    ssh_host_port: 20000,
    lease_expires_at: "2026-10-04T01:00:00+00:00",
    inactive_since: null,
    cleanup_after: null,
    created_at: timestamp,
    updated_at: timestamp,
    last_error: null,
    image_fingerprint: "a".repeat(64),
    resources_json: JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }),
    reservation_bytes: 0,
    previous_generation: null,
    resource_reservation_json: "{}",
  };
  const validPath = join(root, "valid.sqlite3");
  const valid = StateStore.bootstrap(validPath);
  valid.putTask(task);
  valid.putPort({ task_id: task.task_id, generation: task.generation, port_name: "ssh", protocol: "tcp", host_port: 20000, vm_port: 22, device_name: "agent-vm-avm-valid-ssh-tcp", state: "active", created_at: timestamp });
  valid.close();
  try {
    const reopened = new StateStore(validPath);
    reopened.verifyRuntimeState();
    reopened.close();

    const invalidPath = join(root, "invalid.sqlite3");
    const invalid = StateStore.bootstrap(invalidPath);
    invalid.putTask({ ...task, task_id: "avm-invalid-state", session_id: "invalid-state", instance_name: "agent-vm-avm-invalid-state", state: "cached", ssh_host_port: null, lease_expires_at: null, resources_json: JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }), reservation_bytes: 1, resource_reservation_json: JSON.stringify({ cpu: 2 }) });
    invalid.putPort({ task_id: "avm-invalid-state", generation: 3, port_name: "ssh", protocol: "tcp", host_port: 20001, vm_port: 22, device_name: "agent-vm-avm-invalid-state-ssh-tcp", state: "active", created_at: timestamp });
    invalid.close();
    chmodSync(invalidPath, 0o600);
    expectSyncCode(() => new StateStore(invalidPath), "state_invalid");

    const operationPath = join(root, "invalid-operation.sqlite3");
    const operationStore = StateStore.bootstrap(operationPath);
    operationStore.recordOperation("bad-operation", "acquire", "operation-session", 1, { outcome: "success", protocol: PROTOCOL_VERSION, action: "acquire", session_id: "operation-session", generation: 1, operation_id: "bad-operation", result: {}, server_time: timestamp });
    expectSyncCode(() => operationStore.operation("bad-operation"), "state_invalid");
    operationStore.close();
    chmodSync(operationPath, 0o600);
    expectSyncCode(() => new StateStore(operationPath), "state_invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails closed on unknown draining and preserves legal active resize reservations", () => {
  const root = mkdtempSync("/tmp/agent-vm-state-runtime-contract-test-");
  const timestamp = "2026-10-04T00:00:00+00:00";
  const base = {
    task_id: "avm-resize", session_id: "resize-session", generation: 3, state: "active", instance_name: "agent-vm-avm-resize",
    vm_ip: "198.51.100.20", ssh_host_port: 20000, lease_expires_at: "2026-10-04T01:00:00+00:00", inactive_since: null,
    cleanup_after: null, created_at: timestamp, updated_at: timestamp, last_error: null, image_fingerprint: "a".repeat(64),
    resources_json: JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }), reservation_bytes: 1024,
    previous_generation: null, resource_reservation_json: JSON.stringify({ cpu: 2, memory_mib: 8192, disk_gib: 20 }),
  };
  const validPath = join(root, "valid.sqlite3");
  const valid = StateStore.bootstrap(validPath);
  valid.putTask(base);
  valid.putPort({ task_id: base.task_id, generation: base.generation, port_name: "ssh", protocol: "tcp", host_port: 20000, vm_port: 22, device_name: "agent-vm-avm-resize-ssh-tcp", state: "active", created_at: timestamp });
  valid.verifyRuntimeState();
  valid.db.run("INSERT INTO meta(key, value) VALUES ('draining', 'maybe')");
  expectSyncCode(() => valid.verifyRuntimeState(), "state_invalid");
  valid.close();

  const residualPath = join(root, "residual.sqlite3");
  const residual = StateStore.bootstrap(residualPath);
  residual.putTask({ ...base, task_id: "avm-cached-residual", session_id: "cached-residual", instance_name: "agent-vm-avm-cached-residual", state: "cached", lease_expires_at: null, reservation_bytes: 1, resource_reservation_json: "{}", ssh_host_port: null });
  expectSyncCode(() => residual.verifyRuntimeState(), "state_invalid");
  residual.close();

  const missingActivePath = join(root, "missing-active.sqlite3");
  const missingActive = StateStore.bootstrap(missingActivePath);
  missingActive.putTask({ ...base, task_id: "avm-missing-active", session_id: "missing-active", instance_name: "agent-vm-avm-missing-active", vm_ip: null, ssh_host_port: null, resource_reservation_json: "{}" });
  expectSyncCode(() => missingActive.verifyRuntimeState(), "state_invalid");
  missingActive.close();

  const incompletePreparingPath = join(root, "incomplete-preparing.sqlite3");
  const incompletePreparing = StateStore.bootstrap(incompletePreparingPath);
  incompletePreparing.putTask({ ...base, task_id: "avm-incomplete-preparing", session_id: "incomplete-preparing", instance_name: "agent-vm-avm-incomplete-preparing", state: "preparing", vm_ip: null, ssh_host_port: null, reservation_bytes: 1, resource_reservation_json: JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }) });
  expectSyncCode(() => incompletePreparing.verifyRuntimeState(), "state_invalid");
  incompletePreparing.close();

  const incompleteClosingPath = join(root, "incomplete-closing.sqlite3");
  const incompleteClosing = StateStore.bootstrap(incompleteClosingPath);
  incompleteClosing.putTask({ ...base, task_id: "avm-incomplete-closing", session_id: "incomplete-closing", instance_name: "agent-vm-avm-incomplete-closing", state: "closing", lease_expires_at: null, ssh_host_port: null, resource_reservation_json: "{}" });
  expectSyncCode(() => incompleteClosing.verifyRuntimeState(), "state_invalid");
  incompleteClosing.close();
  rmSync(root, { recursive: true, force: true });
});

test("keeps cached reacquire reservation failure restartable after a restart", async () => {
  const f = fixture();
  const task = (f.control as any).baseTask("cached-reopen", 2) as Dict;
  Object.assign(task, {
    vm_ip: "198.51.100.20",
    lease_expires_at: new Date(f.now.getTime() + 1_800_000).toISOString(),
    resources_json: JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }),
  });
  (f.control as any).resourcePolicy = async () => ({ limits: { cpu: 64, memory_mib: 65536 }, memory: { available_bytes: 24 * GIB, threshold_bytes: 4 * GIB } });
  (f.control as any).runningInventoryGuard = async () => undefined;
  await (f.control as any).reserveResources(task, { cpu: 2, memory_mib: 4096, disk_gib: 20 });
  const persisted = f.store.getTask({ taskId: task.task_id }) as Dict;
  expect(persisted.vm_ip).toBeNull();
  expect(persisted.ssh_host_port).toBeNull();
  expect(persisted.reservation_bytes).toBe(0n);
  f.store.close();
  f.storeClosed = true;
  const reopened = new StateStore(f.config.state_db);
  try { reopened.verifyRuntimeState(); }
  finally { reopened.close(); }
});

test("reconciles a cached reacquire reservation after a controller restart", async () => {
  const f = fixture();
  const first = await f.call("acquire", { public_key: KEY }, "op-restart-reconcile-create");
  await f.call("release", {}, "op-restart-reconcile-release");
  const cached = f.store.getTask({ taskId: String(first.task_id) })!;
  const next = {
    ...cached,
    generation: Number(cached.generation) + 1,
    state: "preparing",
    previous_generation: cached.generation,
    lease_expires_at: new Date(f.now.getTime() + 1_800_000).toISOString(),
    inactive_since: null,
    cleanup_after: null,
    reservation_bytes: 0n,
    resource_reservation_json: "{}",
    ssh_host_port: null,
  };
  await (f.control as any).reserveResources(next, JSON.parse(String(cached.resources_json)));
  expect(f.store.getTask({ taskId: String(first.task_id) })?.vm_ip).toBe(cached.vm_ip);
  f.store.close();
  f.storeClosed = true;
  const reopened = new StateStore(f.config.state_db);
  const restarted = new Control(f.config, { runner: f.runner, store: reopened, systemd: f.systemd, clock: () => f.now, which: () => null });
  try {
    await restarted.dispatch({ protocol: PROTOCOL_VERSION, action: "admin-reconcile", generation: 0, operation_id: "op-restart-reconcile", apply: true });
    const restored = reopened.getTask({ taskId: String(first.task_id) });
    expect(restored?.state).toBe("cached");
    expect(restored?.vm_ip).toBe(cached.vm_ip);
  } finally {
    reopened.close();
  }
});

test("restores a valid cached VM address after timer and capacity reacquire failures", async () => {
  for (const mode of ["timer", "capacity"] as const) {
    const f = fixture();
    const created = await f.call("acquire", { public_key: KEY }, `op-${mode}-create`);
    const cached = await f.call("release", {}, `op-${mode}-release`);
    const originalIp = cached.vm_ip;
    if (mode === "timer") (f.control as any).scheduleExpiry = async () => { throw new ControlError("timer_failed", "injected timer failure"); };
    else (f.control as any).reclaimCapacity = async () => { throw new ControlError("capacity_insufficient", "injected capacity failure"); };
    await expectCode(f.call("acquire", { public_key: KEY }, `op-${mode}-failure`), mode === "timer" ? "timer_failed" : "capacity_insufficient");
    const failed = f.store.getTask({ taskId: String(created.task_id) })!;
    expect(failed.state).toBe("cached");
    expect(failed.vm_ip).toBe(originalIp);
    expect(failed.ssh_host_port).toBeNull();
    expect(failed.reservation_bytes).toBe(0n);
    f.store.close();
    f.storeClosed = true;
    const reopened = new StateStore(f.config.state_db);
    try { reopened.verifyRuntimeState(); }
    finally { reopened.close(); }
  }
});

test("rejects a cached instance from an older pinned image before native resume", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-cache-image-create");
  const cached = await f.call("release", {}, "op-cache-image-release");
  f.store.updateTask(String(active.task_id), { image_fingerprint: "b".repeat(64) });
  const callsBefore = f.runner.calls.length;
  await expectCode(f.call("acquire", { public_key: KEY }, "op-cache-image-retry"), "cache_ineligible");
  expect(f.store.getTask({ taskId: String(cached.task_id) })?.state).toBe("cached");
  expect(f.runner.calls.slice(callsBefore).some(({ args }) => args[0] === "incus" && ["start", "config"].includes(args[3] ?? ""))).toBe(false);
});

test("rejects a legacy cached image without the Bun capability marker before resume", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-cache-tools-create");
  const cached = await f.call("release", {}, "op-cache-tools-release");
  const instance = f.runner.instances.get(String(cached.instance_name))!;
  delete instance.config["user.agent-vm.guest-tools"];
  delete instance.expanded_config["user.agent-vm.guest-tools"];
  f.runner.missingGuestTool = "bun";
  const callsBefore = f.runner.calls.length;
  await expectCode(f.call("acquire", { public_key: KEY }, "op-cache-tools-retry"), "cache_ineligible");
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("cached");
  expect(f.runner.calls.slice(callsBefore).some(({ args }) => args[0] === "incus" && args[3] === "start")).toBe(false);
});

test("projects untrusted result JSON before operation and audit persistence", async () => {
  const f = fixture();
  const sensitiveName = ["extra", "secret"].join("_");
  const nestedSensitiveName = ["nested", "secret", "value"].join("_");
  const canary = "persist-" + "canary";
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJhZ2VudCJ9", "jwt-persist-canary"].join(".");
  (f.control as any).dispatchAction = async () => ({
    generation: 0,
    state: "active",
    [sensitiveName]: canary,
    nested: { [nestedSensitiveName]: canary },
    payload: "x".repeat(20_000),
    stderr: "Cookie: sessionid=cookie-persist-canary\nSet-Cookie: sessionid=set-cookie-persist-canary\nAuthorization: Digest response=digest-persist-canary\njwt=" + jwt + " AGENT_VM_COMMAND_ID=marker-persist-canary",
    message: "sessionid=session-persist-canary",
  });
  const response = await f.control.dispatch(f.request("acquire", {}, "op-persistence-boundary"));
  expect(response.result[sensitiveName]).toBeUndefined();
  expect(response.result.nested).toBeUndefined();
  expect(response.result.payload.length).toBeLessThanOrEqual(4096);
  const operation = String((f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?") as any).get("op-persistence-boundary").response_json);
  const audit = String((f.store.db.query("SELECT detail_json FROM audit WHERE action = ?") as any).get("acquire").detail_json);
  expect(operation).not.toContain(canary);
  expect(audit).not.toContain(canary);
  for (const secret of ["cookie-persist-canary", "set-cookie-persist-canary", "digest-persist-canary", "jwt-persist-canary", "marker-persist-canary", "session-persist-canary"]) {
    expect(operation).not.toContain(secret);
    expect(audit).not.toContain(secret);
  }
  expect(operation.length).toBeLessThan(16_384);
  expect(audit.length).toBeLessThan(16_384);
});

test("overlimit persistence keeps an explicit marker and capacity facts", async () => {
  const f = fixture();
  (f.control as any).dispatchAction = async () => ({ generation: 0, capacity: { total: 100, free: 40 }, payload: Array.from({ length: 128 }, () => "x".repeat(4096)) });
  const response = await f.control.dispatch(f.request("acquire", {}, "op-persistence-capacity"));
  expect(response.result).toMatchObject({ truncated: true, capacity: { total: 100, free: 40 } });
  const stored = JSON.parse(String((f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?") as any).get("op-persistence-capacity").response_json));
  expect(stored.result).toMatchObject({ truncated: true, capacity: { total: 100, free: 40 } });
});

test("bounds persisted documents by UTF-8 bytes", async () => {
  const f = fixture();
  (f.control as any).dispatchAction = async () => ({ generation: 0, errors: Array.from({ length: 128 }, () => ({ message: "界".repeat(4096) })) });
  await f.control.dispatch(f.request("acquire", {}, "op-persistence-utf8"));
  const raw = String((f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?") as any).get("op-persistence-utf8").response_json);
  expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64 * 1024);
  expect(JSON.parse(raw).result).toMatchObject({ truncated: true });
});

test("bounds task error collections and documents before durable persistence", async () => {
  const f = fixture();
  const projectedGuestIpError = new ControlError("guest_ip_mismatch", "guest address differs", {
    reported: Array.from({ length: 256 }, (_, index) => `198.51.100.${index % 250 + 1}`),
  }).asDict();
  expect((projectedGuestIpError.detail as Dict).reported).toHaveLength(128);
  expect(JSON.stringify(projectedGuestIpError).length).toBeLessThanOrEqual(64 * 1024);
  const active = await f.call("acquire", { public_key: KEY }, "op-task-error-boundary-create");
  const taskId = String(active.task_id);
  f.store.updateTask(taskId, { last_error: { code: "guest_ip_mismatch", reported: Array.from({ length: 256 }, (_, index) => `198.51.100.${index % 250 + 1}`) } });
  const collectionRaw = String(f.store.getTask({ taskId })?.last_error);
  const collectionError = JSON.parse(collectionRaw);
  expect(collectionError.reported.length).toBe(128);
  expect(collectionRaw.length).toBeLessThanOrEqual(64 * 1024);

  f.store.updateTask(taskId, { last_error: { code: "resize_partial", native_attempts: Array.from({ length: 128 }, () => ({ stderr: "x".repeat(4096) })) } });
  const documentRaw = String(f.store.getTask({ taskId })?.last_error);
  expect(documentRaw.length).toBeLessThanOrEqual(64 * 1024);
  expect(JSON.parse(documentRaw)).toMatchObject({ truncated: true });
});

test("preserves exact decimal native resources through cache persistence", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-native-exact");
  const huge = 9007199254740993n;
  const instance = f.runner.instances.get(active.instance_name)!;
  for (const [key, value] of [["limits.cpu", String(huge)], ["limits.memory", `${huge}GiB`]] as const) {
    instance.config[key] = value;
    instance.expanded_config[key] = value;
  }
  for (const devices of [instance.devices, instance.expanded_devices]) devices.root.size = `${huge}GiB`;
  const observed = await (f.control as any).nativeResources(f.store.getTask({ taskId: String(active.task_id) }));
  expect(observed).toEqual({ cpu: huge, memory_mib: huge * 1024n, disk_gib: huge });
  const cached = await f.call("release", {}, "op-native-exact-release");
  expect(cached.resources).toEqual(observed);
  expect(f.store.getTask({ taskId: String(active.task_id) })?.resources_json).toBe(`{"cpu":${huge},"disk_gib":${huge},"memory_mib":${huge * 1024n}}`);
});

test("keeps request digests compatible with Python Unicode code-point ordering", async () => {
  const f = fixture();
  const request = f.request("acquire", {
    public_key: KEY,
    metadata: { "\uE000": { nested: "\u{10000}" }, "\u{10000}": { nested: "\uE000" } },
  }, "op-unicode-digest");
  await f.control.dispatch(request);
  const journal = f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?").get("op-unicode-digest") as { response_json: string };
  const child = Bun.spawnSync(["python3", "-c", "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.loads(sys.argv[1]), ensure_ascii=True, sort_keys=True, separators=(\", \", \": \" )).encode(\"utf-8\")).hexdigest())", JSON.stringify(request)], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
  expect(JSON.parse(journal.response_json)._request_digest).toBe(new TextDecoder().decode(child.stdout).trim());
});

test("replays a durable response without rounding a large JSON integer", async () => {
  const f = fixture();
  const request = f.request("acquire", { public_key: KEY }, "op-large-response");
  await f.control.dispatch(request);
  const row = f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?").get("op-large-response") as { response_json: string };
  const marker = '"result":';
  const start = row.response_json.indexOf(marker) + marker.length;
  const end = row.response_json.indexOf(',"server_time"', start);
  if (start < marker.length || end < 0) throw new Error("operation result marker missing");
  const responseJson = `${row.response_json.slice(0, start)}{"memory_mib":9007199254740993}${row.response_json.slice(end)}`;
  (f.store.db as any).run("UPDATE operations SET response_json = ? WHERE operation_id = ?", responseJson, "op-large-response");
  const replay = await f.control.dispatch(request);
  expect(replay.outcome).toBe("replayed");
  expect(replay.result.memory_mib).toBe(9007199254740993n);
});

test("replays an accepted persisted operation without changing its digest or native state", async () => {
  const root = mkdtempSync("/tmp/agent-vm-baseline-test-");
  const dbPath = join(root, "state.sqlite3");
  const digest = "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a";
  const response = {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy",
    generation: 0, operation_id: "legacy-op", outcome: "success", result: { state: "active" }, _request_digest: digest,
  };
  writeLegacyOperation(dbPath, response);
  const store = new StateStore(dbPath);
  expect(store.getMeta("schema_migration")).toBe("python-baseline-v1->bun-canonical-v1");
  expect(Number((store.db.query("SELECT COUNT(*) AS count FROM audit WHERE action = 'schema-migration'") as any).get().count)).toBe(1);
  const runner = new NativeCommands();
  const control = new Control({ state_db: dbPath, timer_dir: root }, { store, runner });
  try {
    const replay = await control.dispatch({ protocol: PROTOCOL_VERSION, action: "acquire", session_id: "legacy", generation: 0, operation_id: "legacy-op", public_key: KEY });
    expect(replay.outcome).toBe("replayed");
    expect(replay.result).toEqual({ state: "active" });
    expect(runner.calls).toHaveLength(0);
    await expectCode(control.dispatch({ protocol: PROTOCOL_VERSION, action: "acquire", session_id: "legacy", generation: 0, operation_id: "legacy-op", public_key: `${KEY} conflict` }), "operation_conflict");
    expect(JSON.parse(String((store.db.query("SELECT response_json FROM operations WHERE operation_id = ?") as any).get("legacy-op").response_json))._request_digest).toBe(digest);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects and bounds every JSON payload during legacy state migration", () => {
  const root = mkdtempSync("/tmp/agent-vm-projected-migration-test-");
  const dbPath = join(root, "state.sqlite3");
  const digest = "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a";
  const canary = "legacy-projection-canary";
  const huge = Array.from({ length: 256 }, () => "x".repeat(4096));
  const response = {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy-projected",
    generation: 0, operation_id: "legacy-projected-op", outcome: "success",
    result: { state: "active", capacity: { secretValue: canary }, payload: huge, secretValue: canary, tokenValue: canary }, _request_digest: digest,
  };
  writeLegacyOperation(dbPath, response);
  const legacy = new Database(dbPath);
  const timestamp = "2026-10-04T00:00:00+00:00";
  legacy.run("INSERT INTO tasks (task_id, session_id, generation, state, instance_name, vm_ip, ssh_host_port, lease_expires_at, inactive_since, cleanup_after, created_at, updated_at, last_error, image_fingerprint, resources_json, reservation_bytes, previous_generation, resource_reservation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    "avm-legacy-projected", "legacy-projected", 1, "cached", "agent-vm-avm-legacy-projected", "198.51.100.20", null, null, null, null, timestamp, timestamp,
    JSON.stringify({ code: "command_failed", payload: huge, secretValue: canary, tokenValue: canary }), "a".repeat(64), JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }), 0, null, "{}",
  ]);
  legacy.run("INSERT INTO audit (action, task_id, session_id, generation, outcome, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    "legacy-test", "avm-legacy-projected", "legacy-projected", 1, "error", JSON.stringify({ capacity: { secretValue: canary }, payload: huge, tokenValue: canary }), timestamp,
  ]);
  legacy.close();
  const store = new StateStore(dbPath);
  try {
    const task = store.getTask({ taskId: "avm-legacy-projected" })!;
    const operation = JSON.parse(String((store.db.query("SELECT response_json FROM operations WHERE operation_id = ?") as any).get("legacy-projected-op").response_json));
    const audit = JSON.parse(String((store.db.query("SELECT detail_json FROM audit WHERE action = 'legacy-test'") as any).get().detail_json));
    for (const value of [task.last_error, JSON.stringify(operation), JSON.stringify(audit)]) {
      expect(String(value)).not.toContain(canary);
      expect(String(value).length).toBeLessThanOrEqual(64 * 1024);
    }
    expect(JSON.parse(String(task.last_error))).toMatchObject({ truncated: true });
    expect(operation.result).toMatchObject({ truncated: true, capacity: {} });
    expect(audit).toMatchObject({ truncated: true, capacity: {} });
    store.verifyRuntimeState();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unknown legacy metadata instead of copying its raw value", () => {
  const root = mkdtempSync("/tmp/agent-vm-unknown-meta-migration-test-");
  const dbPath = join(root, "state.sqlite3");
  writeLegacyOperation(dbPath, {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy-meta",
    generation: 0, operation_id: "legacy-meta-op", outcome: "success", result: { state: "active" }, _request_digest: "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a",
  });
  const legacy = new Database(dbPath);
  legacy.run("INSERT INTO meta(key, value) VALUES (?, ?)", ["api_token", "legacy-secret-canary-" + "界".repeat(40_000)]);
  legacy.close();
  try {
    expectSyncCode(() => new StateStore(dbPath), "state_invalid");
    const rolledBack = new Database(dbPath);
    try {
      expect(rolledBack.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__agent_vm_legacy_meta'").get()).toBeNull();
      expect((rolledBack.query("SELECT value FROM meta WHERE key = 'api_token'").get() as any)?.value).toContain("legacy-secret-canary");
    } finally { rolledBack.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails closed and rolls back a legacy migration with invalid JSON", () => {
  const root = mkdtempSync("/tmp/agent-vm-invalid-migration-test-");
  const dbPath = join(root, "state.sqlite3");
  writeLegacyOperation(dbPath, {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy-invalid",
    generation: 0, operation_id: "legacy-invalid-op", outcome: "success", result: { state: "active" }, _request_digest: "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a",
  });
  const legacy = new Database(dbPath);
  legacy.run("UPDATE operations SET response_json = ? WHERE operation_id = ?", ["not-json", "legacy-invalid-op"]);
  legacy.close();
  try {
    expectSyncCode(() => new StateStore(dbPath), "state_invalid");
    const rolledBack = new Database(dbPath);
    try {
      expect(rolledBack.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'").get()).toBeTruthy();
      expect(rolledBack.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__agent_vm_legacy_operations'").get()).toBeNull();
    } finally { rolledBack.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects conflicting legacy schema migration provenance", () => {
  const root = mkdtempSync("/tmp/agent-vm-conflicting-migration-test-");
  const dbPath = join(root, "state.sqlite3");
  writeLegacyOperation(dbPath, {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy-conflict",
    generation: 0, operation_id: "legacy-conflict-op", outcome: "success", result: { state: "active" }, _request_digest: "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a",
  });
  const legacy = new Database(dbPath);
  legacy.run("INSERT INTO meta(key, value) VALUES ('schema_migration', 'untrusted-provenance')");
  legacy.close();
  try { expectSyncCode(() => new StateStore(dbPath), "state_invalid"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unknown canonical schema migration provenance", () => {
  const root = mkdtempSync("/tmp/agent-vm-unknown-canonical-migration-test-");
  const dbPath = join(root, "state.sqlite3");
  const store = StateStore.bootstrap(dbPath);
  store.setMeta("schema_migration", "untrusted-provenance");
  store.close();
  try { expectSyncCode(() => new StateStore(dbPath), "state_invalid"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("serializes concurrent legacy-state startup and records one migration", async () => {
  const root = mkdtempSync("/tmp/agent-vm-concurrent-migration-test-");
  const dbPath = join(root, "state.sqlite3");
  writeLegacyOperation(dbPath, {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy-concurrent",
    generation: 0, operation_id: "legacy-concurrent-op", outcome: "success", result: { state: "active" }, _request_digest: "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a",
  });
  const source = `const { StateStore } = await import(process.env.CONTROL_PATH); const store = new StateStore(process.env.DB_PATH); store.close();`;
  try {
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, CONTROL_PATH, DB_PATH: dbPath }, stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(collect));
    expect(results.every((result) => result.exit === 0)).toBe(true);
    for (const result of results) expect(result.stderr).toBe("");
    const store = new StateStore(dbPath);
    try { expect(Number((store.db.query("SELECT COUNT(*) AS count FROM audit WHERE action = 'schema-migration'") as any).get().count)).toBe(1); }
    finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects a pending legacy operation without rewriting its journal", async () => {
  const root = mkdtempSync("/tmp/agent-vm-pending-baseline-test-");
  const dbPath = join(root, "state.sqlite3");
  const digest = "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a";
  const response = { protocol: PROTOCOL_VERSION, action: "acquire", session_id: "legacy", generation: 0, operation_id: "legacy-op", outcome: "pending", _request_digest: digest };
  writeLegacyOperation(dbPath, response);
  const store = new StateStore(dbPath);
  const runner = new NativeCommands();
  const control = new Control({ state_db: dbPath, timer_dir: root }, { store, runner });
  try {
    await expectCode(control.dispatch({ protocol: PROTOCOL_VERSION, action: "acquire", session_id: "legacy", generation: 0, operation_id: "legacy-op", public_key: KEY }), "operation_incomplete");
    expect(store.operation("legacy-op")).toEqual(response);
    expect(runner.calls).toHaveLength(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("replays an accepted operation after restart and preserves an updated renewal deadline", async () => {
  const f = fixture();
  const acquireRequest = f.request("acquire", { public_key: KEY }, "op-restart-acquire");
  const first = (await f.control.dispatch(acquireRequest)).result;
  const renewalRequest = f.request("renew", {}, "op-deadline");
  const renewed = (await f.control.dispatch(renewalRequest)).result;
  expect(renewed.lease_expires_at).not.toBe(first.lease_expires_at);
  f.now = new Date("2026-10-04T00:00:20.000Z");
  const replayedRenewal = await f.control.dispatch(renewalRequest);
  expect(replayedRenewal.outcome).toBe("replayed");
  expect((await f.call("status")).lease_expires_at).toBe(renewed.lease_expires_at);

  f.store.close();
  f.storeClosed = true;
  const restartedRunner = new NativeCommands();
  restartedRunner.configureGuest(join(f.root, "restarted-guest"));
  const restartedStore = StateStore.bootstrap(f.config.state_db);
  const restartedResources = { cpu: () => 16, memory: () => ({ scope: "ct-memory", sources: ["fixture"], limit_bytes: 32 * GIB, available_bytes: f.memoryAvailable, threshold_bytes: 4 * GIB }) };
  const restarted = new Control(f.config, { runner: restartedRunner, store: restartedStore, systemd: new SystemdManager(restartedRunner, f.config, false), resources: restartedResources as unknown as CTResources, clock: () => f.now, which: (command) => command === "conntrack" ? "/usr/sbin/conntrack" : null });
  try {
    const replay = await restarted.dispatch(acquireRequest);
    expect(replay.outcome).toBe("replayed");
    expect(replay.result.lease_expires_at).toBe(first.lease_expires_at);
    expect(restartedRunner.calls).toHaveLength(0);
  } finally { restartedStore.close(); }
});

test("executes the embedded guest growth program for ext4 and xfs", () => {
  for (const fstype of ["ext4", "xfs"] as const) {
    const root = mkdtempSync(`/tmp/agent-vm-guest-${fstype}-`);
    try {
      const guest = createGuestFixture(root, { fstype, virtualBytes: 2 * GIB });
      const run = runGuestGrowth(guest, 1);
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ virtual_bytes: 2 * GIB, filesystem: fstype });
      expect(readFileSync(guest.log, "utf8")).toBe(`growpart\n${fstype === "ext4" ? "resize2fs" : "xfs_growfs"}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("bounds every guest growth native command to 45 seconds with kill termination", () => {
  const boundedScript = GUEST_GROWTH_SCRIPT.replaceAll("45_000", "50");
  for (const delayCommand of ["findmnt", "growpart"] as const) {
    const root = mkdtempSync(`/tmp/agent-vm-guest-timeout-${delayCommand}-`);
    try {
      const guest = createGuestFixture(root, { delayCommand, virtualBytes: 2 * GIB });
      const started = performance.now();
      const run = runGuestGrowth(guest, 1, boundedScript);
      expect(run.exitCode).not.toBe(0);
      expect(performance.now() - started).toBeLessThan(500);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("refuses ambiguous guest roots and missing growth commands", () => {
  const ambiguousRoot = mkdtempSync("/tmp/agent-vm-guest-ambiguous-");
  const missingCommandRoot = mkdtempSync("/tmp/agent-vm-guest-missing-command-");
  try {
    const ambiguous = runGuestGrowth(createGuestFixture(ambiguousRoot, { parent: "vda/mapper", virtualBytes: 2 * GIB }), 1);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stderr).toContain("ambiguous root disk");
    const missingGuest = createGuestFixture(missingCommandRoot, { includeGrowpart: false, virtualBytes: 2 * GIB });
    const missing = runGuestGrowth(missingGuest, 1);
    expect(missing.exitCode).not.toBe(0);
    expect(existsSync(missingGuest.log)).toBe(false);
  } finally {
    rmSync(ambiguousRoot, { recursive: true, force: true });
    rmSync(missingCommandRoot, { recursive: true, force: true });
  }
});

test("fails closed on primitive, null, and array ACL rules before native init", async () => {
  const invalidRules: unknown[] = [null, 7, "invalid", [], { action: null }, { state: null }, { source: null }];
  for (const direction of ["ingress", "egress"] as const) {
    for (const [index, invalidRule] of invalidRules.entries()) {
      const f = fixture();
      f.runner.aclMalformedDirection = direction;
      f.runner.aclMalformedEntries = [invalidRule];
      const operation = `op-acl-${direction}-${index}`;
      await expectCode(f.call("acquire", { public_key: KEY }, operation), "network_unverified");
      expect(f.store.operation(operation)?.outcome).toBe("error");
      expect(f.runner.calls.some(({ args }) => args[0] === "incus" && args[3] === "init")).toBe(false);
    }
  }
});

test("requires the exact ordered isolation ACL without extra rules or fields", async () => {
  const extra = fixture();
  extra.runner.aclMalformedDirection = "egress";
  extra.runner.aclMalformedEntries = [{ action: "allow", state: "enabled", destination: "0.0.0.0/0" }];
  await expectCode(extra.call("acquire", { public_key: KEY }, "op-acl-extra"), "network_unverified");
  const reordered = fixture();
  const runner = reordered.runner as any;
  const original = runner.acl.bind(runner);
  runner.acl = () => {
    const value = original();
    [value.egress[0], value.egress[1]] = [value.egress[1], value.egress[0]];
    return value;
  };
  await expectCode(reordered.call("acquire", { public_key: KEY }, "op-acl-order"), "network_unverified");
});

test("keeps bounded output and reaps a timed out process group", async () => {
  const runner = new CommandRunner();
  const bounded = await runner.runBounded(["/bin/sh", "-c", "printf 1234567890; printf abcdefghij >&2"], { timeout: 5, stdoutLimit: 4, stderrLimit: 4, check: false });
  expect(new TextDecoder().decode(bounded.stdout)).toBe("1234");
  expect(new TextDecoder().decode(bounded.stderr)).toBe("ghij");
  expect(bounded.stdoutTruncated).toBe(true);
  try {
    await runner.runBounded(["/bin/sh", "-c", "sleep 10"], { timeout: 0.05 });
    throw new Error("expected command_timeout");
  } catch (error) {
    if (error instanceof Error && error.message === "expected command_timeout") throw error;
    expect((error as ControlError).code).toBe("command_timeout");
    expect((error as ControlError).detail).toMatchObject({ reaped: true });
    expect(typeof ((error as ControlError).detail as Dict).process_group_killed).toBe("boolean");
  }
});

linuxTest("reaps a process group after a reader communication failure", async () => {
  let childPid = 0;
  class ReaderRejectingRunner extends CommandRunner {
    override spawn(argv: readonly string[], options: Record<string, unknown>): Bun.Subprocess<"pipe", "pipe", "pipe"> {
      const child = super.spawn(argv, options);
      childPid = child.pid;
      const rejected = new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error("injected reader failure")); },
      });
      return new Proxy(child, {
        get(target, property) {
          if (property === "stdout") return rejected;
          return Reflect.get(target, property, target);
        },
      }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    }
  }
  const runner = new ReaderRejectingRunner();
  let failure: any;
  try { await runner.runBounded(["/bin/sh", "-c", "sleep 30 & wait"], { timeout: 5 }); }
  catch (error) { failure = error; }
  expect(failure?.code).toBe("command_io");
  expect(failure?.detail?.reaped).toBe(true);
  expect(failure?.detail?.process_group_killed).toBe(true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(childPid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
    }
    await Bun.sleep(10);
  }
  let alive = true;
  try { process.kill(childPid, 0); }
  catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  expect(alive).toBe(false);
});

test("redacts command stderr before journal, audit, and diagnostic output", async () => {
  const f = fixture();
  f.runner.failure = (args) => args[0] === "incus" && args[3] === "init";
  const originalFailure = f.runner.failure;
  f.runner.failure = (args) => {
    if (!originalFailure?.(args)) return false;
    throw new ControlError("command_failed", "native command failed", { returncode: 1, stderr: "password=secret-value secretValue=camel-secret-value tokenValue: camel-token-value bearer super-token Authorization: Bearer auth-canary-01 Authorization: Bearer \"quoted-secret-canary\" \"Authorization\": \"Bearer quoted-auth-01\"" });
  };
  await expectCode(f.call("acquire", { public_key: KEY }, "op-redacted-native-error"), "command_failed");
  const operation = JSON.stringify(f.store.operation("op-redacted-native-error"));
  const audit = JSON.stringify(f.store.db.query("SELECT detail_json FROM audit").all());
  const task = String(f.store.getTask({ sessionId: "thread-a" })?.last_error ?? "");
  expect(operation).not.toContain("secret-value");
  expect(operation).not.toContain("super-token");
  expect(operation).not.toContain("auth-canary-01");
  expect(operation).not.toContain("quoted-secret-canary");
  expect(operation).not.toContain("quoted-auth-01");
  expect(operation).not.toContain("camel-secret-value");
  expect(operation).not.toContain("camel-token-value");
  expect(audit).not.toContain("secret-value");
  expect(audit).not.toContain("super-token");
  expect(audit).not.toContain("auth-canary-01");
  expect(audit).not.toContain("quoted-secret-canary");
  expect(audit).not.toContain("quoted-auth-01");
  expect(audit).not.toContain("camel-secret-value");
  expect(audit).not.toContain("camel-token-value");
  expect(task).not.toContain("secret-value");
  expect(task).not.toContain("auth-canary-01");
  expect(task).not.toContain("quoted-secret-canary");
  expect(task).not.toContain("camel-secret-value");
  expect(task).not.toContain("camel-token-value");
  const diagnostic = new ControlError("command_failed", "native command failed", { nested: [{ stderr: "Authorization: Bearer nested-auth-01" }, { Authorization: "Bearer field-auth-01", secretValue: "structured-secret-value", tokenValue: "structured-token-value" }], stderr: "private_key=secret-value Authorization: Bearer \"quoted-secret-diagnostic\" \"Authorization\": \"Bearer quoted-auth-02\"" }).asDict();
  expect(JSON.stringify(diagnostic)).not.toContain("secret-value");
  expect(JSON.stringify(diagnostic)).not.toContain("nested-auth-01");
  expect(JSON.stringify(diagnostic)).not.toContain("field-auth-01");
  expect(JSON.stringify(diagnostic)).not.toContain("structured-secret-value");
  expect(JSON.stringify(diagnostic)).not.toContain("structured-token-value");
  expect(JSON.stringify(diagnostic)).not.toContain("quoted-auth-02");
  expect(JSON.stringify(diagnostic)).not.toContain("quoted-secret-diagnostic");
  const quoted = new ControlError("command_failed", "native command failed", { stderr: ["password", "=", '"line-one-secret-canary\nline-two-secret-canary" token=\'escaped\\\'multiline-token-canary\''].join("") }).asDict();
  expect(JSON.stringify(quoted)).not.toContain("secret-canary");
  expect(JSON.stringify(quoted)).not.toContain("multiline-token-canary");
  const pemDiagnostic = new ControlError("command_failed", "native command failed", { stderr: "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "pem-canary-".repeat(2000) }).asDict();
  expect(JSON.stringify(pemDiagnostic)).not.toContain("pem-canary");
  const values = [
    ["password", '"unterminated-secret-canary'],
    ["password", '"escaped\\"-secret-canary'],
    ["token", "'unterminated-token-canary"],
    ["token", "'escaped\\'-token-canary"],
    ["password", '"terminal-secret-canary\\'],
    ["token", "'terminal-token-canary\\"],
  ].map(([label, value]) => label + "=" + value);
  for (const value of values) {
    expect(JSON.stringify(new ControlError("command_failed", "native command failed", { stderr: value }).asDict())).not.toContain("canary");
  }
});

test("admin status retries when durable task state changes during the native snapshot", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-admin-snapshot-create");
  const original = (f.control as any).consistentRuntimeSummaries.bind(f.control);
  let injected = false;
  (f.control as any).consistentRuntimeSummaries = async () => {
    const summaries = await original();
    if (!injected) {
      injected = true;
      f.store.updateTask(String(active.task_id), { last_error: JSON.stringify({ code: "snapshot-race" }) });
    }
    return summaries;
  };
  (f.control as any).doctor = async () => ({ ready: true });
  const status = await (f.control as any).adminStatus({}, undefined);
  expect(injected).toBe(true);
  expect(status.doctor).toEqual({ ready: true });
  expect(status.tasks).toHaveLength(1);
  expect(status.tasks[0].last_error).toMatchObject({ code: "snapshot-race" });
});

test("real guest readiness shares one budget and emits a projected slow-start diagnostic", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-readiness-budget");
  f.runner.waitTimeout = true;
  let failure: ControlError | undefined;
  try { await (f.control as any).waitGuestReady(f.store.getTask({ taskId: active.task_id })); }
  catch (error) { failure = error as ControlError; }
  expect(failure?.code).toBe("guest_readiness_timeout");
  expect(failure?.detail).toMatchObject({ budget_seconds: 300, readiness: { diagnostic: { emitted: true } } });
  const waits = f.runner.calls.filter(({ args }) => args[0] === "incus" && args.includes("wait"));
  expect(waits.length).toBeGreaterThanOrEqual(3);
  const diagnostic = (f.store.db.query("SELECT detail_json FROM audit WHERE action = ? ORDER BY id DESC LIMIT 1") as any).get("boot-diagnostic") as { detail_json: string };
  expect(JSON.parse(diagnostic.detail_json)).toMatchObject({ event: "agent-vm-slow-start", readiness: { budget_seconds: 300 } });
});

test("expiry and drain fences stop preparation before a late native effect", async () => {
  for (const mode of ["expiry", "drain"] as const) {
    const f = fixture();
    let triggered = false;
    f.runner.onConfigSet = (_name, key) => {
      if (triggered || key !== "limits.memory") return;
      triggered = true;
      if (mode === "expiry") f.now = new Date(f.store.getTask({ sessionId: "thread-a" })!.lease_expires_at);
      else f.store.setMeta("draining", "1");
    };
    await expectCode(f.call("acquire", { public_key: KEY }, `op-fence-${mode}`), mode === "expiry" ? "lease_expired" : "draining");
    const task = f.store.getTask({ sessionId: "thread-a" });
    expect(task?.state).toBe("cached");
    expect(f.runner.instances.get(task?.instance_name)?.status).toBe("Stopped");
    expect(f.runner.calls.some(({ args }) => args[0] === "incus" && args[3] === "start")).toBe(false);
  }
});

test("release waits for an in-flight native barrier before revoking the lease", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-release-fence-create");
  const task = f.store.getTask({ sessionId: "thread-a" })!;
  let enter!: () => void;
  let unblock!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const held = (f.control as any).nativeBarrier(async () => { enter(); await blocked; }, false);
  await entered;
  let release: Promise<Dict> | undefined;
  try {
    release = f.call("release", {}, "op-release-fence");
    await Bun.sleep(25);
    expect(f.store.getTask({ taskId: String(task.task_id) })?.state).toBe("active");
    unblock();
    await held;
    expect((await release!).state).toBe("cached");
    await expectCode((f.control as any).nativeConfigSet(task, "limits.memory", "4096MiB"), "lease_expired");
  } finally {
    unblock();
    await held.catch(() => {});
    await release?.catch(() => {});
  }
});

test("bounds descendant-held pipes and stdin backpressure by one communication deadline", async () => {
  const runner = new CommandRunner();
  for (const [argv, options] of [
    [["/bin/sh", "-c", "sleep 1 & exit 0"], { timeout: 0.05 }],
    [["/bin/sh", "-c", "sleep 1; cat >/dev/null"], { timeout: 0.05, inputData: new Uint8Array(1024 * 1024) }],
  ] as const) {
    const started = performance.now();
    await expectCode(runner.runBounded(argv, options), "command_timeout");
    expect(performance.now() - started).toBeLessThan(500);
  }
});

test("keeps a successful command outcome when the child closes stdin early", async () => {
  const runner = new CommandRunner();
  const completed = await runner.runBounded(["/bin/sh", "-c", "exec 0<&-; exit 0"], { timeout: 1, inputData: new Uint8Array(1024 * 1024) });
  expect(completed.returncode).toBe(0);
});

test("rejects truncated ordinary output and native JSON consumers", async () => {
  const runner = new CommandRunner();
  const blocks = Math.floor(COMMAND_OUTPUT_LIMIT / 1024) + 1;
  await expectCode(runner.run(["/bin/sh", "-c", `dd if=/dev/zero bs=1024 count=${blocks} status=none`], { timeout: 5, check: false }), "command_output_truncated");

  class TruncatedRunner extends CommandRunner {
    override async run(argv: readonly string[], _options: RunnerOptions = {}): Promise<ProcessResult> {
      return { ...result(argv, "{}"), stdoutTruncated: true };
    }
  }
  const client = new IncusClient(new TruncatedRunner(), { project: "agents" });
  await expectCode(client.listInstances(), "command_output_truncated");
});

test("flushes a large response before a child exits", async () => {
  const child = Bun.spawn([process.execPath, "-e", `const { writeProcessOutput } = await import(process.env.CONTROL_PATH); await writeProcessOutput(JSON.stringify({ ok: true, data: "x".repeat(16 * 1024 * 1024) })); process.exit(0);`], {
    env: { ...process.env, CONTROL_PATH: fileURLToPath(new URL("../scripts/agent_vm_control.ts", import.meta.url)) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await collect(child);
  expect(output.exit).toBe(0);
  expect(output.stderr).toBe("");
  const parsed = JSON.parse(output.stdout) as Dict;
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toHaveLength(16 * 1024 * 1024);
});

test("removes an orphaned systemd timer only after native absence proof", async () => {
  const root = mkdtempSync("/tmp/agent-vm-timer-test-");
  const runner = new NativeCommands();
  const systemd = new SystemdManager(runner, { timer_dir: root }, true);
  try {
    const unit = await systemd.scheduleExpiry("avm-timer", 1, "2026-10-04T00:00:00+00:00");
    expect(readFileSync(join(root, unit), "utf8")).toContain("OnCalendar=2026-10-04 00:00:00 UTC");
    expect(readdirSync(root).filter((name) => name.startsWith(".agent-vm-timer-")).length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removes timer temporary artifacts when systemctl setup fails", async () => {
  const root = mkdtempSync("/tmp/agent-vm-timer-failure-test-");
  const runner = new NativeCommands();
  runner.failure = (args) => args[0] === "systemctl";
  const systemd = new SystemdManager(runner, { timer_dir: root }, true);
  try {
    await expectCode(systemd.scheduleExpiry("avm-timer-failure", 1, "2026-10-04T00:00:00+00:00"), "command_failed");
    expect(readdirSync(root).filter((name) => name.startsWith(".agent-vm-timer-"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("acquire is idempotent and binds Bun guest growth to the allocated generation", async () => {
  const f = fixture();
  const request = f.request("acquire", { public_key: KEY }, "op-acquire");
  const first = (await f.control.dispatch(request)).result;
  expect(first.state).toBe("active");
  expect(first.ports.map((port: Dict) => port.port_name)).toEqual(["ssh"]);
  expect(first.guest_filesystem.virtual_bytes).toBe(20 * GIB);
  expect(f.runner.calls.some(({ args }) => args.includes("bun"))).toBe(true);
  const journal = f.store.db.query("SELECT response_json FROM operations WHERE operation_id = ?").get("op-acquire") as { response_json: string };
  expect(JSON.parse(journal.response_json)._request_digest).toBe("aa47d7a4b589616cc101c6a704766df7d6e129e46033934d348ea9eceeb7037e");
  f.now = new Date("2026-10-04T00:00:20.000Z");
  const replay = await f.control.dispatch(request);
  expect(replay.outcome).toBe("replayed");
  expect(replay.result.lease_expires_at).toBe(first.lease_expires_at);
  expect(f.runner.calls.filter(({ args }) => args[3] === "init")).toHaveLength(1);
});

test("missing guest Bun remains mandatory when custom tools omit it", async () => {
  const f = fixture();
  (f.control as any).config.required_guest_tools = ["python3", "sshd", "rsync", "docker"];
  f.runner.missingGuestTool = "bun";
  await expectCode(f.call("acquire", { public_key: KEY }, "op-missing-bun"), "command_failed");
  expect(f.runner.calls.some(({ args }) => args.some((arg) => arg.includes("command -v")))).toBe(true);
  expect(f.runner.calls.some(({ args }) => args.includes("authorized_keys"))).toBe(false);
  expect(f.runner.calls.some(({ args }) => args[0] === "incus" && args.includes("bun"))).toBe(false);
});

test("default guest prerequisites reject an image without Python 3 before guest writes", async () => {
  const f = fixture();
  f.runner.missingGuestTool = "python3";
  await expectCode(f.call("acquire", { public_key: KEY }, "op-missing-python3"), "command_failed");
  expect(f.runner.calls.some(({ args }) => args.some((arg) => arg.includes("command -v")))).toBe(true);
  expect(f.runner.calls.some(({ args }) => args.includes("authorized_keys"))).toBe(false);
  expect(f.runner.calls.some(({ args }) => args[0] === "incus" && args.includes("bun"))).toBe(false);
});

test("uses exact ratio floors, reservation ceilings and bigint capacity boundaries", async () => {
  const f = fixture();
  const config = (f.control as any).config as Dict;
  config.cpu_budget = 15;
  config.memory_budget_mib = 12288;
  config.cpu_overcommit_ratio = 4;
  config.memory_overcommit_ratio = 4;
  let policy = await (f.control as any).resourcePolicy();
  expect(policy.limits).toEqual({ cpu: 60, memory_mib: 49152 });
  config.cpu_overcommit_ratio = "1.1";
  config.memory_overcommit_ratio = "1.01";
  policy = await (f.control as any).resourcePolicy();
  expect(policy.limits).toEqual({ cpu: 16, memory_mib: 12410 });

  config.cpu_budget = 4;
  config.memory_budget_mib = 4096;
  config.cpu_overcommit_ratio = 1;
  config.memory_overcommit_ratio = 1;
  const first = (f.control as any).baseTask("one", 1) as Dict;
  first.lease_expires_at = new Date(f.now.getTime() + 1800 * 1000).toISOString();
  first.resources_json = JSON.stringify({ cpu: 4, memory_mib: 4096, disk_gib: 20 });
  await (f.control as any).reserveResources(first, { cpu: 4, memory_mib: 4096, disk_gib: 20 });
  const second = (f.control as any).baseTask("two", 1) as Dict;
  second.lease_expires_at = new Date(f.now.getTime() + 1800 * 1000).toISOString();
  second.resources_json = JSON.stringify({ cpu: 4, memory_mib: 4096, disk_gib: 20 });
  await expectCode((f.control as any).reserveResources(second, { cpu: 4, memory_mib: 4096, disk_gib: 20 }), "resource_insufficient");
  expect(f.runner.calls.some(({ args }) => args[0] === "incus" && ["init", "start", "stop", "delete"].includes(args[3] ?? ""))).toBe(false);

  const exact = 9007199254740993n;
  f.store.updateTask(String(first.task_id), { reservation_bytes: 1n });
  const facts = { layers: [{ free: exact + 6n, low: exact + 2n }] };
  expect(await (f.control as any).spaceSufficient(facts, 3n, "low")).toBe(true);
  expect(await (f.control as any).spaceSufficient(facts, 4n, "low")).toBe(false);
});

test("keeps high-ratio policy limits and admission remaining exact", async () => {
  const f = fixture();
  const config = (f.control as any).config as Dict;
  config.cpu_budget = 4;
  config.cpu_overcommit_ratio = "1e308";
  config.memory_overcommit_ratio = 1;
  await f.call("acquire", { public_key: KEY }, "op-high-ratio-acquire");
  const status = await f.call("status");
  const exactLimit = 4n * 10n ** 308n;
  expect(status.admission.limits.cpu).toBe(exactLimit);
  expect(status.admission.ratios.cpu).toBe("1e308");
  expect(status.admission.allocated_and_reserved.cpu).toBe(2);
  expect(status.admission.remaining.cpu).toBe(exactLimit - 2n);
});

test("drain protects active leases and reclaim never deletes them", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-protected-active");
  await f.control.dispatch(f.request("drain-enter", {}, "op-drain-enter"));
  await expectCode(f.callFor("new-session", "acquire", { public_key: KEY }, "op-drain-acquire"), "draining");
  await expectCode(f.call("renew", {}, "op-drain-renew"), "draining");
  await f.control.dispatch(f.request("drain-exit", {}, "op-drain-exit"));

  const cached = await f.callFor("cached-session", "acquire", { public_key: KEY }, "op-protected-cache");
  await f.callFor("cached-session", "release", {}, "op-protected-cache-release");
  f.storageFree = 0;
  f.runner.failure = (args) => args[0] === "incus" && args[3] === "delete";
  await expectCode(f.callFor("new-session", "acquire", { public_key: KEY }, "op-reclaim-failure"), "reclaim_failed");
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("active");
  expect(f.store.getTask({ taskId: String(cached.task_id) })?.state).toBe("deleting");
  const deletes = f.runner.calls.filter(({ args }) => args[0] === "incus" && args[3] === "delete");
  expect(deletes.every(({ args }) => !args.includes(active.instance_name))).toBe(true);
});

test("drain enter and exit retain operation identity and replay safely", async () => {
  const f = fixture();
  const enter = f.request("drain-enter", {}, "op-drain-replay-enter");
  const first = await f.control.dispatch(enter);
  const replay = await f.control.dispatch(enter);
  expect(first.generation).toBe(0);
  expect(first.outcome).toBe("success");
  expect(replay.generation).toBe(0);
  expect(replay.outcome).toBe("replayed");
  const exit = f.request("drain-exit", {}, "op-drain-replay-exit");
  expect((await f.control.dispatch(exit)).operation_id).toBe("op-drain-replay-exit");
});

test("bounds and redacts ControlError messages before durable use", () => {
  const error = new ControlError("remote_failed", `Authorization: Basic dXNlcjpzZWNyZXQ= ${"x".repeat(10_000)}`);
  expect(error.message.length).toBeLessThanOrEqual(4096);
  expect(error.message).not.toContain("dXNlcjpzZWNyZXQ=");
  expect(JSON.stringify(error.asDict())).not.toContain("dXNlcjpzZWNyZXQ=");
});

test("retains conservative accounting after cleanup failure and reconciles on retry", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-cleanup-active");
  (f.control as any).systemd = new SystemdManager(f.runner, f.config, true);
  f.runner.failure = (args) => args[0] === "conntrack" && args[1] === "-D";
  await expectCode(f.call("release", {}, "op-cleanup-failure"), "cleanup_incomplete");
  const closing = f.store.getTask({ taskId: String(active.task_id) })!;
  expect(closing.state).toBe("closing");
  expect(closing.resource_reservation_json).toBe("{}");
  expect((f.control as any).allocationTotals()).toEqual({ cpu: 2, memory_mib: 4096 });
  expect(f.runner.calls.some(({ args }) => args[0] === "systemctl" && args[1] === "start" && args[2] === "--no-block")).toBe(true);

  f.runner.failure = undefined;
  const reconciled = await f.control.dispatch(f.request("admin-reconcile", { apply: true }, "op-cleanup-reconcile"));
  expect(reconciled.result.dry_run).toBe(false);
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("cached");
  expect(f.store.getPorts(String(active.task_id))).toHaveLength(0);
  expect(f.runner.instances.get(active.instance_name)?.status).toBe("Stopped");
});

test("treats whitespace-only conntrack output as no flows and blocks real flows", async () => {
  const clean = fixture();
  await clean.call("acquire", { public_key: KEY }, "op-whitespace-create");
  clean.runner.conntrackListOutput = " \n\t";
  expect((await clean.call("release", {}, "op-whitespace-release")).state).toBe("cached");

  const blocked = fixture();
  const active = await blocked.call("acquire", { public_key: KEY }, "op-flow-create");
  blocked.runner.conntrackListOutput = "tcp      6 431999 ESTABLISHED\n";
  await expectCode(blocked.call("release", {}, "op-flow-release"), "cleanup_incomplete");
  expect(blocked.store.getTask({ taskId: String(active.task_id) })?.state).toBe("closing");
  const reconciled = await blocked.control.dispatch(blocked.request("admin-reconcile", { apply: true }, "op-flow-reconcile"));
  expect(reconciled.result.actions.some((item: Dict) => item.error?.code === "cleanup_incomplete")).toBe(true);
  expect(blocked.store.getTask({ taskId: String(active.task_id) })?.state).toBe("closing");
});

test("keeps an orphan native proxy retryable and refuses cached resume", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-orphan-cleanup");
  const instance = f.runner.instances.get(active.instance_name)!;
  const orphan = { type: "proxy", listen: "tcp:198.51.100.19:20029", connect: "tcp:198.51.100.20:9029", nat: "true" };
  instance.devices["orphan-proxy"] = orphan;
  instance.expanded_devices["orphan-proxy"] = orphan;
  await expectCode(f.call("release", {}, "op-orphan-release"), "cleanup_incomplete");
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("closing");
  expect(f.runner.instances.get(active.instance_name)?.status).toBe("Stopped");
  expect(f.runner.instances.get(active.instance_name)?.expanded_devices["orphan-proxy"]).toBeDefined();

  const second = fixture();
  const cached = await second.call("acquire", { public_key: KEY }, "op-orphan-resume-create");
  await second.call("release", {}, "op-orphan-resume-release");
  const cachedInstance = second.runner.instances.get(cached.instance_name)!;
  cachedInstance.devices["orphan-proxy"] = orphan;
  cachedInstance.expanded_devices["orphan-proxy"] = orphan;
  await expectCode(second.call("acquire", { public_key: KEY }, "op-orphan-resume"), "cache_ineligible");
  expect(second.store.getTask({ taskId: String(cached.task_id) })?.state).toBe("cached");
});

test("fails before resize or GC writes when native device maps are malformed", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-malformed-resize-create");
  const before = f.runner.calls.length;
  f.runner.invalidDeviceMaps = true;
  await expectCode(f.call("resize", { disk_gib: 40, allow_restart: true }, "op-malformed-resize"), "mapping_unverified");
  expect(f.runner.calls.slice(before).some(({ args }) => args[0] === "incus" && args[3] === "config" && ["set", "device"].includes(args[4] ?? ""))).toBe(false);

  f.runner.invalidDeviceMaps = false;
  await f.call("release", {}, "op-malformed-gc-release");
  f.runner.invalidDeviceMaps = true;
  const gc = await f.control.dispatch(f.request("admin-gc", { apply: true }, "op-malformed-gc"));
  expect(gc.result.candidates).toHaveLength(1);
  expect(gc.result.candidates[0].error.code).toBe("mapping_unverified");
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("cached");
});

test("normalizes CIDR native addresses and rejects ambiguous address inventory", async () => {
  const f = fixture();
  f.runner.instances.set("native-cidr", {
    name: "native-cidr",
    status: "Stopped",
    devices: { eth0: { type: "nic", network: "agentsbr0", "ipv4.address": "198.51.100.20/24", "ipv6.address": "2001:db8::20/64" } },
    expanded_devices: { eth0: { type: "nic", network: "agentsbr0", "ipv4.address": "198.51.100.20/24", "ipv6.address": "2001:db8::20/64" } },
  });
  const allocated = await f.call("acquire", { public_key: KEY }, "op-cidr-address");
  expect(allocated.vm_ip).toBe("198.51.100.21");

  const malformed = fixture();
  malformed.runner.instances.set("native-malformed-address", {
    name: "native-malformed-address",
    status: "Stopped",
    devices: { eth0: { type: "nic", network: "agentsbr0", "ipv4.address": "198.51.100.20/33" } },
    expanded_devices: { eth0: { type: "nic", network: "agentsbr0", "ipv4.address": "198.51.100.20/33" } },
  });
  await expectCode(malformed.call("acquire", { public_key: KEY }, "op-malformed-address"), "vm_ip_unverified");
  expect(malformed.runner.calls.some(({ args }) => args[0] === "incus" && args[3] === "init")).toBe(false);
});

test("GC previews and deletes only eligible stopped caches", async () => {
  const f = fixture();
  const old = await f.callFor("old-session", "acquire", { public_key: KEY }, "op-gc-old");
  await f.callFor("old-session", "release", {}, "op-gc-old-release");
  f.now = new Date(f.now.getTime() + 25 * 60 * 60 * 1000);
  const active = await f.call("acquire", { public_key: KEY }, "op-gc-active");
  const preview = await f.control.dispatch(f.request("admin-gc", {}, "op-gc-preview"));
  expect(preview.result.dry_run).toBe(true);
  expect(preview.result.minimum_idle_seconds).toBe(0);
  expect(preview.result.candidates.map((item: Dict) => item.task_id)).toContain(old.task_id);
  const previewReplay = await f.control.dispatch(f.request("admin-gc", {}, "op-gc-preview"));
  expect(previewReplay.result.minimum_idle_seconds).toBe(0);
  await f.control.dispatch(f.request("admin-gc", { apply: true }, "op-gc-apply"));
  expect(f.store.getTask({ taskId: String(old.task_id) })?.state).toBe("absent");
  expect(f.store.getTask({ taskId: String(old.task_id) })?.resources_json).toBe("{}");
  const reopened = new StateStore(f.config.state_db);
  reopened.close();
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("active");
  expect(f.runner.instances.has(old.instance_name)).toBe(false);
  expect(f.runner.instances.has(active.instance_name)).toBe(true);
});

test("requires named native instances before release and deletion absence claims", { timeout: 30_000 }, async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-malformed-list-release-create");
  f.runner.malformedListRecord = true;
  await expectCode(f.call("release", {}, "op-malformed-list-release"), "cleanup_incomplete");
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("closing");

  const deleting = fixture();
  const cached = await deleting.call("acquire", { public_key: KEY }, "op-malformed-list-delete-create");
  await deleting.call("release", {}, "op-malformed-list-delete-release");
  deleting.runner.malformedListRecord = true;
  await expectCode(deleting.call("destroy", {}, "op-malformed-list-delete"), "native_inventory_unverified");
  expect(deleting.store.getTask({ taskId: String(cached.task_id) })?.state).toBe("deleting");
  const reconciled = await deleting.control.dispatch(deleting.request("admin-reconcile", { apply: true }, "op-malformed-list-reconcile"));
  expect(reconciled.result.actions.some((item: Dict) => item.error?.code === "native_inventory_unverified")).toBe(true);

  const absent = fixture();
  const owned = await absent.call("acquire", { public_key: KEY }, "op-valid-absence-create");
  absent.runner.instances.delete(owned.instance_name);
  expect((await absent.call("release", {}, "op-valid-absence-release")).state).toBe("absent");
});

test("partial live-memory failure keeps conservative allocation and no restart fallback", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-partial-create");
  f.runner.onConfigSet = () => { throw new ControlError("command_timeout", "uncertain native memory update"); };
  const resizeStart = f.runner.calls.length;
  await expectCode(f.call("resize", { memory_mib: 2048, live_memory: true }, "op-partial-memory"), "resize_partial");
  const status = await f.call("status");
  expect(status.state).toBe("active");
  expect(status.effective_lease).toBe(true);
  expect(status.resources.memory_mib).toBe(4096);
  expect(status.last_error.error.code).toBe("command_timeout");
  expect(f.runner.calls.slice(resizeStart).some(({ args }) => ["start", "stop", "delete"].includes(args[3] ?? ""))).toBe(false);
});

test("settles a balloon timeout once and retries only after guarded rereads", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-balloon-success-create");
  const instance = f.runner.instances.get(active.instance_name)!;
  const attempts: string[] = [];
  f.runner.onConfigSet = (_name, key, value) => {
    if (key !== "limits.memory" || value !== "2048MiB") return;
    attempts.push(value);
    if (attempts.length === 1) {
      instance.config["limits.memory"] = "4096MiB";
      instance.expanded_config["limits.memory"] = "4096MiB";
      throw balloonTimeout(2048);
    }
  };
  const resizeStart = f.runner.calls.length;
  const changed = await f.call("resize", { memory_mib: 2048, live_memory: true }, "op-balloon-success");
  expect(attempts).toHaveLength(2);
  expect(f.settleDelays).toEqual([45_000]);
  expect(f.runner.calls.slice(resizeStart).filter(({ args }) => args.includes("/proc/sys/kernel/random/boot_id")).length).toBeGreaterThanOrEqual(3);
  expect(changed.native_attempts.map((item: Dict) => item.ok)).toEqual([false, true]);
  expect(changed.resources.memory_mib).toBe(2048);
  expect(f.runner.calls.slice(resizeStart).some(({ args }) => args[0] === "incus" && ["start", "stop", "delete"].includes(args[3] ?? ""))).toBe(false);
});

test("keeps conservative accounting after the only balloon retry fails", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-balloon-failure-create");
  const instance = f.runner.instances.get(active.instance_name)!;
  const attempts: string[] = [];
  f.runner.onConfigSet = (_name, key, value) => {
    if (key !== "limits.memory" || value !== "2048MiB") return;
    attempts.push(value);
    instance.config["limits.memory"] = "4096MiB";
    instance.expanded_config["limits.memory"] = "4096MiB";
    throw balloonTimeout(2048);
  };
  const resizeStart = f.runner.calls.length;
  await expectCode(f.call("resize", { memory_mib: 2048, live_memory: true }, "op-balloon-failure"), "resize_partial");
  expect(attempts).toHaveLength(2);
  expect(f.settleDelays).toEqual([45_000]);
  const status = await f.call("status");
  expect(status.resources.memory_mib).toBe(4096);
  expect(status.resource_reservation.memory_mib).toBe(4096);
  expect(status.effective_lease).toBe(true);
  expect(status.last_error.native_attempts).toHaveLength(2);
  expect(f.runner.instances.get(active.instance_name)?.status).toBe("Running");
  expect(f.runner.calls.slice(resizeStart).some(({ args }) => args[0] === "incus" && ["start", "stop", "delete"].includes(args[3] ?? ""))).toBe(false);
});

test("does not retry a balloon timeout after settlement guard invalidation", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-balloon-guard-create");
  const instance = f.runner.instances.get(active.instance_name)!;
  const attempts: string[] = [];
  f.runner.onConfigSet = (_name, key, value) => {
    if (key !== "limits.memory" || value !== "2048MiB") return;
    attempts.push(value);
    instance.config["limits.memory"] = "4096MiB";
    instance.expanded_config["limits.memory"] = "4096MiB";
    throw balloonTimeout(2048);
  };
  f.onSettle = () => { instance.boot_id = "00000000-0000-4000-8000-000000000002"; };
  await expectCode(f.call("resize", { memory_mib: 2048, live_memory: true }, "op-balloon-guard"), "resize_partial");
  expect(attempts).toHaveLength(1);
  expect(f.settleDelays).toEqual([45_000]);
  expect(f.store.getTask({ taskId: String(active.task_id) })?.resources_json).toBe('{"cpu":2,"disk_gib":20,"memory_mib":4096}');
});

test("release caches the VM and reacquire advances the generation without renewing the lease", async () => {
  const f = fixture();
  const first = await f.call("acquire", { public_key: KEY }, "op-create");
  const cached = await f.call("release", {}, "op-release");
  expect(cached.state).toBe("cached");
  expect(cached.ports).toEqual([]);
  const resumed = await f.call("acquire", { public_key: KEY }, "op-resume");
  expect(resumed.task_id).toBe(first.task_id);
  expect(resumed.generation).toBe(2);
  expect(resumed.lease_expires_at).toBe(first.lease_expires_at);
});

test("project port mappings are durable before native exposure and removable exactly", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-create");
  const added = await f.call("port-add", { name: "web", vm_port: 8080 }, "op-port-add");
  expect(added.state).toBe("active");
  expect((await f.call("port-list", {})).ports.map((port: Dict) => port.port_name)).toEqual(["ssh", "web"]);
  const removed = await f.call("port-remove", { name: "web" }, "op-port-remove");
  expect(removed.removed).toBe(true);
  expect((await f.call("status")).task_id).toBe(active.task_id);
  expect((await f.call("port-list", {})).ports.map((port: Dict) => port.port_name)).toEqual(["ssh"]);
});

test("reconciles a transitional port after drain cleanup failure", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-drain-port-create");
  await f.call("port-add", { name: "web", vm_port: 8080 }, "op-drain-port-add");
  f.store.setMeta("draining", "1");
  f.runner.failure = (args) => args[0] === "conntrack" && args[1] === "-D";
  await expectCode(f.call("port-remove", { name: "web" }, "op-drain-port-remove"), "command_failed");
  expect(f.store.getPort(String(f.store.getTask({ sessionId: "thread-a" })!.task_id), "web", "tcp")?.state).toBe("closing");

  f.runner.failure = undefined;
  const reconciled = await f.control.dispatch(f.request("admin-reconcile", { apply: true }, "op-drain-port-reconcile"));
  expect(reconciled.result.actions.some((item: Dict) => item.action === "rearm-current-expiry")).toBe(true);
  expect((await f.call("port-list", {})).ports.map((port: Dict) => port.port_name)).toEqual(["ssh"]);
});

test("explicit null port protocols and admin apply values fail before native writes", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-null-fields-create");
  const nativeWrites = (): number => f.runner.calls.filter(({ args }) => args[0] === "incus" && args[3] === "config" && args[4] === "device" && ["add", "remove"].includes(args[5] ?? "")).length;
  const before = nativeWrites();
  await expectCode(f.call("port-add", { name: "null-add", vm_port: 8080, port_protocol: null }, "op-null-port-add"), "invalid_request");
  await expectCode(f.call("port-remove", { name: "ssh", port_protocol: null }, "op-null-port-remove"), "invalid_request");
  await expectCode(f.control.dispatch(f.request("admin-reconcile", { apply: null }, "op-null-reconcile")), "invalid_request");
  await expectCode(f.control.dispatch(f.request("admin-gc", { apply: null }, "op-null-gc")), "invalid_request");
  expect(nativeWrites()).toBe(before);
});

test("rejects non-scalar port protocols before effects and journals ControlError", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-protocol-boundary-create");
  const callsBefore = f.runner.calls.length;
  for (const [label, value] of [["array", ["tcp"]], ["object", {}], ["null", null]] as const) {
    const operation = `op-bad-protocol-${label}`;
    await expectCode(f.call("port-add", { name: `bad-${label}`, vm_port: 8080, port_protocol: value }, operation), "invalid_request");
    expect(f.store.operation(operation)?.outcome).toBe("error");
  }
  const removeOperation = "op-bad-protocol-remove";
  await expectCode(f.call("port-remove", { name: "missing", port_protocol: ["udp"] }, removeOperation), "invalid_request");
  expect(f.store.operation(removeOperation)?.outcome).toBe("error");
  expect(f.runner.calls.length).toBe(callsBefore);
});

test("fails closed on a mixed native inventory before allocating a project port", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-inventory-owner");
  const callsBeforeInventory = f.runner.calls.length;
  f.runner.malformedInventory = true;
  await expectCode(f.call("port-add", { name: "web", vm_port: 8080 }, "op-malformed-inventory"), "port_inventory_unverified");
  expect(f.store.getPort(String(f.store.getTask({ sessionId: "thread-a" })?.task_id), "web", "tcp")).toBeUndefined();
  expect(f.runner.calls.slice(callsBeforeInventory).some(({ args }) => args[0] === "incus" && args[1] === "--project" && args[3] === "config" && args[4] === "device" && args[5] === "add")).toBe(false);
});

test("keeps durable port accounting when native device maps are unavailable", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-mapping-owner");
  f.runner.invalidDeviceMaps = true;
  await expectCode(f.call("release", {}, "op-mapping-release"), "cleanup_incomplete");
  expect(f.store.getTask({ taskId: String(active.task_id) })?.state).toBe("closing");
  expect(f.store.getPorts(String(active.task_id))).toHaveLength(1);
  expect(Object.keys(f.runner.instances.get(active.instance_name)?.devices ?? {}).some((name) => name.endsWith("-ssh-tcp"))).toBe(true);
});

test("live memory reduction preserves lease and guest continuity", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-create");
  const changed = await f.call("resize", { memory_mib: 2048, live_memory: true }, "op-live");
  expect(changed.applied).toBe(true);
  expect(changed.resources).toEqual({ cpu: 2, memory_mib: 2048, disk_gib: 20 });
  expect(changed.lease_expires_at).toBe(active.lease_expires_at);
  expect(changed.resource_reservation).toEqual({});
  expect(f.runner.calls.filter(({ args }) => args.includes("limits.memory=2048MiB"))).toHaveLength(1);
});

test("treats explicit null resize resources as omitted", async () => {
  const live = fixture();
  await live.call("acquire", { public_key: KEY }, "op-null-resize-live-create");
  const liveStart = live.runner.calls.length;
  const changed = await live.call("resize", { memory_mib: 2048, cpu: null, disk_gib: null, live_memory: true }, "op-null-resize-live");
  expect(changed.applied).toBe(true);
  expect(live.runner.calls.slice(liveStart).some(({ args }) => args[0] === "incus" && ["start", "stop", "delete"].includes(args[3] ?? ""))).toBe(false);

  const restart = fixture();
  await restart.call("acquire", { public_key: KEY }, "op-null-resize-restart-create");
  const growthBefore = restart.runner.calls.filter(({ args }) => args[0] === "incus" && args[3] === "exec" && args.includes("bun")).length;
  const resized = await restart.call("resize", { memory_mib: 8192, disk_gib: null, allow_restart: true }, "op-null-resize-restart");
  const growthAfter = restart.runner.calls.filter(({ args }) => args[0] === "incus" && args[3] === "exec" && args.includes("bun")).length;
  expect(resized.completed).not.toContain("guest_filesystem");
  expect(growthAfter).toBe(growthBefore);
});

test("restart-capable disk growth updates native and guest sizes", async () => {
  const f = fixture();
  await f.call("acquire", { public_key: KEY }, "op-create");
  const changed = await f.call("resize", { disk_gib: 40, allow_restart: true }, "op-disk");
  expect(changed.applied).toBe(true);
  expect(changed.resources.disk_gib).toBe(40);
  expect(changed.guest_filesystem.virtual_bytes).toBe(40 * GIB);
  expect(f.runner.instances.get(changed.instance_name)?.status).toBe("Running");
});

test("expiry preempts the lease and leaves the native object cached", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-create");
  f.now = new Date(active.lease_expires_at);
  const response = await f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "timer-expire", task_id: active.task_id, generation: active.generation });
  expect(response.result.state).toBe("cached");
  expect((await f.call("status")).effective_lease).toBe(false);
  expect(f.runner.instances.get(active.instance_name)?.status).toBe("Stopped");
});

test("lease expiry cleans durable ports before leaving the VM cached", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-expiry-port-create");
  await f.call("port-add", { name: "web", vm_port: 8080 }, "op-expiry-port-add");
  f.now = new Date(active.lease_expires_at);
  const response = await f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "timer-expire", task_id: active.task_id, generation: active.generation });
  expect(response.result.state).toBe("cached");
  expect(response.result.ports).toEqual([]);
  expect(f.store.getPorts(String(active.task_id))).toEqual([]);
});

test("does not attach cleanup errors to a stale generation or state", async () => {
  const f = fixture();
  const active = await f.call("acquire", { public_key: KEY }, "op-stale-cleanup-create");
  f.store.updateTask(String(active.task_id), { state: "closing", lease_expires_at: null });
  await (f.control as any).updateCleanupLastError({ ...active, state: "active" }, JSON.stringify({ code: "stale-state" }));
  expect(f.store.getTask({ taskId: String(active.task_id) })?.last_error).toBeNull();
  const closing = f.store.getTask({ taskId: String(active.task_id) })!;
  f.store.updateTask(String(active.task_id), { generation: 2 });
  await (f.control as any).updateCleanupLastError(closing, JSON.stringify({ code: "stale-generation" }));
  expect(f.store.getTask({ taskId: String(active.task_id) })?.last_error).toBeNull();
});

test("native wait distinguishes timeout from a stopped guest", async () => {
  const runner = new NativeCommands();
  const client = new IncusClient(runner, { project: "agents" });
  runner.failure = (args) => args.includes("wait");
  await expectCode(client.wait("vm", "agent", 1), "command_failed");
});
