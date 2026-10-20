import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireWriterIntent, anchoredProcessGroupMembers, COMMAND_OUTPUT_LIMIT, CONFIG_PATH_ENV, DIAGNOSTIC_LOG_TRUNCATION_MARKER, CommandRunner, Control, ControlError, hasWriterIntent, IncusClient, killProcessTree, ProcessIdentity, StateStore, SystemdManager } from "../scripts/agent_vm_control.ts";

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
function hasManagedBun(): boolean {
  try {
    const info = lstatSync("/usr/bin/bun");
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
const hasSystemdPrerequisites = isLinux && hasManagedBun() && Bun.which("systemd-analyze") !== null;
const hasIsolatedTransportEvidence = isLinux && process.env.AGENT_VM_ISOLATED_TRANSPORT_EVIDENCE === "1";

type TestCallback = () => void | Promise<void>;

function linuxTest(name: string, callback: TestCallback): void {
  if (isLinux) test(name, callback);
  else test.skip(name, callback);
}

function nonLinuxTest(name: string, callback: TestCallback): void {
  if (!isLinux) test(name, callback);
  else test.skip(name, callback);
}

function systemdTest(name: string, callback: TestCallback): void {
  if (hasSystemdPrerequisites) test(name, callback);
  else test.skip(name, callback);
}

function transportTest(name: string, callback: TestCallback): void {
  // This case only uses a temporary fake SSH transport and a non-systemd controller wrapper.
  // macOS exercises the same client/controller transport boundary; Linux real
  // native transport remains root-gated and CI uses only the isolated fake path.
  if (!isLinux || isRoot || hasIsolatedTransportEvidence) test(name, callback);
  else test.skip(name, callback);
}

test("records native prerequisite availability", () => {
  const prerequisites = {
    platform: process.platform,
    euid: typeof getEuid === "function" ? getEuid() : null,
    root: isRoot,
    managed_bun: hasManagedBun(),
    systemd_analyze: Bun.which("systemd-analyze"),
  };
  console.log(`native-prerequisites=${JSON.stringify(prerequisites)}`);
  expect(["linux", "darwin"]).toContain(prerequisites.platform);
  expect(typeof prerequisites.root).toBe("boolean");
  expect(prerequisites.euid === null || Number.isInteger(prerequisites.euid)).toBe(true);
});

test("rejects a missing guest prerequisite before the guest write boundary", async () => {
  const probeRoot = root("agent-vm-prerequisite");
  class MissingGuestRunner extends CommandRunner {
    readonly calls: string[][] = [];

    override async run(argv: readonly string[], _options: Dict = {}): Promise<any> {
      const args = [...argv];
      this.calls.push(args);
      if (args[0] === "incus" && args.includes("exec")) throw new ControlError("command_failed", "required guest tool is missing", { returncode: 127, stderr: "bun: command not found" });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    }
  }
  const runner = new MissingGuestRunner();
  const dbPath = join(probeRoot, "state.sqlite3");
  const store = StateStore.bootstrap(dbPath);
  const control = new Control({ project: "agents", state_db: dbPath, timer_dir: probeRoot, required_guest_tools: ["bun", "sshd", "rsync", "docker", "growpart"] }, { store, runner });
  try {
    store.putTask({ task_id: "avm-prerequisite", session_id: "prerequisite", generation: 1, state: "active", instance_name: "agent-vm-prerequisite", lease_expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), image_fingerprint: "a".repeat(64) });
    let failure: any;
    try { await (control as any).verifyGuestTools(store.getTask({ taskId: "avm-prerequisite" })); }
    catch (error) { failure = error; }
    expect(failure?.code).toBe("command_failed");
    expect(runner.calls.some((args) => args.some((arg) => arg.includes("command -v")))).toBe(true);
    expect(runner.calls.some((args) => args.some((arg) => arg.includes("authorized_keys")))).toBe(false);
  } finally { store.close(); }
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

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (error instanceof Error && error.message === `expected ${code}`) throw error;
    expect((error as ControlError).code).toBe(code);
  }
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

async function requireWorkerMarker(child: any, path: string, label: string): Promise<void> {
  if (await waitFor(path)) return;
  child.kill();
  const result = await collect(child);
  throw new Error(`${label} worker exited before synchronization marker: ${JSON.stringify(result)}`);
}

async function runSessionExpiryRace(mode: "status" | "acquire"): Promise<void> {
  const probeRoot = root("agent-vm-session-race-" + mode);
  const dbPath = join(probeRoot, "state.sqlite3");
  const enteredPath = join(probeRoot, "entered");
  const releasePath = join(probeRoot, "release");
  const expiryStartedPath = join(probeRoot, "expiry-started");
  const expiryDonePath = join(probeRoot, "expiry-done");
  const expiredPath = join(probeRoot, "expired");
  const leaseExpiresAt = "2030-01-01T00:00:00.000Z";
  const store = StateStore.bootstrap(dbPath);
  store.putTask({
    task_id: "avm-race", session_id: "race-session", generation: 1, state: "active", instance_name: "agent-vm-avm-race",
    vm_ip: "198.51.100.20", ssh_host_port: 20000, lease_expires_at: leaseExpiresAt, inactive_since: null, cleanup_after: null,
    created_at: leaseExpiresAt, updated_at: leaseExpiresAt, last_error: null, image_fingerprint: "a".repeat(64),
    resources_json: JSON.stringify({ cpu: 2, memory_mib: 4096, disk_gib: 20 }), reservation_bytes: 0n,
    previous_generation: null, resource_reservation_json: "{}",
  });
  store.putPort({ task_id: "avm-race", generation: 1, port_name: "ssh", protocol: "tcp", host_port: 20000, vm_port: 22, device_name: "agent-vm-avm-race-ssh-tcp", state: "active", created_at: leaseExpiresAt });
  store.close();

  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, CommandRunner, stableJson, StateStore, SystemdManager } = await import(process.env.CONTROL_PATH);
    const result = (value) => ({ args: [], returncode: 0, stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array() });
    class Runner extends CommandRunner {
      async run(argv, options = {}) {
        if (argv[0] !== "incus") throw new Error("unexpected command: " + argv.join(" "));
        if (argv[1] === "query") {
          const path = new URL(argv[2], "http://incus.test").pathname;
          if (path.endsWith("/state")) return result({ status: "Running" });
          return result({
            config: {
              "user.agent-vm.managed": "native-v1",
              "user.agent-vm.task": "avm-race",
              "user.agent-vm.session": "race-session",
              "user.agent-vm.generation": "1",
            },
            expanded_config: {},
            devices: {},
            expanded_devices: {},
          });
        }
        if (argv[1] === "--project" && argv[3] === "list") return result([]);
        throw new Error("unexpected incus command: " + argv.join(" "));
      }
      async runBounded(argv, options = {}) { return this.run(argv, options); }
    }
    const expiry = new Date(process.env.LEASE_EXPIRES);
    const clock = () => new Date(existsSync(process.env.EXPIRED) ? expiry.getTime() : expiry.getTime() - 1000);
    const store = StateStore.bootstrap(process.env.DB_PATH);
    const config = {
      project: "agents", profile: "agent-vm", state_db: process.env.DB_PATH, timer_dir: process.env.PROBE_ROOT,
      storage_path: process.env.PROBE_ROOT, cache_seconds: 86400, image_fingerprint: "a".repeat(64),
    };
    const runner = new Runner();
    const control = new Control(config, { store, runner, systemd: new SystemdManager(runner, config, false), clock });
    control.resourceDiagnostics = async () => ({ verified: true, remaining: { cpu: 2, memory_mib: 12288 }, allocated_and_reserved: { cpu: 2, memory_mib: 4096 }, memory_pressure: false });
    control.instanceDiagnostics = async () => ({ verified: true, total: 1, running: 1, stopped: 0, cached: 0, other: 0, limits: {}, policy_compliant: true });
    const mode = process.env.RACE_MODE;
    if (mode === "status") {
      const original = control.runtimeSummary.bind(control);
      let paused = true;
      control.runtimeSummary = async (task) => {
        if (paused) {
          paused = false;
          await Bun.write(process.env.ENTERED, "1");
          while (!existsSync(process.env.RELEASE)) await Bun.sleep(5);
        }
        return original(task);
      };
    } else if (mode === "acquire") {
      const original = control.ownership.bind(control);
      let paused = true;
      control.ownership = async (task) => {
        if (paused) {
          paused = false;
          await Bun.write(process.env.ENTERED, "1");
          while (!existsSync(process.env.RELEASE)) await Bun.sleep(5);
        }
        return original(task);
      };
    } else if (mode === "expire") {
      await Bun.write(process.env.EXPIRED, "1");
      control.cleanupTask = async () => [[], []];
      await Bun.write(process.env.EXPIRY_STARTED, "1");
    }
    const request = mode === "status"
      ? { protocol: 4, action: "status", session_id: "race-session", generation: 1 }
      : mode === "acquire"
        ? { protocol: 4, action: "acquire", session_id: "race-session", generation: 1, operation_id: "race-acquire", public_key: "ssh-ed25519 fixture" }
        : { protocol: 4, action: "timer-expire", task_id: "avm-race", generation: 1 };
    try {
      const response = mode === "acquire" ? await control.acquire(request, "race-session") : await control.dispatch(request);
      console.log(stableJson(response));
    } catch (error) {
      const detail = error && typeof error.asDict === "function"
        ? error.asDict()
        : { code: "internal_error", name: error?.name, message: error?.message };
      console.log(JSON.stringify({ ok: false, error: detail }));
      process.exitCode = 2;
    } finally {
      if (mode === "expire") await Bun.write(process.env.EXPIRY_DONE, "1");
      store.close();
    }
  `;
  const baseEnv = {
    DB_PATH: dbPath, PROBE_ROOT: probeRoot, ENTERED: enteredPath, RELEASE: releasePath, EXPIRED: expiredPath,
    EXPIRY_STARTED: expiryStartedPath, EXPIRY_DONE: expiryDonePath, LEASE_EXPIRES: leaseExpiresAt, RACE_MODE: mode, CONTROL_PATH,
  };
  const primary = spawnWorker(worker, baseEnv);
  await requireWorkerMarker(primary, enteredPath, mode);
  const expiry = spawnWorker(worker, { ...baseEnv, RACE_MODE: "expire" });
  await requireWorkerMarker(expiry, expiryStartedPath, "expire");
  if (mode === "acquire") await requireWorkerMarker(expiry, expiryDonePath, "expire");
  else await Bun.sleep(50);
  const beforeRelease = StateStore.bootstrap(dbPath);
  expect(beforeRelease.getTask({ taskId: "avm-race" })?.state).toBe(mode === "acquire" ? "absent" : "active");
  beforeRelease.close();
  await Bun.write(releasePath, "1");
  const [primaryResult, expiryResult] = await Promise.all([collect(primary), collect(expiry)]);
  expect(expiryResult.exit).toBe(0);
  expect(lastJson(expiryResult.stdout).result.state).toBe("absent");
  if (mode === "status") {
    if (primaryResult.exit !== 0) throw new Error(`status worker failed: ${JSON.stringify(primaryResult)}`);
    expect(lastJson(primaryResult.stdout).result).toMatchObject({ state: "active", native_status: "Running" });
  } else {
    expect(primaryResult.exit).toBe(2);
    expect(lastJson(primaryResult.stdout).error.code).toBe("task_transition");
  }
}

linuxTest("serializes status reads with expiry across control processes", async () => {
  await runSessionExpiryRace("status");
});

linuxTest("rejects an active acquire response after expiry revocation across processes", async () => {
  await runSessionExpiryRace("acquire");
});

test("refuses to kill a PID after its recorded Linux identity changes", () => {
  const member: ProcessIdentity = { pid: 4242, starttime: "old-starttime" };
  const killed: number[] = [];
  const result = killProcessTree([member], {
    exists: () => true,
    readIdentity: () => "reused-starttime",
    zombie: () => false,
    kill: (pid) => { killed.push(pid); return true; },
  });
  expect(result).toEqual({ killed: false, error: "process_identity_mismatch" });
  expect(killed).toEqual([]);
});

linuxTest("fails closed when a leader exits before a live process identity anchor is available", () => {
  let scanned = false;
  const result = anchoredProcessGroupMembers(
    777,
    [{ pid: 4244, starttime: "old-starttime" }],
    () => ({ pid: 4244, starttime: "reused-starttime", state: "S", ppid: 1, pgrp: 777 }),
    () => { scanned = true; return { members: [{ pid: 4245, starttime: "unrelated" }], complete: true }; },
  );
  expect(result).toEqual({ members: [], complete: false });
  expect(scanned).toBe(false);
});

test("treats an identity-matched zombie as already reaped", () => {
  const member: ProcessIdentity = { pid: 4243, starttime: "zombie-starttime" };
  const killed: number[] = [];
  const result = killProcessTree([member], {
    exists: () => true,
    readIdentity: () => member.starttime,
    zombie: () => true,
    kill: (pid) => { killed.push(pid); return true; },
  });
  expect(result).toEqual({ killed: true, error: null });
  expect(killed).toEqual([]);
});

linuxTest("kills a TERM-ignoring descendant after the leader exits on SIGTERM", async () => {
  const runner = new CommandRunner();
  const probeRoot = root("agent-vm-term-descendant");
  const pidPath = join(probeRoot, "child.pid");
  let failure: any;
  try {
    await runner.runBounded(["/bin/sh", "-c", `(setsid /bin/sh -c 'trap "" TERM; sleep 30') & echo $! > ${pidPath}; trap 'exit 0' TERM; while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done`], { timeout: 0.2, stdoutLimit: 128, stderrLimit: 128 });
  } catch (error) { failure = error; }
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

nonLinuxTest("fails closed when a process-group anchor is lost after leader exit", async () => {
  const runner = new CommandRunner();
  const probeRoot = root("agent-vm-darwin-term-descendant");
  const pidPath = join(probeRoot, "child.pid");
  let failure: any;
  try {
    await runner.runBounded(["/bin/sh", "-c", `(sh -c 'trap "" TERM; sleep 30') & echo $! > ${pidPath}; trap 'exit 0' TERM; while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done`], { timeout: 0.2, stdoutLimit: 128, stderrLimit: 128 });
  } catch (error) { failure = error; }
  expect(failure?.code).toBe("command_timeout");
  expect(failure?.detail?.reaped).toBe(true);
  // Once the leader has exited, this platform has no independent process
  // identity anchor that can prove the PGID has not been reused.
  expect(failure?.detail?.process_group_killed).toBe(false);
  expect(failure?.detail?.process_group_cleanup_error).toBe("process_group_anchor_lost");
  expect(await waitFor(pidPath)).toBe(true);
  const pid = Number(readFileSync(pidPath, "utf8"));
  try { process.kill(pid, "SIGKILL"); } catch { /* The child may have exited during cleanup. */ }
});

linuxTest("reaps a TERM-ignoring descendant after the leader exits before timeout", async () => {
  const runner = new CommandRunner();
  const probeRoot = root("agent-vm-early-leader");
  const pidPath = join(probeRoot, "child.pid");
  let failure: any;
  try {
    await runner.runBounded(["/bin/sh", "-c", `(setsid /bin/sh -c 'trap "" TERM; sleep 30') & echo $! > ${pidPath}; while [ ! -s ${pidPath} ]; do sleep 0.01; done; sleep 0.05; exit 0`], { timeout: 0.3, stdoutLimit: 128, stderrLimit: 128 });
  } catch (error) { failure = error; }
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

linuxTest("does not kill an unrelated process that spoofs the command marker", async () => {
  const runner = new CommandRunner();
  const probeRoot = root("agent-vm-marker-spoof");
  const markerPath = join(probeRoot, "marker");
  let unrelated: any;
  let failure: any;
  try {
    const command = runner.runBounded(["/bin/sh", "-c", `printf '%s' "$AGENT_VM_COMMAND_ID" > ${markerPath}; sleep 30`], { timeout: 0.2, stdoutLimit: 128, stderrLimit: 128 });
    expect(await waitFor(markerPath)).toBe(true);
    const marker = readFileSync(markerPath, "utf8");
    unrelated = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, AGENT_VM_COMMAND_ID: marker } });
    try { await command; }
    catch (error) { failure = error; }
    expect(failure?.code).toBe("command_timeout");
    expect(failure?.detail?.process_group_killed).toBe(false);
    expect(String(failure?.detail?.process_group_cleanup_error)).toContain("marker");
    expect(procState(unrelated.pid)).not.toBe("Z");
  } finally {
    try { unrelated?.kill?.("SIGKILL"); } catch { /* The unrelated probe may already have exited. */ }
  }
});

linuxTest("retains bounded redacted stderr in timeout diagnostics", async () => {
  const runner = new CommandRunner();
  let failure: any;
  try {
    await runner.runBounded(["/bin/sh", "-c", "printf 'password=\"timeout-secret-canary\\ncontinued-secret-canary\" AGENT_VM_COMMAND_ID=marker-timeout-canary\\n' >&2; sleep 30"], { timeout: 0.05, stderrLimit: 256 });
  } catch (error) { failure = error; }
  expect(failure?.code).toBe("command_timeout");
  expect(failure?.detail?.stderr).toContain("[REDACTED]");
  expect(failure?.detail?.stderr).not.toContain("timeout-secret-canary");
  expect(failure?.detail?.stderr).not.toContain("continued-secret-canary");
  expect(failure?.detail?.stderr).not.toContain("marker-timeout-canary");
  expect(failure?.detail?.stderr.length).toBeLessThanOrEqual(256);
});

linuxTest("drains noisy stdout and stderr and reaps a real descendant", async () => {
  const runner = new CommandRunner();
  const bounded = await runner.runBounded(["/bin/sh", "-c", "dd if=/dev/zero bs=1M count=8 status=none; dd if=/dev/zero bs=1M count=8 status=none >&2"], { timeout: 5, stdoutLimit: 128, stderrLimit: 128 });
  expect(bounded.stdout.length).toBe(128);
  expect(bounded.stderr.length).toBeLessThanOrEqual(128);
  expect(new TextDecoder().decode(bounded.stderr)).toBe(DIAGNOSTIC_LOG_TRUNCATION_MARKER);
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

linuxTest("rejects truncated ordinary output before native JSON inventory use", async () => {
  class NoisyIncusRunner extends CommandRunner {
    override async run(_argv: readonly string[], options: Dict = {}): Promise<any> {
      const blocks = Math.floor(COMMAND_OUTPUT_LIMIT / 1024) + 1;
      return super.run(["/bin/sh", "-c", `dd if=/dev/zero bs=1024 count=${blocks} status=none`], options);
    }
  }
  const client = new IncusClient(new NoisyIncusRunner(), { project: "agents" });
  let failure: any;
  try { await client.listInstances(); }
  catch (error) { failure = error; }
  expect(failure?.code).toBe("command_output_truncated");
});

linuxTest("enforces one deadline across descendant pipes and stdin backpressure", async () => {
  const runner = new CommandRunner();
  for (const [argv, options] of [
    [["/bin/sh", "-c", "sleep 1 & exit 0"], { timeout: 0.05 }],
    [["/bin/sh", "-c", "sleep 1; cat >/dev/null"], { timeout: 0.05, inputData: new Uint8Array(1024 * 1024) }],
  ] as const) {
    const started = performance.now();
    let failure: any;
    try { await runner.runBounded(argv, options); }
    catch (error) { failure = error; }
    expect(failure?.code).toBe("command_timeout");
    expect(performance.now() - started).toBeLessThan(500);
  }
});

linuxTest("reaps a descendant when the command closes stdin before a large write", async () => {
  const runner = new CommandRunner();
  const probeRoot = root("agent-vm-early-stdin");
  const pidPath = join(probeRoot, "child.pid");
  let failure: any;
  try {
    await runner.runBounded(["/bin/sh", "-c", `echo $$ > ${pidPath}; exec 0<&-; sleep 30`], { timeout: 1, inputData: new Uint8Array(1024 * 1024) });
  } catch (error) { failure = error; }
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

linuxTest("waits for an independent SQLite writer and preserves durable failure metadata", async () => {
  const probeRoot = root("agent-vm-sqlite-writer");
  const dbPath = join(probeRoot, "state.sqlite3");
  const initial = StateStore.bootstrap(dbPath);
  initial.close();
  const worker = `
    const { existsSync } = await import("node:fs");
    const { StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    if (process.env.PROBE_MODE === "writer") await Bun.write(root + "/writer-start", "1");
    const store = StateStore.bootstrap(root + "/state.sqlite3");
    try {
      if (process.env.PROBE_MODE === "hold") {
        store.db.run("BEGIN IMMEDIATE");
        await Bun.write(root + "/held", "1");
        while (!existsSync(root + "/release")) await Bun.sleep(10);
        store.db.run("ROLLBACK");
        console.log("holder-released");
      } else {
        await Bun.write(root + "/writer-ready", "1");
        while (!existsSync(root + "/writer-go")) await Bun.sleep(10);
        const started = Date.now();
        store.recordOperation("op-sqlite-competition", "acquire", "session-sqlite", 1, { outcome: "error", error: { code: "synthetic_failure", message: "synthetic failure" }, _request_digest: "0".repeat(64) });
        store.audit("acquire", "error", { code: "synthetic_failure" }, undefined, "session-sqlite", 1);
        store.setMeta("last_failure", "synthetic_failure");
        await Bun.write(root + "/writer-done", String(Date.now() - started));
        console.log(JSON.stringify({ elapsed: Date.now() - started }));
      }
    } finally { store.close(); }
  `;
  const env = { PROBE_ROOT: probeRoot };
  const writer = spawnWorker(worker, { ...env, PROBE_MODE: "writer" });
  expect(await waitFor(join(probeRoot, "writer-start"))).toBe(true);
  expect(await waitFor(join(probeRoot, "writer-ready"))).toBe(true);
  const holder = spawnWorker(worker, { ...env, PROBE_MODE: "hold" });
  expect(await waitFor(join(probeRoot, "held"))).toBe(true);
  await Bun.write(join(probeRoot, "writer-go"), "1");
  await Bun.sleep(250);
  expect(existsSync(join(probeRoot, "writer-done"))).toBe(false);
  await Bun.sleep(500);
  await Bun.write(join(probeRoot, "release"), "1");
  const holderResult = await collect(holder);
  const writerResult = await collect(writer);
  expect(holderResult.exit).toBe(0);
  expect(writerResult.exit).toBe(0);
  expect(Number(readFileSync(join(probeRoot, "writer-done"), "utf8"))).toBeGreaterThanOrEqual(600);

  const store = StateStore.bootstrap(dbPath);
  try {
    expect(store.operation("op-sqlite-competition")).toMatchObject({ outcome: "error", error: { code: "synthetic_failure" } });
    expect(store.getMeta("last_failure")).toBe("synthetic_failure");
    const audits = (store.db.query("SELECT action, outcome, detail_json FROM audit WHERE session_id = ?").all("session-sqlite") as Dict[]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "acquire", outcome: "error" });
  } finally { store.close(); }
});

linuxTest("serializes object locks across real control processes", async () => {
  const probeRoot = root("agent-vm-object-lock");
  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = StateStore.bootstrap(root + "/state.sqlite3");
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

linuxTest("prevents a queued cross-process drain writer from being bypassed by readers", async () => {
  const probeRoot = root("agent-vm-native-barrier-fairness");
  const dbPath = join(probeRoot, "state.sqlite3");
  const initial = StateStore.bootstrap(dbPath);
  initial.close();
  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = StateStore.bootstrap(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root }, { store });
    const barrier = (callback, exclusive) => control.nativeBarrier(callback, exclusive);
    try {
      if (process.env.PROBE_MODE === "hold") {
        await barrier(async () => {
          await Bun.write(root + "/reader-held", "1");
          while (!existsSync(root + "/release")) await Bun.sleep(10);
        }, false);
      } else if (process.env.PROBE_MODE === "writer") {
        await Bun.write(root + "/writer-waiting", "1");
        await barrier(async () => {
          await Bun.write(root + "/writer-entered", "1");
          await Bun.sleep(150);
        }, true);
        await Bun.write(root + "/writer-done", "1");
      } else {
        await barrier(async () => {
          await Bun.write(root + "/reader-entered", "1");
          await Bun.sleep(100);
        }, false);
      }
    } finally { store.close(); }
  `;
  const processes: any[] = [];
  let collected = false;
  try {
    const env = (mode: string): Dict => ({ PROBE_ROOT: probeRoot, PROBE_MODE: mode });
    const holder = spawnWorker(worker, env("hold"));
    processes.push(holder);
    expect(await waitFor(join(probeRoot, "reader-held"))).toBe(true);
    const writer = spawnWorker(worker, env("writer"));
    processes.push(writer);
    expect(await waitFor(join(probeRoot, "writer-waiting"))).toBe(true);
    await Bun.sleep(150);
    const reader = spawnWorker(worker, env("reader"));
    processes.push(reader);
    await Bun.sleep(250);
    expect(existsSync(join(probeRoot, "reader-entered"))).toBe(false);
    expect(existsSync(join(probeRoot, "writer-entered"))).toBe(false);
    await Bun.write(join(probeRoot, "release"), "1");
    const results = await Promise.all(processes.map(collect));
    collected = true;
    expect(results.every((result) => result.exit === 0)).toBe(true);
    expect(existsSync(join(probeRoot, "writer-done"))).toBe(true);
    expect(existsSync(join(probeRoot, "reader-entered"))).toBe(true);
  } finally {
    await Bun.write(join(probeRoot, "release"), "1");
    if (!collected) await Promise.all(processes.map((child) => collect(child).catch(() => undefined)));
  }
});

linuxTest("does not reclaim a pending writer marker before its flock transition", async () => {
  const probeRoot = root("agent-vm-native-marker-race");
  const dbPath = join(probeRoot, "state.sqlite3");
  const initial = StateStore.bootstrap(dbPath);
  initial.close();
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const marker = join(lockDirectory, "native-writer-pending");
  writeFileSync(marker, `pending ${process.pid} marker-test\n`, { mode: 0o600 });
  const markerFd = openSync(marker, "r+");
  const worker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = StateStore.bootstrap(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root }, { store });
    try {
      await control.nativeBarrier(async () => { await Bun.write(root + "/reader-entered", "1"); }, false);
    } finally { store.close(); }
  `;
  const child = spawnWorker(worker, { PROBE_ROOT: probeRoot });
  let collected = false;
  try {
    await Bun.sleep(250);
    expect(existsSync(join(probeRoot, "reader-entered"))).toBe(false);
    rmSync(marker, { force: true });
    closeSync(markerFd);
    // The marker descriptor is intentionally held across the pending window.
    const result = await collect(child);
    collected = true;
    expect(result.exit).toBe(0);
    expect(existsSync(join(probeRoot, "reader-entered"))).toBe(true);
  } finally {
    try { closeSync(markerFd); } catch { /* The pending marker descriptor may already be closed. */ }
    rmSync(marker, { force: true });
    if (!collected) await collect(child).catch(() => undefined);
  }
});

linuxTest("reclaims empty, malformed, and crashed writer markers", () => {
  const probeRoot = root("agent-vm-native-marker-recovery");
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(lockDirectory, "native-writer-empty"), "", { mode: 0o600 });
  writeFileSync(join(lockDirectory, "native-writer-malformed"), "corrupt marker\n", { mode: 0o600 });
  writeFileSync(join(lockDirectory, "native-writer-crashed"), "pending 99999999 dead-token\n", { mode: 0o600 });
  expect(hasWriterIntent(lockDirectory)).toBe(false);
  expect(readdirSync(lockDirectory).filter((name) => name.startsWith("native-writer-"))).toEqual([]);
});

linuxTest("fails closed on filesystem-shaped writer markers without retrying forever", () => {
  const probeRoot = root("agent-vm-native-marker-shape");
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const symlink = join(lockDirectory, "native-writer-symlink");
  const target = join(probeRoot, "outside");
  writeFileSync(target, "not a marker\n", { mode: 0o600 });
  symlinkSync(target, symlink);
  expect(hasWriterIntent(lockDirectory)).toBe(false);
  expect(existsSync(symlink)).toBe(false);

  mkdirSync(join(lockDirectory, "native-writer-directory"), { mode: 0o700 });
  let failure: any;
  try { hasWriterIntent(lockDirectory); }
  catch (error) { failure = error; }
  expect(failure?.code).toBe("lock_unavailable");
});

linuxTest("reclaims only aged orphan writer marker temporary files within a bounded scan", () => {
  const probeRoot = root("agent-vm-native-marker-temp-recovery");
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const oldTemp = join(lockDirectory, "native-writer-crashed.tmp-old");
  const freshTemp = join(lockDirectory, "native-writer-fresh.tmp-new");
  writeFileSync(oldTemp, "orphan\n", { mode: 0o600 });
  writeFileSync(freshTemp, "in flight\n", { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  utimesSync(oldTemp, old, old);
  expect(hasWriterIntent(lockDirectory)).toBe(false);
  expect(existsSync(oldTemp)).toBe(false);
  expect(existsSync(freshTemp)).toBe(true);
});

linuxTest("reclaims only aged orphan writer state sidecars within a bounded scan", () => {
  const probeRoot = root("agent-vm-native-marker-state-recovery");
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const oldState = join(lockDirectory, "native-writer-orphan.state");
  const freshState = join(lockDirectory, "native-writer-fresh.state");
  writeFileSync(oldState, "orphan\n", { mode: 0o600 });
  writeFileSync(freshState, "in flight\n", { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  utimesSync(oldState, old, old);
  expect(hasWriterIntent(lockDirectory)).toBe(false);
  expect(existsSync(oldState)).toBe(false);
  expect(existsSync(freshState)).toBe(true);
});

test("systemd assets fence the alternate configuration environment", () => {
  for (const path of UNIT_PATHS) {
    const content = readFileSync(path, "utf8");
    expect(content).toContain("UnsetEnvironment=AGENT_VM_CONFIG_PATH");
    expect(content).not.toMatch(/^Environment=AGENT_VM_CONFIG_PATH=/m);
  }
});

nonLinuxTest("fails closed instead of waiting forever on an unverified writer marker", async () => {
  const probeRoot = root("agent-vm-native-marker-nonlinux");
  const dbPath = join(probeRoot, "state.sqlite3");
  const store = StateStore.bootstrap(dbPath);
  const systemd = new SystemdManager(new CommandRunner(), { timer_dir: probeRoot }, false);
  const control = new Control({ state_db: dbPath, timer_dir: probeRoot }, { store, systemd });
  const marker = join(probeRoot, "locks", "native-writer-unverified");
  writeFileSync(marker, `pending ${process.pid} unknown-identity token\n`, { mode: 0o600 });
  try {
    await expectCode((control as any).nativeBarrier(async () => undefined, false), "lock_unavailable");
  } finally {
    store.close();
    rmSync(probeRoot, { recursive: true, force: true });
  }
});

linuxTest("publishes writer marker state atomically and removes it on release", () => {
  const probeRoot = root("agent-vm-native-marker-atomic");
  const lockDirectory = join(probeRoot, "locks");
  const release = acquireWriterIntent(lockDirectory);
  try {
    const names = readdirSync(lockDirectory).filter((name) => name.startsWith("native-writer-") && !name.includes(".tmp-"));
    expect(names.filter((name) => !name.endsWith(".state"))).toHaveLength(1);
    expect(names.filter((name) => name.endsWith(".state"))).toHaveLength(1);
    const stateName = names.find((name) => name.endsWith(".state"))!;
    expect(readFileSync(join(lockDirectory, stateName), "utf8")).toMatch(/^ready__ /);
  } finally { release(); }
  expect(readdirSync(lockDirectory).filter((name) => name.startsWith("native-writer-"))).toEqual([]);
});

linuxTest("treats a cross-process ready sidecar flock as active", async () => {
  const probeRoot = root("agent-vm-native-ready-sidecar");
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const worker = [
    "const { closeSync, openSync, writeFileSync, existsSync } = await import(\"node:fs\");",
    "const { dlopen } = await import(\"bun:ffi\");",
    "const { flock } = dlopen(process.platform === \"darwin\" ? \"/usr/lib/libSystem.B.dylib\" : \"libc.so.6\", { flock: { args: [\"int\", \"int\"], returns: \"int\" } }).symbols;",
    "const marker = process.env.MARKER_PATH;",
    "writeFileSync(marker, \"ready__ 99999999 unknown sidecar-token\\n\", { mode: 0o600 });",
    "writeFileSync(marker + \".state\", \"ready__ 99999999 unknown sidecar-token\\n\", { mode: 0o600 });",
    "const fd = openSync(marker + \".state\", \"r+\");",
    "if (flock(fd, 2) !== 0) throw new Error(\"sidecar flock failed\");",
    "await Bun.write(process.env.READY_FILE, \"1\");",
    "while (!existsSync(process.env.RELEASE_FILE)) await Bun.sleep(5);",
    "flock(fd, 8);",
    "closeSync(fd);",
  ].join("\n");
  const marker = join(lockDirectory, "native-writer-ready-only");
  const child = spawnWorker(worker, { MARKER_PATH: marker, READY_FILE: join(probeRoot, "ready"), RELEASE_FILE: join(probeRoot, "release") });
  let collected = false;
  try {
    expect(await waitFor(join(probeRoot, "ready"))).toBe(true);
    expect(hasWriterIntent(lockDirectory)).toBe(true);
    await Bun.write(join(probeRoot, "release"), "1");
    const result = await collect(child);
    collected = true;
    expect(result.exit).toBe(0);
    expect(hasWriterIntent(lockDirectory)).toBe(false);
  } finally {
    await Bun.write(join(probeRoot, "release"), "1");
    if (!collected) await collect(child).catch(() => undefined);
    rmSync(lockDirectory, { recursive: true, force: true });
  }
});

linuxTest("does not trust a live but unowned or reused PID in a pending marker", () => {
  const probeRoot = root("agent-vm-native-marker-identity");
  const lockDirectory = join(probeRoot, "locks");
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const unowned = join(lockDirectory, "native-writer-unowned");
  writeFileSync(unowned, "pending " + process.pid + " wrong-identity token\n", { mode: 0o600 });
  expect(hasWriterIntent(lockDirectory)).toBe(false);
  expect(existsSync(unowned)).toBe(false);
});

linuxTest("serializes concurrent SQLite admission and preserves the single reservation", async () => {
  const probeRoot = root("agent-vm-admission");
  const dbPath = join(probeRoot, "state.sqlite3");
  const initial = StateStore.bootstrap(dbPath);
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
    const store = StateStore.bootstrap(db);
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
  const store = StateStore.bootstrap(dbPath);
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
  const store = StateStore.bootstrap(dbPath);
  store.putTask({ task_id: "avm-expire", session_id: "expire-session", generation: 1, state: "active", instance_name: "agent-vm-expire", vm_ip: "198.51.100.20", ssh_host_port: 20000, lease_expires_at: "2020-01-01T00:00:00+00:00", inactive_since: null, cleanup_after: null, created_at: "2020-01-01T00:00:00+00:00", updated_at: "2020-01-01T00:00:00+00:00", last_error: null, image_fingerprint: "a".repeat(64), resources_json: "{\"cpu\":2,\"disk_gib\":20,\"memory_mib\":4096}", reservation_bytes: 0n, resource_reservation_json: "{}" });
  store.close();
  const holderWorker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = StateStore.bootstrap(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root }, { store });
    try {
      await control.objectLock("cleanup:expire-session", async () => {
        await Bun.write(root + "/held", "1");
        while (!existsSync(root + "/release")) await Bun.sleep(10);
      });
    } finally { store.close(); }
  `;
  const expiryWorker = `
    const { existsSync } = await import("node:fs");
    const { Control, StateStore } = await import(process.env.CONTROL_PATH);
    const root = process.env.PROBE_ROOT;
    const store = StateStore.bootstrap(root + "/state.sqlite3");
    const control = new Control({ state_db: root + "/state.sqlite3", timer_dir: root, cache_seconds: 86400 }, { store });
    try {
      await Bun.write(root + "/expiry-ready", "1");
      while (!existsSync(root + "/expiry-go")) await Bun.sleep(10);
      await control.expirePreempt({ task_id: "avm-expire", generation: 1 });
      console.log("preempt-complete");
    } finally { store.close(); }
  `;
  const holder = spawnWorker(holderWorker, { PROBE_ROOT: probeRoot });
  expect(await waitFor(join(probeRoot, "held"))).toBe(true);
  const expiry = spawnWorker(expiryWorker, { PROBE_ROOT: probeRoot });
  expect(await waitFor(join(probeRoot, "expiry-ready"))).toBe(true);
  const observer = StateStore.bootstrap(dbPath);
  await Bun.write(join(probeRoot, "expiry-go"), "1");
  let observed: Dict | undefined;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      observed = observer.getTask({ taskId: "avm-expire" });
      if (observed?.state === "closing") break;
      await Bun.sleep(10);
    }
  } finally {
    observer.close();
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
    const store = StateStore.bootstrap(root + "/state.sqlite3");
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
  const managedBun = lstatSync("/usr/bin/bun");
  expect(managedBun.isFile()).toBe(true);
  expect((managedBun.mode & 0o111) !== 0).toBe(true);
  for (const unit of UNIT_PATHS) {
    const content = readFileSync(unit, "utf8");
    expect(content).toContain("ExecStartPre=/bin/sh -c");
    expect(content).toContain("parent=$(dirname -- \"$path\")");
    expect(content).toContain("stat -c %%u -- \"$parent\"");
    expect(content).toContain("ExecStart=/usr/bin/bun ");
  }
  const processHandle = Bun.spawn(["systemd-analyze", "verify", ...UNIT_PATHS], { stdout: "pipe", stderr: "pipe" });
  const result = await collect(processHandle);
  if (result.exit !== 0) throw new Error(`systemd verify failed: ${JSON.stringify(result)}`);
  const unexpectedDiagnostics = result.stderr.split(/\r?\n/).filter(Boolean).filter((line) => !/^\/usr\/lib\/systemd\/system\/[^:]+:\d+: Support for option CPUAccounting= has been removed and it is ignored$/.test(line));
  if (unexpectedDiagnostics.length > 0) throw new Error(`systemd verify stderr: ${unexpectedDiagnostics.join("\n")}`);
});

linuxTest("the real Bun controller entrypoint accepts an isolated protected config override", async () => {
  const probeRoot = root("agent-vm-real-cli");
  const storage = join(probeRoot, "storage");
  const timerDir = join(probeRoot, "timer");
  for (const path of [storage, timerDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const statePath = join(storage, "state.sqlite3");
  StateStore.bootstrap(statePath).close();
  const configPath = join(probeRoot, "config.json");
  writeFileSync(configPath, JSON.stringify({
    project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64),
    network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19",
    port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250",
    gateway_ip: "198.51.100.1", storage_path: storage, state_db: statePath, timer_dir: timerDir,
  }), { mode: 0o600 });
  const env = { ...process.env, [CONFIG_PATH_ENV]: configPath };
  const stdinChild: any = Bun.spawn(["/usr/bin/bun", CONTROL_PATH], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await stdinChild.stdin.write(JSON.stringify({ protocol: 4, action: "drain-status" }) + "\n");
  stdinChild.stdin.end();
  const stdinResult = await collect(stdinChild);
  expect(stdinResult).toMatchObject({ exit: 0, stderr: "" });
  expect(lastJson(stdinResult.stdout)).toMatchObject({ ok: true, action: "drain-status", result: { draining: false } });

  const timerResult = await collect(Bun.spawn(["/usr/bin/bun", CONTROL_PATH, "--timer-age-gc"], { env, stdout: "pipe", stderr: "pipe" }));
  expect(timerResult).toMatchObject({ exit: 0, stderr: "" });
  expect(lastJson(timerResult.stdout)).toMatchObject({ ok: true, action: "timer-age-gc", result: { candidates: [] } });
});

transportTest("the current Python client reaches the Bun controller through isolated fake SSH", async () => {
  const probeRoot = root("agent-vm-client-transport");
  const storage = join(probeRoot, "storage");
  const timerDir = join(probeRoot, "timer");
  const fakeBin = join(probeRoot, "bin");
  const clientConfig = join(probeRoot, "client-config");
  const clientState = join(probeRoot, "client-state");
  for (const path of [storage, timerDir, fakeBin, clientConfig, clientState]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const statePath = join(storage, "state.sqlite3");
  StateStore.bootstrap(statePath).close();
  const configPath = join(probeRoot, "config.json");
  writeFileSync(configPath, JSON.stringify({ project: "agents", profile: "agent-vm", image_alias: "image", image_fingerprint: "a".repeat(64), network: "agentsbr0", network_acl: "agent-vm-isolation", pool: "agents", host_address: "198.51.100.19", port_start: 20000, port_end: 20030, vm_ip_start: "198.51.100.20", vm_ip_end: "198.51.100.250", gateway_ip: "198.51.100.1", storage_path: storage, state_db: statePath, timer_dir: timerDir, cpu_budget: 4, memory_budget_mib: 4096 }));
  const logPath = join(probeRoot, "ssh-args.log");
  const sshPath = join(fakeBin, "ssh");
  writeFileSync(sshPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_SSH_LOG"\nexec "$BUN_BIN" "$FAKE_CONTROLLER"\n`, { mode: 0o700 });
  const result = await collect(Bun.spawn(["python3", CLIENT_PATH, "admin", "drain", "status"], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, AGENT_VM_SESSION_ID: "transport-smoke", AGENT_VM_CONTROL_HOST: "isolated-control", AGENT_VM_REMOTE_CONTROL: "/opt/agent-vm-native/agent_vm_control.ts", XDG_CONFIG_HOME: clientConfig, XDG_STATE_HOME: clientState, CONTROL_PATH, [CONFIG_PATH_ENV]: configPath, BUN_BIN: process.execPath, FAKE_CONTROLLER: CONTROL_PATH, FAKE_SSH_LOG: logPath },
    stdout: "pipe",
    stderr: "pipe",
  }));
  if (result.exit !== 0) throw new Error(`transport failed: ${JSON.stringify(result)}`);
  if (result.stderr !== "") throw new Error(`transport stderr: ${result.stderr}`);
  expect(JSON.parse(result.stdout)).toMatchObject({ action: "drain-status", protocol: 4, outcome: "success", result: { draining: false } });
  expect(readFileSync(logPath, "utf8")).toContain("/usr/bin/bun /opt/agent-vm-native/agent_vm_control.ts");
  const invalid = Bun.spawn([process.execPath, CONTROL_PATH], { env: { ...process.env, [CONFIG_PATH_ENV]: configPath }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await invalid.stdin.write(JSON.stringify({ protocol: 4, action: "unknown", session_id: "transport-smoke" }) + "\n");
  invalid.stdin.end();
  const invalidResult = await collect(invalid);
  expect(invalidResult.exit).toBe(2);
  expect(invalidResult.stdout).toBe("");
  expect(JSON.parse(invalidResult.stderr)).toMatchObject({ ok: false, error: { code: "unknown_action" } });
});
