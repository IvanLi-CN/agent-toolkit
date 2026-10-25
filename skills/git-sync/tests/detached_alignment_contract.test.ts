/** Test-only execution of documented commands. This is not a production Git CLI. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

class AlignmentBlocked extends Error {}
let root: string, origin: string, seed: string, clone: string, oldHead: string, newHead: string;
function git(cwd: string | null, ...args: string[]) {
  return Bun.spawnSync(["git", ...(cwd ? ["-C", cwd] : []), ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0" } });
}
function run(cwd: string | null, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.exitCode) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}
function succeeds(cwd: string, ...args: string[]) { return git(cwd, ...args).exitCode === 0; }
function actionForRequest(action: string | null, detached: boolean, bareMainline: boolean, callerBaseRemote: boolean): string {
  if (action) return action;
  if (callerBaseRemote) return "rebase-base";
  return bareMainline && detached ? "align-detached-base" : "rebase-base";
}
function requireAction(repo: string, action: string) {
  if (run(repo, "rev-parse", "--abbrev-ref", "HEAD") === "HEAD" && ["ff-topic-upstream", "rebase-base"].includes(action)) throw new AlignmentBlocked(`${action} requires a checked-out topic branch`);
}
function recoverable(repo: string, old: string, target: string): boolean {
  return succeeds(repo, "merge-base", "--is-ancestor", old, target) || !!run(repo, "for-each-ref", `--contains=${old}`, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags") || (succeeds(repo, "reflog", "exists", "HEAD") && run(repo, "reflog", "show", "--format=%H", "HEAD").split("\n").includes(old));
}
function snapshot(repo: string) {
  return { head: run(repo, "rev-parse", "HEAD"), branches: run(repo, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), config: run(repo, "config", "--local", "--list"), remotes: run(repo, "remote", "-v") };
}
function align(repo: string, base: string, remote: string) {
  if (run(repo, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new AlignmentBlocked("requires a detached HEAD");
  if (run(repo, "status", "--porcelain")) throw new AlignmentBlocked("requires a clean worktree");
  const before = snapshot(repo);
  run(repo, "fetch", "--prune", remote);
  const target = run(repo, "rev-parse", "--verify", `${base}^{commit}`);
  if (!recoverable(repo, before.head, target)) throw new AlignmentBlocked("old detached HEAD is not recoverable without a backup ref");
  const aheadBehindBefore = run(repo, "rev-list", "--left-right", "--count", `${before.head}...${target}`);
  run(repo, "switch", "--detach", target);
  expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  expect(run(repo, "status", "--porcelain")).toBe("");
  return { before, after: snapshot(repo), aheadBehindBefore, aheadBehindAfter: run(repo, "rev-list", "--left-right", "--count", `HEAD...${target}`) };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-alignment-"));
  writeFileSync(join(root, "gitconfig"), "");
  origin = join(root, "origin.git"); seed = join(root, "seed"); clone = join(root, "clone");
  run(null, "init", "--bare", origin); run(null, "init", "-b", "main", seed);
  run(seed, "config", "user.name", "Test User"); run(seed, "config", "user.email", "test@example.com");
  writeFileSync(join(seed, "tracked.txt"), "first\n"); run(seed, "add", "tracked.txt"); run(seed, "commit", "-m", "first");
  oldHead = run(seed, "rev-parse", "HEAD");
  run(seed, "remote", "add", "origin", origin); run(seed, "push", "-u", "origin", "main");
  writeFileSync(join(seed, "tracked.txt"), "second\n"); run(seed, "commit", "-am", "second"); newHead = run(seed, "rev-parse", "HEAD");
  run(seed, "push", "origin", "main"); run(null, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main");
  run(null, "clone", origin, clone); run(clone, "switch", "--detach", oldHead);
  run(clone, "config", "user.name", "Test User"); run(clone, "config", "user.email", "test@example.com");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
describe("VER-FOUNDATION-HELPERS-05: isolated native Git", () => {
  test("clean detached alignment preserves all branches and remote/upstream config", () => {
    const result = align(clone, "origin/main", "origin");
    expect(result.before.head).toBe(oldHead); expect(result.after.head).toBe(newHead);
    expect(result.aheadBehindBefore).toBe("0\t1"); expect(result.aheadBehindAfter).toBe("0\t0");
    expect(result.after.branches).toBe(result.before.branches); expect(result.after.remotes).toBe(result.before.remotes); expect(result.after.config).toBe(result.before.config);
    expect(run(clone, "branch", "--show-current")).toBe(""); expect(run(clone, "for-each-ref", "refs/heads/backup")).toBe("");
  });
  test("alignment is idempotent", () => {
    align(clone, "origin/main", "origin");
    const result = align(clone, "origin/main", "origin");
    expect(result.before).toEqual(result.after); expect(result.aheadBehindBefore).toBe("0\t0");
  });
  test("dirty detached worktree retains untracked and tracked changes", () => {
    writeFileSync(join(clone, "local-only.txt"), "keep me\n"); writeFileSync(join(clone, "tracked.txt"), "keep this too\n");
    const before = snapshot(clone);
    expect(() => align(clone, "origin/main", "origin")).toThrow("clean worktree");
    expect(snapshot(clone)).toEqual(before);
    expect(readFileSync(join(clone, "tracked.txt"), "utf8")).toBe("keep this too\n");
    expect(run(clone, "status", "--porcelain")).toContain("?? local-only.txt");
  });
  test("attached HEAD and detached topic actions stay blocked", () => {
    const before = snapshot(clone);
    for (const action of ["ff-topic-upstream", "rebase-base"]) expect(() => requireAction(clone, action)).toThrow("topic branch");
    expect(snapshot(clone)).toEqual(before);
    run(clone, "switch", "main");
    expect(() => align(clone, "origin/main", "origin")).toThrow("detached HEAD");
  });
  test("unrecoverable diverged HEAD is not replaced", () => {
    writeFileSync(join(clone, "tracked.txt"), "diverged\n"); run(clone, "commit", "-am", "diverged");
    const before = snapshot(clone), log = run(clone, "rev-parse", "--git-path", "logs/HEAD");
    unlinkSync(isAbsolute(log) ? log : join(clone, log));
    expect(succeeds(clone, "reflog", "exists", "HEAD")).toBe(false);
    expect(() => align(clone, "origin/main", "origin")).toThrow("not recoverable"); expect(snapshot(clone)).toEqual(before);
  });
  test("diverged HEAD remains recoverable from its recorded reflog", () => {
    writeFileSync(join(clone, "tracked.txt"), "diverged\n"); run(clone, "commit", "-am", "diverged");
    const old = run(clone, "rev-parse", "HEAD");
    expect(recoverable(clone, old, newHead)).toBe(true);
    const result = align(clone, "origin/main", "origin");
    expect(result.before.head).toBe(old); expect(result.after.head).toBe(newHead);
    expect(run(clone, "reflog", "show", "--format=%H", "HEAD")).toContain(old);
  });
  test("existing tag protects diverged commit when reflog is absent", () => {
    writeFileSync(join(clone, "tracked.txt"), "diverged\n"); run(clone, "commit", "-am", "diverged"); run(clone, "tag", "preserve-old");
    const old = run(clone, "rev-parse", "HEAD"), log = run(clone, "rev-parse", "--git-path", "logs/HEAD"); unlinkSync(join(clone, log));
    align(clone, "origin/main", "origin"); expect(run(clone, "rev-parse", "preserve-old")).toBe(old);
  });
  test("invalid base fails without moving HEAD or changing configuration", () => {
    const before = snapshot(clone); expect(() => align(clone, "origin/missing", "origin")).toThrow(); expect(snapshot(clone)).toEqual(before);
  });
  test("explicit actions win and caller base+remote retains rebase semantics", () => {
    expect(actionForRequest(null, true, true, false)).toBe("align-detached-base");
    expect(actionForRequest(null, true, false, true)).toBe("rebase-base"); expect(actionForRequest(null, false, true, false)).toBe("rebase-base");
    for (const action of ["ff-topic-upstream", "rebase-base"]) expect(actionForRequest(action, true, true, false)).toBe(action);
    expect(readFileSync(new URL("../SKILL.md", import.meta.url), "utf8")).toContain("the owner made a bare mainline-sync request, the base was resolved unambiguously, and `HEAD` is attached to a topic branch");
  });
});
