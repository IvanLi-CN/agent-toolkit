"""Git and filesystem behavior, with native network transports substituted."""

import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("sync_worktree", Path(__file__).parents[1] / "scripts/sync_worktree.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.git = self.root / "git"
        self.git.mkdir()
        subprocess.run(["git", "init", "-q", str(self.git)], check=True)
        self.workspace = self.root / "workspace/worktrees"
        self.real_run = MOD.run

    def remote(self, payload, *, exchange=True):
        code = MOD.REMOTE.replace('pathlib.Path("/workspace/worktrees")', 'pathlib.Path(' + repr(str(self.workspace)) + ')')
        output = io.StringIO()
        native_libc = ctypes.CDLL(None)
        class PlatformExchange:
            def renameat2(_, _a, old, _b, new, _flag):
                # macOS test host uses its native atomic swap; production guest uses renameat2.
                return native_libc.renamex_np(old, new, 2)
        library = native_libc if hasattr(native_libc, "renameat2") else PlatformExchange()
        if not exchange: library = object()
        try:
            with patch("sys.stdin", io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(output), patch("ctypes.CDLL", return_value=library):
                exec(compile(code, "guest-sync-action", "exec"), {})
            return json.loads(output.getvalue())
        except Exception as e:
            raise MOD.SyncFailure(str(e)) from e

    def request(self, action, tx="a" * 32, name="repo", **kw):
        return self.remote(dict(action=action, name=name, tx=tx, **kw))

    def test_stderr_redaction_covers_assignments_and_json_fields(self):
        jwt = b".".join((b"eyJhbGciOiJIUzI1NiJ9", b"eyJzdWIiOiJhZ2VudCJ9", b"jwt-signature"))
        value = MOD.redact_stderr(b'{"password":"secret-value", "private_key": "private-value"} secretValue=camel-secret-value tokenValue: camel-token-value token=token-value Authorization: Bearer auth-canary-01 Authorization: Basic dXNlcjpzZWNyZXQ= Cookie: sessionid=cookie-secret Set-Cookie: sessionid=set-cookie-secret Authorization: Digest response=digest-secret jwt=' + jwt)
        self.assertNotIn(b"secret-value", value)
        self.assertNotIn(b"private-value", value)
        self.assertNotIn(b"camel-secret-value", value)
        self.assertNotIn(b"camel-token-value", value)
        self.assertNotIn(b"token-value", value)
        self.assertNotIn(b"auth-canary-01", value)
        self.assertNotIn(b"dXNlcjpzZWNyZXQ=", value)
        for secret in (b"cookie-secret", b"set-cookie-secret", b"digest-secret", b"jwt-signature"):
            self.assertNotIn(secret, value)

    def test_child_diagnostics_are_redacted_before_bounding(self):
        result = MOD.run([sys.executable, "-c", "import sys; sys.stderr.write('Authorization: Bearer ' + 'x' * 20000)"], capture_output=True)
        self.assertLessEqual(len(result.stderr), MOD.DIAGNOSTIC_OUTPUT_LIMIT)
        self.assertNotIn(b"x" * 100, result.stderr)

    def test_unterminated_pem_is_redacted_before_bounding(self):
        value = b"-----BEGIN OPENSSH PRIVATE KEY-----\n" + (b"pem-canary-" * 2000)
        redacted = MOD.redact_and_bound_stderr(value)
        self.assertLessEqual(len(redacted), MOD.DIAGNOSTIC_OUTPUT_LIMIT)
        self.assertNotIn(b"pem-canary", redacted)

    def test_quoted_secret_redaction_handles_unterminated_and_escaped_quotes(self):
        values = [
            "password" + '="unterminated-secret-canary',
            "password" + r'="escaped\"-secret-canary',
            "token" + "='unterminated-token-canary",
            "token" + r"='escaped\'-token-canary",
            "password" + "=" + "\"terminal-secret-canary\\",
            "token" + "=" + "'terminal-token-canary\\",
            "password" + "=" + '"line-one-secret-canary\nline-two-secret-canary"',
            "token" + r'="escaped\"-multiline-token-canary',
        ]
        for value in values:
            self.assertNotIn("canary", MOD.redact_stderr(value.encode()).decode())

    def test_truncated_git_inventory_fails_closed(self):
        complete = MOD.subprocess.CompletedProcess([], 0, b"", b"")
        truncated = MOD.subprocess.CompletedProcess([], 0, b"tracked-without-nul", b"")
        with patch.object(MOD, "run", side_effect=[complete, truncated]):
            with self.assertRaisesRegex(MOD.SyncFailure, "truncated or malformed"):
                MOD.selected_files(self.git)

    def populate(self, tx, files):
        p = self.workspace / "repo" / (".agent-vm-src-stage." + tx)
        manifest = {}
        for name, data in files.items():
            f = p / name
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(data)
            manifest[name] = {"sha256": hashlib.sha256(data).hexdigest(), "mode": f.stat().st_mode & 0o7777}
        return manifest

    def test_git_special_names_ignore_deleted_and_symlink(self):
        for name in ("tracked", "deleted", "space name", "new\nline", "--option", "quote'`$"):
            (self.git / name).write_text(name)
        (self.git / ".gitignore").write_text("ignored\n")
        (self.git / "ignored").write_text("excluded")
        (self.git / "link").symlink_to("/outside/not-followed")
        subprocess.run(["git", "-C", str(self.git), "add", "--", "tracked", "deleted"], check=True)
        (self.git / "deleted").unlink()
        names, manifest = MOD.selected_files(self.git)
        self.assertNotIn(b"deleted", names)
        self.assertNotIn(b"ignored", names)
        self.assertNotIn(b".git", names)
        self.assertIn(b"new\nline", names)
        self.assertEqual(manifest["link"], {"link": "/outside/not-followed"})

    def test_submodule_rejected_before_transport(self):
        subprocess.run(["git", "-C", str(self.git), "update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",module"], check=True)
        with patch.object(MOD, "run", side_effect=self.real_run) as runner, patch("os.getcwd", return_value=str(self.git)):
            with self.assertRaisesRegex(MOD.SyncFailure, "submodules"):
                MOD.selected_files(self.git)
            self.assertEqual(len(runner.call_args_list), 1)

    def test_binary_transfer_without_python311_file_digest(self):
        data = bytes(range(256)) * 8193
        (self.git / "binary").write_bytes(data)
        with patch.object(hashlib, "file_digest", None, create=True):
            names, manifest = MOD.selected_files(self.git)
            self.assertEqual(names, [b"binary"])
            self.assertEqual(manifest["binary"]["sha256"], hashlib.sha256(data).hexdigest())
            self.request("begin")
            self.populate("a" * 32, {"binary": data})
            self.request("commit", manifest=manifest)
            self.request("finish")
        self.assertEqual((self.workspace / "repo/src/binary").read_bytes(), data)

    def test_source_parent_symlink_is_not_followed(self):
        p = self.git / "dir"
        p.mkdir(); (p / "file").write_text("original")
        subprocess.run(["git", "-C", str(self.git), "add", "dir/file"], check=True)
        shutil.rmtree(p)
        outside = self.root / "outside"; outside.mkdir(); (outside / "file").write_text("private")
        p.symlink_to(outside)
        with self.assertRaisesRegex(MOD.SyncFailure, "parent"):
            MOD.selected_files(self.git)

    def test_swap_removes_stale_source_and_preserves_adjacent_results(self):
        a, b = "a" * 32, "b" * 32
        self.request("begin", a)
        self.request("commit", a, manifest=self.populate(a, {"old": b"old"}))
        self.request("finish", a)
        result = self.workspace / "repo/results"
        result.mkdir(); (result / "keep").write_text("result")
        self.request("begin", b)
        self.request("commit", b, manifest=self.populate(b, {"new\nfile": b"new"}))
        self.request("finish", b)
        self.assertFalse((self.workspace / "repo/src/old").exists())
        self.assertEqual((self.workspace / "repo/src/new\nfile").read_bytes(), b"new")
        self.assertEqual((result / "keep").read_text(), "result")

    def test_unowned_source_and_parent_symlink_are_rejected(self):
        p = self.workspace / "repo/src"
        p.mkdir(parents=True)
        (p / "keep").write_text("not ours")
        with self.assertRaises(MOD.SyncFailure): self.request("begin")
        self.assertEqual((p / "keep").read_text(), "not ours")
        shutil.rmtree(self.workspace)
        self.workspace.mkdir(parents=True)
        outside = self.root / "outside"; outside.mkdir()
        (self.workspace / "repo").symlink_to(outside)
        with self.assertRaisesRegex(MOD.SyncFailure, "symlink"):
            self.request("begin")
        self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_stage_manifest_and_exchange_failure_preserve_old_source(self):
        a, b = "a" * 32, "b" * 32
        self.request("begin", a)
        self.request("commit", a, manifest=self.populate(a, {"original": b"data"}))
        self.request("finish", a)
        self.request("begin", b)
        manifest = self.populate(b, {"next": b"new"})
        with self.assertRaisesRegex(MOD.SyncFailure, "differ"):
            self.request("commit", b, manifest={})
        with self.assertRaisesRegex(MOD.SyncFailure, "unavailable"):
            self.remote(dict(action="commit", name="repo", tx=b, manifest=manifest), exchange=False)
        self.assertEqual((self.workspace / "repo/src/original").read_bytes(), b"data")
        self.request("abort", b)

    def test_concurrent_preparations_cannot_overwrite_new_commit(self):
        a, b = "a" * 32, "b" * 32
        self.request("begin", a); self.request("begin", b)
        self.request("commit", a, manifest=self.populate(a, {"winner": b"a"}))
        with self.assertRaisesRegex(MOD.SyncFailure, "changed"):
            self.request("commit", b, manifest=self.populate(b, {"loser": b"b"}))
        self.assertTrue((self.workspace / "repo/src/winner").exists())
        self.request("abort", b)

    def test_lost_ack_abort_retains_recovery_material(self):
        tx = "a" * 32
        self.request("begin", tx)
        self.request("commit", tx, manifest=self.populate(tx, {"file": b"ok"}))
        result = self.request("abort", tx)
        self.assertTrue(result["unverified"])
        self.assertTrue(Path(result["record"]).is_file())

    def local_run(self, argv, **kw):
        if argv[0] == "agent-vm":
            self.commands.append(argv)
            return subprocess.CompletedProcess(argv, 0, b"Host agent-vm\n  StrictHostKeyChecking yes\n", b"")
        if argv[0] == "rsync":
            self.config_seen = Path(argv[argv.index("-e") + 1].split()[2])
            self.assertEqual(self.config_seen.stat().st_mode & 0o777, 0o600)
            if self.fail_transfer: return subprocess.CompletedProcess(argv, 23)
            # The transport fixture selects exactly the NUL list, never shell-splits filenames.
            listing = Path(next(v.split("=", 1)[1] for v in argv if v.startswith("--files-from=")))
            dst = self.stage
            for raw in listing.read_bytes().split(b"\0"):
                if not raw: continue
                relative = os.fsdecode(raw)
                f = dst / relative; f.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.git / relative, f, follow_symlinks=False)
            return subprocess.CompletedProcess(argv, 0)
        return self.real_run(argv, **kw)

    def local_remote(self, ssh, config, payload):
        self.config_seen = config
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        try:
            result = self.remote(payload)
            if payload["action"] == "begin":
                self.stage = Path(result["stage"])
                result["stage"] = result["stage"].replace(str(self.workspace), "/workspace/worktrees")
            if payload["action"] == "commit" and self.lose_ack:
                return subprocess.CompletedProcess([], 255, b"", b"connection lost")
            return subprocess.CompletedProcess([], 0, json.dumps(result).encode(), b"")
        except MOD.SyncFailure as e:
            return subprocess.CompletedProcess([], 1, b"", str(e).encode())

    def run_local(self):
        previous = Path.cwd()
        os.chdir(self.git)
        self.addCleanup(os.chdir, previous)
        self.commands = []; self.fail_transfer = False; self.lose_ack = False
        return patch.multiple(MOD, run=self.local_run, remote=self.local_remote)

    def test_local_config_cleanup_no_lifecycle_and_exact_transfer_exit(self):
        (self.git / "file").write_text("data")
        with self.run_local():
            self.assertEqual(MOD.sync("repo"), 0)
            self.fail_transfer = True
            with self.assertRaises(MOD.SyncFailure) as failure: MOD.sync("repo")
            self.assertEqual(failure.exception.code, 23)
        self.assertFalse(self.config_seen.exists())
        self.assertEqual(self.commands, [["agent-vm", "ssh-info", "--format", "ssh-config"]] * 2)
        self.assertEqual((self.workspace / "repo/src/file").read_text(), "data")

    def test_explicit_session_identity_is_passed_to_ssh_info(self):
        (self.git / "file").write_text("data")
        with self.run_local():
            self.assertEqual(MOD.sync("repo", session_id="explicit"), 0)
        self.assertEqual(self.commands, [["agent-vm", "ssh-info", "--format", "ssh-config", "--session-id", "explicit"]])

    def test_local_lost_commit_ack_is_unverified_and_config_removed(self):
        (self.git / "file").write_text("data")
        with self.run_local():
            self.lose_ack = True
            with self.assertRaisesRegex(MOD.SyncFailure, "unverified") as failure: MOD.sync("repo")
            self.assertEqual(failure.exception.code, 75)
        self.assertFalse(self.config_seen.exists())
        self.assertTrue(list((self.workspace / "repo").glob(".agent-vm-sync-*.json")))
        self.assertEqual((self.workspace / "repo/src/file").read_text(), "data")

    def test_terminate_process_group_kills_descendant_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            child_pid = Path(directory) / "child.pid"
            child_code = "import pathlib, signal, sys, time; pathlib.Path(sys.argv[1]).write_text(str(__import__('os').getpid())); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
            wrapper_code = f"import signal, subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child_code!r}, sys.argv[1]]); signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); time.sleep(30)"
            process = MOD.subprocess.Popen([sys.executable, "-c", wrapper_code, str(child_pid)], start_new_session=True)
            deadline = MOD.time.monotonic() + 1.0
            while not child_pid.exists() and MOD.time.monotonic() < deadline:
                MOD.time.sleep(0.01)
            self.assertTrue(child_pid.exists())
            child = int(child_pid.read_text())
            MOD._terminate_process_group(process)
            deadline = MOD.time.monotonic() + 1.0
            while MOD.time.monotonic() < deadline:
                try:
                    MOD.os.kill(child, 0)
                except ProcessLookupError:
                    break
                MOD.time.sleep(0.01)
            else:
                self.fail("TERM-ignoring descendant survived leader-exit cleanup")

    def test_run_bounded_timeout_closes_stdin_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child_pid = root / "child.pid"
            driver = root / "driver.py"
            driver.write_text(
                "import importlib.util, pathlib, subprocess, sys\n"
                "module_path, pid_path = sys.argv[1:3]\n"
                "spec = importlib.util.spec_from_file_location('sync_worktree_probe', module_path)\n"
                "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n"
                "child_code = \"import pathlib, signal, sys, time; pathlib.Path(sys.argv[1]).write_text(str(__import__('os').getpid())); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)\"\n"
                "wrapper_code = f\"import signal, subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child_code!r}, sys.argv[1]]); signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); time.sleep(30)\"\n"
                "try:\n"
                "    module._run_bounded([sys.executable, '-c', wrapper_code, pid_path], input_data=b'x' * (4 * 1024 * 1024), timeout=0.1)\n"
                "except subprocess.TimeoutExpired:\n"
                "    raise SystemExit(0)\n"
                "raise SystemExit(9)\n",
                encoding="utf-8",
            )
            probe = MOD.subprocess.Popen([sys.executable, str(driver), str(MOD.__file__), str(child_pid)], start_new_session=True)
            try:
                result = probe.wait(timeout=3)
            except MOD.subprocess.TimeoutExpired:
                if child_pid.exists():
                    try:
                        MOD.os.kill(int(child_pid.read_text()), MOD.signal.SIGKILL)
                    except (ProcessLookupError, ValueError):
                        pass
                try:
                    MOD.os.killpg(probe.pid, MOD.signal.SIGKILL)
                except ProcessLookupError:
                    pass
                probe.wait(timeout=1)
                self.fail("_run_bounded retained a closed leader's stdin registration")
            self.assertEqual(result, 0)

    def test_main_redacts_unexpected_exception_text(self):
        with patch.object(MOD, "sync", side_effect=RuntimeError("password" + '="unexpected-secret"')):
            with patch.object(MOD.sys, "argv", ["sync_worktree", "--name", "repo"]), patch.object(MOD.sys, "stderr", new_callable=io.StringIO) as stderr:
                self.assertEqual(MOD.main(), 1)
        self.assertNotIn("unexpected-secret", stderr.getvalue())

    def test_invalid_name_fails_before_remote_and_missing_cli_preserves_exit(self):
        with patch.object(MOD, "run") as runner:
            with self.assertRaises(MOD.SyncFailure): MOD.sync("../escape")
            runner.assert_not_called()
        with self.run_local(), patch.object(MOD, "remote") as transport:
            original = self.local_run
            def missing(argv, **kw):
                if argv[0] == "agent-vm":
                    return subprocess.CompletedProcess(argv, 27, b"", b"")
                return original(argv, **kw)
            with patch.object(MOD, "run", side_effect=missing):
                with self.assertRaises(MOD.SyncFailure) as failure: MOD.sync("repo")
            self.assertEqual(failure.exception.code, 27)
            transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
