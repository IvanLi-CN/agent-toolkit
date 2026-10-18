"""Offline tests for the generic agent-vm session contract."""
from __future__ import annotations

import importlib.util
import io
from pathlib import Path
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
        with mock.patch.dict(CLI.os.environ, {}, clear=True), mock.patch.object(CLI.subprocess, "run") as run:
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
        with mock.patch.object(CLI.subprocess, "run", return_value=process) as run:
            CLI.control_request("status", session="thread")
        remote = run.call_args.args[0][-1]
        self.assertEqual(remote, "bun /opt/agent-vm-native/agent_vm_control.ts")

    def test_remote_stderr_is_redacted_before_cli_output(self):
        response = CLI.subprocess.CompletedProcess([], 2, b"", b'{"password":"secret-value"} bearer super-token\n')
        stderr = io.BytesIO()
        stream = mock.Mock()
        stream.buffer = stderr
        stream.flush = mock.Mock()
        with mock.patch.object(CLI.subprocess, "run", return_value=response), mock.patch.object(CLI.sys, "stderr", stream):
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("status", session="thread")
        self.assertNotIn(b"secret-value", stderr.getvalue())
        self.assertNotIn(b"super-token", stderr.getvalue())
        self.assertNotIn("secret-value", str(error.exception.as_dict()))

    def test_guest_command_stderr_is_redacted_before_cli_output(self):
        response = CLI.subprocess.CompletedProcess([], 1, b"", b'token=secret-value {"private_key":"private-value"}\n')
        stderr = io.BytesIO()
        stream = mock.Mock()
        stream.buffer = stderr
        stream.flush = mock.Mock()
        with mock.patch.object(CLI.subprocess, "run", return_value=response), mock.patch.object(CLI.sys, "stderr", stream):
            self.assertEqual(CLI.run_command(["ssh", "agent-vm"]), 1)
        self.assertNotIn(b"secret-value", stderr.getvalue())
        self.assertNotIn(b"private-value", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
