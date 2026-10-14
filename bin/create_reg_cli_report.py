#!/usr/bin/env python3
"""Create a multi-image reg-cli report from existing chat image snapshots."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from secrets import token_hex
from typing import Sequence

sys.dont_write_bytecode = True

from snapshot_local_image import _default_store_root, _repo_scope


SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg"}
PAIR_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*\Z")
REPORT_TOKEN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\Z")
SNAPSHOT_SCOPE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*__[a-f0-9]{8}\Z")
SNAPSHOT_FILENAME = re.compile(
    r"\d{8}T\d{6}Z-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}\.(?:png|jpe?g)\Z"
)
REG_CLI_COMMAND = ("npm", "ci")
REG_CLI_VERSION = "0.18.16"
REG_CLI_PACKAGE_ROOT = Path(__file__).resolve().parent / "reg-cli-report"
REPORT_ROOT_ENTRIES = {"actual", "expected", "diff", "report.html", "reg.json", "manifest.json"}
SANDBOX_READ_DENY_ROOTS = (
    "/Users",
    "/private/var/folders",
    "/private/tmp",
    "/private/var/tmp",
    "/Volumes",
    "/Network",
    "/Library/Keychains",
    "/opt/homebrew",
    "/usr/local",
)
SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
CLONE_NOFOLLOW = 0x0001


@dataclass(frozen=True)
class ImagePair:
    name: str
    expected: Path
    actual: Path


def _snapshot_path(path: Path, store_root: Path) -> Path:
    resolved = path.expanduser().resolve(strict=True)
    try:
        relative = resolved.relative_to(store_root)
    except ValueError as error:
        raise ValueError(f"image must be an existing snapshot under {store_root}: {path}") from error
    if any(part.casefold() == "reg-cli-reports" for part in relative.parts):
        raise ValueError("report outputs cannot be used as snapshot inputs")
    if not resolved.is_file() or path.is_symlink():
        raise ValueError(f"image must be a regular snapshot file: {path}")
    if (
        len(relative.parts) != 5
        or not SNAPSHOT_SCOPE.fullmatch(relative.parts[0])
        or not re.fullmatch(r"\d{4}", relative.parts[1])
        or not re.fullmatch(r"\d{2}", relative.parts[2])
        or not re.fullmatch(r"\d{2}", relative.parts[3])
        or not SNAPSHOT_FILENAME.fullmatch(relative.parts[4])
    ):
        raise ValueError("image must use the generated chat snapshot path layout")
    try:
        directory_date = datetime.strptime("/".join(relative.parts[1:4]), "%Y/%m/%d")
        filename_date = datetime.strptime(relative.parts[4][:16], "%Y%m%dT%H%M%SZ")
        image_stat = resolved.stat()
    except (OSError, ValueError) as error:
        raise ValueError("image must use the generated chat snapshot path layout") from error
    if directory_date.date() != filename_date.date():
        raise ValueError("snapshot filename timestamp does not match its date directory")
    if image_stat.st_nlink != 1:
        raise ValueError("snapshot inputs must not be hard-linked aliases")
    return resolved


def _validated_pairs(pairs: Sequence[ImagePair], store_root: Path) -> list[ImagePair]:
    if not pairs:
        raise ValueError("at least one --pair is required")
    seen: set[str] = set()
    validated: list[ImagePair] = []
    for pair in pairs:
        if not PAIR_NAME.fullmatch(pair.name) or pair.name in {".", ".."}:
            raise ValueError(f"invalid pair name: {pair.name}")
        normalized_name = pair.name.casefold()
        if normalized_name in seen:
            raise ValueError(f"duplicate pair name: {pair.name}")
        seen.add(normalized_name)
        expected = _snapshot_path(pair.expected, store_root)
        actual = _snapshot_path(pair.actual, store_root)
        if expected.suffix.lower() != actual.suffix.lower() or actual.suffix.lower() not in SUPPORTED_SUFFIXES:
            raise ValueError(f"pair {pair.name} requires matching PNG or JPEG extensions")
        validated.append(ImagePair(pair.name, expected, actual))
    return validated


def _sandbox_read_paths(
    directory: Path,
    additional_paths: Sequence[Path],
    *,
    include_staging: bool,
    include_snapshot_symlinks: bool,
) -> list[Path]:
    paths = [
        Path("/System/Library"),
        Path("/usr/bin"),
        Path("/usr/lib"),
        Path("/usr/share"),
        Path("/bin"),
        Path("/sbin"),
        Path("/private/etc"),
        Path("/dev"),
        *([directory] if include_staging else []),
        *additional_paths,
    ]
    for folder in ("actual", "expected") if include_snapshot_symlinks else ():
        source_dir = directory / folder
        if _is_real_directory(source_dir):
            paths.extend(
                path.resolve(strict=True)
                for path in source_dir.iterdir()
                if path.is_symlink()
            )
    resolved: dict[str, Path] = {}
    for path in paths:
        try:
            canonical = path.resolve(strict=True)
        except OSError as error:
            raise RuntimeError(f"sandbox read path is unavailable: {path}") from error
        resolved[str(canonical)] = canonical
    return list(resolved.values())


def _sandbox_profile(
    directory: Path,
    *,
    executable_paths: Sequence[Path],
    additional_read_paths: Sequence[Path] = (),
    allow_network: bool = False,
    include_staging_read: bool = True,
    include_snapshot_reads: bool = True,
) -> str:
    if sys.platform != "darwin" or not SANDBOX_EXEC.is_file() or not os.access(SANDBOX_EXEC, os.X_OK):
        raise RuntimeError("reg-cli reports require macOS sandbox-exec; refusing to run unsandboxed")
    canonical_directory = directory.resolve(strict=True)
    writable_path = json.dumps(str(canonical_directory))
    rules = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork)",
        "(allow signal (target children))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
    ]
    for executable in executable_paths:
        canonical_executable = executable.resolve(strict=True)
        if not canonical_executable.is_file() or not os.access(canonical_executable, os.X_OK):
            raise RuntimeError(f"sandbox executable is unavailable: {executable}")
        rules.append(f"(allow process-exec (literal {json.dumps(str(canonical_executable))}))")
    read_paths = _sandbox_read_paths(
        directory,
        additional_read_paths,
        include_staging=include_staging_read,
        include_snapshot_symlinks=include_snapshot_reads,
    )
    rules.append('(allow file-read* (subpath "/"))')
    for denied_root in SANDBOX_READ_DENY_ROOTS:
        rules.append(f"(deny file-read-data (subpath {json.dumps(denied_root)}))")
    for read_path in read_paths:
        predicate = "subpath" if read_path.is_dir() else "literal"
        path_rule = f"({predicate} {json.dumps(str(read_path))})"
        rules.append(f"(allow file-read-data {path_rule})")
        rules.append(f"(allow file-read-metadata {path_rule})")
    if allow_network:
        rules.append("(allow network-outbound)")
    rules.append(f"(allow file-write* (subpath {writable_path}))")
    return "\n".join(rules)


def _terminate_process_group(process_id: int) -> None:
    try:
        os.killpg(process_id, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _run_sandboxed_command(
    directory: Path,
    argv: Sequence[str],
    *,
    runtime_dir: Path,
    env: dict[str, str],
    allow_network: bool,
    label: str,
    additional_read_paths: Sequence[Path] = (),
    include_staging_read: bool = True,
    include_snapshot_reads: bool = True,
    working_directory: Path | None = None,
) -> None:
    executable = Path(argv[0]).resolve(strict=True)
    command = (str(executable), *argv[1:])
    profile = _sandbox_profile(
        directory,
        executable_paths=(executable,),
        additional_read_paths=additional_read_paths,
        allow_network=allow_network,
        include_staging_read=include_staging_read,
        include_snapshot_reads=include_snapshot_reads,
    )
    log_prefix = label.replace(" ", "-")
    with (runtime_dir / f"{log_prefix}.stdout.log").open("w+", encoding="utf-8") as stdout_log, (
        runtime_dir / f"{log_prefix}.stderr.log"
    ).open("w+", encoding="utf-8") as stderr_log:
        process = subprocess.Popen(
            [str(SANDBOX_EXEC), "-p", profile, *command],
            cwd=working_directory or directory,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stdout_log,
            stderr=stderr_log,
            start_new_session=True,
        )
        timed_out = False
        try:
            process.wait(timeout=300)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            _terminate_process_group(process.pid)
            process.wait()
        stdout_log.flush()
        stderr_log.flush()
        stdout_log.seek(0)
        stderr_log.seek(0)
        stdout = stdout_log.read()
        stderr = stderr_log.read()
    if timed_out:
        raise subprocess.TimeoutExpired(argv, 300, output=stdout, stderr=stderr)
    if process.returncode != 0:
        details = "\n".join(output.strip() for output in (stderr, stdout) if output.strip())
        raise RuntimeError(f"{label} failed (exit {process.returncode}): {details}")


def _run_reg_cli(
    directory: Path,
    command: Sequence[str] = REG_CLI_COMMAND,
) -> tuple[str, os.stat_result] | None:
    if tuple(command) != REG_CLI_COMMAND:
        raise ValueError("reg-cli command is fixed; custom commands are not supported")
    if not _is_real_directory(directory):
        raise RuntimeError("reg-cli staging directory is not a regular directory")
    runtime_dir = Path(tempfile.mkdtemp(prefix=".reg-cli-runtime-", dir=directory))
    runtime_identity = runtime_dir.lstat()
    runtime_home = runtime_dir / "home"
    runtime_tmp = runtime_dir / "tmp"
    npm_cache = runtime_dir / "npm-cache"
    package_root = runtime_dir / "package"
    completed = False
    try:
        runtime_home.mkdir()
        runtime_tmp.mkdir()
        npm_cache.mkdir()
        package_root.mkdir()
        npm_global_config = runtime_dir / "global.npmrc"
        npm_global_config.write_text("", encoding="utf-8")
        for filename in ("package.json", "package-lock.json"):
            source = REG_CLI_PACKAGE_ROOT / filename
            if not _is_regular_file(source):
                raise RuntimeError(f"pinned reg-cli package lock is missing: {filename}")
            shutil.copyfile(source, package_root / filename)

        env = {
            key: os.environ[key]
            for key in (
                "PATH", "LANG", "LC_ALL", "LC_CTYPE",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "all_proxy", "no_proxy",
            )
            if key in os.environ
        }
        env.update({
            "HOME": str(runtime_home),
            "TMPDIR": str(runtime_tmp),
            "TMP": str(runtime_tmp),
            "TEMP": str(runtime_tmp),
            "npm_config_cache": str(npm_cache),
            "npm_config_logs_dir": str(npm_cache / "_logs"),
            "npm_config_userconfig": os.devnull,
            "npm_config_globalconfig": str(npm_global_config),
            "npm_config_ignore_scripts": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
            "npm_config_update_notifier": "false",
            "CI": "1",
        })
        node = shutil.which("node", path=env.get("PATH"))
        npm = shutil.which("npm", path=env.get("PATH"))
        if not node or not npm:
            raise RuntimeError("node and npm are required to install the pinned reg-cli package")
        node_binary = Path(node).resolve(strict=True)
        npm_cli = Path(npm).resolve(strict=True)
        if (
            npm_cli.name != "npm-cli.js"
            or tuple(path.name for path in npm_cli.parents[:4]) != ("bin", "npm", "node_modules", "lib")
        ):
            raise RuntimeError("npm installation layout is unsupported; refusing to run unsandboxed")
        node_root = npm_cli.parents[4]
        if node_binary.parent.parent != node_root:
            raise RuntimeError("node and npm must belong to the same installation")
        npm_root = npm_cli.parent.parent

        _run_sandboxed_command(
            directory,
            (
                str(node_binary), str(npm_cli), "ci", "--prefix", str(package_root),
                "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
                "--registry=https://registry.npmjs.org/",
            ),
            runtime_dir=runtime_dir,
            env=env,
            allow_network=True,
            label="pinned reg-cli installation",
            additional_read_paths=(node_root, npm_root, runtime_dir),
            include_staging_read=False,
            include_snapshot_reads=False,
            working_directory=package_root,
        )

        package_dir = package_root / "node_modules" / "reg-cli"
        manifest_path = package_dir / "package.json"
        if not _is_real_directory(package_dir) or not _is_regular_file(manifest_path):
            raise RuntimeError("npm did not install the pinned reg-cli package")
        runtime_root = runtime_dir.resolve(strict=True)
        package_dir = package_dir.resolve(strict=True)
        try:
            package_dir.relative_to(runtime_root)
        except ValueError as error:
            raise RuntimeError("pinned reg-cli package escaped the runtime directory") from error
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError("pinned reg-cli package metadata is invalid") from error
        if not isinstance(manifest, dict) or manifest.get("version") != REG_CLI_VERSION:
            raise RuntimeError("npm installed an unexpected reg-cli version")
        bin_manifest = manifest.get("bin")
        bin_entry = bin_manifest.get("reg-cli") if isinstance(bin_manifest, dict) else None
        if not isinstance(bin_entry, str):
            raise RuntimeError("pinned reg-cli package has no expected executable")
        entry_path = Path(bin_entry)
        if entry_path.is_absolute() or ".." in entry_path.parts:
            raise RuntimeError("pinned reg-cli executable path is invalid")
        executable = (package_dir / entry_path).resolve(strict=True)
        try:
            executable.relative_to(package_dir)
        except ValueError as error:
            raise RuntimeError("pinned reg-cli executable escaped its package") from error
        if not _is_regular_file(executable):
            raise RuntimeError("pinned reg-cli executable is missing")
        _run_sandboxed_command(
            directory,
            (
                str(node_binary), str(executable), "actual", "expected", "diff", "-R",
                "report.html", "-J", "reg.json", "-I",
            ),
            runtime_dir=runtime_dir,
            env=env,
            allow_network=False,
            label="reg-cli",
            additional_read_paths=(node_root,),
        )
        completed = True
        return runtime_dir.name, runtime_identity
    finally:
        if not completed:
            _remove_staging_path(runtime_dir, runtime_identity)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def _is_independent_regular_file(path: Path) -> bool:
    try:
        file_stat = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(file_stat.st_mode) and file_stat.st_nlink == 1


def _is_real_directory(path: Path) -> bool:
    try:
        return stat.S_ISDIR(path.lstat().st_mode)
    except OSError:
        return False


def _directory_has_exact_names(directory: Path, expected_names: set[str]) -> bool:
    try:
        entries = list(directory.iterdir())
    except OSError:
        return False
    return len(entries) == len(expected_names) and {entry.name for entry in entries} == expected_names


def _staging_directory_is_intact(path: Path, root: Path, original: os.stat_result) -> bool:
    try:
        current = path.lstat()
    except OSError:
        return False
    absolute = Path(os.path.abspath(path))
    return (
        stat.S_ISDIR(current.st_mode)
        and (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino)
        and _contained_path_without_symlinks(absolute, root) == absolute
    )


def _seal_staging_directory(
    staging: Path,
    parent: Path,
    root: Path,
    original: os.stat_result,
    *,
    sealed_path: Path | None = None,
) -> Path:
    if not _staging_directory_is_intact(staging, root, original):
        raise RuntimeError("reg-cli replaced or moved the staging directory")
    sealed = sealed_path or parent / f".sealed-report-{token_hex(8)}"
    if sealed.parent != parent:
        raise ValueError("sealed staging must be a sibling of the report directory")
    if sealed.exists() or sealed.is_symlink():
        raise FileExistsError(f"report staging already exists: {sealed}")
    staging.rename(sealed)
    if not _staging_directory_is_intact(sealed, root, original):
        raise RuntimeError("reg-cli replaced or moved the staging directory")
    return sealed


def _clone_report_file(source: Path, destination: Path) -> None:
    if not _is_independent_regular_file(source):
        raise RuntimeError(f"report output is not an independent regular file: {source.name}")
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"report output already exists: {destination}")
    try:
        clonefile = ctypes.CDLL(None, use_errno=True).clonefile
    except AttributeError as error:
        raise RuntimeError("APFS copy-on-write cloning is unavailable") from error
    clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
    clonefile.restype = ctypes.c_int
    result = clonefile(os.fsencode(source), os.fsencode(destination), CLONE_NOFOLLOW)
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), str(source))
    if not _is_independent_regular_file(destination):
        raise RuntimeError(f"cloned report output is not an independent regular file: {destination.name}")


def _remove_staging_path(path: Path, original: os.stat_result) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError:
        return
    if (
        stat.S_ISDIR(current.st_mode)
        and (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino)
    ):
        shutil.rmtree(path)


def _contained_path_without_symlinks(path: Path, root: Path) -> Path | None:
    absolute_root = Path(os.path.abspath(root))
    raw_absolute = path if path.is_absolute() else Path.cwd() / path
    absolute = Path(os.path.abspath(raw_absolute))
    try:
        absolute.relative_to(absolute_root)
    except ValueError:
        return None

    current = Path(raw_absolute.anchor)
    parts = raw_absolute.parts[1:]
    for index, part in enumerate(parts):
        if part in ("", "."):
            continue
        if part == "..":
            if current == absolute_root:
                return None
            current = current.parent
            continue

        component = current / part
        inside_root = (
            current == absolute_root
            or current.is_relative_to(absolute_root)
            or component == absolute_root
        )
        if inside_root:
            try:
                metadata = component.lstat()
            except FileNotFoundError:
                if any(remaining not in ("", ".") for remaining in parts[index + 1 :]):
                    return None
                current = component
                break
            except OSError:
                return None
            if stat.S_ISLNK(metadata.st_mode):
                return None
            if (
                not stat.S_ISDIR(metadata.st_mode)
                and any(remaining not in ("", ".") for remaining in parts[index + 1 :])
            ):
                return None
        current = component

    try:
        resolved_root = absolute_root.resolve(strict=True)
        Path(raw_absolute).resolve(strict=False).relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError):
        return None
    return absolute


def _ensure_directory_tree_under_root(path: Path, root: Path) -> Path:
    absolute_root = Path(os.path.abspath(root))
    absolute_path = Path(os.path.abspath(path))
    if not _is_real_directory(absolute_root):
        raise ValueError(f"snapshot store is not a regular directory: {absolute_root}")
    try:
        parts = absolute_path.relative_to(absolute_root).parts
    except ValueError as error:
        raise ValueError(f"report directory must be under the snapshot store: {absolute_path}") from error

    current = absolute_root
    for part in parts:
        current = current / part
        try:
            current.mkdir()
        except FileExistsError:
            pass
        if not _is_real_directory(current):
            raise ValueError(f"report path component is not a regular directory: {current}")
    return absolute_path


def _valid_report_filename(value: object) -> bool:
    if not isinstance(value, str) or Path(value).name != value or value in {".", ".."}:
        return False
    suffix = Path(value).suffix.lower()
    stem = value[:-len(suffix)] if suffix else ""
    return suffix in SUPPORTED_SUFFIXES and bool(PAIR_NAME.fullmatch(stem))


def _validated_item_lists(reg_json: object, filenames: set[str]) -> dict[str, list[str]]:
    if not isinstance(reg_json, dict):
        raise ValueError("reg-cli produced invalid JSON")
    if any(not isinstance(reg_json.get(key, []), list) or reg_json.get(key, []) for key in ("newItems", "deletedItems")):
        raise ValueError("reg-cli reported unexpected new or deleted items")
    item_lists: dict[str, list[str]] = {}
    for key in ("actualItems", "expectedItems", "failedItems", "passedItems", "diffItems"):
        value = reg_json.get(key)
        if not isinstance(value, list) or any(not _valid_report_filename(item) for item in value):
            raise ValueError("reg-cli produced invalid comparison items")
        if len(value) != len(set(value)):
            raise ValueError("reg-cli produced duplicate comparison items")
        item_lists[key] = value
    if set(item_lists["actualItems"]) != filenames or set(item_lists["expectedItems"]) != filenames:
        raise ValueError("reg-cli did not report every requested pair")
    failed_items = item_lists["failedItems"]
    passed_items = item_lists["passedItems"]
    if set(failed_items + passed_items) != filenames or set(failed_items) & set(passed_items):
        raise ValueError("reg-cli could not compare every requested pair")
    expected_diff_items = {Path(filename).with_suffix(".png").name for filename in failed_items}
    if set(item_lists["diffItems"]) != expected_diff_items:
        raise ValueError("reg-cli produced invalid diffItems for failed comparisons")
    return item_lists


def _diff_output_issue(diff_dir: Path, diff_items: list[str], failed_items: list[str]) -> str | None:
    try:
        entries = list(diff_dir.iterdir())
    except OSError:
        return "cannot inspect diff directory"
    for entry in entries:
        if entry.name not in diff_items:
            return f"unexpected diff artifact: {entry.name}"
        if not _is_independent_regular_file(entry):
            return f"unsafe diff artifact: {entry.name}"
    for filename in {Path(item).with_suffix(".png").name for item in failed_items}:
        if not _is_independent_regular_file(diff_dir / filename):
            return f"missing or unsafe diff image: {filename}"
    return None


def _report_layout_issue(report_dir: Path, root: Path, manifest: dict[str, object]) -> str | None:
    try:
        parts = Path(os.path.abspath(report_dir)).relative_to(root).parts
    except ValueError:
        return "report directory is outside the snapshot store"
    if (
        len(parts) != 6
        or not SNAPSHOT_SCOPE.fullmatch(parts[0])
        or not re.fullmatch(r"[0-9]{4}", parts[1])
        or not re.fullmatch(r"0[1-9]|1[0-2]", parts[2])
        or not re.fullmatch(r"0[1-9]|[12][0-9]|3[01]", parts[3])
        or parts[4] != "reg-cli-reports"
    ):
        return "report directory does not match the snapshot store layout"
    match = re.fullmatch(r"([0-9]{8}T[0-9]{6}Z)-([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})", parts[5])
    created_at_raw = manifest.get("created_at_utc")
    if not match or manifest.get("repo_scope") != parts[0] or not isinstance(created_at_raw, str):
        return "report directory does not match its manifest"
    try:
        created_at = datetime.fromisoformat(created_at_raw)
    except ValueError:
        return "report manifest has an invalid creation timestamp"
    if created_at.tzinfo is None or created_at.utcoffset() is None:
        return "report manifest creation timestamp must be timezone-aware"
    created_at = created_at.astimezone(timezone.utc)
    expected_date = (f"{created_at.year:04d}", f"{created_at.month:02d}", f"{created_at.day:02d}")
    expected_name = f"{created_at.strftime('%Y%m%dT%H%M%SZ')}-{match.group(2)}"
    if tuple(parts[1:4]) != expected_date or parts[5] != expected_name:
        return "report directory does not match its manifest"
    return None


class _ReportHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.has_app_mount = False
        self.scripts: list[str] = []
        self._active_script: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag.lower() == "div" and attributes.get("id") == "app":
            self.has_app_mount = True
        if tag.lower() == "script":
            self.scripts.append("")
            self._active_script = len(self.scripts) - 1

    def handle_data(self, data: str) -> None:
        if self._active_script is not None:
            self.scripts[self._active_script] += data

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script":
            self._active_script = None


def _html_report_issue(report_html: Path, item_lists: dict[str, list[str]]) -> str | None:
    try:
        content = report_html.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return "cannot read HTML report"
    parser = _ReportHTMLParser()
    parser.feed(content)
    parser.close()
    config_index = None
    assignment = None
    for index, script in enumerate(parser.scripts):
        match = re.search(r"window\s*\[\s*['\"]__reg__['\"]\s*\]\s*=\s*", script)
        if match is not None:
            config_index = index
            assignment = match
            break
    if not parser.has_app_mount or assignment is None or config_index is None:
        return "HTML report is missing the rendered reg-cli application or report data"
    if not any(index != config_index and len(script.strip()) > 32 for index, script in enumerate(parser.scripts)):
        return "HTML report is missing the rendered reg-cli application"

    config_script = parser.scripts[config_index]
    try:
        data, _ = json.JSONDecoder().raw_decode(config_script[assignment.end():])
    except json.JSONDecodeError:
        return "HTML report contains invalid reg-cli report data"
    if not isinstance(data, dict):
        return "HTML report contains invalid reg-cli report data"
    if any(data.get(key) != f"./{folder}" for key, folder in (
        ("actualDir", "actual"), ("expectedDir", "expected"), ("diffDir", "diff")
    )):
        return "HTML report does not reference the report input directories"

    for result_key in ("failedItems", "passedItems"):
        entries = data.get(result_key)
        if not isinstance(entries, list) or any(
            not isinstance(entry, dict)
            or not _valid_report_filename(entry.get("raw"))
            or entry.get("encoded") != entry.get("raw")
            for entry in entries
        ):
            return "HTML report contains invalid comparison entries"
        names = [entry["raw"] for entry in entries]
        if len(names) != len(item_lists[result_key]) or set(names) != set(item_lists[result_key]):
            missing = sorted(set(item_lists[result_key]) - set(names))
            return f"HTML report is missing comparison entries: {', '.join(missing)}"
        if data.get("hasFailed" if result_key == "failedItems" else "hasPassed") != bool(names):
            return "HTML report result flags do not match its comparison entries"

    if (
        data.get("newItems") != []
        or data.get("deletedItems") != []
        or data.get("hasNew") is not False
        or data.get("hasDeleted") is not False
    ):
        return "HTML report contains unrequested new or deleted items"
    return None


def _snapshot_integrity_issue(
    manifest_pairs: list[dict[str, str]],
    root: Path,
) -> str | None:
    for pair in manifest_pairs:
        for path_key, hash_key in (
            ("actual_snapshot", "actual_sha256"),
            ("expected_snapshot", "expected_sha256"),
        ):
            source = Path(pair[path_key])
            try:
                if _snapshot_path(source, root) != source:
                    return "snapshot input disappeared or escaped the asset root"
            except (OSError, ValueError):
                return "snapshot input disappeared or escaped the asset root"
            try:
                if _sha256(source) != pair[hash_key]:
                    return "snapshot input changed during report generation"
            except OSError:
                return "snapshot input disappeared during report generation"
    return None


def _populate_publication_stage(
    source: Path,
    publication: Path,
    root: Path,
    manifest_pairs: list[dict[str, str]],
) -> None:
    if not _directory_has_exact_names(source, REPORT_ROOT_ENTRIES - {"manifest.json"}):
        raise RuntimeError("reg-cli produced unexpected top-level report artifacts")
    if not all(_is_real_directory(source / folder) for folder in ("actual", "expected", "diff")):
        raise RuntimeError("reg-cli replaced an input or diff directory")
    if not _is_independent_regular_file(source / "report.html") or not _is_independent_regular_file(source / "reg.json"):
        raise RuntimeError("reg-cli outputs must be independent regular files")

    filenames = {pair["filename"] for pair in manifest_pairs}
    for folder in ("actual", "expected"):
        if not _directory_has_exact_names(source / folder, filenames):
            raise RuntimeError(f"reg-cli changed or added snapshot inputs in {folder}")
    for pair in manifest_pairs:
        for folder, key in (("actual", "actual_snapshot"), ("expected", "expected_snapshot")):
            link = source / folder / pair["filename"]
            if not link.is_symlink() or link.resolve(strict=True) != Path(pair[key]):
                raise RuntimeError("reg-cli changed an input snapshot link")

    snapshot_issue = _snapshot_integrity_issue(manifest_pairs, root)
    if snapshot_issue:
        raise RuntimeError(snapshot_issue)

    for filename in ("report.html", "reg.json"):
        _clone_report_file(source / filename, publication / filename)
    try:
        reg_json = json.loads((publication / "reg.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("reg-cli produced invalid JSON") from error
    try:
        item_lists = _validated_item_lists(reg_json, filenames)
    except ValueError as error:
        raise RuntimeError(str(error)) from error
    diff_issue = _diff_output_issue(source / "diff", item_lists["diffItems"], item_lists["failedItems"])
    if diff_issue:
        raise RuntimeError(diff_issue)
    for filename in item_lists["diffItems"]:
        _clone_report_file(source / "diff" / filename, publication / "diff" / filename)

    for folder in ("actual", "expected"):
        (publication / folder).mkdir()
    for pair in manifest_pairs:
        for folder, key in (("actual", "actual_snapshot"), ("expected", "expected_snapshot")):
            source_image = Path(pair[key])
            if (
                _contained_path_without_symlinks(source_image, root) != source_image
                or not _is_regular_file(source_image)
            ):
                raise RuntimeError("snapshot input disappeared or escaped the asset root")
            link = publication / folder / pair["filename"]
            link.symlink_to(os.path.relpath(source_image, link.parent))
            if link.resolve(strict=True) != source_image:
                raise RuntimeError("published snapshot link does not reference its original input")

    if not all(_directory_has_exact_names(publication / folder, filenames) for folder in ("actual", "expected")):
        raise RuntimeError("published snapshot links are incomplete")
    html_issue = _html_report_issue(publication / "report.html", item_lists)
    if html_issue:
        raise RuntimeError(html_issue)
    diff_issue = _diff_output_issue(publication / "diff", item_lists["diffItems"], item_lists["failedItems"])
    if diff_issue:
        raise RuntimeError(diff_issue)


def create_report(
    pairs: Sequence[ImagePair],
    *,
    cwd: Path,
    store_root: Path | None = None,
    now: datetime | None = None,
    token: str | None = None,
) -> dict[str, object]:
    root = (store_root or _default_store_root()).expanduser().resolve()
    checked = _validated_pairs(pairs, root)
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    report_token = token or token_hex(4)
    if not REPORT_TOKEN.fullmatch(report_token):
        raise ValueError("report token must be a single safe path component")
    scope = _repo_scope(cwd.expanduser().resolve())["repo_scope"]
    parent = root / scope / timestamp.strftime("%Y/%m/%d") / "reg-cli-reports"
    parent = _ensure_directory_tree_under_root(parent, root)
    report_dir = parent / f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}-{report_token}"
    if report_dir.exists() or report_dir.is_symlink():
        raise FileExistsError(f"report already exists: {report_dir}")

    staging = Path(tempfile.mkdtemp(prefix=".report-", dir=parent))
    staging_identity: os.stat_result | None = None
    sealed_staging: Path | None = None
    publication_staging: Path | None = None
    publication_identity: os.stat_result | None = None
    publication_committed = False
    try:
        staging_identity = staging.lstat()
        for folder in ("actual", "expected", "diff"):
            (staging / folder).mkdir()
        manifest_pairs: list[dict[str, str]] = []
        for pair in checked:
            filename = f"{pair.name}{pair.actual.suffix.lower()}"
            for folder, source in (("actual", pair.actual), ("expected", pair.expected)):
                link = staging / folder / filename
                link.symlink_to(os.path.relpath(source, link.parent))
            manifest_pairs.append({
                "name": pair.name,
                "filename": filename,
                "expected_snapshot": str(pair.expected),
                "expected_sha256": _sha256(pair.expected),
                "actual_snapshot": str(pair.actual),
                "actual_sha256": _sha256(pair.actual),
            })

        runtime = _run_reg_cli(staging, REG_CLI_COMMAND)
        sealed_staging = parent / f".sealed-report-{token_hex(8)}"
        staging = _seal_staging_directory(
            staging,
            parent,
            root,
            staging_identity,
            sealed_path=sealed_staging,
        )
        if runtime is not None:
            runtime_name, runtime_identity = runtime
            _remove_staging_path(staging / runtime_name, runtime_identity)
        if not _staging_directory_is_intact(staging, root, staging_identity):
            raise RuntimeError("reg-cli replaced or moved the staging directory")
        publication_staging = Path(tempfile.mkdtemp(prefix=".publication-", dir=parent))
        publication_identity = publication_staging.lstat()
        (publication_staging / "diff").mkdir()
        _populate_publication_stage(staging, publication_staging, root, manifest_pairs)

        manifest = {
            "created_at_utc": timestamp.isoformat(),
            "repo_scope": scope,
            "pairs": manifest_pairs,
            "generated_files": ["report.html", "reg.json", "diff/"],
        }
        (publication_staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        if (
            not _directory_has_exact_names(publication_staging, REPORT_ROOT_ENTRIES)
            or not _staging_directory_is_intact(publication_staging, root, publication_identity)
            or not _is_real_directory(parent)
            or _contained_path_without_symlinks(parent, root) is None
            or _contained_path_without_symlinks(report_dir, root) is None
        ):
            raise ValueError("report path contains a symlink or escapes the snapshot store")
        if report_dir.exists() or report_dir.is_symlink():
            raise FileExistsError(f"report already exists: {report_dir}")
        snapshot_issue = _snapshot_integrity_issue(manifest_pairs, root)
        if snapshot_issue:
            raise RuntimeError(snapshot_issue)
        publication_staging.rename(report_dir)
        snapshot_issue = _snapshot_integrity_issue(manifest_pairs, root)
        if snapshot_issue:
            raise RuntimeError(snapshot_issue)
        publication_committed = True
        return {"report_html": str(report_dir / "report.html"), "report_dir": str(report_dir), "pairs": len(checked)}
    finally:
        if publication_staging is not None and publication_identity is not None and not publication_committed:
            _remove_staging_path(publication_staging, publication_identity)
        if not publication_committed and publication_identity is not None:
            _remove_staging_path(report_dir, publication_identity)
        if sealed_staging is not None and staging_identity is not None:
            _remove_staging_path(sealed_staging, staging_identity)
        if staging_identity is not None:
            _remove_staging_path(staging, staging_identity)


def audit_report(report_dir: Path, *, store_root: Path | None = None) -> dict[str, object]:
    root = (store_root or _default_store_root()).expanduser().resolve()
    requested_dir = report_dir.expanduser()
    issues: list[str] = []
    if requested_dir.is_symlink():
        return {"report_dir": str(requested_dir), "status": "broken", "issues": ["report directory must not be a symlink"]}
    contained_dir = _contained_path_without_symlinks(requested_dir, root)
    if contained_dir is None:
        return {"report_dir": str(requested_dir), "status": "broken", "issues": ["report directory must be under the snapshot store"]}
    if not _is_real_directory(contained_dir):
        return {"report_dir": str(contained_dir), "status": "broken", "issues": ["report directory is not a regular directory"]}
    report_dir = contained_dir

    if not _directory_has_exact_names(report_dir, REPORT_ROOT_ENTRIES):
        issues.append("unexpected or missing top-level report artifacts")

    manifest_path = report_dir / "manifest.json"
    if not _is_independent_regular_file(manifest_path):
        return {"report_dir": str(report_dir), "status": "broken", "issues": ["missing or unsafe manifest file"]}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"report_dir": str(report_dir), "status": "broken", "issues": ["invalid manifest JSON"]}
    if not isinstance(manifest, dict) or not isinstance(manifest.get("pairs"), list) or not manifest["pairs"]:
        return {"report_dir": str(report_dir), "status": "broken", "issues": ["invalid manifest pairs"]}
    layout_issue = _report_layout_issue(report_dir, root, manifest)
    if layout_issue:
        return {"report_dir": str(report_dir), "status": "broken", "issues": [layout_issue]}

    manifest_filenames: set[str] = set()
    for pair in manifest["pairs"]:
        if not isinstance(pair, dict):
            issues.append("invalid manifest pair")
            continue
        name = pair.get("name")
        filename = pair.get("filename")
        suffix = Path(filename).suffix.lower() if isinstance(filename, str) else ""
        if (
            not isinstance(name, str)
            or not PAIR_NAME.fullmatch(name)
            or not _valid_report_filename(filename)
            or filename != f"{name}{suffix}"
            or filename in manifest_filenames
        ):
            issues.append("invalid manifest filename")
            continue
        manifest_filenames.add(filename)
        for folder, key in (("actual", "actual_snapshot"), ("expected", "expected_snapshot")):
            link_dir = report_dir / folder
            link = link_dir / filename
            raw_source = pair.get(key)
            expected_hash = pair.get(f"{folder}_sha256")
            if (
                not _is_real_directory(link_dir)
                or not isinstance(raw_source, str)
                or not Path(raw_source).is_absolute()
                or not isinstance(expected_hash, str)
                or not re.fullmatch(r"[a-f0-9]{64}", expected_hash)
            ):
                issues.append(f"invalid {folder} dependency metadata: {filename}")
                continue
            source = _contained_path_without_symlinks(Path(raw_source), root)
            if source is None:
                issues.append(f"snapshot is missing or outside the store: {raw_source}")
                continue
            if not _is_regular_file(source):
                issues.append(f"snapshot is missing or not a regular file: {source}")
                continue
            try:
                _snapshot_path(source, root)
            except (OSError, ValueError):
                issues.append(f"snapshot is not an independent generated chat snapshot: {source}")
                continue
            try:
                raw_link_target = Path(os.readlink(link))
                if not raw_link_target.is_absolute():
                    raw_link_target = link.parent / raw_link_target
                link_target = _contained_path_without_symlinks(raw_link_target, root)
            except OSError:
                link_target = None
            if not link.is_symlink() or link_target != source:
                issues.append(f"missing or changed dependency: {link} -> {source}")
            elif _sha256(source) != expected_hash:
                issues.append(f"modified snapshot: {source}")

    for folder in ("actual", "expected"):
        link_dir = report_dir / folder
        if not _is_real_directory(link_dir):
            issues.append(f"missing or unsafe snapshot directory: {folder}")
        elif not _directory_has_exact_names(link_dir, manifest_filenames):
            issues.append(f"unexpected or missing snapshot entries: {folder}")

    for filename in ("report.html", "reg.json"):
        if not _is_independent_regular_file(report_dir / filename):
            issues.append(f"missing or unsafe report file: {filename}")
    diff_dir = report_dir / "diff"
    if not _is_real_directory(diff_dir):
        issues.append("missing or unsafe diff directory")
    reg_path = report_dir / "reg.json"
    if _is_independent_regular_file(reg_path) and _is_real_directory(diff_dir):
        try:
            reg_json = json.loads(reg_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            issues.append("invalid reg-cli JSON")
        else:
            try:
                item_lists = _validated_item_lists(reg_json, manifest_filenames)
            except ValueError:
                issues.append("invalid comparison items")
            else:
                report_html = report_dir / "report.html"
                if _is_independent_regular_file(report_html):
                    html_issue = _html_report_issue(report_html, item_lists)
                    if html_issue:
                        issues.append(html_issue)
                diff_issue = _diff_output_issue(diff_dir, item_lists["diffItems"], item_lists["failedItems"])
                if diff_issue:
                    issues.append(diff_issue)
    return {"report_dir": str(report_dir), "status": "ok" if not issues else "broken", "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    create = subparsers.add_parser("create", help="Create a report from existing user-inline-assets snapshots.")
    create.add_argument("--cwd", type=Path, required=True, help="Repository directory for report ownership.")
    create.add_argument("--pair", nargs=3, action="append", metavar=("NAME", "EXPECTED", "ACTUAL"), required=True)
    audit = subparsers.add_parser("audit", help="Check that a report and its snapshot dependencies remain readable.")
    audit.add_argument("report_dir", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "create":
            result = create_report([ImagePair(name, Path(expected), Path(actual)) for name, expected, actual in args.pair], cwd=args.cwd)
        else:
            result = audit_report(args.report_dir)
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0 if result.get("status") != "broken" else 1


if __name__ == "__main__":
    raise SystemExit(main())
