import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CommandRunner,
  Control,
  ControlError,
  CTResources,
  IncusClient,
  PROTOCOL_VERSION,
  StateStore,
  SystemdManager,
  loadConfig,
} from "../scripts/agent_vm_control.ts";

const GIB = 1024 ** 3;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestfixture";

type Dict = Record<string, any>;
type RunnerOptions = { inputData?: Uint8Array | string; timeout?: number; check?: boolean };
type ProcessResult = { args: string[]; returncode: number; stdout: Uint8Array; stderr: Uint8Array; stdoutTruncated?: boolean };

function result(args: readonly string[], stdout: string | Dict | Dict[] = "", returncode = 0, stderr = ""): ProcessResult {
  const text = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
  return { args: [...args], returncode, stdout: new TextEncoder().encode(text), stderr: new TextEncoder().encode(stderr) };
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
  onWait: ((name: string, condition: string) => void) | undefined;
  onStart: ((name: string) => void) | undefined;
  onConfigSet: ((name: string, key: string, value: string) => void) | undefined;

  override async run(argv: readonly string[], options: RunnerOptions = {}): Promise<ProcessResult> {
    const args = [...argv];
    this.calls.push({ args, options });
    if (this.failure?.(args)) throw new ControlError("command_failed", "injected native failure", { returncode: 1, stderr: "injected native failure" });
    if (args[0] === "ss") return result(args);
    if (args[0] === "conntrack") return result(args);
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
    if (path === "/1.0/instances") return result(args, project === "agents" ? [...this.instances.values()] : []);
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
      return result(args, instance);
    }
    throw new Error(`unexpected query: ${path}`);
  }

  private incus(command: string[]): ProcessResult {
    const verb = command[0];
    if (verb === "list") return result(["incus", ...command], [...this.instances.values()]);
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
        devices: { eth0: { type: "nic", network: "agentsbr0" }, root: { type: "disk", size: "20GiB" } },
        expanded_devices: { eth0: { type: "nic", network: "agentsbr0" }, root: { type: "disk", size: "20GiB" } },
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
      if (!this.guestToolsAvailable) throw new ControlError("command_failed", "required guest tool is missing", { returncode: 127, stderr: "bun: command not found" });
      return result(["incus", ...command]);
    }
    if (guestArgs[0] === "bun") return result(["incus", ...command], { virtual_bytes: instance.guest_disk_bytes, filesystem_before: instance.guest_disk_bytes - 1024, filesystem_bytes: instance.guest_disk_bytes, filesystem: "ext4" });
    return result(["incus", ...command]);
  }

  private acl(): Dict {
    const start = "198.51.100.20";
    const end = "198.51.100.250";
    return {
      config: { "user.agent-vm.managed": "native-v1" },
      ingress: [{ action: "drop", state: "enabled", source: `${start}-${end}` }],
      egress: [
        { action: "drop", state: "enabled", destination: `${start}-${end}` },
        { action: "drop", state: "enabled", destination: "198.51.100.19" },
        { action: "drop", state: "enabled", destination: "198.51.100.1", protocol: "tcp", destination_port: "22" },
      ],
    };
  }
}

class Fixture {
  readonly root = mkdtempSync("/tmp/agent-vm-control-test-");
  readonly runner = new NativeCommands();
  readonly store: StateStore;
  readonly systemd: SystemdManager;
  readonly control: Control;
  now = new Date("2026-10-04T00:00:00.000Z");
  readonly config: Dict;

  constructor() {
    this.config = {
      project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64),
      network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19",
      port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1",
      initial_lease_seconds: 1800, renew_seconds: 900, max_lease_seconds: 7200, cache_seconds: 86400,
      create_cost_bytes: 4 * GIB, resume_cost_bytes: GIB, resize_cost_bytes: GIB, storage_path: this.root,
      cpu_budget: 4, memory_budget_mib: 16384, cpu_overcommit_ratio: 4, memory_overcommit_ratio: 4,
      required_guest_tools: ["bun", "sshd", "rsync", "docker"], state_db: join(this.root, "state.sqlite3"), timer_dir: join(this.root, "systemd"),
    };
    this.store = new StateStore(this.config.state_db);
    this.systemd = new SystemdManager(this.runner, this.config, false);
    const resources = { cpu: () => 16, memory: () => ({ scope: "ct-memory", sources: ["lxcfs"], limit_bytes: 32 * GIB, available_bytes: 24 * GIB, threshold_bytes: 4 * GIB }) };
    this.control = new Control(this.config, {
      runner: this.runner,
      store: this.store,
      systemd: this.systemd,
      resources: resources as unknown as CTResources,
      clock: () => this.now,
      which: (command) => command === "conntrack" ? "/usr/sbin/conntrack" : null,
    });
    (this.control as any).ensureCapacityVerified = () => ({ scope: "ct-filesystem", observed_at: this.now.toISOString(), layers: [{ label: "ct-filesystem", total: 100 * GIB, free: 80 * GIB, kind: "data", low: 1 * GIB, target: 2 * GIB }] });
    (this.control as any).ephemeralPorts = () => new Set<number>();
  }

  close(): void { this.store.close(); rmSync(this.root, { recursive: true, force: true }); }

  request(action: string, fields: Dict = {}, operation?: string): Dict {
    const task = this.store.getTask({ sessionId: "thread-a" });
    return { protocol: PROTOCOL_VERSION, action, session_id: "thread-a", generation: Number(task?.generation ?? 0), operation_id: operation ?? `op-${Math.random().toString(16).slice(2)}`, ...fields };
  }

  async call(action: string, fields: Dict = {}, operation?: string): Promise<Dict> {
    const response = await this.control.dispatch(this.request(action, fields, operation));
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

test("loads Bun as the managed guest prerequisite", () => {
  const root = mkdtempSync("/tmp/agent-vm-config-test-");
  try {
    const config = { project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: root, state_db: join(root, "state.sqlite3"), timer_dir: root };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    expect(loadConfig(join(root, "config.json")).required_guest_tools).toEqual(["bun", "sshd", "rsync", "docker", "growpart"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects invalid identity, protocol, action and generation before native writes", async () => {
  const f = fixture();
  await expectCode(f.control.dispatch({ protocol: 3, action: "acquire", session_id: "thread-a", generation: 0, operation_id: "old-protocol", public_key: KEY }), "protocol_mismatch");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "status" }), "invalid_request");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "not-an-action", session_id: "thread-a" }), "unknown_action");
  await expectCode(f.control.dispatch({ protocol: PROTOCOL_VERSION, action: "acquire", session_id: "thread-a", generation: 1, operation_id: "wrong-generation", public_key: KEY }), "generation_mismatch");
  expect(f.runner.calls).toHaveLength(0);
});

test("keeps SQLite integer reservations exact beyond the JS safe range", () => {
  const root = mkdtempSync("/tmp/agent-vm-sqlite-test-");
  const store = new StateStore(join(root, "state.sqlite3"));
  try {
    const exact = 9007199254740993n;
    store.putTask({ task_id: "avm-exact", session_id: "exact", generation: 1, state: "active", instance_name: "agent-vm-exact", created_at: "2026-10-04T00:00:00+00:00", updated_at: "2026-10-04T00:00:00+00:00", image_fingerprint: "a".repeat(64), resources_json: "{}", reservation_bytes: exact, resource_reservation_json: "{}" });
    const task = store.getTask({ taskId: "avm-exact" });
    expect(typeof task?.reservation_bytes).toBe("bigint");
    expect(task?.reservation_bytes).toBe(exact);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("replays an accepted persisted operation without changing its digest or native state", async () => {
  const root = mkdtempSync("/tmp/agent-vm-baseline-test-");
  const dbPath = join(root, "state.sqlite3");
  const store = new StateStore(dbPath);
  const digest = "c3dccc911349ced563eb9615fb6db8ffa5801d121c9542c29c5a3fc0575a768a";
  const response = {
    ok: true, protocol: PROTOCOL_VERSION, server_time: "2026-10-04T00:00:00+00:00", action: "acquire", session_id: "legacy",
    generation: 0, operation_id: "legacy-op", outcome: "success", result: { state: "active" }, _request_digest: digest,
  };
  (store.db as any).run("INSERT INTO operations(operation_id, action, session_id, generation, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", "legacy-op", "acquire", "legacy", 0, JSON.stringify(response), "2026-10-04T00:00:00+00:00");
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

test("missing guest Bun fails before guest writes", async () => {
  const f = fixture();
  f.runner.guestToolsAvailable = false;
  await expectCode(f.call("acquire", { public_key: KEY }, "op-missing-bun"), "command_failed");
  expect(f.runner.calls.some(({ args }) => args.some((arg) => arg.includes("command -v")))).toBe(true);
  expect(f.runner.calls.some(({ args }) => args.includes("authorized_keys"))).toBe(false);
  expect(f.runner.calls.some(({ args }) => args[0] === "incus" && args.includes("bun"))).toBe(false);
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

test("native wait distinguishes timeout from a stopped guest", async () => {
  const runner = new NativeCommands();
  const client = new IncusClient(runner, { project: "agents" });
  runner.failure = (args) => args.includes("wait");
  await expectCode(client.wait("vm", "agent", 1), "command_failed");
});
