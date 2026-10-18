#!/usr/bin/env python3
"""Native Incus agent VM client.

The client sends one bounded JSON request to the configured control host. VM
access then uses a generation-bound native OpenSSH configuration.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Sequence
import uuid


PROTOCOL_VERSION = 4
VERSION = "0.4.0-native"
REMOTE_CONTROL = "/opt/agent-vm-native/agent_vm_control.ts"
DEFAULT_CONTROL_TIMEOUT_SECONDS = 240
LONG_CONTROL_TIMEOUT_SECONDS = 600
DIAGNOSTIC_OUTPUT_LIMIT = 8192
DIAGNOSTIC_TRUNCATION_MARKER = b"\n[TRUNCATED BY DIAGNOSTIC LIMIT]"
RAW_DIAGNOSTIC_CAPTURE_LIMIT = 1024 * 1024
CONTROL_RESPONSE_LIMIT = 4 * 1024 * 1024
CHILD_DRAIN_GRACE_SECONDS = 1.0
DIAGNOSTIC_MESSAGE_LIMIT = 4096
DEFAULT_CHILD_TIMEOUT_SECONDS = 600
SESSION_ENV = "AGENT_VM_SESSION_ID"
CONTROL_HOST_ENV = "AGENT_VM_CONTROL_HOST"
REMOTE_CONTROL_ENV = "AGENT_VM_REMOTE_CONTROL"
DEFAULT_CONTROL_HOST = "agent-vm-host"
DEFAULT_REMOTE_CONTROL = "/opt/agent-vm-native/agent_vm_control.ts"
LOCAL_CONFIG_ROOT = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "agent-vm"
LOCAL_STATE_ROOT = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "agent-vm"
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_.:@/-]{1,160}$")
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
SENSITIVE_FIELD_RE = re.compile(r"(?:password|passwd|passphrase|secret|token|authorization|private[_ -]?key|public[_ -]?key|api[_ -]?key|access[_ -]?key|client[_ -]?secret|credentials?)", re.IGNORECASE)
SECRET_LABELS = r"(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|secret|token|authorization|private[_ -]?key|public[_ -]?key|api[_ -]?key|access[_ -]?key|client[_ -]?secret|credentials?)(?:[_-][A-Za-z0-9]+)*"
PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 _-]*PRIVATE KEY-----", re.IGNORECASE)
UNTERMINATED_PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*$", re.IGNORECASE)
AUTH_SCHEME_RE = re.compile(r"(?i)(['\"]?\bauthorization\b['\"]?\s*(?:[:=]\s*)?['\"]?(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+")
AUTH_BASIC_RE = re.compile(r"(?i)(\bbasic\s+)[A-Za-z0-9._~+/=-]+")
SECRET_DOUBLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)\"(?:\\.|[^\"\\\r\n])*\"")
SECRET_SINGLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)'(?:\\.|[^'\\\r\n])*'")
UNTERMINATED_SECRET_DOUBLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)\"(?:\\.|[^\"\\\r\n])*$")
UNTERMINATED_SECRET_SINGLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)'(?:\\.|[^'\\\r\n])*$")
SECRET_TOKEN_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)([^\s,;}}\]\\\"']+)")
SSHPASS_RE = re.compile(r"(?i)(\bsshpass\b[ \t]+-p)[^\r\n]*")
URL_CREDENTIAL_RE = re.compile(r"(?i)(\b[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:)([^@\s/]+)(@)")
BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+")


def redact_diagnostic_text(value: str) -> str:
    redacted = PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", value)
    redacted = UNTERMINATED_PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", redacted)
    redacted = AUTH_SCHEME_RE.sub(r"\1[REDACTED]", redacted)
    redacted = AUTH_BASIC_RE.sub(r"\1[REDACTED]", redacted)
    redacted = SECRET_DOUBLE_RE.sub(r'\1"[REDACTED]"', redacted)
    redacted = SECRET_SINGLE_RE.sub(r"\1'[REDACTED]'", redacted)
    redacted = UNTERMINATED_SECRET_DOUBLE_RE.sub(r'\1"[REDACTED]', redacted)
    redacted = UNTERMINATED_SECRET_SINGLE_RE.sub(r"\1'[REDACTED]", redacted)
    redacted = SECRET_TOKEN_RE.sub(r"\1[REDACTED]", redacted)
    redacted = SSHPASS_RE.sub(r"\1 [REDACTED]", redacted)
    redacted = URL_CREDENTIAL_RE.sub(r"\1[REDACTED]\3", redacted)
    return BEARER_RE.sub(r"\1[REDACTED]", redacted)


def bounded_diagnostic_text(value: str, limit: int = DIAGNOSTIC_MESSAGE_LIMIT) -> str:
    redacted = redact_diagnostic_text(value)
    if len(redacted) <= limit:
        return redacted
    marker = DIAGNOSTIC_TRUNCATION_MARKER.decode("utf-8")
    return redacted[: max(0, limit - len(marker))] + marker


def redact_and_bound_diagnostic(value: bytes, *, truncated: bool = False, limit: int = DIAGNOSTIC_OUTPUT_LIMIT) -> bytes:
    redacted = redact_diagnostic_text(value.decode("utf-8", "replace")).encode("utf-8")
    if not truncated and len(redacted) <= limit:
        return redacted
    available = max(0, limit - len(DIAGNOSTIC_TRUNCATION_MARKER))
    return redacted[:available] + DIAGNOSTIC_TRUNCATION_MARKER


def redact_diagnostic_value(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[REDACTED]"
    if isinstance(value, str):
        return bounded_diagnostic_text(value, DIAGNOSTIC_OUTPUT_LIMIT)
    if isinstance(value, list):
        return [redact_diagnostic_value(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {key: "[REDACTED]" if SENSITIVE_FIELD_RE.search(str(key)) else redact_diagnostic_value(child, depth + 1) for key, child in value.items()}
    return value


class CliError(Exception):
    def __init__(self, code: str, message: str, detail: Any = None, exit_code: int = 2):
        safe_message = bounded_diagnostic_text(str(message))
        super().__init__(safe_message)
        self.code = code
        self.message = safe_message
        self.detail = redact_diagnostic_value(detail) if detail is not None else None
        self.exit_code = exit_code

    def as_dict(self) -> dict[str, Any]:
        value = {"code": self.code, "message": self.message}
        if self.detail is not None:
            value["detail"] = redact_diagnostic_value(self.detail)
        return value


def fail(code: str, message: str, detail: Any = None, exit_code: int = 2) -> None:
    raise CliError(code, message, detail, exit_code)


def session_id(explicit: str | None = None, *, required: bool = True) -> str | None:
    value = explicit if explicit is not None else os.environ.get(SESSION_ENV)
    if value is None and not required:
        return None
    if not value:
        fail("missing_session", f"{SESSION_ENV} must be set before a remote operation")
    if SESSION_ID_RE.fullmatch(value) is None:
        fail("invalid_session", f"{SESSION_ENV} contains unsupported characters")
    return value


def json_output(value: Any) -> None:
    sys.stdout.write(json.dumps(value, sort_keys=True, indent=2) + "\n")


def local_session_dir(value: str) -> Path:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
    return LOCAL_STATE_ROOT / "sessions" / digest


def _secure_directory(path: Path, *, code: str = "local_state_invalid") -> Path:
    path = path.absolute()
    try:
        current = path.lstat()
    except FileNotFoundError:
        try:
            path.mkdir(mode=0o700, parents=True, exist_ok=False)
        except FileExistsError:
            pass
        except OSError as error:
            fail(code, "local directory cannot be created", str(error))
        try:
            current = path.lstat()
        except OSError:
            fail(code, "local directory cannot be inspected")
    except OSError:
        fail(code, "local directory cannot be inspected")
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
        fail(code, "local directory must be a real directory")
    owner = getattr(os, "geteuid", lambda: current.st_uid)()
    if current.st_uid != owner or stat.S_IMODE(current.st_mode) & 0o022:
        fail(code, "local directory must be privately owned")
    os.chmod(path, 0o700)
    return path


def _secure_session_directory(session: str) -> Path:
    root = _secure_directory(LOCAL_STATE_ROOT)
    sessions = _secure_directory(root / "sessions")
    return _secure_directory(sessions / hashlib.sha256(session.encode("utf-8")).hexdigest()[:24])


def _secure_config_session_directory(session: str) -> Path:
    root = _secure_directory(LOCAL_CONFIG_ROOT, code="local_config_invalid")
    sessions = _secure_directory(root / "sessions", code="local_config_invalid")
    return _secure_directory(sessions / hashlib.sha256(session.encode("utf-8")).hexdigest()[:24], code="local_config_invalid")


def _secure_file(path: Path, *, code: str = "local_state_invalid") -> Path:
    path = path.absolute()
    try:
        current = path.lstat()
    except FileNotFoundError:
        fail(code, "local file is missing")
    except OSError:
        fail(code, "local file cannot be inspected")
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
        fail(code, "local file must be a real regular file")
    owner = getattr(os, "geteuid", lambda: current.st_uid)()
    if current.st_uid != owner or stat.S_IMODE(current.st_mode) & 0o077 or stat.S_IMODE(current.st_mode) & 0o111:
        fail(code, "local file must be privately owned")
    return path


def _secure_fd(fd: int, *, code: str = "local_state_invalid") -> None:
    current = os.fstat(fd)
    if not stat.S_ISREG(current.st_mode):
        fail(code, "local file descriptor is not a regular file")
    owner = getattr(os, "geteuid", lambda: current.st_uid)()
    if current.st_uid != owner or stat.S_IMODE(current.st_mode) & 0o077 or stat.S_IMODE(current.st_mode) & 0o111:
        fail(code, "local file descriptor is not privately owned")


def operation_journal_path(session: str, operation: str) -> Path:
    return _secure_session_directory(session) / "operations" / (hashlib.sha256(operation.encode()).hexdigest() + ".json")


def read_operation_journal(path: Path) -> dict[str, Any]:
    try:
        _secure_file(path, code="local_journal_invalid")
        value = json.loads(path.read_text(encoding="utf-8"))
    except CliError:
        raise
    except (OSError, UnicodeError, ValueError):
        fail("local_journal_invalid", "operation journal is unreadable")
    if not isinstance(value, dict) or not isinstance(value.get("request"), dict):
        fail("local_journal_invalid", "operation journal is malformed")
    return value


def ensure_operation_journal(directory: Path, request: dict[str, Any]) -> None:
    session = request.get("session_id")
    if not isinstance(session, str):
        fail("local_journal_invalid", "operation journal request has no session identity")
    expected = _secure_session_directory(session) / "operations"
    if directory.absolute() != expected.absolute():
        fail("local_journal_invalid", "operation journal path is outside the session namespace")
    _secure_directory(expected)
    operation = str(request["operation_id"])
    path = directory / (hashlib.sha256(operation.encode()).hexdigest() + ".json")
    lock_path = path.with_suffix(path.suffix + ".lock")
    if lock_path.exists() or os.path.lexists(lock_path):
        _secure_file(lock_path)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        lock_fd = os.open(lock_path, flags, 0o600)
    except OSError as error:
        fail("local_journal_invalid", "operation journal lock is unsafe", str(error))
    with os.fdopen(lock_fd, "a+", encoding="utf-8") as lock:
        _secure_fd(lock.fileno())
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            if os.path.lexists(path):
                _secure_file(path, code="local_journal_invalid")
                old = read_operation_journal(path)
                if old["request"] != request:
                    fail("operation_conflict", "operation ID already describes another request")
                return
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    _secure_fd(handle.fileno())
                    os.fchmod(handle.fileno(), 0o600)
                    json.dump({"request": request, "outcome": "pending"}, handle, sort_keys=True)
                    handle.flush()
                    os.fsync(handle.fileno())
            except FileExistsError:
                _secure_file(path, code="local_journal_invalid")
                old = read_operation_journal(path)
                if old["request"] != request:
                    fail("operation_conflict", "operation ID already describes another request")
            except OSError as error:
                fail("local_journal_invalid", "operation journal file is unsafe", str(error))
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


class _BoundedCapture:
    def __init__(self, limit: int, *, tail: bool) -> None:
        self.limit = limit
        self.tail = tail
        self.value = bytearray()
        self.seen = 0

    def append(self, chunk: bytes) -> None:
        self.seen += len(chunk)
        if self.limit <= 0:
            return
        if self.tail:
            self.value.extend(chunk)
            if len(self.value) > self.limit:
                del self.value[:-self.limit]
        elif len(self.value) < self.limit:
            self.value.extend(chunk[: self.limit - len(self.value)])

    def finish(self, *, marker: bool = True) -> bytes:
        value = bytes(self.value)
        if not marker or self.seen <= self.limit:
            return value
        available = max(0, self.limit - len(DIAGNOSTIC_TRUNCATION_MARKER))
        if self.tail:
            return DIAGNOSTIC_TRUNCATION_MARKER + value[-available:] if available else DIAGNOSTIC_TRUNCATION_MARKER
        return value[:available] + DIAGNOSTIC_TRUNCATION_MARKER


def terminate_process_group(process: subprocess.Popen[Any]) -> None:
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=0.25)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def run_child(argv: Sequence[str], *, input_data: bytes | None = None,
              capture_stdout: bool = False, stdout_limit: int = DIAGNOSTIC_OUTPUT_LIMIT,
              timeout: float | None = None) -> subprocess.CompletedProcess:
    try:
        process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE if input_data is not None else None,
            stdout=subprocess.PIPE if capture_stdout else None,
            stderr=subprocess.PIPE,
            close_fds=True,
            start_new_session=os.name == "posix",
        )
    except FileNotFoundError:
        raise
    selector = selectors.DefaultSelector()
    stdout_capture = _BoundedCapture(stdout_limit, tail=False)
    # Keep the diagnostic prefix. A bounded tail can retain an unlabeled secret
    # suffix after truncation, even when the retained bytes are redacted later.
    stderr_capture = _BoundedCapture(RAW_DIAGNOSTIC_CAPTURE_LIMIT, tail=False)
    input_view = memoryview(input_data or b"")
    input_offset = 0

    def close_stream(stream: Any) -> None:
        try:
            selector.unregister(stream)
        except KeyError:
            pass
        try:
            stream.close()
        except OSError:
            pass

    for stream, kind in ((process.stdout, "stdout"), (process.stderr, "stderr")):
        if stream is not None:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, kind)
    if process.stdin is not None:
        os.set_blocking(process.stdin.fileno(), False)
        if input_view:
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
    effective_timeout = DEFAULT_CHILD_TIMEOUT_SECONDS if timeout is None else timeout
    deadline = time.monotonic() + effective_timeout
    drain_deadline: float | None = None
    try:
        while selector.get_map() or process.poll() is None:
            if process.poll() is not None and drain_deadline is None:
                drain_deadline = time.monotonic() + CHILD_DRAIN_GRACE_SECONDS
            deadlines = [value for value in (deadline, drain_deadline) if value is not None]
            remaining = None if not deadlines else min(deadlines) - time.monotonic()
            if remaining is not None and remaining <= 0:
                if deadline is not None and (drain_deadline is None or deadline <= drain_deadline):
                    terminate_process_group(process)
                    raise subprocess.TimeoutExpired(list(argv), effective_timeout, output=stdout_capture.finish(marker=False), stderr=redact_and_bound_diagnostic(stderr_capture.finish(marker=False), truncated=stderr_capture.seen > stderr_capture.limit))
                terminate_process_group(process)
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        close_stream(stream)
                continue
            if not selector.get_map():
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    terminate_process_group(process)
                    raise subprocess.TimeoutExpired(list(argv), effective_timeout, output=stdout_capture.finish(marker=False), stderr=redact_and_bound_diagnostic(stderr_capture.finish(marker=False), truncated=stderr_capture.seen > stderr_capture.limit))
                break
            events = selector.select(remaining)
            for key, _ in events:
                stream = key.fileobj
                if key.data == "stdin":
                    try:
                        written = os.write(stream.fileno(), input_view[input_offset:])
                    except (BrokenPipeError, OSError):
                        close_stream(stream)
                    else:
                        input_offset += written
                        if input_offset >= len(input_view):
                            close_stream(stream)
                    continue
                try:
                    chunk = os.read(stream.fileno(), 64 * 1024)
                except BlockingIOError:
                    continue
                if chunk:
                    (stdout_capture if key.data == "stdout" else stderr_capture).append(chunk)
                else:
                    close_stream(stream)
        completed = subprocess.CompletedProcess(
            list(argv),
            process.wait(),
            stdout_capture.finish(marker=not capture_stdout) if capture_stdout else None,
            redact_and_bound_diagnostic(stderr_capture.finish(marker=False), truncated=stderr_capture.seen > stderr_capture.limit),
        )
        completed.stdout_truncated = stdout_capture.seen > stdout_capture.limit if capture_stdout else False
        return completed
    finally:
        if process.poll() is None:
            terminate_process_group(process)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        selector.close()
        if process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                pass


def read_session_state(value: str) -> dict[str, Any]:
    path = _secure_session_directory(value) / "state.json"
    if not os.path.lexists(path):
        fail("local_state_missing", "local session state is missing; run acquire first")
    try:
        _secure_file(path)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            _secure_fd(handle.fileno())
            state = json.load(handle)
    except CliError:
        raise
    except (OSError, json.JSONDecodeError):
        fail("local_state_invalid", "local session state cannot be read")
    if not isinstance(state, dict):
        fail("local_state_invalid", "local session state is not an object")
    return state


def write_session_state(value: str, state: dict[str, Any]) -> None:
    directory = _secure_session_directory(value)
    path = directory / "state.json"
    if os.path.lexists(path):
        _secure_file(path)
    fd, temp_name = tempfile.mkstemp(prefix=".state.json.", dir=directory)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            _secure_fd(handle.fileno())
            json.dump(state, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fchmod(handle.fileno(), 0o600)
            os.fsync(handle.fileno())
        os.replace(temp, path)
        _secure_file(path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def current_generation(value: str) -> int:
    state = read_session_state(value)
    generation = state.get("generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
        fail("local_state_invalid", "local session state has no valid generation")
    return generation


def journal_generation(session: str, operation: str, fallback: int) -> int:
    path = operation_journal_path(session, operation)
    if not os.path.lexists(path):
        return fallback
    _secure_file(path)
    record = read_operation_journal(path)
    value = record["request"].get("generation")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        fail("local_journal_invalid", "operation journal has no valid generation")
    return value


def control_timeout(action: str, fields: dict[str, Any] | None = None) -> int:
    if action in {"acquire", "restart"}:
        return LONG_CONTROL_TIMEOUT_SECONDS
    if action == "resize" and fields and fields.get("allow_restart") is True:
        return LONG_CONTROL_TIMEOUT_SECONDS
    return DEFAULT_CONTROL_TIMEOUT_SECONDS


def control_request(action: str, *, session: str | None, generation: int | None = None,
                    write: bool = False, operation_id: str | None = None,
                    fields: dict[str, Any] | None = None) -> dict[str, Any]:
    if write and session is None: fail("missing_session", f"{SESSION_ENV} is required")
    request = {"protocol": PROTOCOL_VERSION, "action": action}
    if session is not None: request["session_id"] = session
    if generation is not None: request["generation"] = generation
    if write: request["operation_id"] = operation_id or str(uuid.uuid4())
    if fields: request.update(fields)
    if write:
        directory = _secure_directory(_secure_session_directory(session) / "operations")
        ensure_operation_journal(directory, request)
    try:
        control_host = os.environ.get(CONTROL_HOST_ENV, DEFAULT_CONTROL_HOST)
        remote_control = os.environ.get(REMOTE_CONTROL_ENV, DEFAULT_REMOTE_CONTROL)
        process = run_child(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", control_host,
                             shlex.join(["bun", remote_control])],
                            input_data=json.dumps(request, sort_keys=True).encode(), capture_stdout=True,
                            stdout_limit=CONTROL_RESPONSE_LIMIT,
                            timeout=control_timeout(action, fields))
    except FileNotFoundError: fail("command_missing", "ssh is not installed")
    except subprocess.TimeoutExpired:
        fail("remote_timeout", "control outcome is uncertain; retry the same operation ID",
             {"operation_id": request.get("operation_id")})
    if process.stderr:
        sys.stderr.buffer.write(redact_and_bound_diagnostic(process.stderr))
        sys.stderr.flush()
    if process.returncode:
        fail("remote_failed", "remote request failed; retry only with its original operation ID",
             {"operation_id": request.get("operation_id")}, process.returncode)
    if getattr(process, "stdout_truncated", False):
        fail("invalid_remote_response", "control response exceeds the protocol size limit", {"limit": CONTROL_RESPONSE_LIMIT})
    try: response = json.loads(process.stdout or b"")
    except (ValueError, UnicodeDecodeError): fail("invalid_remote_response", "control did not return JSON")
    if not isinstance(response, dict) or response.get("protocol") != PROTOCOL_VERSION or response.get("action") != action or response.get("session_id") != session:
        fail("protocol_mismatch", "response protocol or request identity differs")
    generation = response.get("generation")
    if "generation" not in response or (generation is not None and (isinstance(generation, bool) or not isinstance(generation, int) or generation < 0)):
        fail("invalid_remote_response", "control response generation is invalid")
    if write and request.get("generation") is not None and generation != request["generation"]:
        fail("invalid_remote_response", "mutation response generation is inconsistent")
    if response.get("outcome") not in {"success", "replayed"}:
        fail("invalid_remote_response", "control response outcome is invalid")
    if not response.get("ok") or not isinstance(response.get("result"), dict) or not isinstance(response.get("server_time"), str):
        fail("invalid_remote_response", "invalid control response envelope")
    expected_operation_id = request.get("operation_id") if write else None
    if "operation_id" not in response or response.get("operation_id") != expected_operation_id:
        fail("invalid_remote_response", "control response operation identity is invalid")
    if action == "status":
        result_generation = response["result"].get("generation")
        if (isinstance(generation, bool) or not isinstance(generation, int) or generation < 0 or
                isinstance(result_generation, bool) or not isinstance(result_generation, int) or result_generation < 0 or
                generation != result_generation):
            fail("invalid_remote_response", "status response generation is inconsistent")
    return response



def run_command(argv: Sequence[str], *, input_data: bytes | None = None, output: bool = False) -> int:
    try:
        process = run_child(list(argv), input_data=input_data)
    except FileNotFoundError:
        fail("command_missing", f"command not found: {argv[0]}")
    except subprocess.TimeoutExpired:
        fail("command_timeout", f"command timed out: {argv[0]}")
    if process.stderr:
        sys.stderr.buffer.write(redact_and_bound_diagnostic(process.stderr))
        sys.stderr.flush()
    return process.returncode


def make_ssh_key(session: str) -> tuple[Path, str]:
    directory = _secure_directory(_secure_session_directory(session) / "keys")
    private_key = directory / "id_ed25519"
    public_key = private_key.with_suffix(".pub")
    private_exists = os.path.lexists(private_key)
    public_exists = os.path.lexists(public_key)
    if private_exists != public_exists:
        fail("key_invalid", "SSH key pair is incomplete")
    if private_exists:
        _secure_file(private_key)
        _secure_file(public_key)
        os.chmod(public_key, 0o600)
    else:
        try:
            process = run_child(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(private_key)], capture_stdout=True)
        except FileNotFoundError:
            fail("command_missing", "ssh-keygen is not installed")
        except subprocess.TimeoutExpired:
            fail("command_timeout", "ssh-keygen timed out")
        if process.returncode != 0:
            fail("keygen_failed", "ssh-keygen failed", process.stderr.decode("utf-8", "replace"))
    os.chmod(private_key, 0o600)
    os.chmod(public_key, 0o600)
    _secure_file(private_key)
    _secure_file(public_key)
    try:
        key = public_key.read_text(encoding="utf-8").strip()
    except OSError:
        fail("key_missing", "generated public key cannot be read")
    if not key:
        fail("key_invalid", "generated public key is empty")
    return private_key, key


def ssh_paths(session: str, info: dict[str, Any]) -> tuple[Path, Path]:
    task_id = str(info["task_id"])
    generation = int(info["generation"])
    directory = _secure_config_session_directory(session)
    return directory / f"agent-vm-{task_id}-g{generation}.ssh", directory / f"agent-vm-{task_id}-g{generation}.known_hosts"


def write_ssh_config(session: str, info: dict[str, Any], private_key: Path) -> Path:
    host = str(info["host"])
    port = int(info["port"])
    alias = str(info["host_key_alias"])
    try: ipaddress.IPv4Address(host)
    except ValueError: fail("invalid_remote_response", "invalid VM endpoint address")
    if not 1024 <= port <= 65535 or not re.fullmatch(r"agent-vm-[a-z0-9-]+-g[1-9][0-9]*", alias):
        fail("invalid_remote_response", "invalid VM endpoint identity")
    if not re.fullmatch(r"avm-[a-z0-9-]+", str(info["task_id"])) or int(info["generation"]) < 1:
        fail("invalid_remote_response", "invalid task identity")
    host_key = str(info["host_key"])
    fields = host_key.split()
    if len(fields) != 2 or fields[0] != "ssh-ed25519" or not re.fullmatch(r"[A-Za-z0-9+/=]+", fields[1]):
        fail("invalid_host_key", "control returned an invalid trusted host key")
    config_path, known_hosts_path = ssh_paths(session, info)
    expected_key = _secure_session_directory(session) / "keys" / "id_ed25519"
    if private_key.absolute() != expected_key.absolute():
        fail("invalid_path", "SSH identity file is outside the session namespace")
    _secure_file(expected_key)
    known_hosts = f"{alias} {host_key}\n"
    config = (
        "Host agent-vm\n"
        f"  HostName {host}\n"
        f"  Port {port}\n"
        "  User root\n"
        f"  HostKeyAlias {alias}\n"
        "  StrictHostKeyChecking yes\n"
        "  IdentitiesOnly yes\n"
        f"  IdentityFile {ssh_config_path(private_key)}\n"
        f"  UserKnownHostsFile {ssh_config_path(known_hosts_path)}\n"
        "  ControlMaster no\n"
        "  ControlPath none\n"
    )
    for path, content in ((known_hosts_path, known_hosts), (config_path, config)):
        if os.path.lexists(path):
            _secure_file(path, code="local_config_invalid")
        fd, temp_name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
        temp = Path(temp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                _secure_fd(handle.fileno(), code="local_config_invalid")
                handle.write(content)
                handle.flush()
                os.fchmod(handle.fileno(), 0o600)
                os.fsync(handle.fileno())
            os.replace(temp, path)
            _secure_file(path, code="local_config_invalid")
        finally:
            try:
                temp.unlink()
            except FileNotFoundError:
                pass
    return config_path


def ssh_config_path(path: Path) -> str:
    value = str(path.resolve())
    if any(ch in value for ch in ('\n', '\r', '\0')):
        fail("invalid_path", "SSH configuration path contains a control character")
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def fetch_ssh_info(session: str) -> tuple[dict[str, Any], dict[str, Any], Path]:
    response = control_request("ssh-info", session=session)
    info = response["result"]
    if not isinstance(info, dict):
        fail("invalid_remote_response", "ssh-info result is not an object")
    state = read_session_state(session)
    private_key = Path(str(state["private_key"]))
    if state.get("task_id") != info["task_id"] or state.get("generation") != info["generation"]:
        fail("generation_mismatch", "connection material belongs to another lease; acquire the current lease first")
    expected_key = _secure_session_directory(session) / "keys" / "id_ed25519"
    if private_key.absolute() != expected_key.absolute():
        fail("invalid_path", "session state points outside the session key namespace")
    _secure_file(expected_key)
    config_path = write_ssh_config(session, info, private_key)
    _, known_hosts = ssh_paths(session, info)
    info.update(identity_file=str(private_key), known_hosts_file=str(known_hosts), ssh_config=str(config_path))
    return response, info, config_path


def parse_memory(value: str) -> int:
    match = re.fullmatch(r"([0-9]+)(MiB|GiB|M|G)", value, re.IGNORECASE)
    if match is None:
        fail("invalid_size", "memory must use MiB, GiB, M or G")
    amount = int(match.group(1))
    unit = match.group(2).lower()
    return amount if unit == "mib" or unit == "m" else amount * 1024


def parse_disk(value: str) -> int:
    match = re.fullmatch(r"([0-9]+)(GiB|G)", value, re.IGNORECASE)
    if match is None:
        fail("invalid_size", "disk must use GiB or G")
    return int(match.group(1))


def add_common_mutation_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--operation-id", help="reuse this ID when retrying a mutation")


def add_session_option(parser: argparse.ArgumentParser, *, suppress_default: bool = False) -> None:
    options = {"help": f"session identity override (defaults to {SESSION_ENV})"}
    if suppress_default:
        options["default"] = argparse.SUPPRESS
    parser.add_argument("--session-id", **options)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-vm")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    add_session_option(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)
    version = subparsers.add_parser("version")
    add_session_option(version, suppress_default=True)
    help_parser = subparsers.add_parser("help")
    add_session_option(help_parser, suppress_default=True)

    doctor = subparsers.add_parser("doctor")
    add_session_option(doctor, suppress_default=True)
    status = subparsers.add_parser("status")
    add_session_option(status, suppress_default=True)
    acquire = subparsers.add_parser("acquire")
    add_session_option(acquire, suppress_default=True)
    acquire.add_argument("--ssh-host-port", type=int)
    acquire.add_argument("--cpu", type=int)
    acquire.add_argument("--memory")
    acquire.add_argument("--disk")
    add_common_mutation_options(acquire)
    for name in ("renew", "release", "destroy", "restart"):
        command = subparsers.add_parser(name)
        add_session_option(command, suppress_default=True)
        add_common_mutation_options(command)
    resize = subparsers.add_parser("resize")
    add_session_option(resize, suppress_default=True)
    resize.add_argument("--cpu", type=int)
    resize.add_argument("--memory")
    resize.add_argument("--disk")
    mode = resize.add_mutually_exclusive_group()
    mode.add_argument("--allow-restart", action="store_true")
    mode.add_argument("--live", action="store_true", help="adjust memory only without restarting; no automatic fallback")
    add_common_mutation_options(resize)
    ssh_info = subparsers.add_parser("ssh-info")
    add_session_option(ssh_info, suppress_default=True)
    ssh_info.add_argument("--format", choices=("json", "ssh-config"), default="json")
    ssh = subparsers.add_parser("ssh")
    add_session_option(ssh, suppress_default=True)
    ssh.add_argument("ssh_args", nargs=argparse.REMAINDER)
    execute = subparsers.add_parser("exec")
    add_session_option(execute, suppress_default=True)
    execute.add_argument("argv", nargs=argparse.REMAINDER)
    sync = subparsers.add_parser("sync")
    add_session_option(sync, suppress_default=True)
    sync.add_argument("--name", required=True)
    upload = subparsers.add_parser("upload")
    add_session_option(upload, suppress_default=True)
    upload.add_argument("source")
    upload.add_argument("destination")
    download = subparsers.add_parser("download")
    add_session_option(download, suppress_default=True)
    download.add_argument("source")
    download.add_argument("destination")
    export = subparsers.add_parser("export")
    add_session_option(export, suppress_default=True)
    export.add_argument("path")

    port = subparsers.add_parser("port")
    add_session_option(port, suppress_default=True)
    port_sub = port.add_subparsers(dest="port_command", required=True)
    port_add = port_sub.add_parser("add")
    add_session_option(port_add, suppress_default=True)
    port_add.add_argument("name")
    port_add.add_argument("--guest-port", type=int, required=True)
    port_add.add_argument("--protocol", choices=("tcp", "udp"), default="tcp")
    port_add.add_argument("--host-port", type=int)
    add_common_mutation_options(port_add)
    port_list = port_sub.add_parser("list")
    add_session_option(port_list, suppress_default=True)
    port_remove = port_sub.add_parser("remove")
    add_session_option(port_remove, suppress_default=True)
    port_remove.add_argument("name")
    port_remove.add_argument("--protocol", choices=("tcp", "udp"), default="tcp")
    add_common_mutation_options(port_remove)

    admin = subparsers.add_parser("admin")
    add_session_option(admin, suppress_default=True)
    admin_sub = admin.add_subparsers(dest="admin_command", required=True)
    admin_status = admin_sub.add_parser("status")
    add_session_option(admin_status, suppress_default=True)
    admin_session = admin_sub.add_parser("session")
    add_session_option(admin_session, suppress_default=True)
    session_sub = admin_session.add_subparsers(dest="session_command", required=True)
    session_list = session_sub.add_parser("list")
    add_session_option(session_list, suppress_default=True)
    drain = admin_sub.add_parser("drain")
    add_session_option(drain, suppress_default=True)
    drain.add_argument("drain_command", choices=("enter", "status", "exit"))
    add_common_mutation_options(drain)
    reconcile = admin_sub.add_parser("reconcile")
    add_session_option(reconcile, suppress_default=True)
    reconcile.add_argument("--apply", action="store_true")
    add_common_mutation_options(reconcile)
    gc = admin_sub.add_parser("gc")
    add_session_option(gc, suppress_default=True)
    gc.add_argument("--apply", action="store_true")
    add_common_mutation_options(gc)
    return parser


def operation_id(args: argparse.Namespace) -> str:
    value = getattr(args, "operation_id", None)
    return value or str(uuid.uuid4())


def mutation(
    action: str,
    args: argparse.Namespace,
    *,
    fields: dict[str, Any] | None = None,
    generation: int | None = None,
    session: str | None = None,
) -> dict[str, Any]:
    session = session if session is not None else session_id(getattr(args, "session_id", None))
    requested_operation = getattr(args, "operation_id", None)
    if requested_operation and session is not None:
        generation = journal_generation(session, requested_operation, generation if generation is not None else 0)
    if generation is None and action not in {"acquire", "drain-enter", "drain-exit", "admin-reconcile", "admin-gc"}:
        assert session is not None
        generation = current_generation(session)
    return control_request(
        action,
        session=session,
        generation=0 if generation is None and action == "acquire" else generation,
        write=True,
        operation_id=operation_id(args),
        fields=fields,
    )


def command_acquire(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    private_key, public_key = make_ssh_key(session)
    # Observation never renews. Reuse a saved operation's original generation
    # when retrying after a lost acknowledgement.
    generation = control_request("status", session=session)["result"]["generation"]
    requested_op = getattr(args, "operation_id", None)
    if requested_op:
        generation = journal_generation(session, requested_op, generation)
    fields = {"public_key": public_key}
    if args.ssh_host_port is not None: fields["ssh_host_port"] = args.ssh_host_port
    if args.cpu is not None: fields["cpu"] = args.cpu
    if args.memory is not None: fields["memory_mib"] = parse_memory(args.memory)
    if args.disk is not None: fields["disk_gib"] = parse_disk(args.disk)
    response = mutation("acquire", args, generation=generation, session=session, fields=fields)
    result = response.get("current_state", response["result"])
    if result is None or not result.get("effective_lease"):
        fail("lease_unavailable", "replayed allocation no longer has an active lease; inspect status")
    write_session_state(session, {"session_id": session, "task_id": result["task_id"],
                                 "generation": result["generation"], "private_key": str(private_key)})
    json_output(response)
    return 0



def command_ssh_info(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    assert session is not None
    response, info, config_path = fetch_ssh_info(session)
    if args.format == "json":
        json_output(response)
    else:
        sys.stdout.write(config_path.read_text(encoding="utf-8"))
    return 0


def command_ssh(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    assert session is not None
    _, _, config_path = fetch_ssh_info(session)
    ssh_args = list(args.ssh_args)
    if ssh_args and ssh_args[0] == "--":
        ssh_args = ssh_args[1:]
    return run_command(["ssh", "-F", str(config_path), "agent-vm", *ssh_args])


def command_exec(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    argv = list(args.argv)
    if not argv or argv[0] != "--": fail("invalid_request", "exec requires -- followed by a program and its arguments")
    argv = argv[1:]
    if not argv or any("\0" in value for value in argv): fail("invalid_request", "invalid execution argv")
    _, _, config_path = fetch_ssh_info(session)
    return run_command(["ssh", "-F", str(config_path), "-o", "BatchMode=yes", "--", "agent-vm", shlex.join(argv)])



def command_transfer(args: argparse.Namespace, direction: str) -> int:
    session = session_id(args.session_id)
    remote = args.destination if direction == "upload" else args.source
    if not remote.startswith("/") or "\0" in remote: fail("invalid_path", "remote path must be absolute")
    _, _, config_path = fetch_ssh_info(session)
    local = str(Path(args.source if direction == "upload" else args.destination).absolute())
    source, destination = (local, "agent-vm:" + remote) if direction == "upload" else ("agent-vm:" + remote, local)
    return run_command(["scp", "-F", str(config_path), "-o", "BatchMode=yes", "--", source, destination])



def command_export(args: argparse.Namespace) -> int:
    if not args.path.startswith("/") or "\0" in args.path: fail("invalid_path", "export path must be absolute")
    _, _, config_path = fetch_ssh_info(session_id(args.session_id))
    relative = args.path.lstrip("/") or "."
    # The tar stream alone owns stdout. No server-side archive is created.
    return run_command(["ssh", "-F", str(config_path), "-o", "BatchMode=yes", "--", "agent-vm",
                        shlex.join(["tar", "-C", "/", "-cf", "-", "--", relative])])



def command_sync(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", args.name) is None:
        fail("invalid_name", "--name must be one safe path segment")
    helper = Path(__file__).with_name("sync_worktree.py")
    if not helper.is_file(): fail("sync_helper_missing", "sync helper is missing")
    return run_command([
        sys.executable,
        str(helper),
        "--name",
        args.name,
        "--cli",
        str(Path(__file__).resolve()),
        "--session-id",
        session,
    ])



def command_port(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    assert session is not None
    generation = current_generation(session)
    if args.port_command == "list":
        response = control_request("port-list", session=session, generation=generation)
    elif args.port_command == "add":
        response = mutation(
            "port-add",
            args,
            fields={
                "name": args.name,
                "vm_port": args.guest_port,
                "port_protocol": args.protocol,
                **({"host_port": args.host_port} if args.host_port is not None else {}),
            },
            generation=generation,
            session=session,
        )
    else:
        response = mutation(
            "port-remove",
            args,
            fields={"name": args.name, "port_protocol": args.protocol},
            generation=generation,
            session=session,
        )
    json_output(response)
    return 0


def command_admin(args: argparse.Namespace) -> int:
    session = session_id(args.session_id)
    if args.admin_command == "status":
        response = control_request("admin-status", session=session)
    elif args.admin_command == "session":
        response = control_request("admin-session-list", session=session)
    elif args.admin_command == "drain":
        if args.drain_command == "status":
            response = control_request("drain-status", session=session)
        else:
            response = mutation(
                f"drain-{args.drain_command}",
                args,
                generation=0,
                session=session,
            )
    elif args.admin_command == "reconcile":
        response = mutation(
            "admin-reconcile",
            args,
            fields={"apply": bool(args.apply)},
            generation=0,
            session=session,
        )
    else:
        response = mutation(
            "admin-gc",
            args,
            fields={"apply": bool(args.apply)},
            generation=0,
            session=session,
        )
    json_output(response)
    return 0


def dispatch(args: argparse.Namespace) -> int:
    if args.command == "version":
        json_output({"version": VERSION, "protocol": PROTOCOL_VERSION})
        return 0
    if args.command == "help":
        build_parser().print_help()
        return 0
    if args.command == "doctor":
        response = control_request("doctor", session=session_id(args.session_id, required=False))
        json_output(response)
        return 0
    if args.command == "status":
        session = session_id(args.session_id)
        response = control_request("status", session=session)
        json_output(response)
        return 0
    if args.command == "acquire":
        return command_acquire(args)
    if args.command in {"renew", "release", "destroy", "restart"}:
        response = mutation(args.command, args)
        json_output(response)
        return 0
    if args.command == "resize":
        if args.live and (args.memory is None or args.cpu is not None or args.disk is not None):
            raise CliError("invalid_request", "--live requires only --memory; CPU/disk changes use --allow-restart")
        fields: dict[str, Any] = {"allow_restart": bool(args.allow_restart), "live_memory": bool(args.live)}
        if args.cpu is not None:
            fields["cpu"] = args.cpu
        if args.memory is not None:
            fields["memory_mib"] = parse_memory(args.memory)
        if args.disk is not None:
            fields["disk_gib"] = parse_disk(args.disk)
        response = mutation("resize", args, fields=fields)
        json_output(response)
        return 0
    if args.command == "ssh-info":
        return command_ssh_info(args)
    if args.command == "ssh":
        return command_ssh(args)
    if args.command == "exec":
        return command_exec(args)
    if args.command == "sync":
        return command_sync(args)
    if args.command == "upload":
        return command_transfer(args, "upload")
    if args.command == "download":
        return command_transfer(args, "download")
    if args.command == "export":
        return command_export(args)
    if args.command == "port":
        return command_port(args)
    if args.command == "admin":
        return command_admin(args)
    fail("unknown_command", "unknown command")
    return 2


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
        return dispatch(args)
    except CliError as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": exc.as_dict()}, sort_keys=True) + "\n")
        return exc.exit_code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
