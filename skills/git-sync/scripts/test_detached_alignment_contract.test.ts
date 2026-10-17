import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

class AlignmentBlocked extends Error {}

function text(value: Uint8Array | undefined): string {
  return value === undefined ? "" : new TextDecoder().decode(value);
}

function run(cwd: string | undefined, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${text(result.stderr)}`);
  return text(result.stdout).trim();
}

function succeeds(cwd: string | undefined, ...args: string[]): boolean {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

function actionForRequest(
  action: string | undefined,
  headDetached: boolean,
  ownerBareMainlineRequest: boolean,
  callerProvidedBaseAndRemote: boolean,
): string {
  if (action !== undefined) return action;
  if (callerProvidedBaseAndRemote) return "rebase-base";
  if (ownerBareMainlineRequest && headDetached) return "align-detached-base";
  return "rebase-base";
}

function requireSupportedDetachedAction(repo: string, action: string): void {
  if (run(repo, "rev-parse", "--abbrev-ref", "HEAD") === "HEAD" && ["ff-topic-upstream", "rebase-base"].includes(action)) {
    throw new AlignmentBlocked(`${action} requires a checked-out topic branch`);
  }
}

function oldHeadIsRecoverable(repo: string, oldHead: string, targetSha: string): boolean {
  if (succeeds(repo, "merge-base", "--is-ancestor", oldHead, targetSha)) return true;
  if (run(repo, "for-each-ref", `--contains=${oldHead}`, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags")) return true;
  return succeeds(repo, "reflog", "exists", "HEAD") && run(repo, "reflog", "show", "--format=%H", "HEAD").split("\n").includes(oldHead);
}

interface AlignmentResult {
  oldHead: string;
  newHead: string;
  aheadBehindBefore: string;
  aheadBehindAfter: string;
  localBranchesBefore: string;
  localBranchesAfter: string;
  remoteConfigBefore: string;
  remoteConfigAfter: string;
}

function alignDetachedBase(repo: string, baseRef: string, remote: string): AlignmentResult {
  if (run(repo, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new AlignmentBlocked("align-detached-base requires a detached HEAD");
  if (run(repo, "status", "--porcelain")) throw new AlignmentBlocked("align-detached-base requires a clean worktree");
  const localBranchesBefore = run(repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  const remoteConfigBefore = run(repo, "remote", "-v");
  run(repo, "fetch", "--prune", remote);
  const oldHead = run(repo, "rev-parse", "HEAD");
  const targetSha = run(repo, "rev-parse", "--verify", `${baseRef}^{commit}`);
  if (!oldHeadIsRecoverable(repo, oldHead, targetSha)) throw new AlignmentBlocked("old detached HEAD is not recoverable without a backup ref");
  const aheadBehindBefore = run(repo, "rev-list", "--left-right", "--count", `${oldHead}...${targetSha}`);
  run(repo, "switch", "--detach", targetSha);
  if (run(repo, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error("alignment attached HEAD to a branch");
  if (run(repo, "status", "--porcelain")) throw new Error("alignment left the worktree dirty");
  const newHead = run(repo, "rev-parse", "HEAD");
  return {
    oldHead,
    newHead,
    aheadBehindBefore,
    aheadBehindAfter: run(repo, "rev-list", "--left-right", "--count", `${newHead}...${targetSha}`),
    localBranchesBefore,
    localBranchesAfter: run(repo, "for-each-ref", "--format=%(refname)", "refs/heads"),
    remoteConfigBefore,
    remoteConfigAfter: run(repo, "remote", "-v"),
  };
}

describe("detached alignment contract", () => {
  let temporaryDirectory: string;
  let origin: string;
  let seed: string;
  let clone: string;
  let oldHead: string;
  let newHead: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-toolkit-git-sync-"));
    origin = join(temporaryDirectory, "origin.git");
    seed = join(temporaryDirectory, "seed");
    clone = join(temporaryDirectory, "clone");
    run(undefined, "init", "--bare", origin);
    run(undefined, "init", "-b", "main", seed);
    run(seed, "config", "user.name", "Test User");
    run(seed, "config", "user.email", "test@example.com");
    await writeFile(join(seed, "tracked.txt"), "first\n");
    run(seed, "add", "tracked.txt");
    run(seed, "commit", "-m", "first");
    oldHead = run(seed, "rev-parse", "HEAD");
    run(seed, "remote", "add", "origin", origin);
    run(seed, "push", "-u", "origin", "main");
    await writeFile(join(seed, "tracked.txt"), "second\n");
    run(seed, "commit", "-am", "second");
    newHead = run(seed, "rev-parse", "HEAD");
    run(seed, "push", "origin", "main");
    run(undefined, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main");
    run(undefined, "clone", origin, clone);
    run(clone, "switch", "--detach", oldHead);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test("aligns a clean detached worktree without branch or remote changes", () => {
    const result = alignDetachedBase(clone, "origin/main", "origin");
    expect(result.oldHead).toBe(oldHead);
    expect(result.newHead).toBe(newHead);
    expect(result.aheadBehindBefore).toBe("0\t1");
    expect(result.aheadBehindAfter).toBe("0\t0");
    expect(result.localBranchesBefore).toBe(result.localBranchesAfter);
    expect(result.remoteConfigBefore).toBe(result.remoteConfigAfter);
    expect(run(clone, "branch", "--show-current")).toBe("");
    expect(run(clone, "for-each-ref", "refs/heads/backup")).toBe("");
  });

  test("is idempotent at the confirmed base", () => {
    alignDetachedBase(clone, "origin/main", "origin");
    const result = alignDetachedBase(clone, "origin/main", "origin");
    expect(result.oldHead).toBe(newHead);
    expect(result.newHead).toBe(newHead);
    expect(result.aheadBehindBefore).toBe("0\t0");
    expect(result.aheadBehindAfter).toBe("0\t0");
  });

  test("does not move a dirty detached worktree", async () => {
    await writeFile(join(clone, "local-only.txt"), "keep me\n");
    const beforeHead = run(clone, "rev-parse", "HEAD");
    const beforeBranches = run(clone, "for-each-ref", "--format=%(refname)", "refs/heads");
    const beforeRemoteConfig = run(clone, "remote", "-v");
    expect(() => alignDetachedBase(clone, "origin/main", "origin")).toThrow(/clean worktree/);
    expect(run(clone, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(run(clone, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(beforeBranches);
    expect(run(clone, "remote", "-v")).toBe(beforeRemoteConfig);
    expect(run(clone, "status", "--porcelain")).toContain("?? local-only.txt");
  });

  test("does not replace an unrecoverable diverged head", async () => {
    run(clone, "config", "user.name", "Test User");
    run(clone, "config", "user.email", "test@example.com");
    await writeFile(join(clone, "tracked.txt"), "diverged\n");
    run(clone, "commit", "-am", "diverged");
    const divergedHead = run(clone, "rev-parse", "HEAD");
    const headReflog = run(clone, "rev-parse", "--git-path", "logs/HEAD");
    await rm(resolve(clone, headReflog), { force: true });
    expect(succeeds(clone, "reflog", "exists", "HEAD")).toBe(false);
    expect(() => alignDetachedBase(clone, "origin/main", "origin")).toThrow(/not recoverable/);
    expect(run(clone, "rev-parse", "HEAD")).toBe(divergedHead);
  });

  test("uses the recorded head reflog for a diverged head", async () => {
    run(clone, "config", "user.name", "Test User");
    run(clone, "config", "user.email", "test@example.com");
    await writeFile(join(clone, "tracked.txt"), "diverged\n");
    run(clone, "commit", "-am", "diverged");
    const divergedHead = run(clone, "rev-parse", "HEAD");
    expect(oldHeadIsRecoverable(clone, divergedHead, newHead)).toBe(true);
    const result = alignDetachedBase(clone, "origin/main", "origin");
    expect(result.oldHead).toBe(divergedHead);
    expect(result.newHead).toBe(newHead);
    expect(run(clone, "branch", "--show-current")).toBe("");
  });

  test("preserves action selection and detached-head blockers", () => {
    expect(actionForRequest(undefined, true, true, false)).toBe("align-detached-base");
    expect(actionForRequest(undefined, true, false, true)).toBe("rebase-base");
    const beforeHead = run(clone, "rev-parse", "HEAD");
    for (const action of ["ff-topic-upstream", "rebase-base"]) {
      expect(() => requireSupportedDetachedAction(clone, action)).toThrow(/topic branch/);
      expect(run(clone, "rev-parse", "HEAD")).toBe(beforeHead);
    }
    expect(actionForRequest("ff-topic-upstream", true, true, false)).toBe("ff-topic-upstream");
    expect(actionForRequest("rebase-base", true, true, false)).toBe("rebase-base");
  });

  test("keeps the skill contract's attached-head rebase wording", async () => {
    const skillText = await readFile(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    expect(skillText).toContain("the owner made a bare mainline-sync request, the base was resolved unambiguously, and `HEAD` is attached to a topic branch");
  });
});
