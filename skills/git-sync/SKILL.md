---
name: git-sync
description: "Synchronize topic branches and align detached HEADs with confirmed git baselines."
---

# Git sync

Use this skill for pure local git synchronization: fetching remotes, aligning a detached `HEAD` to a confirmed base, fast-forwarding a topic branch to its verified upstream, rebasing a topic branch onto a confirmed base, and checking ahead/behind state.

This skill does not create PRs, merge PRs, clean worktrees, or change remote configuration. PR freshness and GitHub merge behavior remain owned by `$project-engineering-workflow`.

## Inputs

- `ACTION=fetch|check|align-detached-base|ff-topic-upstream|rebase-base`; default selection is described below.
- `BASE_REF`: confirmed target base ref, for example `origin/main`.
- `REMOTE`: remote to fetch. Required when `BASE_REF` points to a remote; otherwise default to `origin` when that remote exists, or the sole configured remote when exactly one remote exists.
- `ALLOW_REBASE`: explicit outer-flow authorization for history rewrite. Optional for the default Step 4 confirmed-base contract where the caller passes only `BASE_REF` and `REMOTE`.
- `ALLOW_FORCE_WITH_LEASE`: explicit outer-flow authorization for updating a published branch after rebase.

When a caller passes only `BASE_REF` and `REMOTE`, use the confirmed-base sync contract: fetch the remote, check divergence, and rebase the current topic branch onto the confirmed base. Treat that exact bare call shape as the active shared linear-history sync authorization. In `$project-engineering-workflow`, this same confirmed-base path may run once in Step 1 as a topic-branch freshness pre-sync and again in Step 4 as the canonical closeout recheck. Do not infer a different sync strategy from vague wording.

When the owner makes a bare mainline-sync request without `BASE_REF` / `REMOTE`, resolve a reliable default base locally instead of asking immediately. If `HEAD` is detached, select `align-detached-base`; otherwise preserve the old `rebase-base` behavior. Ask only when the base ref is ambiguous, no suitable remote/base exists, or the selected operation is blocked by its guardrails.

`ACTION=align-detached-base` is also available for an explicit owner request to align the current detached worktree to a confirmed `BASE_REF`. It is a direct checkout operation, not a rebase. An explicit `ACTION` always wins; the exact `BASE_REF` + `REMOTE` caller shape above remains `rebase-base` even when the caller happens to be detached.

## Guardrails

- Always fetch before comparing against remote refs.
- Never change remote URLs, push URLs, credential helpers, upstreams, or transport settings.
- Never push unless the owner or outer flow explicitly authorizes that exact remote update.
- Never run `reset --hard`.
- Rebase requires a safety backup ref.
- `align-detached-base` requires a detached `HEAD`, a clean worktree, a confirmed base, and a recoverable old commit. Do not stash changes, create a branch or backup ref, or turn the worktree into a branch.
- Detached `HEAD` is allowed for `ACTION=fetch|check|align-detached-base`; stop before `ff-topic-upstream` or `rebase-base`.
- If the owner or active flow forbids history rewrite or force-push, stop `rebase-base` instead of switching to a different strategy. This does not prohibit an explicitly selected direct detached alignment because it does not rewrite history.

## Workflow

### 1) Preflight

- `git rev-parse --show-toplevel`
- `git rev-parse --abbrev-ref HEAD`
- `git status --porcelain`

For `ACTION=align-detached-base`, require a detached `HEAD` and an empty `git status --porcelain`; otherwise stop before fetch, checkout, or any preservation action. For `ff-topic-upstream` and `rebase-base`, a detached `HEAD` remains a blocker. When an owner bare mainline-sync request omits `ACTION`, choose `align-detached-base` only after confirming that `HEAD` is detached; the `BASE_REF` + `REMOTE` caller shape remains `rebase-base`.

### 2) Resolve remote and base

For bare "sync mainline" requests:

1. Resolve `REMOTE`:
   - use provided `REMOTE` when present;
   - otherwise use `origin` when it exists;
   - otherwise use the sole configured remote when exactly one remote exists;
   - otherwise ask one key question.
2. Fetch before resolving remote-tracking refs:
   - `git fetch --prune <REMOTE>`
3. Resolve `BASE_REF`:
   - use provided `BASE_REF` when present;
   - otherwise use the remote default branch when it resolves:
     - `git symbolic-ref --quiet --short refs/remotes/<REMOTE>/HEAD`
   - otherwise probe common candidates:
     - `<REMOTE>/main`
     - `<REMOTE>/master`
     - `<REMOTE>/develop`
   - use a probed candidate only when exactly one exists.
   - if multiple plausible targets remain or none exists, ask which branch the PR/work should target.

Only treat the resolved base as confirmed when it came from an explicit input, a remote default branch, or a single unambiguous common candidate.

### 3) Fetch

- `git fetch --prune <REMOTE>`

If `REMOTE` is unknown and `BASE_REF` is remote-qualified, derive the remote from `BASE_REF`. Otherwise use the remote/base resolution step above.

### 4) Check divergence

- `git rev-list --left-right --count HEAD...<BASE_REF>`

Left count is local-only commits. Right count is base-only commits.

### 5) Fast-forward to topic upstream

Use this only when the upstream has been verified to represent the same topic branch head.

- `git pull --ff-only`

If fast-forward is impossible, stop and report the non-ff state.

### 6) Rebase onto confirmed base

Use this when `ACTION=rebase-base`, when the owner made a bare mainline-sync request, the base was resolved unambiguously, and `HEAD` is attached to a topic branch, or when `ACTION` is omitted and both `BASE_REF` and `REMOTE` are provided by a caller that already resolved the confirmed base. Rebase is authorized by `ALLOW_REBASE=yes`, by an active flow that grants linear-history sync, by an unambiguous bare mainline-sync request on an attached topic branch, or by the exact default Step 4 call shape that provides only `BASE_REF` and `REMOTE`.

1. If dirty, preserve local changes with:
   - `git stash push -u -m "wip: before git-sync rebase"`
2. Create backup:
   - `git branch "backup/<branch>-before-git-sync-<timestamp>"`
3. Rebase:
   - `git rebase <BASE_REF>`
4. If a stash was created, replay with `git stash apply`; drop it only after a clean replay.
5. If the branch is published, report that remote update requires `git push --force-with-lease`; run it only with explicit authorization.

### 7) Align detached `HEAD` to confirmed base

Use this only for `ACTION=align-detached-base`, or for an owner bare mainline-sync request that resolved this action because the current `HEAD` is detached. It must not be used as a fallback for blocked rebase or fast-forward requests.

1. Confirm again that `git rev-parse --abbrev-ref HEAD` prints `HEAD` and `git status --porcelain` is empty.
2. Fetch and resolve the confirmed base as above, then capture exact commits:
   - `OLD_HEAD=$(git rev-parse HEAD)`
   - `TARGET_SHA=$(git rev-parse --verify "<BASE_REF>^{commit}")`
3. Prove that `OLD_HEAD` will remain recoverable. It is sufficient for the target commit or an existing ref to contain it; otherwise the existing HEAD reflog must contain `OLD_HEAD`. If none of these conditions holds, stop before switching because the owner did not authorize a backup ref.
   - `git merge-base --is-ancestor "$OLD_HEAD" "$TARGET_SHA"`
   - `git for-each-ref --contains="$OLD_HEAD" --format='%(refname)' refs/heads refs/remotes refs/tags`
   - `git reflog exists HEAD && git reflog show --format='%H' HEAD | grep -Fx "$OLD_HEAD"`
4. Record ahead/behind before the move:
   - `git rev-list --left-right --count "$OLD_HEAD...$TARGET_SHA"`
5. Align without creating a branch:
   - `git switch --detach "$TARGET_SHA"`
6. Verify that `HEAD` is still detached, the worktree is clean, and record ahead/behind after the move. Report whether the recovery path was target ancestry, an existing ref, or the HEAD reflog.

## Output

Report:

- branch, or `HEAD (detached)` for direct alignment
- base ref and remote
- ahead/behind before and after
- old and new `HEAD` plus the recovery path for direct alignment; backup ref when a rebase created one
- whether a push is needed and whether it was authorized
