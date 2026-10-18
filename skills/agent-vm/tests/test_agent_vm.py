"""Offline tests for the generic agent-vm session contract."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("agent_vm_client", ROOT / "skills/agent-vm/scripts/agent_vm.py")
assert SPEC and SPEC.loader
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)


class SessionContractTests(unittest.TestCase):
    def test_session_option_is_accepted_before_or_after_command(self):
        before = CLI.build_parser().parse_args(["--session-id", "before", "status"])
        after = CLI.build_parser().parse_args(["status", "--session-id", "after"])
        nested = CLI.build_parser().parse_args(["admin", "status", "--session-id", "nested"])
        self.assertEqual(before.session_id, "before")
        self.assertEqual(after.session_id, "after")
        self.assertEqual(nested.session_id, "nested")

    def test_explicit_session_overrides_environment(self):
        with mock.patch.dict(CLI.os.environ, {"AGENT_VM_SESSION_ID": "environment"}):
            self.assertEqual(CLI.session_id("explicit"), "explicit")

    def test_environment_is_fallback(self):
        with mock.patch.dict(CLI.os.environ, {"AGENT_VM_SESSION_ID": "environment"}):
            self.assertEqual(CLI.session_id(), "environment")

    def test_missing_session_fails_before_remote_write(self):
        with mock.patch.dict(CLI.os.environ, {}, clear=True), mock.patch.object(CLI, "run_child") as run:
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("acquire", session=None, write=True)
        self.assertEqual(error.exception.code, "missing_session")
        run.assert_not_called()

    def test_session_state_namespace_is_derived_from_selected_identity(self):
        self.assertNotEqual(CLI.local_session_dir("first"), CLI.local_session_dir("second"))
        self.assertIn("agent-vm", str(CLI.local_session_dir("first")))

    def test_sync_passes_selected_identity_to_helper(self):
        args = CLI.build_parser().parse_args(["sync", "--name", "repo", "--session-id", "explicit"])
        with mock.patch.object(CLI, "run_command", return_value=0) as run_command:
            self.assertEqual(CLI.command_sync(args), 0)
        command = run_command.call_args.args[0]
        self.assertEqual(command[-2:], ["--session-id", "explicit"])

    def test_control_uses_bun_for_the_remote_controller(self):
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "result": {}}
        process = CLI.subprocess.CompletedProcess([], 0, CLI.json.dumps(response).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process) as run:
            CLI.control_request("status", session="thread")
        remote = run.call_args.args[0][-1]
        self.assertEqual(remote, "bun /opt/agent-vm-native/agent_vm_control.ts")

    def test_remote_stderr_is_redacted_before_cli_output(self):
        response = CLI.subprocess.CompletedProcess([], 2, b"", b'{"password":"secret-value"} bearer super-token Authorization: Bearer auth-canary-01 "Authorization": "Bearer quoted-auth-01"\n')
        stderr = io.BytesIO()
        stream = mock.Mock()
        stream.buffer = stderr
        stream.flush = mock.Mock()
        with mock.patch.object(CLI, "run_child", return_value=response), mock.patch.object(CLI.sys, "stderr", stream):
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("status", session="thread")
        self.assertNotIn(b"secret-value", stderr.getvalue())
        self.assertNotIn(b"super-token", stderr.getvalue())
        self.assertNotIn(b"auth-canary-01", stderr.getvalue())
        self.assertNotIn(b"quoted-auth-01", stderr.getvalue())
        self.assertNotIn("secret-value", str(error.exception.as_dict()))

    def test_guest_command_stderr_is_redacted_before_cli_output(self):
        response = CLI.subprocess.CompletedProcess([], 1, b"", b'token=secret-value {"private_key":"private-value"} Authorization: Bearer guest-auth-01\n')
        stderr = io.BytesIO()
        stream = mock.Mock()
        stream.buffer = stderr
        stream.flush = mock.Mock()
        with mock.patch.object(CLI, "run_child", return_value=response), mock.patch.object(CLI.sys, "stderr", stream):
            self.assertEqual(CLI.run_command(["ssh", "agent-vm"]), 1)
        self.assertNotIn(b"secret-value", stderr.getvalue())
        self.assertNotIn(b"private-value", stderr.getvalue())
        self.assertNotIn(b"guest-auth-01", stderr.getvalue())

    def test_same_operation_journal_creation_is_idempotent_across_threads(self):
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "acquire", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "operation_id": "same-operation", "result": {}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", return_value=process):
                def request():
                    return CLI.control_request("acquire", session="thread", generation=0, write=True, operation_id="same-operation", fields={"public_key": "ssh-ed25519 fixture"})

                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(lambda _: request(), range(2)))
                self.assertEqual(len(results), 2)
                journal = CLI.operation_journal_path("thread", "same-operation")
                self.assertEqual(json.loads(journal.read_text())["request"]["operation_id"], "same-operation")

    def test_malformed_operation_journal_returns_structured_error(self):
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child") as run:
                journal = CLI.operation_journal_path("thread", "broken-operation")
                journal.parent.mkdir(parents=True)
                journal.write_text("{not-json", encoding="utf-8")
                with self.assertRaises(CLI.CliError) as error:
                    CLI.control_request("acquire", session="thread", generation=0, write=True, operation_id="broken-operation", fields={"public_key": "ssh-ed25519 fixture"})
                self.assertEqual(error.exception.code, "local_journal_invalid")
                run.assert_not_called()

    def test_child_diagnostics_are_bounded_before_redaction(self):
        process = CLI.run_child([CLI.sys.executable, "-c", "import sys; sys.stderr.write('Authorization: Bearer ' + 'x' * 20000)"], capture_stdout=True)
        self.assertLessEqual(len(process.stderr), CLI.DIAGNOSTIC_OUTPUT_LIMIT)
        self.assertIn(CLI.DIAGNOSTIC_TRUNCATION_MARKER, process.stderr)


if __name__ == "__main__":
    unittest.main()
