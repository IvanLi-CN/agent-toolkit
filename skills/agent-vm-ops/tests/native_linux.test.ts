import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CommandRunner, Control, StateStore } from "../scripts/agent_vm_control.ts";

type Dict = Record<string, any>;

const CONTROL_PATH = fileURLToPath(new URL("../scripts/agent_vm_control.ts", import.meta.url));
const CLIENT_PATH = fileURLToPath(new URL("../../agent-vm/scripts/agent_vm.py", import.meta.url));
const UNIT_PATHS = [
  fileURLToPath(new URL("../assets/systemd/agent-vm-native-age-gc.service", import.meta.url)),
  fileURLToPath(new URL("../assets/systemd/agent-vm-native-expire@.service", import.meta.url)),
  fileURLToPath(new URL("../assets/systemd/agent-vm-native-reconcile.service", import.meta.url)),
];

const getEuid = (process as unknown as { geteuid?: () => number }).geteuid;
const isRoot = typeof getEuid === "function" && getEuid() === 0;
const isLinux = process.platform === "linux";
const hasSystemdPrerequisites = isLinux && existsSync("/usr/bin/bun") && Bun.which("systemd-analyze") !== null;

type TestCallback = () => void | Promise<void>;

function linuxTest(name: string, callback: TestCallback): void {
  if (isLinux) test(name, callback);
  else test.skip(name, callback);
}

function systemdTest(name: string, callback: TestCallback): void {
  if (hasSystemdPrerequisites) test(name, callback);
  else test.skip(name, callback);
}

function transportTest(name: string, callback: TestCallback): void {
  if (isLinux && isRoot) test(name, callback);
  else test.skip(name, callback);
}

test("records native prerequisite availability", () => {
  const prerequisites = {
    platform: process.platform,
    euid: typeof getEuid === "function" ? getEuid() : null,
    root: isRoot,
    managed_bun: existsSync("/usr/bin/bun"),
    systemd_analyze: Bun.which("systemd-analyze"),
  };
  console.log(`native-prerequisites=${JSON.stringify(prerequisites)}`);
  expect(prerequisites.platform).toBe(process.platform);
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = mkdtempSync(`/tmp/${prefix}-`);
  roots.push(value);
  return value;
}

async function collect(child: any): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exit = await child.exited;
  return { exit, stdout: await stdout, stderr: await stderr };
}

function spawnWorker(source: string, env: Dict): any {
  return Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, CONTROL_PATH, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function lastJson(output: string): Dict {
  return JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? "{}");
}

function procState(pid: number): string | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = value.lastIndexOf(")");
    return value.slice(closeParen + 2).trim().split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

async function waitFor(path: string, timeoutMs = 3000): Promise<boolean> {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 10) {
    if (existsSync(path)) return true;
    await Bun.sleep(10);
  }
  return existsSync(path);
}

linuxTest("drains noisy stdout and stderr and reaps a real descendant", async () => {
  const runner = new CommandRunner();
  const bounded = await runner.runBounded(["/bin/sh", "-c", "dd if=/dev/zero bs=1M count=8 status=none; dd if=/dev/zero bs=1M count=8 status=none >&2"], { timeout: 5, stdoutLimit: 128, stderrLimit: 128 });
  expect(bounded.stdout.length).toBe(128);
  expect(bounded.stderr.length).toBe(128);
  expect(bounded.stdoutTruncated).toBe(true);

  const probeRoot = root("agent-vm-process-tree");
  const pidPath = join(probeRoot, "child.pid");
  let failure: any;
  try {
    await runner.runBounded(["/bin/sh", "-c", `(sleep 30) & echo $! > ${pidPath}; while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done`], { timeout: 0.25, stdoutLimit: 128, stderrLimit: 128 });
  } catch (error) {
    failure = error;
  }
  expect(failure?.code).toBe("command_timeout");
  expect(failure?.detail?.reaped).toBe(true);
  expect(failure?.detail?.process_group_killed).toBe(true);
  expect(await waitFor(pidPath)).toBe(true);
  const pid = Number(readFileSync(pidPath, "utf8"));
  let state: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    state = procState(pid);
    if (state === undefined || state === "Z") break;
    await Bun.sleep(10);
  }
  expect(state === undefined || state === "Z").toBe(true);
});

linuxTest("serializes object locks across real control processes", async () => {
  const probeRoot = root("agent-vm-object-lock");
  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = new StateStore(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root }, { store });
    try {
      if (process.env.PROBE_MODE === "hold") {
        await control.objectLock("session:shared", async () => {
          await Bun.write(root + "/held", "1");
          while (!existsSync(root + "/release")) await Bun.sleep(10);
        });
        console.log("hold-released");
      } else {
        try {
          await control.objectLock("session:shared", async () => {}, false);
          console.log("probe-acquired");
        } catch (error) {
          console.log(JSON.stringify({ code: error.code, message: error.message }));
        }
      }
    } finally {
      store.close();
    }
  `;
  const env = (mode: string): Dict => ({ PROBE_ROOT: probeRoot, PROBE_MODE: mode });
  const holder = spawnWorker(worker, env("hold"));
  expect(await waitFor(join(probeRoot, "held"))).toBe(true);
  const busy = spawnWorker(worker, env("probe"));
  const busyResult = await collect(busy);
  expect(busyResult.exit).toBe(0);
  expect(lastJson(busyResult.stdout)).toMatchObject({ code: "object_busy" });
  await Bun.write(join(probeRoot, "release"), "1");
  const holderResult = await collect(holder);
  expect(holderResult.exit).toBe(0);
  const free = spawnWorker(worker, env("probe"));
  const freeResult = await collect(free);
  expect(freeResult.exit).toBe(0);
  expect(freeResult.stdout.trim()).toBe("probe-acquired");
});

linuxTest("serializes concurrent SQLite admission and preserves the single reservation", async () => {
  const probeRoot = root("agent-vm-admission");
  const dbPath = join(probeRoot, "state.sqlite3");
  const initial = new StateStore(dbPath);
  initial.close();
  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore, CommandRunner, stableJson } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const mode = process.env.PROBE_MODE;
    const db = root + "/state.sqlite3";
    const encoder = new TextEncoder();
    const result = (value) => ({ args: [], returncode: 0, stdout: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)), stderr: new Uint8Array() });
    class Runner extends CommandRunner {
      async run(argv, options = {}) {
        if (argv[0] === "incus" && argv[1] === "query") return result({ config: {} });
        if (argv[0] === "incus" && argv[1] === "--project") return result([]);
        throw new Error("unexpected command: " + argv.join(" "));
      }
      async runBounded(argv, options = {}) { return this.run(argv, options); }
    }
    const store = new StateStore(db);
    const control = new Control({ project: "agents", profile: "agent-vm", state_db: db, timer_dir: root, storage_path: root, cpu_budget: 4, memory_budget_mib: 4096, cpu_overcommit_ratio: 1, memory_overcommit_ratio: 1, create_cost_bytes: 1, resume_cost_bytes: 1, resize_cost_bytes: 1 }, {
      store,
      runner: new Runner(),
      resources: { cpu: () => 16, memory: () => ({ scope: "ct-memory", sources: ["fixture"], limit_bytes: 32 * 1024 ** 3, available_bytes: 24 * 1024 ** 3, threshold_bytes: 4 * 1024 ** 3 }) },
    });
    await Bun.write(root + "/ready-" + mode, "1");
    while (!existsSync(root + "/go")) await Bun.sleep(5);
    const resources = { cpu: 3, memory_mib: 4096, disk_gib: 20 };
    const task = { task_id: "avm-" + mode, session_id: mode, generation: 1, state: "preparing", instance_name: "agent-vm-" + mode, vm_ip: null, ssh_host_port: null, lease_expires_at: new Date(Date.now() + 600000).toISOString(), inactive_since: null, cleanup_after: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null, image_fingerprint: "a".repeat(64), resources_json: stableJson(resources), reservation_bytes: 0n, resource_reservation_json: "{}" };
    try {
      const reserved = await control.reserveResources(task, resources);
      console.log(JSON.stringify({ mode, outcome: "admitted", reservation: reserved.resource_reservation_json }));
    } catch (error) {
      console.log(JSON.stringify({ mode, outcome: "rejected", code: error.code, detail: error.detail }));
    } finally {
      store.close();
    }
  `;
  const env = (mode: string): Dict => ({ PROBE_ROOT: probeRoot, PROBE_MODE: mode });
  const one = spawnWorker(worker, env("one"));
  const two = spawnWorker(worker, env("two"));
  const readyOne = await waitFor(join(probeRoot, "ready-one"));
  const readyTwo = await waitFor(join(probeRoot, "ready-two"));
  await Bun.write(join(probeRoot, "go"), "1");
  const oneResult = await collect(one);
  const twoResult = await collect(two);
  if (!readyOne || !readyTwo) throw new Error(`admission worker did not become ready: ${JSON.stringify({ readyOne, readyTwo, oneResult, twoResult })}`);
  if (oneResult.exit !== 0) throw new Error(`admission worker one failed: ${JSON.stringify(oneResult)}`);
  if (twoResult.exit !== 0) throw new Error(`admission worker two failed: ${JSON.stringify(twoResult)}`);
  const outcomes = [lastJson(oneResult.stdout), lastJson(twoResult.stdout)];
  expect(outcomes.filter((value) => value.outcome === "admitted")).toHaveLength(1);
  expect(outcomes.filter((value) => value.code === "resource_insufficient")).toHaveLength(1);
  const store = new StateStore(dbPath);
  try {
    const tasks = store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.resource_reservation_json).toBe("{\"cpu\":3,\"disk_gib\":20,\"memory_mib\":4096}");
  } finally {
    store.close();
  }
});

linuxTest("expiration preempts a lease while cleanup remains contended", async () => {
  const probeRoot = root("agent-vm-expiry");
  const dbPath = join(probeRoot, "state.sqlite3");
  const store = new StateStore(dbPath);
  store.putTask({ task_id: "avm-expire", session_id: "expire-session", generation: 1, state: "active", instance_name: "agent-vm-expire", vm_ip: "198.51.100.20", ssh_host_port: 20000, lease_expires_at: "2020-01-01T00:00:00+00:00", inactive_since: null, cleanup_after: null, created_at: "2020-01-01T00:00:00+00:00", updated_at: "2020-01-01T00:00:00+00:00", last_error: null, image_fingerprint: "a".repeat(64), resources_json: "{\"cpu\":2,\"disk_gib\":20,\"memory_mib\":4096}", reservation_bytes: 0n, resource_reservation_json: "{}" });
  store.close();
  const holderWorker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = new StateStore(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root }, { store });
    try {
      await control.objectLock("cleanup:expire-session", async () => {
        await Bun.write(root + "/held", "1");
        while (!existsSync(root + "/release")) await Bun.sleep(10);
      });
    } finally { store.close(); }
  `;
  const expiryWorker = `
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = new StateStore(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root, cache_seconds: 86400 }, { store });
    try {
      await control.expirePreempt({ task_id: "avm-expire", generation: 1 });
      console.log("preempt-complete");
    } finally { store.close(); }
  `;
  const holder = spawnWorker(holderWorker, { PROBE_ROOT: probeRoot });
  expect(await waitFor(join(probeRoot, "held"))).toBe(true);
  const expiry = spawnWorker(expiryWorker, { PROBE_ROOT: probeRoot });
  let observed: Dict | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = new StateStore(dbPath);
    observed = current.getTask({ taskId: "avm-expire" });
    current.close();
    if (observed?.state === "closing") break;
    await Bun.sleep(10);
  }
  if (observed?.state !== "closing") {
    await Bun.write(join(probeRoot, "release"), "1");
    const holderResult = await collect(holder);
    const expiryResult = await collect(expiry);
    throw new Error(`expiration did not preempt: ${JSON.stringify({ observed, holderResult, expiryResult }, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  }
  expect(observed?.lease_expires_at).toBeNull();
  await Bun.write(join(probeRoot, "release"), "1");
  const holderResult = await collect(holder);
  const expiryResult = await collect(expiry);
  expect(holderResult.exit).toBe(0);
  expect(expiryResult.exit).toBe(0);
});

linuxTest("a long native lock does not hold the global admission lock", async () => {
  const probeRoot = root("agent-vm-lock-order");
  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = new StateStore(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root }, { store });
    try {
      if (process.env.PROBE_MODE === "native") {
        await control.nativeLock({ session_id: "slow-native" }, async () => {
          await Bun.write(root + "/native-held", "1");
          while (!existsSync(root + "/release")) await Bun.sleep(10);
        });
      } else {
        while (!existsSync(root + "/native-held")) await Bun.sleep(10);
        await control.globalLock(async () => { await Bun.write(root + "/global-entered", "1"); });
      }
    } finally { store.close(); }
  `;
  const native = spawnWorker(worker, { PROBE_ROOT: probeRoot, PROBE_MODE: "native" });
  expect(await waitFor(join(probeRoot, "native-held"))).toBe(true);
  const global = spawnWorker(worker, { PROBE_ROOT: probeRoot, PROBE_MODE: "global" });
  expect(await waitFor(join(probeRoot, "global-entered"))).toBe(true);
  await Bun.write(join(probeRoot, "release"), "1");
  expect((await collect(native)).exit).toBe(0);
  expect((await collect(global)).exit).toBe(0);
});

systemdTest("systemd assets validate against the Bun runtime path", async () => {
  const processHandle = Bun.spawn(["systemd-analyze", "verify", ...UNIT_PATHS], { stdout: "pipe", stderr: "pipe" });
  const result = await collect(processHandle);
  if (result.exit !== 0) throw new Error(`systemd verify failed: ${JSON.stringify(result)}`);
  if (result.stderr !== "") throw new Error(`systemd verify stderr: ${result.stderr}`);
});

transportTest("the current Python client reaches the Bun controller through isolated fake SSH", async () => {
  const probeRoot = root("agent-vm-client-transport");
  const storage = join(probeRoot, "storage");
  const timerDir = join(probeRoot, "timer");
  const fakeBin = join(probeRoot, "bin");
  const clientConfig = join(probeRoot, "client-config");
  const clientState = join(probeRoot, "client-state");
  for (const path of [storage, timerDir, fakeBin, clientConfig, clientState]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const configPath = join(probeRoot, "config.json");
  writeFileSync(configPath, JSON.stringify({ project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: storage, state_db: join(storage, "state.sqlite3"), timer_dir: timerDir, cpu_budget: 4, memory_budget_mib: 4096 }));
  const wrapperPath = join(probeRoot, "controller-wrapper.ts");
  writeFileSync(wrapperPath, `const controller = await import(process.env.CONTROL_PATH); const request = JSON.parse(await Bun.stdin.text()); const config = controller.loadConfig(process.env.CONFIG_PATH); const store = new controller.StateStore(config.state_db); const control = new controller.Control(config, { store, systemd: new controller.SystemdManager(new controller.CommandRunner(), config, false) }); try { process.stdout.write(controller.stableJson(await control.dispatch(request)) + "\\n"); } catch (error) { process.stderr.write(controller.stableJson({ ok: false, error: error.asDict ? error.asDict() : { code: "internal_error" } }) + "\\n"); process.exitCode = 2; } finally { store.close(); }`);
  const logPath = join(probeRoot, "ssh-args.log");
  const sshPath = join(fakeBin, "ssh");
  writeFileSync(sshPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_SSH_LOG"\nexec "$BUN_BIN" "$FAKE_CONTROLLER"\n`, { mode: 0o700 });
  const result = await collect(Bun.spawn(["python3", CLIENT_PATH, "admin", "drain", "status"], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, AGENT_VM_SESSION_ID: "transport-smoke", AGENT_VM_CONTROL_HOST: "isolated-control", AGENT_VM_REMOTE_CONTROL: "/opt/agent-vm-native/agent_vm_control.ts", XDG_CONFIG_HOME: clientConfig, XDG_STATE_HOME: clientState, CONTROL_PATH, CONFIG_PATH: configPath, BUN_BIN: process.execPath, FAKE_CONTROLLER: wrapperPath, FAKE_SSH_LOG: logPath },
    stdout: "pipe",
    stderr: "pipe",
  }));
  if (result.exit !== 0) throw new Error(`transport failed: ${JSON.stringify(result)}`);
  if (result.stderr !== "") throw new Error(`transport stderr: ${result.stderr}`);
  expect(JSON.parse(result.stdout)).toMatchObject({ action: "drain-status", protocol: 4, outcome: "success", result: { draining: false } });
  expect(readFileSync(logPath, "utf8")).toContain("bun /opt/agent-vm-native/agent_vm_control.ts");
});
