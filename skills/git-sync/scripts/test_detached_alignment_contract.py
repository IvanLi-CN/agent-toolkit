#!/usr/bin/env python3
"""Exercise the Git commands documented for detached baseline alignment."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path


class AlignmentBlocked(RuntimeError):
    pass


def run(cwd: Path | None, *args: str) -> str:
    command = ["git"]
    if cwd is not None:
        command.extend(["-C", str(cwd)])
    command.extend(args)
    completed = subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=True,
    )
    return completed.stdout.strip()


def succeeds(cwd: Path | None, *args: str) -> bool:
    command = ["git"]
    if cwd is not None:
        command.extend(["-C", str(cwd)])
    command.extend(args)
    return subprocess.run(command, text=True, capture_output=True, check=False).returncode == 0


def action_for_request(
    action: str | None,
    *,
    head_detached: bool,
    owner_bare_mainline_request: bool,
    caller_provided_base_and_remote: bool,
) -> str:
    if action is not None:
        return action
    if caller_provided_base_and_remote:
        return "rebase-base"
    if owner_bare_mainline_request and head_detached:
        return "align-detached-base"
    return "rebase-base"


def require_supported_detached_action(repo: Path, action: str) -> None:
    if run(repo, "rev-parse", "--abbrev-ref", "HEAD") == "HEAD" and action in {
        "ff-topic-upstream",
        "rebase-base",
    }:
        raise AlignmentBlocked(f"{action} requires a checked-out topic branch")


def old_head_is_recoverable(repo: Path, old_head: str, target_sha: str) -> bool:
    if succeeds(repo, "merge-base", "--is-ancestor", old_head, target_sha):
        return True
    if run(
        repo,
        "for-each-ref",
        f"--contains={old_head}",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ):
        return True
    return succeeds(repo, "reflog", "exists", "HEAD") and old_head in run(
        repo,
        "reflog",
        "show",
        "--format=%H",
        "HEAD",
    ).splitlines()


@dataclass(frozen=True)
class AlignmentResult:
    old_head: str
    new_head: str
    ahead_behind_before: str
    ahead_behind_after: str
    local_branches_before: str
    local_branches_after: str
    remote_config_before: str
    remote_config_after: str


def align_detached_base(repo: Path, base_ref: str, remote: str) -> AlignmentResult:
    if run(repo, "rev-parse", "--abbrev-ref", "HEAD") != "HEAD":
        raise AlignmentBlocked("align-detached-base requires a detached HEAD")
    if run(repo, "status", "--porcelain"):
        raise AlignmentBlocked("align-detached-base requires a clean worktree")

    local_branches_before = run(repo, "for-each-ref", "--format=%(refname)", "refs/heads")
    remote_config_before = run(repo, "remote", "-v")
    run(repo, "fetch", "--prune", remote)

    old_head = run(repo, "rev-parse", "HEAD")
    target_sha = run(repo, "rev-parse", "--verify", f"{base_ref}^{{commit}}")
    if not old_head_is_recoverable(repo, old_head, target_sha):
        raise AlignmentBlocked("old detached HEAD is not recoverable without a backup ref")
    ahead_behind_before = run(repo, "rev-list", "--left-right", "--count", f"{old_head}...{target_sha}")
    run(repo, "switch", "--detach", target_sha)

    if run(repo, "rev-parse", "--abbrev-ref", "HEAD") != "HEAD":
        raise AssertionError("alignment attached HEAD to a branch")
    if run(repo, "status", "--porcelain"):
        raise AssertionError("alignment left the worktree dirty")

    new_head = run(repo, "rev-parse", "HEAD")
    return AlignmentResult(
        old_head=old_head,
        new_head=new_head,
        ahead_behind_before=ahead_behind_before,
        ahead_behind_after=run(repo, "rev-list", "--left-right", "--count", f"{new_head}...{target_sha}"),
        local_branches_before=local_branches_before,
        local_branches_after=run(repo, "for-each-ref", "--format=%(refname)", "refs/heads"),
        remote_config_before=remote_config_before,
        remote_config_after=run(repo, "remote", "-v"),
    )


class DetachedAlignmentContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.origin = self.root / "origin.git"
        self.seed = self.root / "seed"
        self.clone = self.root / "clone"

        run(None, "init", "--bare", str(self.origin))
        run(None, "init", "-b", "main", str(self.seed))
        run(self.seed, "config", "user.name", "Test User")
        run(self.seed, "config", "user.email", "test@example.com")

        (self.seed / "tracked.txt").write_text("first\n", encoding="utf-8")
        run(self.seed, "add", "tracked.txt")
        run(self.seed, "commit", "-m", "first")
        self.old_head = run(self.seed, "rev-parse", "HEAD")
        run(self.seed, "remote", "add", "origin", str(self.origin))
        run(self.seed, "push", "-u", "origin", "main")

        (self.seed / "tracked.txt").write_text("second\n", encoding="utf-8")
        run(self.seed, "commit", "-am", "second")
        self.new_head = run(self.seed, "rev-parse", "HEAD")
        run(self.seed, "push", "origin", "main")
        run(None, "--git-dir", str(self.origin), "symbolic-ref", "HEAD", "refs/heads/main")

        run(None, "clone", str(self.origin), str(self.clone))
        run(self.clone, "switch", "--detach", self.old_head)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_clean_detached_worktree_aligns_without_branch_or_remote_changes(self) -> None:
        result = align_detached_base(self.clone, "origin/main", "origin")

        self.assertEqual(result.old_head, self.old_head)
        self.assertEqual(result.new_head, self.new_head)
        self.assertEqual(result.ahead_behind_before, "0\t1")
        self.assertEqual(result.ahead_behind_after, "0\t0")
        self.assertEqual(result.local_branches_before, result.local_branches_after)
        self.assertEqual(result.remote_config_before, result.remote_config_after)
        self.assertEqual(run(self.clone, "branch", "--show-current"), "")
        self.assertEqual(run(self.clone, "for-each-ref", "refs/heads/backup"), "")

    def test_alignment_is_idempotent_at_the_confirmed_base(self) -> None:
        align_detached_base(self.clone, "origin/main", "origin")
        result = align_detached_base(self.clone, "origin/main", "origin")

        self.assertEqual(result.old_head, self.new_head)
        self.assertEqual(result.new_head, self.new_head)
        self.assertEqual(result.ahead_behind_before, "0\t0")
        self.assertEqual(result.ahead_behind_after, "0\t0")

    def test_dirty_detached_worktree_does_not_move_head(self) -> None:
        (self.clone / "local-only.txt").write_text("keep me\n", encoding="utf-8")
        before_head = run(self.clone, "rev-parse", "HEAD")
        before_branches = run(self.clone, "for-each-ref", "--format=%(refname)", "refs/heads")
        before_remote_config = run(self.clone, "remote", "-v")

        with self.assertRaisesRegex(AlignmentBlocked, "clean worktree"):
            align_detached_base(self.clone, "origin/main", "origin")

        self.assertEqual(run(self.clone, "rev-parse", "HEAD"), before_head)
        self.assertEqual(run(self.clone, "for-each-ref", "--format=%(refname)", "refs/heads"), before_branches)
        self.assertEqual(run(self.clone, "remote", "-v"), before_remote_config)
        self.assertIn("?? local-only.txt", run(self.clone, "status", "--porcelain"))

    def test_unrecoverable_diverged_head_is_not_replaced(self) -> None:
        run(self.clone, "config", "user.name", "Test User")
        run(self.clone, "config", "user.email", "test@example.com")
        (self.clone / "tracked.txt").write_text("diverged\n", encoding="utf-8")
        run(self.clone, "commit", "-am", "diverged")
        diverged_head = run(self.clone, "rev-parse", "HEAD")
        head_reflog = Path(run(self.clone, "rev-parse", "--git-path", "logs/HEAD"))
        if not head_reflog.is_absolute():
            head_reflog = self.clone / head_reflog
        head_reflog.unlink()

        self.assertFalse(succeeds(self.clone, "reflog", "exists", "HEAD"))
        with self.assertRaisesRegex(AlignmentBlocked, "not recoverable"):
            align_detached_base(self.clone, "origin/main", "origin")

        self.assertEqual(run(self.clone, "rev-parse", "HEAD"), diverged_head)

    def test_diverged_head_uses_its_recorded_head_reflog(self) -> None:
        run(self.clone, "config", "user.name", "Test User")
        run(self.clone, "config", "user.email", "test@example.com")
        (self.clone / "tracked.txt").write_text("diverged\n", encoding="utf-8")
        run(self.clone, "commit", "-am", "diverged")
        diverged_head = run(self.clone, "rev-parse", "HEAD")

        self.assertTrue(old_head_is_recoverable(self.clone, diverged_head, self.new_head))
        result = align_detached_base(self.clone, "origin/main", "origin")

        self.assertEqual(result.old_head, diverged_head)
        self.assertEqual(result.new_head, self.new_head)
        self.assertEqual(run(self.clone, "branch", "--show-current"), "")

    def test_action_selection_preserves_rebase_and_fast_forward_blockers(self) -> None:
        self.assertEqual(
            action_for_request(
                None,
                head_detached=True,
                owner_bare_mainline_request=True,
                caller_provided_base_and_remote=False,
            ),
            "align-detached-base",
        )
        self.assertEqual(
            action_for_request(
                None,
                head_detached=True,
                owner_bare_mainline_request=False,
                caller_provided_base_and_remote=True,
            ),
            "rebase-base",
        )
        before_head = run(self.clone, "rev-parse", "HEAD")
        for action in ("ff-topic-upstream", "rebase-base"):
            with self.assertRaisesRegex(AlignmentBlocked, "topic branch"):
                require_supported_detached_action(self.clone, action)
            self.assertEqual(run(self.clone, "rev-parse", "HEAD"), before_head)
        self.assertEqual(
            action_for_request(
                "ff-topic-upstream",
                head_detached=True,
                owner_bare_mainline_request=True,
                caller_provided_base_and_remote=False,
            ),
            "ff-topic-upstream",
        )
        self.assertEqual(
            action_for_request(
                "rebase-base",
                head_detached=True,
                owner_bare_mainline_request=True,
                caller_provided_base_and_remote=False,
            ),
            "rebase-base",
        )

    def test_skill_contract_limits_bare_rebase_to_attached_heads(self) -> None:
        skill_text = (Path(__file__).resolve().parent.parent / "SKILL.md").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "the owner made a bare mainline-sync request, the base was resolved "
            "unambiguously, and `HEAD` is attached to a topic branch",
            skill_text,
        )


if __name__ == "__main__":
    unittest.main()
