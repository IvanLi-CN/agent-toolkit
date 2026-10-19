#!/usr/bin/env python3
"""Synchronize Git-selected source without changing an Agent VM lease."""

from __future__ import annotations

import argparse
import hashlib
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
import uuid

OWNER = ".agent-vm-sync-owner.json"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
DIAGNOSTIC_OUTPUT_LIMIT = 8192
DIAGNOSTIC_TRUNCATION_MARKER = b"\n[TRUNCATED BY DIAGNOSTIC LIMIT]"
RAW_DIAGNOSTIC_CAPTURE_LIMIT = 1024 * 1024
STRUCTURED_OUTPUT_LIMIT = 16 * 1024 * 1024
CHILD_DRAIN_GRACE_SECONDS = 1.0
DEFAULT_CHILD_TIMEOUT_SECONDS = 600
SECRET_LABELS = r"(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|secret|token|authorization|private[_ -]?key|public[_ -]?key|api[_ -]?key|access[_ -]?key|client[_ -]?secret|credentials?|cookie|set[-_]?cookie)(?:[_-][A-Za-z0-9]+)*"
CAMEL_SECRET_LABELS = r"(?:password|passwd|passphrase|secret|token|authorization|privateKey|publicKey|apiKey|accessKey|clientSecret|credentials?|cookie|setCookie)[A-Z][A-Za-z0-9]*"
PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 _-]*PRIVATE KEY-----", re.IGNORECASE)
UNTERMINATED_PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*$", re.IGNORECASE)
AUTH_SCHEME_RE = re.compile(r"(?i)(['\"]?\bauthorization\b['\"]?\s*(?:[:=]\s*)?['\"]?(?:bearer|basic)\s+)(?:(['\"])(?:\\.|(?!\2)[^\r\n])*\2|[A-Za-z0-9._~+/=-]+)")
AUTH_DIGEST_RE = re.compile(r"(?i)(['\"]?\bauthorization\b['\"]?\s*(?:[:=]\s*)?['\"]?digest\s+)[^\r\n]+")
AUTH_BASIC_RE = re.compile(r"(?i)(\bbasic\s+)(?:(['\"])(?:\\.|(?!\2)[^\r\n])*\2|[A-Za-z0-9._~+/=-]+)")
COOKIE_HEADER_RE = re.compile(r"(?i)(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+")
SESSION_VALUE_RE = re.compile(r"(?i)(\b(?:session[_-]?id)\b\s*[:=]\s*)[^\s,;}\]\r\n]+")
DIGEST_FIELD_RE = re.compile(r"(?i)(\b(?:response|nonce|cnonce|opaque|nc|qop)\s*[:=]\s*)[^\s,;}\]\r\n]+")
JWT_RE = re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])")
COMMAND_MARKER_RE = re.compile(r"(?i)(\bAGENT_VM_COMMAND_ID\s*[:=]\s*)[^\s,;}\]\r\n]+")
CAMEL_SECRET_RE = re.compile(rf"(['\"]?\b{CAMEL_SECRET_LABELS}\b['\"]?\s*[:=]\s*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;{{}}\[\]\\\"']+)")
SECRET_DOUBLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)\"(?:\\.|[^\"\\])*\"")
SECRET_SINGLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)'(?:\\.|[^'\\])*'")
UNTERMINATED_SECRET_DOUBLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)\"(?:\\.|[^\"\\])*\\?$")
UNTERMINATED_SECRET_SINGLE_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)'(?:\\.|[^'\\])*\\?$")
SECRET_TOKEN_RE = re.compile(rf"(?i)(['\"]?\b{SECRET_LABELS}\b['\"]?\s*[:=]\s*)(?!(?:bearer|basic|digest)\b)([^\s,;}}\]\\\"']+)")
SSHPASS_RE = re.compile(r"(?i)(\bsshpass\b[ \t]+-p)[^\r\n]*")
URL_CREDENTIAL_RE = re.compile(r"(?i)(\b[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:)([^@\s/]+)(@)")
BEARER_RE = re.compile(r"(?i)(bearer\s+)(?:(['\"])(?:\\.|(?!\2)[^\r\n])*\2|[A-Za-z0-9._~+/=-]+)")


def redact_credential_match(match: re.Match[str]) -> str:
    prefix = match.group(1)
    quote = match.group(2)
    return prefix + (quote + "[REDACTED]" + quote if quote else "[REDACTED]")


def redact_stderr(value: bytes) -> bytes:
    text = value.decode("utf-8", "replace")
    text = PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", text)
    text = UNTERMINATED_PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", text)
    text = COOKIE_HEADER_RE.sub(r"\1[REDACTED]", text)
    text = AUTH_DIGEST_RE.sub(r"\1[REDACTED]", text)
    text = AUTH_SCHEME_RE.sub(redact_credential_match, text)
    text = AUTH_BASIC_RE.sub(redact_credential_match, text)
    text = SESSION_VALUE_RE.sub(r"\1[REDACTED]", text)
    text = DIGEST_FIELD_RE.sub(r"\1[REDACTED]", text)
    text = COMMAND_MARKER_RE.sub(r"\1[REDACTED]", text)
    text = CAMEL_SECRET_RE.sub(r"\1[REDACTED]", text)
    text = SECRET_DOUBLE_RE.sub(r'\1"[REDACTED]"', text)
    text = SECRET_SINGLE_RE.sub(r"\1'[REDACTED]'", text)
    text = UNTERMINATED_SECRET_DOUBLE_RE.sub(r'\1"[REDACTED]', text)
    text = UNTERMINATED_SECRET_SINGLE_RE.sub(r"\1'[REDACTED]", text)
    text = SECRET_TOKEN_RE.sub(r"\1[REDACTED]", text)
    text = SSHPASS_RE.sub(r"\1 [REDACTED]", text)
    text = URL_CREDENTIAL_RE.sub(r"\1[REDACTED]\3", text)
    text = BEARER_RE.sub(redact_credential_match, text)
    return JWT_RE.sub("[REDACTED JWT]", text).encode("utf-8")


def redact_and_bound_stderr(value: bytes, *, truncated: bool = False, limit: int = DIAGNOSTIC_OUTPUT_LIMIT) -> bytes:
    redacted = redact_stderr(value)
    if not truncated and len(redacted) <= limit:
        return redacted
    available = max(0, limit - len(DIAGNOSTIC_TRUNCATION_MARKER))
    return redacted[:available] + DIAGNOSTIC_TRUNCATION_MARKER


def write_redacted_stderr(value: bytes) -> None:
    if value:
        output = redact_and_bound_stderr(value)
        stream = getattr(sys.stderr, "buffer", None)
        if stream is not None:
            stream.write(output)
        else:
            sys.stderr.write(output.decode("utf-8", "replace"))
        sys.stderr.flush()

# Executed as a bounded Python action inside the guest, never installed as a service.
REMOTE = r'''
import ctypes, errno, fcntl, hashlib, json, os, pathlib, shutil, stat, sys

OWNER = ".agent-vm-sync-owner.json"
TAG = "agent-vm-source-v1"
TRUSTED_SHARED_ROOTS = {"/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"}
r = json.load(sys.stdin)
name, tx, action = r["name"], r["tx"], r["action"]
import re
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", name):
    raise ValueError("unsafe workspace name")
if not re.fullmatch(r"[0-9a-f]{32}", tx):
    raise ValueError("unsafe transaction")
parent = pathlib.Path("/workspace/worktrees") / name
src = parent / "src"
stage = parent / (".agent-vm-src-stage." + tx)
record = parent / (".agent-vm-sync-" + tx + ".json")

def directory(p, create=False):
    cur = pathlib.Path("/")
    for part in p.parts[1:]:
        cur = cur / part
        try:
            s = cur.lstat()
        except FileNotFoundError:
            if not create: raise
            try: cur.mkdir(mode=0o700)
            except FileExistsError: pass
            s = cur.lstat()
        if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):
            raise ValueError("non-directory or symlink: " + str(cur))
    if str(p.resolve(strict=True)) != str(p):
        raise ValueError("non-canonical directory")

def secure_directory(p):
    directory(p)
    cur = pathlib.Path("/")
    for part in p.parts[1:]:
        cur = cur / part
        s = cur.lstat()
        mode = stat.S_IMODE(s.st_mode)
        if str(cur) in TRUSTED_SHARED_ROOTS and stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and mode & 0o1000 and mode & 0o077 == 0o077:
            continue
        if mode & 0o022 or (cur == p and s.st_uid != os.geteuid()):
            raise ValueError("workspace directory ownership or mode is unsafe")

def read_json(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        s = os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077:
            raise ValueError("metadata is not a regular file")
        return json.load(f)

def file_sha256(p):
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def durable(p, obj):
    tmp = p.with_name(p.name + ".new")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, sort_keys=True)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, p)
        fsync_parent()
    finally:
        if tmp.exists(): tmp.unlink()

def fsync_parent():
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def owned(p):
    secure_directory(p)
    m = read_json(p / OWNER)
    if m.get("helper") != TAG or m.get("name") != name:
        raise ValueError("source is not owned by this helper")
    return m

def identity(p):
    if not os.path.lexists(p): return None
    m = owned(p)
    s = p.lstat()
    return [s.st_dev, s.st_ino, m["tx"]]

def remove_owned(p):
    owned(p)
    shutil.rmtree(p)
    fsync_parent()

directory(parent, create=(action == "begin"))
secure_directory(parent.parent)
secure_directory(parent)
if os.path.lexists(src):
    secure_directory(src)
lock = os.open(parent / ".agent-vm-sync.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
if not stat.S_ISREG(os.fstat(lock).st_mode): raise ValueError("invalid lock")
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    if action == "begin":
        baseline = identity(src)
        stage.mkdir(mode=0o700)  # exclusive, never adopts a stranger's staging directory
        durable(stage / OWNER, {"helper": TAG, "name": name, "tx": tx})
        durable(record, {"phase": "prepared", "baseline": baseline, "tx": tx})
        print(json.dumps({"stage": str(stage), "tx": tx}))
    elif action == "commit":
        state = read_json(record)
        if state["phase"] != "prepared": raise ValueError("transaction is not prepared")
        if identity(src) != state["baseline"]:
            raise ValueError("source changed during transfer; retry with a new transaction")
        if owned(stage)["tx"] != tx: raise ValueError("wrong stage owner")
        expected = r["manifest"]
        actual = {}
        for root, dirs, files in os.walk(stage, followlinks=False):
            for entry in list(dirs) + files:
                p = pathlib.Path(root) / entry
                rel = str(p.relative_to(stage))
                s = p.lstat()
                if stat.S_ISDIR(s.st_mode): continue
                if rel == OWNER: continue
                if stat.S_ISLNK(s.st_mode):
                    actual[rel] = {"link": os.readlink(p)}
                elif stat.S_ISREG(s.st_mode):
                    actual[rel] = {"sha256": file_sha256(p), "mode": stat.S_IMODE(s.st_mode)}
                else: raise ValueError("unsupported staged file: " + rel)
        if actual != expected: raise ValueError("staged files differ from source manifest")
        # Files and directories must be durable before the directory transaction.
        for root, dirs, files in os.walk(stage, followlinks=False):
            for entry in files:
                p = pathlib.Path(root) / entry
                if p.is_symlink(): continue
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
                try: os.fsync(fd)
                finally: os.close(fd)
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
        if state["baseline"] is None:
            os.rename(stage, src)
        else:
            libc = ctypes.CDLL(None, use_errno=True)
            exchange = getattr(libc, "renameat2", None)
            if exchange is None: raise RuntimeError("atomic directory exchange is unavailable")
            if exchange(-100, os.fsencode(stage), -100, os.fsencode(src), 2) != 0:
                e = ctypes.get_errno()
                raise OSError(e, os.strerror(e))
        fsync_parent()
        state["phase"] = "committed"
        durable(record, state)
        print(json.dumps({"committed": True, "tx": tx, "target": str(src)}))
    elif action in ("abort", "finish"):
        state = read_json(record)
        # Source marker detects a commit even if control died before recording it.
        committed = os.path.lexists(src) and owned(src)["tx"] == tx
        if action == "abort" and (committed or state["phase"] == "committed"):
            print(json.dumps({"unverified": True, "record": str(record)}))
        else:
            if action == "finish" and not committed:
                raise ValueError("commit is not confirmed; retaining recovery material")
            if os.path.lexists(stage): remove_owned(stage)
            record.unlink(); fsync_parent()
            print(json.dumps({"cleaned": True}))
    else: raise ValueError("unknown action")
finally:
    os.close(lock)
'''


class SyncFailure(Exception):
    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


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


def _linux_process_record(pid: int) -> tuple[str, int] | None:
    """Return a Linux process start identity and process group id."""
    if sys.platform != "linux":
        return None
    try:
        value = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None
    close_paren = value.rfind(")")
    if close_paren < 0:
        return None
    fields = value[close_paren + 2 :].split()
    if len(fields) <= 19:
        return None
    try:
        process_group = int(fields[2])
    except ValueError:
        return None
    if process_group <= 1:
        return None
    return fields[19], process_group


def _linux_group_members(process_group: int) -> dict[int, tuple[str, int]]:
    members: dict[int, tuple[str, int]] = {}
    try:
        entries = Path("/proc").iterdir()
    except OSError:
        return members
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        record = _linux_process_record(pid)
        if record is not None and record[1] == process_group:
            members[pid] = record
    return members


def _linux_signal_process(pid: int, expected: tuple[str, int], sig: signal.Signals) -> bool:
    current = _linux_process_record(pid)
    if current != expected:
        return False
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return True


def _terminate_process_group(process: subprocess.Popen, *, tracked_members: dict[int, tuple[str, int]] | None = None) -> None:
    if os.name == "posix" and sys.platform == "linux":
        # A negative-PGID kill remains vulnerable to PGID reuse after the
        # leader exits. Track members while the leader is alive, then signal
        # each PID only after rechecking its start identity and PGID.
        members = dict(tracked_members or {})
        leader = _linux_process_record(process.pid)
        if leader is not None:
            members.update(_linux_group_members(leader[1]))
        for pid, identity in list(members.items()):
            _linux_signal_process(pid, identity, signal.SIGTERM)
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            pass
        for pid, identity in list(members.items()):
            _linux_signal_process(pid, identity, signal.SIGKILL)
    elif os.name == "posix":
        # On platforms without /proc, retain group cleanup only while the
        # session leader is alive and still owns its PGID.
        group_id: int | None = None
        if process.poll() is None:
            try:
                candidate = os.getpgid(process.pid)
                if candidate == process.pid:
                    group_id = candidate
                    os.killpg(group_id, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
            if group_id is not None:
                try:
                    os.killpg(group_id, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
    else:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        if os.name == "posix" and sys.platform == "linux":
            leader = _linux_process_record(process.pid)
            if leader is not None:
                _linux_signal_process(process.pid, leader, signal.SIGKILL)
        else:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def _run_bounded(argv: list[str], *, input_data: bytes | None = None, timeout: float | None = None,
                 stdout_limit: int = DIAGNOSTIC_OUTPUT_LIMIT, structured_stdout: bool = False) -> subprocess.CompletedProcess:
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE if input_data is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        close_fds=True,
        start_new_session=os.name == "posix",
    )
    selector = selectors.DefaultSelector()
    stdout_capture = _BoundedCapture(stdout_limit, tail=False)
    # Retain a bounded prefix so discarded bytes cannot expose an unlabeled
    # credential suffix after the diagnostic is redacted.
    stderr_capture = _BoundedCapture(RAW_DIAGNOSTIC_CAPTURE_LIMIT, tail=False)
    input_view = memoryview(input_data or b"")
    input_offset = 0
    tracked_members: dict[int, tuple[str, int]] = {}
    last_group_scan = 0.0

    def refresh_group_members(*, force: bool = False) -> None:
        nonlocal last_group_scan
        if sys.platform != "linux":
            return
        now = time.monotonic()
        if not force and now - last_group_scan < 0.05:
            return
        last_group_scan = now
        leader = _linux_process_record(process.pid)
        if leader is not None:
            tracked_members.update(_linux_group_members(leader[1]))

    refresh_group_members(force=True)

    def close_stream(stream):
        try:
            selector.unregister(stream)
        except (KeyError, ValueError):
            pass
        try:
            stream.close()
        except OSError:
            pass

    for stream, kind in ((process.stdout, "stdout"), (process.stderr, "stderr")):
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
            refresh_group_members()
            if process.poll() is not None and drain_deadline is None:
                if process.stdin is not None:
                    close_stream(process.stdin)
                drain_deadline = time.monotonic() + CHILD_DRAIN_GRACE_SECONDS
            deadlines = [value for value in (deadline, drain_deadline) if value is not None]
            remaining = None if not deadlines else min(deadlines) - time.monotonic()
            if remaining is not None and remaining <= 0:
                if deadline is not None and (drain_deadline is None or deadline <= drain_deadline):
                    _terminate_process_group(process, tracked_members=tracked_members)
                    raise subprocess.TimeoutExpired(argv, effective_timeout, output=stdout_capture.finish(marker=False), stderr=redact_and_bound_stderr(stderr_capture.finish(marker=False), truncated=stderr_capture.seen > stderr_capture.limit))
                _terminate_process_group(process, tracked_members=tracked_members)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        close_stream(stream)
                continue
            if not selector.get_map():
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    _terminate_process_group(process, tracked_members=tracked_members)
                    raise subprocess.TimeoutExpired(argv, effective_timeout, output=stdout_capture.finish(marker=False), stderr=redact_and_bound_stderr(stderr_capture.finish(marker=False), truncated=stderr_capture.seen > stderr_capture.limit))
                break
            select_timeout = min(remaining, 0.05) if remaining is not None else 0.05
            for key, _ in selector.select(select_timeout):
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
        completed = subprocess.CompletedProcess(argv, process.wait(), stdout_capture.finish(marker=not structured_stdout), redact_and_bound_stderr(stderr_capture.finish(marker=False), truncated=stderr_capture.seen > stderr_capture.limit))
        completed.stdout_truncated = stdout_capture.seen > stdout_capture.limit
        return completed
    finally:
        if process.poll() is None:
            _terminate_process_group(process, tracked_members=tracked_members)
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


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    capture_output = kwargs.pop("capture_output", False)
    result = _run_bounded(argv, input_data=kwargs.pop("input", None), timeout=kwargs.pop("timeout", DEFAULT_CHILD_TIMEOUT_SECONDS),
                          stdout_limit=kwargs.pop("stdout_limit", DIAGNOSTIC_OUTPUT_LIMIT),
                          structured_stdout=kwargs.pop("structured_stdout", False))
    if kwargs.pop("check", False) and result.returncode:
        raise subprocess.CalledProcessError(result.returncode, argv, result.stdout, result.stderr)
    if kwargs:
        raise TypeError(f"unsupported run options: {', '.join(sorted(kwargs))}")
    return result


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def selected_files(root: Path) -> tuple[list[bytes], dict]:
    modules = run(["git", "-C", str(root), "ls-files", "--stage", "-z"], capture_output=True,
                  stdout_limit=STRUCTURED_OUTPUT_LIMIT, structured_stdout=True)
    if modules.returncode:
        raise SyncFailure("cannot inspect Git index", modules.returncode)
    if getattr(modules, "stdout_truncated", False) or (modules.stdout and not modules.stdout.endswith(b"\0")):
        raise SyncFailure("Git index inventory is truncated or malformed")
    if any(entry.startswith(b"160000 ") for entry in modules.stdout.split(b"\0")):
        raise SyncFailure("submodules are unsupported; use explicit native upload/rsync")
    result = run(["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"], capture_output=True,
                 stdout_limit=STRUCTURED_OUTPUT_LIMIT, structured_stdout=True)
    if result.returncode:
        raise SyncFailure("cannot select Git files", result.returncode)
    if getattr(result, "stdout_truncated", False) or (result.stdout and not result.stdout.endswith(b"\0")):
        raise SyncFailure("Git file inventory is truncated or malformed")
    names, manifest = [], {}
    for raw in sorted(set(result.stdout.split(b"\0")) - {b""}):
        parts = raw.split(b"/")
        if raw.startswith(b"/") or any(p in (b"", b".", b"..") for p in parts):
            raise SyncFailure("unsafe Git file path")
        if b".git" in parts:
            continue
        name = os.fsdecode(raw)
        if name == OWNER:
            raise SyncFailure("source uses the helper's reserved ownership filename")
        source = root / name
        # lstat on the leaf alone would follow a replaced parent symlink.
        parent = root
        absent = False
        for part in parts[:-1]:
            parent = parent / os.fsdecode(part)
            try:
                mode = parent.lstat().st_mode
            except FileNotFoundError:
                absent = True
                break
            if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
                raise SyncFailure("source parent is not a real directory: " + repr(str(parent)))
        if absent:
            continue
        try:
            s = source.lstat()
        except FileNotFoundError:
            continue  # tracked deletion
        if stat.S_ISLNK(s.st_mode):
            item = {"link": os.readlink(source)}
        elif stat.S_ISREG(s.st_mode):
            item = {"sha256": file_sha256(source), "mode": stat.S_IMODE(s.st_mode)}
        else:
            raise SyncFailure("unsupported source file: " + repr(name))
        names.append(raw)
        manifest[name] = item
    return names, manifest


def remote(ssh: str, config: Path, payload: dict) -> subprocess.CompletedProcess:
    return run([ssh, "-F", str(config), "-o", "BatchMode=yes", "agent-vm",
                "python3 -c " + shlex.quote(REMOTE)], input=json.dumps(payload).encode(), capture_output=True)


def sync(name: str, cli: str = "agent-vm", ssh: str = "ssh", rsync: str = "rsync",
         session_id: str | None = None) -> int:
    if not NAME.fullmatch(name):
        raise SyncFailure("--name must be a safe single segment (letters, digits, underscore, hyphen)")
    git = run(["git", "rev-parse", "--show-toplevel"], capture_output=True)
    if git.returncode:
        raise SyncFailure("run sync inside a Git worktree", git.returncode)
    root = Path(os.fsdecode(git.stdout.rstrip(b"\n"))).resolve()
    names, manifest = selected_files(root)  # reject submodules before any remote action
    info_argv = [cli, "ssh-info", "--format", "ssh-config"]
    if session_id is not None:
        info_argv.extend(["--session-id", session_id])
    info = run(info_argv, capture_output=True)
    if info.returncode:
        write_redacted_stderr(info.stderr)
        raise SyncFailure("cannot obtain an active VM SSH configuration", info.returncode)
    if not info.stdout.strip():
        raise SyncFailure("CLI returned empty SSH configuration")
    tx = uuid.uuid4().hex
    base = {"name": name, "tx": tx}
    prepared, committing = False, False
    with tempfile.TemporaryDirectory(prefix="agent-vm-sync-") as temp:
        config = Path(temp) / "ssh_config"
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f: f.write(info.stdout)
        listing = Path(temp) / "files.nul"
        listing.write_bytes(b"\0".join(names) + (b"\0" if names else b""))
        listing.chmod(0o600)
        try:
            begin = remote(ssh, config, {**base, "action": "begin"})
            if begin.returncode:
                write_redacted_stderr(begin.stderr)
                raise SyncFailure("remote preparation failed; existing source was retained", begin.returncode)
            prepared = True
            stage = json.loads(begin.stdout)["stage"]
            expected = f"/workspace/worktrees/{name}/.agent-vm-src-stage.{tx}"
            if stage != expected: raise SyncFailure("remote returned an unexpected stage path")
            transport = shlex.join([ssh, "-F", str(config), "-o", "BatchMode=yes"])
            transfer = run([rsync, "-a", "--from0", "--files-from=" + str(listing), "--relative",
                            "-e", transport, str(root) + "/", "agent-vm:" + stage + "/"], capture_output=True)
            if transfer.returncode:
                write_redacted_stderr(transfer.stderr)
                raise SyncFailure("transfer failed; existing source was retained", transfer.returncode)
            committing = True
            commit = remote(ssh, config, {**base, "action": "commit", "manifest": manifest})
            if commit.returncode:
                write_redacted_stderr(commit.stderr)
                # SSH failure or control crash can occur after rename, before acknowledgement.
                raise SyncFailure(f"commit unverified (exit {commit.returncode}); retain recovery record "
                                  f"/workspace/worktrees/{name}/.agent-vm-sync-{tx}.json", 75)
            try:
                response = json.loads(commit.stdout)
            except (ValueError, UnicodeError) as e:
                raise SyncFailure("commit acknowledgement unreadable; recovery material retained", 75) from e
            if response.get("committed") is not True or response.get("tx") != tx:
                raise SyncFailure("commit acknowledgement is invalid; recovery material retained", 75)
            finish = remote(ssh, config, {**base, "action": "finish"})
            if finish.returncode:
                write_redacted_stderr(finish.stderr)
                print("source committed; cleanup incomplete, recovery material retained", file=sys.stderr)
            print(json.dumps({"synced": True, "target": f"/workspace/worktrees/{name}/src", "files": len(names)}))
            return 0
        finally:
            if prepared and not committing:
                try:
                    abort = remote(ssh, config, {**base, "action": "abort"})
                except OSError:
                    print("stage cleanup incomplete; recovery material retained for " + tx, file=sys.stderr)
                else:
                    if abort.returncode:
                        print("stage cleanup incomplete; recovery material retained for " + tx, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--cli", default="agent-vm", help="installed CLI path (or candidate client)")
    parser.add_argument("--session-id", help="explicit session identity passed to the CLI")
    args = parser.parse_args()
    try:
        return sync(args.name, args.cli, session_id=args.session_id)
    except SyncFailure as e:
        write_redacted_stderr((str(e) + "\n").encode("utf-8", "replace"))
        return e.code
    except (OSError, ValueError, KeyError) as e:
        print("sync failed: " + redact_stderr(str(e).encode()).decode("utf-8", "replace")[:DIAGNOSTIC_OUTPUT_LIMIT], file=sys.stderr)
        return 1
    except Exception as e:
        print("sync failed: " + redact_stderr(str(e).encode()).decode("utf-8", "replace")[:DIAGNOSTIC_OUTPUT_LIMIT], file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
