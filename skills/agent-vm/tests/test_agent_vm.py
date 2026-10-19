"""Offline tests for the generic agent-vm session contract."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
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
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 1, "operation_id": None, "outcome": "success", "result": {"generation": 1}}
        process = CLI.subprocess.CompletedProcess([], 0, CLI.json.dumps(response).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process) as run:
            CLI.control_request("status", session="thread")
        remote = run.call_args.args[0][-1]
        self.assertEqual(remote, "/usr/bin/bun /opt/agent-vm-native/agent_vm_control.ts")

    def test_remote_stderr_is_redacted_before_cli_output(self):
        response = CLI.subprocess.CompletedProcess([], 2, b"", b'{"password":"secret-value"} bearer super-token Authorization: Bearer auth-canary-01 Authorization: Bearer "quoted-auth-canary" "Authorization": "Bearer quoted-auth-01"\n')
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
        self.assertNotIn(b"quoted-auth-canary", stderr.getvalue())
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
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "acquire", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 0, "operation_id": "same-operation", "outcome": "success", "result": {}}
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

    def test_operation_journal_read_rejects_a_symlink_swap_after_path_validation(self):
        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as outside:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)):
                request = {"session_id": "thread", "generation": 7, "operation_id": "swap-operation"}
                directory = CLI._secure_directory(CLI._secure_session_directory("thread") / "operations")
                CLI.ensure_operation_journal(directory, request)
                journal = CLI.operation_journal_path("thread", "swap-operation")
                attacker = Path(outside) / "attacker.json"
                attacker.write_text(json.dumps({"request": {"generation": 99}}), encoding="utf-8")

                original_secure_file = CLI._secure_file

                def swap_after_validation(path, *, code="local_state_invalid"):
                    result = original_secure_file(path, code=code)
                    if path == journal:
                        path.unlink()
                        path.symlink_to(attacker)
                    return result

                with mock.patch.object(CLI, "_secure_file", side_effect=swap_after_validation):
                    with self.assertRaises(CLI.CliError) as error:
                        CLI.journal_generation("thread", "swap-operation", 0)
                self.assertEqual(error.exception.code, "local_journal_invalid")

    def test_child_diagnostics_are_redacted_before_bounding(self):
        process = CLI.run_child([CLI.sys.executable, "-c", "import sys; sys.stderr.write('Authorization: Bearer ' + 'x' * 20000)"], capture_stdout=True)
        self.assertLessEqual(len(process.stderr), CLI.DIAGNOSTIC_OUTPUT_LIMIT)
        self.assertNotIn(b"x" * 100, process.stderr)

    def test_admin_drain_mutations_expose_a_reusable_operation_id(self):
        args = CLI.build_parser().parse_args(["admin", "drain", "enter", "--session-id", "thread", "--operation-id", "drain-op"])
        self.assertEqual(args.operation_id, "drain-op")

    def test_non_acquire_retry_without_state_uses_remote_generation(self):
        status = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": None, "outcome": "success", "result": {"generation": 7}}
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "release", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": "release-op", "outcome": "success", "result": {}}
        processes = [CLI.subprocess.CompletedProcess([], 0, json.dumps(item).encode(), b"") for item in (status, response)]
        args = CLI.build_parser().parse_args(["release", "--session-id", "thread", "--operation-id", "release-op"])
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", side_effect=processes) as run:
                CLI.mutation("release", args)
        request = json.loads(run.call_args_list[-1].kwargs["input_data"])
        self.assertEqual(request["generation"], 7)

    def test_port_mutation_retries_use_journal_or_remote_generation_without_local_state(self):
        for port_command, action, operation, fields in (
            ("add", "port-add", "port-add-op", {"name": "web", "vm_port": 8080, "port_protocol": "tcp"}),
            ("remove", "port-remove", "port-remove-op", {"name": "web", "port_protocol": "tcp"}),
        ):
            response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": action, "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": operation, "outcome": "success", "result": {}}
            process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
            args = CLI.build_parser().parse_args(["port", port_command, *(["web", "--guest-port", "8080"] if port_command == "add" else ["web"]), "--session-id", "thread", "--operation-id", operation])
            with tempfile.TemporaryDirectory() as state:
                with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", return_value=process) as run, mock.patch.object(CLI, "json_output"):
                    journal_dir = CLI._secure_directory(CLI._secure_session_directory("thread") / "operations")
                    CLI.ensure_operation_journal(journal_dir, {"protocol": CLI.PROTOCOL_VERSION, "action": action, "session_id": "thread", "generation": 7, "operation_id": operation, **fields})
                    self.assertEqual(CLI.command_port(args), 0)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(json.loads(run.call_args.kwargs["input_data"])["generation"], 7)

        status = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": None, "outcome": "success", "result": {"generation": 7}}
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "port-add", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": "port-fallback-op", "outcome": "success", "result": {}}
        args = CLI.build_parser().parse_args(["port", "add", "web", "--guest-port", "8080", "--session-id", "thread", "--operation-id", "port-fallback-op"])
        with tempfile.TemporaryDirectory() as state:
            processes = [CLI.subprocess.CompletedProcess([], 0, json.dumps(item).encode(), b"") for item in (status, response)]
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", side_effect=processes) as run, mock.patch.object(CLI, "json_output"):
                self.assertEqual(CLI.command_port(args), 0)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(json.loads(run.call_args_list[-1].kwargs["input_data"])["generation"], 7)

    def test_explicit_acquire_without_state_uses_remote_status_generation(self):
        status = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 0, "operation_id": None, "outcome": "success", "result": {"generation": 0}}
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "acquire", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 0, "operation_id": "acquire-op", "outcome": "success", "result": {}}
        processes = [CLI.subprocess.CompletedProcess([], 0, json.dumps(item).encode(), b"") for item in (status, response)]
        args = CLI.build_parser().parse_args(["acquire", "--session-id", "thread", "--operation-id", "acquire-op"])
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", side_effect=processes) as run:
                CLI.mutation("acquire", args, session="thread")
        request = json.loads(run.call_args_list[-1].kwargs["input_data"])
        self.assertEqual(request["generation"], 0)

    def test_acquire_retry_uses_existing_journal_before_remote_status(self):
        args = CLI.build_parser().parse_args(["acquire", "--session-id", "thread", "--operation-id", "acquire-retry-op"])
        response = {"result": {"effective_lease": True, "task_id": "avm-task", "generation": 7}}
        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as config:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "LOCAL_CONFIG_ROOT", Path(config)):
                directory = CLI._secure_directory(CLI._secure_session_directory("thread") / "operations")
                CLI.ensure_operation_journal(directory, {
                    "protocol": CLI.PROTOCOL_VERSION, "action": "acquire", "session_id": "thread",
                    "generation": 7, "operation_id": "acquire-retry-op", "public_key": "ssh-ed25519 fixture",
                })
                with mock.patch.object(CLI, "make_ssh_key", return_value=(Path(config) / "id_ed25519", "ssh-ed25519 fixture")), \
                     mock.patch.object(CLI, "mutation", return_value=response) as mutation, \
                     mock.patch.object(CLI, "remote_generation", side_effect=AssertionError("remote status must not be consulted")), \
                     mock.patch.object(CLI, "write_session_state"), mock.patch.object(CLI, "json_output"):
                    self.assertEqual(CLI.command_acquire(args), 0)
        self.assertEqual(mutation.call_args.kwargs["generation"], 7)

    def test_zero_generation_admin_retry_does_not_read_local_state(self):
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "admin-reconcile", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 0, "operation_id": "admin-op", "outcome": "success", "result": {}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        args = CLI.build_parser().parse_args(["admin", "reconcile", "--session-id", "thread", "--operation-id", "admin-op"])
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", return_value=process) as run:
                CLI.mutation("admin-reconcile", args, generation=0, session="thread")
        request = json.loads(run.call_args.kwargs["input_data"])
        self.assertEqual(request["generation"], 0)

    def test_large_structured_response_is_not_diagnostic_truncated(self):
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 1, "operation_id": None, "outcome": "success", "result": {"generation": 1, "payload": "x" * (CLI.DIAGNOSTIC_OUTPUT_LIMIT * 2)}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process):
            actual = CLI.control_request("status", session="thread")
        self.assertEqual(len(actual["result"]["payload"]), CLI.DIAGNOSTIC_OUTPUT_LIMIT * 2)

    def test_malformed_success_generation_and_outcome_are_rejected(self):
        base = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "operation_id": None, "result": {"generation": 1}}
        for field, value in (("generation", True), ("outcome", "pending")):
            response = {**base, "generation": 1, "outcome": "success", field: value}
            process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
            with mock.patch.object(CLI, "run_child", return_value=process):
                with self.assertRaises(CLI.CliError) as error:
                    CLI.control_request("status", session="thread")
            self.assertEqual(error.exception.code, "invalid_remote_response")

    def test_success_requires_null_read_operation_and_consistent_status_generation(self):
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 1, "outcome": "success", "result": {"generation": 1}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process):
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("status", session="thread")
        self.assertEqual(error.exception.code, "invalid_remote_response")

        response["operation_id"] = None
        response["result"] = {"generation": 2}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process):
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("status", session="thread")
        self.assertEqual(error.exception.code, "invalid_remote_response")

    def test_basic_credentials_and_long_error_messages_are_redacted_before_bounds(self):
        value = 'Authorization: Basic dXNlcjpzZWNyZXQ= url=https://user:secret@example.test sshpass -p very-secret'
        self.assertNotIn("dXNlcjpzZWNyZXQ=", CLI.redact_diagnostic_text(value))
        self.assertNotIn("secret", CLI.redact_diagnostic_text(value))
        camel = CLI.redact_diagnostic_text("secretValue=camel-secret-value tokenValue: camel-token-value")
        self.assertNotIn("camel-secret-value", camel)
        self.assertNotIn("camel-token-value", camel)
        structured = CLI.redact_diagnostic_value({"secretValue": "structured-secret-value", "tokenValue": "structured-token-value"})
        self.assertEqual(structured, {"secretValue": "[REDACTED]", "tokenValue": "[REDACTED]"})
        error = CLI.CliError("remote_failed", "Authorization: Basic " + "secret-value" + "x" * 10000)
        self.assertLessEqual(len(error.message), CLI.DIAGNOSTIC_MESSAGE_LIMIT)
        self.assertNotIn("secret-value", error.message)

    def test_redaction_covers_cookie_digest_session_and_jwt(self):
        jwt = ".".join(("eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJhZ2VudCJ9", "jwt-signature"))
        value = (
            "Cookie: sessionid=cookie-secret; theme=dark\n"
            "Set-Cookie: sessionid=set-cookie-secret; Path=/\n"
            "sessionid=session-secret Authorization: Digest username=agent, response=digest-secret\n"
            + "jwt=" + jwt
        )
        redacted = CLI.redact_diagnostic_text(value)
        for secret in ("cookie-secret", "set-cookie-secret", "session-secret", "digest-secret", "jwt-signature"):
            self.assertNotIn(secret, redacted)
        self.assertLessEqual(len(CLI.bounded_diagnostic_text(value, 128)), 128)

    def test_error_details_are_projected_and_document_bounded(self):
        detail = {"message": "x" * 10000, "errors": [{"stderr": "password=\"secret-value\""}] * 256, "untrusted": "drop-me"}
        error = CLI.CliError("remote_failed", "failed", detail)
        encoded = json.dumps(error.as_dict(), sort_keys=True)
        self.assertLessEqual(len(encoded), CLI.PERSISTED_DOCUMENT_LIMIT + 256)
        self.assertNotIn("drop-me", encoded)
        self.assertNotIn("secret-value", encoded)

    def test_unterminated_pem_is_redacted_before_bounding(self):
        value = b"-----BEGIN OPENSSH PRIVATE KEY-----\n" + (b"pem-canary-" * 2000)
        redacted = CLI.redact_and_bound_diagnostic(value)
        self.assertLessEqual(len(redacted), CLI.DIAGNOSTIC_OUTPUT_LIMIT)
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
            self.assertNotIn("canary", CLI.redact_diagnostic_text(value))

    def test_control_requires_boolean_true_and_binds_ssh_info_generation(self):
        response = {"ok": 1, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 1, "operation_id": None, "outcome": "success", "result": {"generation": 1}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process):
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("status", session="thread")
        self.assertEqual(error.exception.code, "invalid_remote_response")

        ssh = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "ssh-info", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 3, "operation_id": None, "outcome": "success", "result": {"generation": 3}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(ssh).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process) as run:
            CLI.control_request("ssh-info", session="thread", generation=3)
        self.assertEqual(json.loads(run.call_args.kwargs["input_data"])["generation"], 3)
        ssh["result"] = {"generation": 4}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(ssh).encode(), b"")
        with mock.patch.object(CLI, "run_child", return_value=process):
            with self.assertRaises(CLI.CliError) as error:
                CLI.control_request("ssh-info", session="thread", generation=3)
        self.assertEqual(error.exception.code, "invalid_remote_response")

    def test_ssh_info_uses_remote_status_generation(self):
        status = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 3, "operation_id": None, "outcome": "success", "result": {"generation": 3}}
        wire = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        host_key = "ssh-ed25519 " + CLI.base64.b64encode(wire).decode("ascii")
        info = {"task_id": "avm-task", "generation": 3, "host": "198.51.100.20", "port": 2200, "user": "root", "host_key_alias": "agent-vm-avm-task-g3", "host_key": host_key}
        ssh = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "ssh-info", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 3, "operation_id": None, "outcome": "success", "result": info}
        processes = [CLI.subprocess.CompletedProcess([], 0, json.dumps(item).encode(), b"") for item in (status, ssh)]
        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as config:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "LOCAL_CONFIG_ROOT", Path(config)), mock.patch.object(CLI, "run_child", side_effect=processes) as run:
                keys = CLI._secure_directory(CLI._secure_session_directory("thread") / "keys")
                key = keys / "id_ed25519"
                key.write_text("fixture", encoding="utf-8")
                key.chmod(0o600)
                CLI.write_session_state("thread", {"task_id": "avm-task", "generation": 3, "private_key": str(key)})
                _, result, _ = CLI.fetch_ssh_info("thread")
        self.assertEqual(result["generation"], 3)
        self.assertEqual([json.loads(call.kwargs["input_data"])["action"] for call in run.call_args_list], ["status", "ssh-info"])
        self.assertEqual(json.loads(run.call_args_list[1].kwargs["input_data"])["generation"], 3)

    def test_explicit_operation_without_a_journal_uses_remote_generation(self):
        status = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "status", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": None, "outcome": "success", "result": {"generation": 7}}
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "release", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 7, "operation_id": "release-op", "outcome": "success", "result": {}}
        processes = [CLI.subprocess.CompletedProcess([], 0, json.dumps(item).encode(), b"") for item in (status, response)]
        args = CLI.build_parser().parse_args(["release", "--session-id", "thread", "--operation-id", "release-op"])
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", side_effect=processes) as run:
                CLI.mutation("release", args)
        self.assertEqual(json.loads(run.call_args_list[-1].kwargs["input_data"])["generation"], 7)

    def test_timeout_diagnostics_preserve_bounded_redacted_stderr(self):
        error = CLI.subprocess.TimeoutExpired(["ssh"], 1, stderr=b"password" + b"=" + b'"timeout-secret-canary\ncontinued-secret-canary"')
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", side_effect=error):
                with self.assertRaises(CLI.CliError) as raised:
                    CLI.control_request("status", session="thread")
        detail = raised.exception.as_dict()["detail"]
        self.assertNotIn("timeout-secret-canary", str(detail))
        self.assertNotIn("continued-secret-canary", str(detail))
        self.assertIn("[REDACTED]", detail["stderr"])

    def test_ssh_config_rejects_noncanonical_endpoint_fields(self):
        info = {"task_id": "avm-task", "generation": 3, "host": "198.51.100.20", "port": 2200, "user": "admin", "host_key_alias": "agent-vm-avm-task-g3", "host_key": "ssh-ed25519 AAAA"}
        with self.assertRaises(CLI.CliError) as error:
            CLI.write_ssh_config("thread", info, Path("/tmp/id_ed25519"))
        self.assertEqual(error.exception.code, "invalid_remote_response")

    def test_ssh_config_rejects_malformed_ed25519_wire_payload(self):
        wire = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        valid = "ssh-ed25519 " + CLI.base64.b64encode(wire).decode("ascii")
        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as config:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "LOCAL_CONFIG_ROOT", Path(config)):
                keys = CLI._secure_directory(CLI._secure_session_directory("thread") / "keys")
                private_key = keys / "id_ed25519"
                private_key.write_text("fixture", encoding="utf-8")
                private_key.chmod(0o600)
                info = {"task_id": "avm-task", "generation": 3, "host": "198.51.100.20", "port": 2200, "user": "root", "host_key_alias": "agent-vm-avm-task-g3", "host_key": valid}
                CLI.write_ssh_config("thread", info, private_key)
                for payload in (wire[:-1], wire + b"\x00", wire.replace(b"ssh-ed25519", b"ssh-rsa   ", 1)):
                    malformed = {**info, "host_key": "ssh-ed25519 " + CLI.base64.b64encode(payload).decode("ascii")}
                    with self.assertRaises(CLI.CliError) as error:
                        CLI.write_ssh_config("thread", malformed, private_key)
                    self.assertEqual(error.exception.code, "invalid_host_key")

    def test_mutation_response_generation_must_match_request(self):
        response = {"ok": True, "protocol": CLI.PROTOCOL_VERSION, "action": "release", "session_id": "thread", "server_time": "2026-10-04T00:00:00+00:00", "generation": 4, "operation_id": "release-op", "outcome": "success", "result": {}}
        process = CLI.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b"")
        with tempfile.TemporaryDirectory() as state:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)), mock.patch.object(CLI, "run_child", return_value=process):
                with self.assertRaises(CLI.CliError) as error:
                    CLI.control_request("release", session="thread", generation=3, write=True, operation_id="release-op")
        self.assertEqual(error.exception.code, "invalid_remote_response")

    def test_session_state_rejects_symlinked_connection_material(self):
        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as outside:
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path(state)):
                CLI.write_session_state("thread", {"session_id": "thread", "generation": 1})
                path = CLI.local_session_dir("thread") / "state.json"
                path.unlink()
                path.symlink_to(Path(outside) / "state.json")
                with self.assertRaises(CLI.CliError) as error:
                    CLI.read_session_state("thread")
        self.assertEqual(error.exception.code, "local_state_invalid")

    def test_local_state_rejects_relative_and_symlinked_roots(self):
        with mock.patch.object(CLI, "LOCAL_STATE_ROOT", Path("relative-state")):
            with self.assertRaises(CLI.CliError) as error:
                CLI.write_session_state("thread", {"session_id": "thread", "generation": 1})
        self.assertEqual(error.exception.code, "local_state_invalid")

        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as outside:
            link = Path(state) / "link"
            link.symlink_to(Path(outside), target_is_directory=True)
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", link):
                with self.assertRaises(CLI.CliError) as error:
                    CLI.write_session_state("thread", {"session_id": "thread", "generation": 1})
            self.assertEqual(error.exception.code, "local_state_invalid")

        with tempfile.TemporaryDirectory() as state:
            unsafe = Path(state) / "unsafe"
            unsafe.mkdir()
            unsafe.chmod(0o777)
            with mock.patch.object(CLI, "LOCAL_STATE_ROOT", unsafe / "agent-vm"):
                with self.assertRaises(CLI.CliError) as error:
                    CLI.write_session_state("thread", {"session_id": "thread", "generation": 1})
            self.assertEqual(error.exception.code, "local_state_invalid")

    def test_timeout_kills_descendant_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            child_pid = Path(directory) / "child.pid"
            code = "import pathlib, subprocess, sys, time; child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(30)"
            with self.assertRaises(CLI.subprocess.TimeoutExpired):
                CLI.run_child([CLI.sys.executable, "-c", code, str(child_pid)], timeout=0.1)
            pid = int(child_pid.read_text())
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                try:
                    CLI.os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail("descendant survived process-group cleanup")

    def test_terminate_process_group_kills_descendant_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            child_pid = Path(directory) / "child.pid"
            child_code = "import pathlib, signal, sys, time; pathlib.Path(sys.argv[1]).write_text(str(__import__('os').getpid())); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
            wrapper_code = f"import signal, subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child_code!r}, sys.argv[1]]); signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); time.sleep(30)"
            process = CLI.subprocess.Popen([CLI.sys.executable, "-c", wrapper_code, str(child_pid)], start_new_session=True)
            deadline = time.monotonic() + 1.0
            while not child_pid.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(child_pid.exists())
            child = int(child_pid.read_text())
            CLI.terminate_process_group(process)
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                try:
                    CLI.os.kill(child, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail("TERM-ignoring descendant survived leader-exit cleanup")

    def test_run_child_timeout_closes_stdin_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child_pid = root / "child.pid"
            driver = root / "driver.py"
            driver.write_text(
                "import importlib.util, pathlib, subprocess, sys\n"
                "module_path, pid_path = sys.argv[1:3]\n"
                "spec = importlib.util.spec_from_file_location('agent_vm_client_probe', module_path)\n"
                "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n"
                "child_code = \"import pathlib, signal, sys, time; pathlib.Path(sys.argv[1]).write_text(str(__import__('os').getpid())); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)\"\n"
                "wrapper_code = f\"import signal, subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child_code!r}, sys.argv[1]]); signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); time.sleep(30)\"\n"
                "try:\n"
                "    module.run_child([sys.executable, '-c', wrapper_code, pid_path], input_data=b'x' * (4 * 1024 * 1024), timeout=0.1)\n"
                "except subprocess.TimeoutExpired:\n"
                "    raise SystemExit(0)\n"
                "raise SystemExit(9)\n",
                encoding="utf-8",
            )
            probe = CLI.subprocess.Popen([CLI.sys.executable, str(driver), str(CLI.__file__), str(child_pid)], start_new_session=True)
            try:
                result = probe.wait(timeout=3)
            except CLI.subprocess.TimeoutExpired:
                if child_pid.exists():
                    try:
                        CLI.os.kill(int(child_pid.read_text()), CLI.signal.SIGKILL)
                    except (ProcessLookupError, ValueError):
                        pass
                try:
                    CLI.os.killpg(probe.pid, CLI.signal.SIGKILL)
                except ProcessLookupError:
                    pass
                probe.wait(timeout=1)
                self.fail("run_child retained a closed leader's stdin registration")
            self.assertEqual(result, 0)

    def test_main_redacts_unexpected_exception_text(self):
        with mock.patch.object(CLI, "dispatch", side_effect=RuntimeError("password" + '="unexpected-secret"')), mock.patch.object(CLI.sys, "stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(CLI.main(["status"]), 3)
        output = stderr.getvalue()
        self.assertNotIn("unexpected-secret", output)
        self.assertIn('"code": "internal_error"', output)


if __name__ == "__main__":
    unittest.main()
