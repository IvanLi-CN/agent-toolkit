#!/usr/bin/env python3
"""Manual Agent VM control-plane release builder and publisher.

This is an operator tool, not part of the public ``agent-vm`` lifecycle CLI.
Remote mutation is limited to the configured SSH alias and fixed release
wrapper actions.  The publisher never edits the control environment directly.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from typing import Any, Callable, Mapping, Protocol


try:
    from release_manifest import (
        MANIFEST_NAME,
        CLIENT_SIDECAR_NAME,
        PROTOCOL_VERSION,
        UNIT_EXEC_START,
        ManifestError,
        build_manifest,
        default_operations,
        load_manifest,
        sha256_file,
        verify_client_sidecar,
        verify_bundle,
    )
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from release_manifest import (
        MANIFEST_NAME,
        CLIENT_SIDECAR_NAME,
        PROTOCOL_VERSION,
        UNIT_EXEC_START,
        ManifestError,
        build_manifest,
        default_operations,
        load_manifest,
        sha256_file,
        verify_client_sidecar,
        verify_bundle,
    )


try:
    from agent_vm_release_wrapper import safe_extract_archive
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from agent_vm_release_wrapper import safe_extract_archive


SOURCE_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_POLL_SECONDS = 1.0
MAX_TIMEOUT_SECONDS = 300
MAX_POLL_SECONDS = 1.0
CONTROL_TRANSITION_STATES = {"preparing", "closing", "deleting", "failed"}
KNOWN_TASK_STATES = {"absent", "cached", "preparing", "active", "closing", "deleting", "failed"}
SOURCE_ARTIFACTS = (
    ("agent_vm.py", "skills/agent-vm/scripts/agent_vm.py", "client", 0o755),
    ("agent_vm_control.py", "skills/agent-vm-ops/scripts/agent_vm_control.py", "control", 0o755),
    ("release_manifest.py", "skills/agent-vm-ops/scripts/release_manifest.py", "support", 0o644),
    ("systemd/agent-vm-native-age-gc.service", "skills/agent-vm-ops/assets/systemd/agent-vm-native-age-gc.service", "unit", 0o644),
    ("systemd/agent-vm-native-age-gc.timer", "skills/agent-vm-ops/assets/systemd/agent-vm-native-age-gc.timer", "unit", 0o644),
    ("systemd/agent-vm-native-expire@.service", "skills/agent-vm-ops/assets/systemd/agent-vm-native-expire@.service", "unit", 0o644),
    ("systemd/agent-vm-native-reconcile.service", "skills/agent-vm-ops/assets/systemd/agent-vm-native-reconcile.service", "unit", 0o644),
)


class ReleaseError(Exception):
    def __init__(self, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.detail is not None:
            result["detail"] = self.detail
        return result


def _fail(code: str, message: str, detail: Any = None) -> None:
    raise ReleaseError(code, message, detail)


def _revision(value: str) -> str:
    if SOURCE_REVISION_RE.fullmatch(value) is None:
        _fail("invalid_source_revision", "source revision must be a 40-character lowercase Git revision")
    return value


def _read_regular(path: Path) -> bytes:
    try:
        info = path.lstat()
    except OSError:
        _fail("source_missing", f"source artifact is missing: {path.name}")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        _fail("source_invalid", f"source artifact is not a regular file: {path.name}")
    try:
        return path.read_bytes()
    except OSError:
        _fail("source_unreadable", f"source artifact cannot be read: {path.name}")


def _write_atomic(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + ".tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        try:
            temporary.unlink()
        except OSError:
            pass
        _fail("bundle_write_failed", f"cannot write release artifact: {path.name}")


def _git_revision(source_root: Path) -> str:
    try:
        process = subprocess.run(
            ["git", "-C", str(source_root), "rev-parse", "HEAD"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            text=True,
        )
    except OSError as exc:
        _fail("git_unavailable", "git is required when source revision is omitted")
    if process.returncode != 0:
        _fail("git_revision_unavailable", "source revision cannot be resolved")
    return _revision(process.stdout.strip())


def _artifact_entry(root: Path, name: str, role: str, mode: int) -> dict[str, Any]:
    path = root / Path(*PurePosixPath(name).parts)
    return {"name": name, "path": name, "role": role, "sha256": sha256_file(path), "mode": mode}


def _write_json(path: Path, value: Mapping[str, Any], mode: int = 0o644) -> None:
    _write_atomic(path, (json.dumps(dict(value), sort_keys=True, indent=2) + "\n").encode(), mode)


def _create_archive(root: Path, output: Path) -> None:
    output.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = output.with_name("." + output.name + ".tmp")
    try:
        with tarfile.open(temporary, mode="w") as archive:
            for path in sorted(root.rglob("*")):
                if not path.is_file() or path.is_symlink():
                    continue
                archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
        os.replace(temporary, output)
    except (OSError, tarfile.TarError) as exc:
        try:
            temporary.unlink()
        except OSError:
            pass
        _fail("bundle_write_failed", "cannot create release archive")


def build_release(source_root: Path, output: Path, source_revision: str | None = None) -> dict[str, Any]:
    source_root = source_root.resolve()
    if not source_root.is_dir():
        _fail("source_missing", "source root is not a directory")
    revision = _revision(source_revision) if source_revision is not None else _git_revision(source_root)
    with tempfile.TemporaryDirectory(prefix="agent-vm-release-") as temporary:
        root = Path(temporary)
        artifacts: list[dict[str, Any]] = []
        for destination_name, source_name, role, mode in SOURCE_ARTIFACTS:
            source = source_root / Path(*PurePosixPath(source_name).parts)
            data = _read_regular(source)
            destination = root / Path(*PurePosixPath(destination_name).parts)
            _write_atomic(destination, data, mode)
            artifact = _artifact_entry(root, destination_name, role, mode)
            artifact["name"] = "unit:" + Path(destination_name).name if role == "unit" else artifact["name"]
            artifacts.append(artifact)
        manifest = build_manifest(revision, artifacts, operations=default_operations())
        _write_json(root / MANIFEST_NAME, manifest)
        client_artifact = next(item for item in artifacts if item["role"] == "client")
        _write_json(root / CLIENT_SIDECAR_NAME, {
            "format": manifest["format"],
            "release_id": manifest["release_id"],
            "source_revision": manifest["source_revision"],
            "protocol": manifest["protocol"],
            "client_artifact": client_artifact,
            "client_view": manifest["client_view"],
        })
        _create_archive(root, output)
    return manifest


def _verify_unit_contents(root: Path, manifest: Mapping[str, Any]) -> None:
    for artifact in manifest["artifacts"]:
        if artifact["role"] != "unit":
            continue
        name = Path(artifact["path"]).name
        if name not in UNIT_EXEC_START and name != "agent-vm-native-age-gc.timer":
            _fail("unit_unverified", f"unit is not in the fixed allowlist: {name}")
        try:
            content = (root / Path(*PurePosixPath(artifact["path"]).parts)).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            _fail("unit_unverified", f"unit cannot be read: {name}")
        required = UNIT_EXEC_START.get(name, "Unit=agent-vm-native-age-gc.service")
        if required not in content or (name != "agent-vm-native-age-gc.timer" and "ExecStart=" not in content):
            _fail("unit_unverified", f"unit does not contain its fixed ExecStart: {name}")
        if any(token in content for token in ("systemctl stop", "systemctl disable", "ExecStop=", "ssh ", "curl ", "wget ")):
            _fail("unit_unverified", f"unit contains a forbidden control path: {name}")


def _verify_python_syntax(root: Path, manifest: Mapping[str, Any]) -> None:
    for artifact in manifest["artifacts"]:
        if artifact["role"] not in {"client", "control", "support"}:
            continue
        path = root / Path(*PurePosixPath(artifact["path"]).parts)
        try:
            compile(path.read_text(encoding="utf-8"), str(path), "exec")
        except (OSError, UnicodeError, SyntaxError):
            _fail("python_syntax_invalid", f"Python artifact cannot be compiled: {artifact['path']}")


def _reject_bundle_extras(root: Path, manifest: Mapping[str, Any]) -> None:
    allowed = {MANIFEST_NAME, CLIENT_SIDECAR_NAME} | {item["path"] for item in manifest["artifacts"]}
    for path in root.rglob("*"):
        if path.is_symlink():
            _fail("bundle_invalid", "bundle contains a symlink", {"path": path.relative_to(root).as_posix()})
        if path.is_file() and path.relative_to(root).as_posix() not in allowed:
            _fail("bundle_invalid", "bundle contains an unallowlisted file", {"path": path.relative_to(root).as_posix()})


def _verify_fixed_artifact_set(manifest: Mapping[str, Any]) -> None:
    expected = {(role, destination) for destination, _, role, _ in SOURCE_ARTIFACTS}
    actual = {(item["role"], item["path"]) for item in manifest["artifacts"]}
    if actual != expected:
        _fail("bundle_invalid", "manifest artifact set differs from the fixed release allowlist", {
            "expected": sorted(expected),
            "actual": sorted(actual),
        })


def _open_bundle(bundle: Path) -> tuple[tempfile.TemporaryDirectory[str], Path, dict[str, Any]]:
    temporary = tempfile.TemporaryDirectory(prefix="agent-vm-release-verify-")
    root = Path(temporary.name)
    try:
        if bundle.is_dir():
            for item in bundle.iterdir():
                destination = root / item.name
                if item.is_dir() and not item.is_symlink():
                    shutil.copytree(item, destination, symlinks=True)
                elif item.is_file() and not item.is_symlink():
                    shutil.copy2(item, destination)
                else:
                    _fail("bundle_invalid", "bundle contains a non-regular top-level entry")
        else:
            try:
                safe_extract_archive(bundle.read_bytes(), root)
            except OSError:
                _fail("bundle_invalid", "release bundle cannot be read")
        manifest = load_manifest(root / MANIFEST_NAME)
        verify_bundle(root, manifest)
        verify_client_sidecar(root, manifest)
        _reject_bundle_extras(root, manifest)
        _verify_fixed_artifact_set(manifest)
        _verify_python_syntax(root, manifest)
        _verify_unit_contents(root, manifest)
        return temporary, root, manifest
    except ManifestError as exc:
        temporary.cleanup()
        _fail(exc.code, exc.message, exc.detail)
    except ReleaseError:
        temporary.cleanup()
        raise


def verify_release(bundle: Path) -> dict[str, Any]:
    temporary, _, manifest = _open_bundle(bundle)
    temporary.cleanup()
    return {
        "verified": True,
        "release_id": manifest["release_id"],
        "source_revision": manifest["source_revision"],
        "protocol": manifest["protocol"],
        "artifacts": len(manifest["artifacts"]),
        "actions": len(manifest["actions"]),
    }


def _archive_bytes(bundle: Path) -> bytes:
    if bundle.is_file():
        try:
            return bundle.read_bytes()
        except OSError:
            _fail("bundle_invalid", "release bundle cannot be read")
    with tempfile.TemporaryDirectory(prefix="agent-vm-release-archive-") as temporary:
        output = Path(temporary) / "release.tar"
        _create_archive(bundle, output)
        return output.read_bytes()


class ReleaseTransport(Protocol):
    def wrapper(self, host: str, wrapper_path: str, action: str, transaction_id: str, release_id: str, payload: bytes | None = None) -> Mapping[str, Any]: ...
    def control(self, host: str, remote_control: str, request: Mapping[str, Any]) -> Mapping[str, Any]: ...


class SSHTransport:
    """OpenSSH transport with fixed command boundaries and JSON envelopes."""

    def __init__(self, *, timeout: float = 60):
        self.timeout = timeout

    @staticmethod
    def _parse(process: subprocess.CompletedProcess[bytes], label: str) -> Mapping[str, Any]:
        if process.returncode != 0:
            detail: Any = process.stderr.decode("utf-8", "replace")[-4000:]
            try:
                value = json.loads(process.stderr)
                if isinstance(value, dict):
                    detail = value
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
            _fail("remote_failed", f"{label} failed", detail)
        try:
            value = json.loads(process.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            _fail("remote_response_invalid", f"{label} did not return JSON")
        if not isinstance(value, dict):
            _fail("remote_response_invalid", f"{label} response is not an object")
        return value

    def _run(self, host: str, command: list[str], payload: bytes | None) -> Mapping[str, Any]:
        try:
            process = subprocess.run(
                ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", host, shlex.join(command)],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=self.timeout,
            )
        except FileNotFoundError:
            _fail("command_missing", "ssh is not installed")
        except subprocess.TimeoutExpired:
            _fail("remote_timeout", "remote release action timed out")
        return self._parse(process, command[0])

    def wrapper(self, host: str, wrapper_path: str, action: str, transaction_id: str, release_id: str, payload: bytes | None = None) -> Mapping[str, Any]:
        return self._run(host, [wrapper_path, action, "--transaction-id", transaction_id, "--release-id", release_id], payload)

    def control(self, host: str, remote_control: str, request: Mapping[str, Any]) -> Mapping[str, Any]:
        response = self._run(host, ["python3", remote_control], json.dumps(dict(request), sort_keys=True).encode())
        if response.get("ok") is False:
            error = response.get("error")
            if isinstance(error, dict):
                _fail(str(error.get("code", "remote_error")), str(error.get("message", "remote control failed")), error.get("detail"))
            _fail("remote_control_failed", "remote control rejected the request")
        return response


def _result(response: Mapping[str, Any]) -> dict[str, Any]:
    if response.get("ok") is False:
        error = response.get("error")
        if isinstance(error, Mapping):
            _fail(str(error.get("code", "remote_error")), str(error.get("message", "remote action failed")), error.get("detail"))
        _fail("remote_error", "remote action failed")
    value = response.get("result", response)
    if not isinstance(value, dict):
        _fail("remote_response_invalid", "remote result is not an object")
    return dict(value)


@dataclass
class ReleasePublisher:
    bundle: Path
    control_host: str
    wrapper_path: str
    remote_control: str = "/opt/agent-vm-native/agent_vm_control.py"
    client_target: Path | None = None
    session_id: str | None = None
    transport: ReleaseTransport | None = None
    sleep: Callable[[float], None] = time.sleep
    monotonic: Callable[[], float] = time.monotonic

    def _transport(self) -> ReleaseTransport:
        return self.transport or SSHTransport()

    def _request(self, manifest: Mapping[str, Any], action: str, *, session: str | None = None, write: bool = False) -> dict[str, Any]:
        spec = manifest["actions"].get(action)
        if not isinstance(spec, Mapping):
            _fail("unknown_action", f"release manifest does not declare action: {action}")
        request: dict[str, Any] = {
            "protocol": PROTOCOL_VERSION,
            "action": action,
            "compatibility": {
                "release_id": manifest["release_id"],
                "protocol": PROTOCOL_VERSION,
                "action": action,
                "request": dict(spec["request"]),
                "accepted_response": dict(spec["control_to_client"]),
            },
        }
        if session is not None:
            request["session_id"] = session
        if write:
            request["generation"] = 0
            request["operation_id"] = "release-" + uuid.uuid4().hex
        return request

    def _control(self, manifest: Mapping[str, Any], action: str, *, session: str | None = None, write: bool = False) -> dict[str, Any]:
        response = self._transport().control(self.control_host, self.remote_control, self._request(manifest, action, session=session, write=write))
        return _result(response)

    def _wrapper(self, action: str, transaction_id: str, release_id: str, payload: bytes | None = None) -> dict[str, Any]:
        response = self._transport().wrapper(self.control_host, self.wrapper_path, action, transaction_id, release_id, payload)
        return _result(response)

    @staticmethod
    def _healthy(metrics: Mapping[str, Any], doctor: Mapping[str, Any]) -> bool:
        pending = metrics.get("pending_operations")
        task_states = metrics.get("task_states")
        if metrics.get("draining") is not True or pending != [] or not isinstance(task_states, Mapping):
            return False
        if any(state not in KNOWN_TASK_STATES for state in task_states):
            return False
        for state in CONTROL_TRANSITION_STATES:
            count = task_states.get(state, 0)
            if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count:
                return False
        return bool(metrics.get("up")) and bool(doctor.get("ready")) and not doctor.get("issues")

    def _wait_for_convergence(self, manifest: Mapping[str, Any], timeout: float, poll: float) -> dict[str, Any]:
        deadline = self.monotonic() + timeout
        last: dict[str, Any] = {}
        while True:
            last = self._control(manifest, "admin-metrics")
            pending = last.get("pending_operations")
            states = last.get("task_states")
            if last.get("draining") is not True:
                _fail("drain_unverified", "admission drain was not confirmed during convergence", {"draining": last.get("draining")})
            if isinstance(states, Mapping) and any(state not in KNOWN_TASK_STATES for state in states):
                _fail("state_unverified", "control returned an unknown task state during convergence", {"task_states": states})
            converged = False
            if pending == [] and isinstance(states, Mapping):
                converged = all(
                    not isinstance(states.get(state, 0), bool)
                    and isinstance(states.get(state, 0), int)
                    and states.get(state, 0) >= 0
                    and states.get(state, 0) == 0
                    for state in CONTROL_TRANSITION_STATES
                )
            if converged:
                return last
            remaining = deadline - self.monotonic()
            if remaining <= 0:
                _fail("convergence_timeout", "pending operations or task transitions did not converge", {
                    "pending_operations": pending,
                    "task_states": states,
                    "draining": last.get("draining"),
                })
            self.sleep(min(poll, remaining))

    def _health(self, manifest: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        doctor = self._control(manifest, "doctor")
        metrics = self._control(manifest, "admin-metrics")
        if not self._healthy(metrics, doctor):
            _fail("remote_health_failed", "remote control health or timer checks failed", {
                "doctor": {"ready": doctor.get("ready"), "issues": doctor.get("issues")},
                "metrics": {"up": metrics.get("up"), "draining": metrics.get("draining"), "pending_operations": metrics.get("pending_operations"), "task_states": metrics.get("task_states")},
            })
        return doctor, metrics

    def _install_local_client(self, manifest: Mapping[str, Any]) -> None:
        if self.client_target is None:
            _fail("local_client_target_missing", "publish requires an explicit local client target")
        temporary, root, _ = _open_bundle(self.bundle)
        try:
            target = self.client_target
            if target.exists() and target.is_dir():
                client_path = target / "agent_vm.py"
            elif target.name == "agent_vm.py" or target.suffix == ".py":
                client_path = target
            else:
                client_path = target / "agent_vm.py"
            sidecar_path = client_path.with_name(CLIENT_SIDECAR_NAME)
            client_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            source_client = root / "agent_vm.py"
            source_manifest = root / CLIENT_SIDECAR_NAME
            staged_dir: Path | None = Path(tempfile.mkdtemp(prefix="agent-vm-client-", dir=str(client_path.parent)))
            assert staged_dir is not None
            staged_client = staged_dir / "agent_vm.py"
            staged_manifest = staged_dir / CLIENT_SIDECAR_NAME
            shutil.copy2(source_client, staged_client)
            shutil.copy2(source_manifest, staged_manifest)
            os.chmod(staged_client, 0o755)
            os.chmod(staged_manifest, 0o644)
            try:
                check = subprocess.run(
                    [sys.executable, str(staged_client), "version"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=30,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                _fail("local_client_selfcheck_failed", "new local client could not be self-checked")
            if check.returncode != 0:
                _fail("local_client_selfcheck_failed", "new local client self-check failed", check.stderr.decode("utf-8", "replace")[-2000:])
            backups: list[tuple[Path, Path]] = []
            installed_destinations: list[Path] = []
            installed = [(staged_client, client_path), (staged_manifest, sidecar_path)]
            try:
                for source, destination in installed:
                    if destination.exists() or destination.is_symlink():
                        if destination.is_symlink() or not destination.is_file():
                            _fail("local_client_target_invalid", f"local client target is not a regular file: {destination.name}")
                        backup = destination.with_name("." + destination.name + ".previous")
                        if backup.exists() or backup.is_symlink():
                            backup.unlink()
                        os.replace(destination, backup)
                        backups.append((backup, destination))
                    os.replace(source, destination)
                    installed_destinations.append(destination)
            except (OSError, ReleaseError) as exc:
                backed_up_destinations = {destination for _, destination in backups}
                for destination in reversed(installed_destinations):
                    if destination in backed_up_destinations:
                        continue
                    try:
                        if destination.exists() or destination.is_symlink():
                            destination.unlink()
                    except OSError:
                        pass
                for backup, destination in reversed(backups):
                    try:
                        if destination.exists() or destination.is_symlink():
                            destination.unlink()
                        os.replace(backup, destination)
                    except OSError:
                        pass
                if isinstance(exc, OSError):
                    _fail("local_client_install_failed", "local client files could not be installed")
                raise
            finally:
                for backup, _ in backups:
                    try:
                        backup.unlink()
                    except OSError:
                        pass
            shutil.rmtree(staged_dir, ignore_errors=True)
            staged_dir = None
        except OSError as exc:
            _fail("local_client_install_failed", "local client files could not be installed")
        finally:
            if staged_dir is not None:
                shutil.rmtree(staged_dir, ignore_errors=True)
            temporary.cleanup()

    def publish(self, *, timeout: float = DEFAULT_TIMEOUT_SECONDS, poll: float = DEFAULT_POLL_SECONDS, transaction_id: str | None = None) -> dict[str, Any]:
        if timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS:
            _fail("invalid_timeout", f"timeout must be between 0 and {MAX_TIMEOUT_SECONDS} seconds")
        if poll <= 0 or poll > MAX_POLL_SECONDS:
            _fail("invalid_poll_interval", f"poll interval must be no greater than {MAX_POLL_SECONDS} seconds")
        temporary, _, manifest = _open_bundle(self.bundle)
        try:
            payload = _archive_bytes(self.bundle)
        finally:
            temporary.cleanup()
        transaction = transaction_id or ("tx-" + uuid.uuid4().hex)
        session = self.session_id or ("release-" + transaction)
        staged = self._wrapper("stage", transaction, manifest["release_id"], payload)
        if staged.get("staged") is not True:
            _fail("stage_unverified", "remote wrapper did not confirm staging")
        verified = self._wrapper("verify", transaction, manifest["release_id"])
        if verified.get("verified") is not True:
            _fail("verification_unverified", "remote wrapper did not confirm release verification")
        drain = self._control(manifest, "drain-enter", session=session, write=True)
        if drain.get("draining") is not True:
            _fail("drain_unverified", "control did not confirm admission drain")
        self._wait_for_convergence(manifest, timeout, poll)
        activation = self._wrapper("activate", transaction, manifest["release_id"])
        if activation.get("activated") is not True:
            _fail("activation_unverified", "remote wrapper did not confirm activation")
        try:
            self._health(manifest)
        except ReleaseError as health_error:
            try:
                rollback_result = self._wrapper("rollback", transaction, manifest["release_id"])
                self._health(manifest)
            except ReleaseError as rollback_error:
                raise ReleaseError("rollback_failed", "remote health failed and the single rollback did not restore verified health", {
                    "health_error": health_error.as_dict(),
                    "rollback_error": rollback_error.as_dict(),
                    "draining": True,
                }) from rollback_error
            self._control(manifest, "drain-exit", session=session, write=True)
            return {
                "published": False,
                "rolled_back": True,
                "transaction_id": transaction,
                "release_id": manifest["release_id"],
                "rollback": rollback_result,
                "draining": False,
            }
        try:
            self._install_local_client(manifest)
        except ReleaseError as local_error:
            return {
                "published": False,
                "remote_healthy": True,
                "remote_release_id": activation.get("release_id", manifest["release_id"]),
                "transaction_id": transaction,
                "draining": True,
                "warnings": [{"code": "local_client_update_failed", "message": local_error.message, "detail": local_error.as_dict()}],
            }
        self._control(manifest, "drain-exit", session=session, write=True)
        return {
            "published": True,
            "rolled_back": False,
            "transaction_id": transaction,
            "release_id": manifest["release_id"],
            "local_client_updated": True,
            "draining": False,
        }

    def rollback(self, *, transaction_id: str, release_id: str) -> dict[str, Any]:
        temporary, _, manifest = _open_bundle(self.bundle)
        temporary.cleanup()
        session = self.session_id or ("release-" + transaction_id)
        self._control(manifest, "drain-enter", session=session, write=True)
        result = self._wrapper("rollback", transaction_id, release_id)
        self._health(manifest)
        self._control(manifest, "drain-exit", session=session, write=True)
        return {"rolled_back": True, "draining": False, **result}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-vm-release")
    subparsers = parser.add_subparsers(dest="action", required=True)
    build = subparsers.add_parser("build")
    build.add_argument("--source-root", type=Path, default=Path.cwd())
    build.add_argument("--source-revision")
    build.add_argument("--output", type=Path, required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--bundle", type=Path, required=True)
    publish = subparsers.add_parser("publish")
    publish.add_argument("--bundle", type=Path, required=True)
    publish.add_argument("--control-host", required=True)
    publish.add_argument("--wrapper", required=True)
    publish.add_argument("--remote-control", default="/opt/agent-vm-native/agent_vm_control.py")
    publish.add_argument("--client-target", type=Path)
    publish.add_argument("--session-id")
    publish.add_argument("--transaction-id")
    publish.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    publish.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS)
    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("--bundle", type=Path, required=True)
    rollback.add_argument("--control-host", required=True)
    rollback.add_argument("--wrapper", required=True)
    rollback.add_argument("--remote-control", default="/opt/agent-vm-native/agent_vm_control.py")
    rollback.add_argument("--session-id")
    rollback.add_argument("--transaction-id", required=True)
    rollback.add_argument("--release-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.action == "build":
            result = build_release(args.source_root, args.output, args.source_revision)
        elif args.action == "verify":
            result = verify_release(args.bundle)
        else:
            publisher = ReleasePublisher(
                bundle=args.bundle,
                control_host=args.control_host,
                wrapper_path=args.wrapper,
                remote_control=args.remote_control,
                client_target=getattr(args, "client_target", None),
                session_id=args.session_id,
            )
            if args.action == "publish":
                result = publisher.publish(timeout=args.timeout, poll=args.poll, transaction_id=args.transaction_id)
            else:
                result = publisher.rollback(transaction_id=args.transaction_id, release_id=args.release_id)
        sys.stdout.write(json.dumps(result, sort_keys=True, indent=2) + "\n")
        return 0
    except ReleaseError as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": exc.as_dict()}, sort_keys=True) + "\n")
        return 2
    except Exception as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": {"code": "internal_error", "message": type(exc).__name__}}, sort_keys=True) + "\n")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
