#!/usr/bin/env python3
"""Narrow root-owned activation wrapper for Agent VM control releases.

The wrapper is a deployment prerequisite.  It intentionally exposes only
stage, verify, activate, rollback, and status actions; it never accepts an
arbitrary destination, shell command, configuration file, or state database
path from the caller.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, Mapping


try:
    from release_manifest import (
        MANIFEST_NAME,
        UNIT_CONTENT_SHA256,
        UNIT_EXEC_START,
        ManifestError,
        load_manifest,
        sha256_file,
        verify_client_sidecar,
        verify_bundle,
    )
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from release_manifest import (
        MANIFEST_NAME,
        UNIT_CONTENT_SHA256,
        UNIT_EXEC_START,
        ManifestError,
        load_manifest,
        sha256_file,
        verify_client_sidecar,
        verify_bundle,
    )


DEFAULT_CONFIG_PATH = Path("/etc/agent-vm-native/release-wrapper.json")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
RELEASE_ID_RE = re.compile(r"^[0-9a-f]{40}$")
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
FORBIDDEN_CONFIG_NAMES = {"config.json", "state.sqlite3", "control.lock", "admission.lock"}
FIXED_UNIT_NAMES = tuple(sorted(set(UNIT_EXEC_START) | {"agent-vm-native-age-gc.timer"}))
FIXED_ARTIFACTS = {
    ("client", "agent_vm.py"),
    ("control", "agent_vm_control.py"),
    ("support", "release_manifest.py"),
    *{("unit", "systemd/" + name) for name in FIXED_UNIT_NAMES},
}
FIXED_ARTIFACT_MODES = {
    ("client", "agent_vm.py"): 0o755,
    ("control", "agent_vm_control.py"): 0o755,
    ("support", "release_manifest.py"): 0o644,
    **{("unit", "systemd/" + name): 0o644 for name in FIXED_UNIT_NAMES},
}


class WrapperError(Exception):
    def __init__(self, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.detail is not None:
            value["detail"] = self.detail
        return value


def _fail(code: str, message: str, detail: Any = None) -> None:
    raise WrapperError(code, message, detail)


def _safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or ID_RE.fullmatch(value) is None:
        _fail("invalid_request", f"{label} is invalid")
    return value


def _release_id(value: Any) -> str:
    if not isinstance(value, str) or RELEASE_ID_RE.fullmatch(value) is None:
        _fail("invalid_request", "release_id must be a 40-character lowercase Git revision")
    return value


def _absolute_path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        _fail("wrapper_config_invalid", f"{label} must be an absolute path")
    path = Path(value)
    if any(part == ".." for part in path.parts):
        _fail("wrapper_config_invalid", f"{label} cannot contain parent traversal")
    return path


def _paths_overlap(left: Path, right: Path) -> bool:
    left_resolved = left.resolve(strict=False)
    right_resolved = right.resolve(strict=False)
    return left_resolved == right_resolved or left_resolved in right_resolved.parents or right_resolved in left_resolved.parents


def _read_json(path: Path, code: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        _fail(code, f"cannot read JSON: {path.name}")
    if not isinstance(value, dict):
        _fail(code, f"JSON root must be an object: {path.name}")
    return value


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> dict[str, Any]:
    raw = _read_json(path, "wrapper_config_invalid")
    required = {
        "release_root",
        "staging_root",
        "current_link",
        "previous_link",
        "control_path",
        "unit_dir",
        "state_root",
    }
    missing = sorted(required - set(raw))
    if missing:
        _fail("wrapper_config_invalid", "wrapper config is missing required fields", {"fields": missing})
    config = {key: _absolute_path(raw[key], key) for key in required}
    owner_uid = raw.get("owner_uid", 0)
    if isinstance(owner_uid, bool) or not isinstance(owner_uid, int) or owner_uid < 0:
        _fail("wrapper_config_invalid", "owner_uid must be a non-negative integer")
    config["owner_uid"] = owner_uid
    if raw.get("require_drained", True) is not True:
        _fail("wrapper_config_invalid", "release activation must require admission drain")
    config["require_drained"] = True
    unit_names = raw.get("unit_names", list(FIXED_UNIT_NAMES))
    if not isinstance(unit_names, list) or not all(isinstance(item, str) for item in unit_names) or sorted(unit_names) != list(FIXED_UNIT_NAMES):
        _fail("wrapper_config_invalid", "unit_names must equal the fixed systemd unit set")
    config["unit_names"] = tuple(unit_names)
    for path_key in ("release_root", "staging_root", "state_root"):
        if config[path_key].name in FORBIDDEN_CONFIG_NAMES:
            _fail("wrapper_config_invalid", f"{path_key} cannot target durable control state")
    if config["current_link"].parent != config["release_root"].parent or config["previous_link"].parent != config["release_root"].parent:
        _fail("wrapper_config_invalid", "current and previous links must be release-root siblings")
    if _paths_overlap(config["current_link"], config["previous_link"]):
        _fail("wrapper_config_invalid", "current and previous links must be distinct")
    protected = tuple(config[key] for key in (
        "release_root", "staging_root", "state_root", "current_link", "previous_link", "control_path", "unit_dir",
    ))
    for index, left in enumerate(protected):
        for right in protected[index + 1:]:
            if _paths_overlap(left, right):
                _fail("wrapper_config_invalid", "wrapper paths must not overlap", {"left": str(left), "right": str(right)})
    return config


def _mkdir_private(path: Path, mode: int = 0o700) -> None:
    try:
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                _fail("wrapper_io_error", f"private path is not a directory: {path.name}")
        path.mkdir(mode=mode, parents=True, exist_ok=True)
        os.chmod(path, mode)
    except OSError as exc:
        _fail("wrapper_io_error", f"cannot prepare private directory: {path.name}")


@contextmanager
def _release_lock(config: Mapping[str, Any]):
    """Serialize all root-owned release staging and activation transitions."""
    lock_root = Path(config["state_root"])
    _mkdir_private(lock_root)
    lock_path = lock_root / ".release-wrapper.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        _fail("wrapper_lock_unavailable", "cannot open the release transaction lock")
    try:
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        except OSError as exc:
            _fail("wrapper_lock_unavailable", "cannot acquire the release transaction lock")
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(descriptor)
        except OSError:
            pass


def _safe_member_path(name: str) -> Path:
    if not name or "\x00" in name or "\\" in name:
        _fail("unsafe_archive", "archive member name is invalid")
    parsed = PurePosixPath(name)
    if parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts):
        _fail("unsafe_archive", "archive member escapes staging root", {"member": name})
    return Path(*parsed.parts)


def safe_extract_archive(payload: bytes, destination: Path) -> None:
    if len(payload) > MAX_ARCHIVE_BYTES:
        _fail("archive_too_large", "staging archive exceeds the fixed size limit")
    _mkdir_private(destination)
    seen: set[str] = set()
    total = 0
    try:
        archive = tarfile.open(fileobj=io.BytesIO(payload), mode="r:")
    except (OSError, tarfile.TarError) as exc:
        _fail("unsafe_archive", "staging input is not a readable tar archive")
    try:
        for member in archive.getmembers():
            relative = _safe_member_path(member.name)
            normalized = relative.as_posix()
            if normalized in seen:
                _fail("unsafe_archive", "archive contains duplicate members", {"member": normalized})
            seen.add(normalized)
            if not member.isfile() or member.issym() or member.islnk() or member.isdev() or member.isdir():
                _fail("unsafe_archive", "archive may contain regular files only", {"member": normalized})
            if member.size < 0 or member.size > MAX_FILE_BYTES:
                _fail("archive_too_large", "archive member exceeds the fixed size limit", {"member": normalized})
            total += member.size
            if total > MAX_ARCHIVE_BYTES:
                _fail("archive_too_large", "staging archive contents exceed the fixed size limit")
            target = destination / relative
            parent = target.parent
            _mkdir_private(parent, 0o700)
            source = archive.extractfile(member)
            if source is None:
                _fail("unsafe_archive", "archive member cannot be read", {"member": normalized})
            with target.open("xb") as handle:
                shutil.copyfileobj(source, handle, length=1024 * 1024)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(target, member.mode & 0o777)
    finally:
        archive.close()


def _transaction_dir(config: Mapping[str, Any], transaction_id: str) -> Path:
    root = Path(config["staging_root"])
    _mkdir_private(root)
    return root / transaction_id


def _metadata_path(config: Mapping[str, Any], transaction_id: str) -> Path:
    return _transaction_dir(config, transaction_id) / ".wrapper-state.json"


def _write_json(path: Path, value: Mapping[str, Any], mode: int = 0o600) -> None:
    _mkdir_private(path.parent)
    temporary = path.with_name("." + path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(dict(value), handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        _fail("wrapper_io_error", f"cannot write wrapper record: {path.name}")


def _load_transaction(config: Mapping[str, Any], transaction_id: str) -> dict[str, Any]:
    path = _metadata_path(config, transaction_id)
    try:
        info = path.lstat()
    except OSError:
        _fail("transaction_missing", "release transaction has not been staged")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        _fail("transaction_missing", "release transaction has not been staged")
    return _read_json(path, "transaction_invalid")


def _require_owned_regular(path: Path, owner_uid: int, mode: int | None = None) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        _fail("artifact_unverified", f"artifact cannot be inspected: {path.name}")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        _fail("artifact_unverified", f"artifact is not a regular file: {path.name}")
    if info.st_uid != owner_uid:
        _fail("artifact_owner_mismatch", f"artifact owner differs: {path.name}", {"expected": owner_uid, "actual": info.st_uid})
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        _fail("artifact_mode_mismatch", f"artifact mode differs: {path.name}", {"expected": mode, "actual": stat.S_IMODE(info.st_mode)})


def _verify_unit_contents(root: Path, manifest: Mapping[str, Any]) -> None:
    for item in manifest["artifacts"]:
        if item["role"] != "unit":
            continue
        name = Path(item["path"]).name
        if name not in UNIT_EXEC_START and name != "agent-vm-native-age-gc.timer":
            _fail("unit_unverified", f"unit is not in the fixed allowlist: {name}")
        path = root / Path(*PurePosixPath(item["path"]).parts)
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            _fail("unit_unverified", f"unit cannot be read: {name}")
        try:
            digest = sha256_file(path)
        except ManifestError:
            _fail("unit_unverified", f"unit cannot be hashed: {name}")
        if digest != UNIT_CONTENT_SHA256[name]:
            _fail("unit_unverified", f"unit bytes differ from the fixed policy: {name}")
        required = UNIT_EXEC_START.get(name, "Unit=agent-vm-native-age-gc.service")
        if required not in content or (name != "agent-vm-native-age-gc.timer" and "ExecStart=" not in content):
            _fail("unit_unverified", f"unit does not contain its fixed ExecStart: {name}")
        if any(token in content for token in ("systemctl stop", "systemctl disable", "ExecStop=", "ssh ", "curl ", "wget ")):
            _fail("unit_unverified", f"unit contains a forbidden control path: {name}")


def _reject_transaction_extras(root: Path, manifest: Mapping[str, Any]) -> None:
    allowed = {MANIFEST_NAME, "client-release.json", ".wrapper-state.json", ".verified.json"} | {
        item["path"] for item in manifest["artifacts"]
    }
    for path in root.rglob("*"):
        if path.is_symlink():
            _fail("artifact_unverified", "transaction contains a symlink", {"path": path.relative_to(root).as_posix()})
        if path.is_file() and path.relative_to(root).as_posix() not in allowed:
            _fail("artifact_unverified", "transaction contains an unallowlisted file", {"path": path.relative_to(root).as_posix()})


def _verify_fixed_artifacts(config: Mapping[str, Any], manifest: Mapping[str, Any]) -> None:
    declared = {(item["role"], item["path"]) for item in manifest["artifacts"]}
    if declared != FIXED_ARTIFACTS:
        _fail(
            "artifact_unverified",
            "manifest artifact set differs from the fixed release allowlist",
            {"expected": sorted(FIXED_ARTIFACTS), "actual": sorted(declared)},
        )
    for item in manifest["artifacts"]:
        expected_mode = FIXED_ARTIFACT_MODES[(item["role"], item["path"])]
        if item["mode"] != expected_mode:
            _fail(
                "artifact_mode_mismatch",
                f"fixed release artifact mode differs: {item['path']}",
                {"expected": expected_mode, "actual": item["mode"]},
            )


def _verify_python_syntax(root: Path, manifest: Mapping[str, Any]) -> None:
    for item in manifest["artifacts"]:
        if item["role"] not in {"client", "control", "support"}:
            continue
        path = root / Path(*PurePosixPath(item["path"]).parts)
        try:
            source = path.read_text(encoding="utf-8")
            compile(source, str(path), "exec")
        except (OSError, UnicodeError, SyntaxError) as exc:
            _fail("python_syntax_invalid", f"Python artifact cannot be compiled: {item['path']}")


def _verify_transaction(config: Mapping[str, Any], transaction_id: str, release_id: str) -> dict[str, Any]:
    transaction = _load_transaction(config, transaction_id)
    if transaction.get("release_id") != release_id:
        _fail("transaction_conflict", "transaction is bound to another release")
    root = _transaction_dir(config, transaction_id)
    try:
        manifest = verify_bundle(root)
        verify_client_sidecar(root, manifest)
    except ManifestError as exc:
        _fail(exc.code, exc.message, exc.detail)
    _reject_transaction_extras(root, manifest)
    _verify_fixed_artifacts(config, manifest)
    _verify_python_syntax(root, manifest)
    _verify_unit_contents(root, manifest)
    owner_uid = int(config["owner_uid"])
    _require_owned_regular(root / MANIFEST_NAME, owner_uid, 0o644)
    _require_owned_regular(root / "client-release.json", owner_uid, 0o644)
    for item in manifest["artifacts"]:
        path = root / Path(*PurePosixPath(item["path"]).parts)
        _require_owned_regular(path, owner_uid, item["mode"])
    checked = {
        "transaction_id": transaction_id,
        "release_id": manifest["release_id"],
        "manifest_sha256": sha256_file(root / MANIFEST_NAME),
        "verified": True,
    }
    _write_json(root / ".verified.json", checked)
    return checked


def verify_transaction(config: Mapping[str, Any], transaction_id: str, release_id: str) -> dict[str, Any]:
    with _release_lock(config):
        return _verify_transaction(config, transaction_id, release_id)


def stage(config: Mapping[str, Any], transaction_id: str, release_id: str, payload: bytes) -> dict[str, Any]:
    transaction_id = _safe_id(transaction_id, "transaction_id")
    release_id = _release_id(release_id)
    with _release_lock(config):
        destination = _transaction_dir(config, transaction_id)
        if destination.exists():
            _fail("transaction_exists", "transaction staging directory already exists")
        temporary = destination.with_name("." + transaction_id + ".staging")
        if temporary.exists():
            _fail("transaction_exists", "temporary transaction staging directory already exists")
        try:
            safe_extract_archive(payload, temporary)
            manifest = load_manifest(temporary / MANIFEST_NAME)
            if manifest["release_id"] != release_id:
                _fail("release_mismatch", "staged manifest does not match requested release")
            _write_json(temporary / ".wrapper-state.json", {"transaction_id": transaction_id, "release_id": release_id, "staged": True})
            os.replace(temporary, destination)
        except ManifestError as exc:
            _fail(exc.code, exc.message, exc.detail)
        except OSError as exc:
            _fail("wrapper_io_error", "cannot commit staged release")
        finally:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)
        return {"staged": True, "transaction_id": transaction_id, "release_id": release_id}


def _current_target(link: Path, release_root: Path | None = None) -> Path | None:
    if not link.exists() and not link.is_symlink():
        return None
    if not link.is_symlink():
        _fail("activation_unverified", f"release pointer is not a symlink: {link.name}")
    target = link.resolve()
    if not target.is_dir():
        _fail("activation_unverified", f"release pointer target is missing: {link.name}")
    if release_root is not None:
        root = release_root.resolve()
        try:
            target.relative_to(root)
        except ValueError:
            _fail("activation_unverified", f"release pointer escapes the release root: {link.name}")
        if RELEASE_ID_RE.fullmatch(target.name) is None:
            _fail("activation_unverified", f"release pointer target has an invalid release id: {link.name}")
    return target


def _verify_retained_release(config: Mapping[str, Any], target: Path) -> dict[str, Any]:
    """Re-verify a release before using it as an activation or rollback target."""
    try:
        manifest = load_manifest(target / MANIFEST_NAME)
        verify_bundle(target, manifest)
        verify_client_sidecar(target, manifest)
    except ManifestError as exc:
        _fail("activation_unverified", "retained release cannot be verified", exc.as_dict())
    _reject_transaction_extras(target, manifest)
    _verify_fixed_artifacts(config, manifest)
    _verify_python_syntax(target, manifest)
    _verify_unit_contents(target, manifest)
    owner_uid = int(config["owner_uid"])
    _require_owned_regular(target / MANIFEST_NAME, owner_uid, 0o644)
    _require_owned_regular(target / "client-release.json", owner_uid, 0o644)
    for item in manifest["artifacts"]:
        _require_owned_regular(target / Path(*PurePosixPath(item["path"]).parts), owner_uid, item["mode"])
    return manifest


def _atomic_symlink(target: Path, link: Path) -> None:
    temporary = link.with_name("." + link.name + ".tmp")
    try:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()
        os.symlink(target, temporary)
        os.replace(temporary, link)
    except OSError as exc:
        _fail("activation_failed", f"cannot atomically update release pointer: {link.name}")


def _copy_atomic(source: Path, target: Path, owner_uid: int, mode: int) -> None:
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        try:
            info = target.lstat()
        except OSError:
            _fail("activation_unverified", f"cannot inspect activation target: {target.name}")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            _fail("activation_unverified", f"activation target is not a regular file: {target.name}")
    temporary = target.with_name("." + target.name + ".release-tmp")
    try:
        with source.open("rb") as source_handle, temporary.open("wb") as target_handle:
            shutil.copyfileobj(source_handle, target_handle, length=1024 * 1024)
            target_handle.flush()
            os.fchmod(target_handle.fileno(), mode)
            if hasattr(os, "fchown"):
                os.fchown(target_handle.fileno(), owner_uid, -1)
            os.fsync(target_handle.fileno())
        os.replace(temporary, target)
    except OSError as exc:
        try:
            if temporary.exists():
                temporary.unlink()
        except OSError:
            pass
        _fail("activation_failed", f"cannot atomically install artifact: {target.name}")


def _activation_targets(config: Mapping[str, Any]) -> tuple[Path, ...]:
    targets = (
        Path(config["control_path"]),
        Path(config["control_path"]).with_name("agent_vm.py"),
        Path(config["control_path"]).with_name("release_manifest.py"),
        Path(config["control_path"]).with_name(MANIFEST_NAME),
        Path(config["control_path"]).with_name("client-release.json"),
    ) + tuple(Path(config["unit_dir"]) / name for name in config["unit_names"])
    return tuple(dict.fromkeys(targets))


def _snapshot_targets(config: Mapping[str, Any]) -> dict[Path, tuple[bytes, int, int] | None]:
    snapshot: dict[Path, tuple[bytes, int, int] | None] = {}
    for target in _activation_targets(config):
        if not target.exists() and not target.is_symlink():
            snapshot[target] = None
            continue
        try:
            info = target.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                _fail("activation_unverified", f"activation target is not a regular file: {target.name}")
            snapshot[target] = (target.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid)
        except OSError as exc:
            _fail("activation_unverified", f"activation target cannot be snapshotted: {target.name}")
    return snapshot


def _restore_targets(snapshot: Mapping[Path, tuple[bytes, int, int] | None]) -> None:
    for target, saved in snapshot.items():
        if saved is None:
            try:
                if target.exists() or target.is_symlink():
                    target.unlink()
            except OSError as exc:
                _fail("activation_restore_failed", f"cannot remove a partially installed target: {target.name}")
            continue
        data, mode, owner_uid = saved
        temporary = target.with_name("." + target.name + ".restore-tmp")
        try:
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with temporary.open("wb") as handle:
                handle.write(data)
                handle.flush()
                os.fchmod(handle.fileno(), mode)
                if hasattr(os, "fchown"):
                    os.fchown(handle.fileno(), owner_uid, -1)
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        except OSError as exc:
            try:
                if temporary.exists():
                    temporary.unlink()
            except OSError:
                pass
            _fail("activation_restore_failed", f"cannot restore activation target: {target.name}")


def _restore_pointer(link: Path, target: Path | None) -> None:
    if target is None:
        try:
            if link.exists() or link.is_symlink():
                link.unlink()
        except OSError as exc:
            _fail("activation_restore_failed", f"cannot remove release pointer: {link.name}")
    else:
        _atomic_symlink(target, link)


def _restore_activation_state(
    config: Mapping[str, Any],
    current_link: Path,
    previous_link: Path,
    old_current: Path | None,
    old_previous: Path | None,
    target_snapshot: Mapping[Path, tuple[bytes, int, int] | None],
) -> None:
    _restore_targets(target_snapshot)
    _restore_pointer(current_link, old_current)
    _restore_pointer(previous_link, old_previous)
    _daemon_reload()


def _ensure_drained(config: Mapping[str, Any]) -> None:
    if not config["require_drained"]:
        return
    try:
        process = subprocess.run(
            ["/usr/bin/python3", str(config["control_path"])],
            input=json.dumps({"protocol": 4, "action": "drain-status"}).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        _fail("drain_unverified", "cannot verify admission drain")
    if process.returncode != 0:
        _fail("drain_unverified", "current control process did not verify admission drain")
    try:
        response = json.loads(process.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("drain_unverified", "drain status response is invalid")
    if not isinstance(response, dict) or response.get("ok") is not True:
        _fail("drain_unverified", "drain status response was not successful")
    result = response.get("result")
    if not isinstance(result, Mapping):
        _fail("drain_unverified", "drain status result is invalid")
    if result.get("draining") is not True:
        _fail("drain_required", "release activation requires admission drain")


def _daemon_reload() -> None:
    try:
        process = subprocess.run(["systemctl", "daemon-reload"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        _fail("activation_failed", "systemd daemon-reload could not be verified")
    if process.returncode != 0:
        _fail("activation_failed", "systemd daemon-reload failed")


def _install_release_files(config: Mapping[str, Any], release_root: Path, manifest: Mapping[str, Any]) -> None:
    owner_uid = int(config["owner_uid"])
    support_installed = False
    for item in manifest["artifacts"]:
        source = release_root / Path(*PurePosixPath(item["path"]).parts)
        if item["role"] == "control":
            if Path(item["path"]).name != "agent_vm_control.py":
                _fail("activation_unverified", "control artifact name is not fixed")
            _copy_atomic(source, Path(config["control_path"]), owner_uid, item["mode"])
        elif item["role"] == "client":
            if Path(item["path"]).name != "agent_vm.py":
                _fail("activation_unverified", "client artifact name is not fixed")
            _copy_atomic(source, Path(config["control_path"]).with_name("agent_vm.py"), owner_uid, item["mode"])
        elif item["role"] == "unit":
            name = Path(item["path"]).name
            if name not in config["unit_names"]:
                _fail("activation_unverified", f"unit target is not fixed: {name}")
            _copy_atomic(source, Path(config["unit_dir"]) / name, owner_uid, item["mode"])
        elif item["role"] == "support":
            if Path(item["path"]).name != "release_manifest.py":
                _fail("activation_unverified", "support artifact name is not fixed")
            _copy_atomic(source, Path(config["control_path"]).with_name("release_manifest.py"), owner_uid, item["mode"])
            support_installed = True
    if not support_installed:
        _fail("activation_unverified", "release manifest support module is missing")
    manifest_source = release_root / MANIFEST_NAME
    _require_owned_regular(manifest_source, owner_uid, 0o644)
    _copy_atomic(manifest_source, Path(config["control_path"]).with_name(MANIFEST_NAME), owner_uid, 0o644)
    client_sidecar = release_root / "client-release.json"
    _require_owned_regular(client_sidecar, owner_uid, 0o644)
    _copy_atomic(client_sidecar, Path(config["control_path"]).with_name("client-release.json"), owner_uid, 0o644)


def activate(config: Mapping[str, Any], transaction_id: str, release_id: str) -> dict[str, Any]:
    with _release_lock(config):
        return _activate_unlocked(config, transaction_id, release_id)


def _activate_unlocked(config: Mapping[str, Any], transaction_id: str, release_id: str) -> dict[str, Any]:
    transaction_id = _safe_id(transaction_id, "transaction_id")
    release_id = _release_id(release_id)
    verified = _verify_transaction(config, transaction_id, release_id)
    _ensure_drained(config)
    activation_path = Path(config["state_root"]) / (transaction_id + ".activation.json")
    if activation_path.exists() or activation_path.is_symlink():
        _fail("transaction_exists", "activation record already exists for this transaction")
    staged = _transaction_dir(config, transaction_id)
    release_root = Path(config["release_root"])
    current_link = Path(config["current_link"])
    previous_link = Path(config["previous_link"])
    old_current = _current_target(current_link, release_root)
    old_previous = _current_target(previous_link, release_root)
    if old_current is not None and old_current == old_previous:
        _fail("activation_unverified", "current and previous pointers must not target the same release")
    if old_current is not None:
        _verify_retained_release(config, old_current)
    if old_previous is not None:
        _verify_retained_release(config, old_previous)
    _mkdir_private(release_root, 0o755)
    release_dir = release_root / release_id
    if release_dir.exists():
        _fail("release_exists", "release directory already exists")
    temporary = release_root / ("." + release_id + ".tmp")
    if temporary.exists():
        _fail("activation_failed", "temporary release directory already exists")
    try:
        shutil.copytree(
            staged,
            temporary,
            symlinks=False,
            ignore=shutil.ignore_patterns(".wrapper-state.json", ".verified.json"),
        )
        os.replace(temporary, release_dir)
    except OSError as exc:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
        _fail("activation_failed", "cannot commit verified release directory")
    previous_id = old_current.name if old_current else None
    target_snapshot = _snapshot_targets(config)
    record = {
        "transaction_id": transaction_id,
        "release_id": release_id,
        "previous_release_id": previous_id,
        "manifest_sha256": verified["manifest_sha256"],
        "activated": False,
        "activation_phase": "prepared",
        "rollback_attempts": 0,
    }
    _write_json(activation_path, record)
    try:
        manifest = load_manifest(release_dir / MANIFEST_NAME)
        _install_release_files(config, release_dir, manifest)
        record["activation_phase"] = "files-installed"
        _write_json(activation_path, record)
        if old_current is not None:
            _atomic_symlink(old_current, previous_link)
        record["activation_phase"] = "previous-pointer-updated"
        _write_json(activation_path, record)
        _atomic_symlink(release_dir, current_link)
        record["activation_phase"] = "current-pointer-updated"
        _write_json(activation_path, record)
        _daemon_reload()
        record["activation_phase"] = "daemon-reloaded"
        _write_json(activation_path, record)
        record["activated"] = True
        record["activation_phase"] = "active"
        _write_json(activation_path, record)
    except (WrapperError, ManifestError) as raw_failure:
        failure = raw_failure if isinstance(raw_failure, WrapperError) else WrapperError(
            raw_failure.code, raw_failure.message, raw_failure.detail,
        )
        try:
            _restore_activation_state(
                config,
                current_link,
                previous_link,
                old_current,
                old_previous,
                target_snapshot,
            )
        except WrapperError as restore_error:
            failure = WrapperError(
                "activation_restore_failed",
                "activation failed and the previous release could not be fully restored",
                {"activation_error": failure.as_dict(), "restore_error": restore_error.as_dict()},
            )
        try:
            _write_json(activation_path, {
                **record,
                "activated": False,
                "activation_phase": "failed",
                "activation_error": failure.as_dict(),
            })
        except WrapperError:
            pass
        raise failure
    return record


def rollback(config: Mapping[str, Any], transaction_id: str, release_id: str) -> dict[str, Any]:
    with _release_lock(config):
        return _rollback_unlocked(config, transaction_id, release_id)


def _rollback_unlocked(config: Mapping[str, Any], transaction_id: str, release_id: str) -> dict[str, Any]:
    transaction_id = _safe_id(transaction_id, "transaction_id")
    release_id = _release_id(release_id)
    activation_path = Path(config["state_root"]) / (transaction_id + ".activation.json")
    try:
        activation_info = activation_path.lstat()
    except OSError:
        _fail("rollback_unavailable", "there is no activation record for this transaction")
    if stat.S_ISLNK(activation_info.st_mode) or not stat.S_ISREG(activation_info.st_mode):
        _fail("rollback_unavailable", "there is no activation record for this transaction")
    record = _read_json(activation_path, "rollback_unavailable")
    interrupted_phases = {
        "prepared",
        "files-installed",
        "previous-pointer-updated",
        "current-pointer-updated",
        "daemon-reloaded",
    }
    interrupted = record.get("activated") is False and record.get("activation_phase") in interrupted_phases
    if record.get("release_id") != release_id or not (record.get("activated") is True or interrupted):
        _fail("rollback_unavailable", "rollback transaction does not match the active release")
    if record.get("rollback_attempts", 0) >= 1:
        _fail("rollback_already_attempted", "automatic rollback is limited to one attempt")
    previous_id = record.get("previous_release_id")
    if not isinstance(previous_id, str) or RELEASE_ID_RE.fullmatch(previous_id) is None:
        _fail("rollback_unavailable", "no previous verified release is retained")
    previous_dir = Path(config["release_root"]) / previous_id
    previous_manifest = _verify_retained_release(config, previous_dir)
    _ensure_drained(config)
    current_link = Path(config["current_link"])
    previous_link = Path(config["previous_link"])
    old_current = _current_target(current_link, Path(config["release_root"]))
    old_previous = _current_target(previous_link, Path(config["release_root"]))
    if old_current is not None and old_current == old_previous:
        _fail("activation_unverified", "current and previous pointers must not target the same release")
    if old_current is not None:
        _verify_retained_release(config, old_current)
    if old_previous is not None:
        _verify_retained_release(config, old_previous)
    target_snapshot = _snapshot_targets(config)
    record["rollback_attempts"] = 1
    record["rollback_started"] = True
    record["rollback_phase"] = "started"
    record["rollback_state"] = "in-progress"
    record["draining"] = True
    _write_json(activation_path, record)
    try:
        _install_release_files(config, previous_dir, previous_manifest)
        _atomic_symlink(previous_dir, current_link)
        if old_current is not None:
            _atomic_symlink(old_current, previous_link)
        _daemon_reload()
    except WrapperError as failure:
        try:
            _restore_activation_state(
                config,
                current_link,
                previous_link,
                old_current,
                old_previous,
                target_snapshot,
            )
        except WrapperError as restore_error:
            failure = WrapperError(
                "activation_restore_failed",
                "rollback failed and the previous release could not be fully restored",
                {"rollback_error": failure.as_dict(), "restore_error": restore_error.as_dict()},
            )
        record["rollback_phase"] = "failed"
        record["rollback_state"] = "failed"
        record["rollback_error"] = failure.as_dict()
        record["draining"] = True
        try:
            _write_json(activation_path, record)
        except WrapperError:
            pass
        raise failure
    record["rolled_back_to"] = previous_id
    record["rollback_phase"] = "complete"
    record["rollback_state"] = "complete"
    record["draining"] = True
    try:
        _write_json(activation_path, record)
    except WrapperError as record_error:
        try:
            _restore_activation_state(
                config,
                current_link,
                previous_link,
                old_current,
                old_previous,
                target_snapshot,
            )
        except WrapperError as restore_error:
            raise WrapperError(
                "activation_restore_failed",
                "rollback record could not be persisted and the active release could not be fully restored",
                {"record_error": record_error.as_dict(), "restore_error": restore_error.as_dict()},
            ) from restore_error
        record["rollback_error"] = record_error.as_dict()
        try:
            _write_json(activation_path, record)
        except WrapperError:
            pass
        raise record_error
    return {"rolled_back": True, "release_id": previous_id, "previous_release_id": old_current.name if old_current else None}


def status(config: Mapping[str, Any]) -> dict[str, Any]:
    release_root = Path(config["release_root"])
    current = _current_target(Path(config["current_link"]), release_root)
    previous = _current_target(Path(config["previous_link"]), release_root)
    return {
        "current_release_id": current.name if current else None,
        "previous_release_id": previous.name if previous else None,
        "release_root": str(config["release_root"]),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-vm-release-wrapper")
    subparsers = parser.add_subparsers(dest="action", required=True)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--transaction-id", required=True)
    stage_parser.add_argument("--release-id", required=True)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--transaction-id", required=True)
    verify_parser.add_argument("--release-id", required=True)
    activate_parser = subparsers.add_parser("activate")
    activate_parser.add_argument("--transaction-id", required=True)
    activate_parser.add_argument("--release-id", required=True)
    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("--transaction-id", required=True)
    rollback_parser.add_argument("--release-id", required=True)
    subparsers.add_parser("status")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = load_config(DEFAULT_CONFIG_PATH)
        if args.action == "stage":
            payload = sys.stdin.buffer.read(MAX_ARCHIVE_BYTES + 1)
            result = stage(config, args.transaction_id, args.release_id, payload)
        elif args.action == "verify":
            result = verify_transaction(config, _safe_id(args.transaction_id, "transaction_id"), _release_id(args.release_id))
        elif args.action == "activate":
            result = activate(config, args.transaction_id, args.release_id)
        elif args.action == "rollback":
            result = rollback(config, args.transaction_id, args.release_id)
        else:
            result = status(config)
        sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
        return 0
    except WrapperError as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": exc.as_dict()}, sort_keys=True) + "\n")
        return 2
    except Exception as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": {"code": "internal_error", "message": type(exc).__name__}}, sort_keys=True) + "\n")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
