#!/usr/bin/env python3
"""Create immutable local image snapshots for owner-facing chat markdown."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from secrets import token_hex

sys.dont_write_bytecode = True


def _slugify(value: str, fallback: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or fallback


def _default_codex_home() -> Path:
    env_home = os.environ.get("CODEX_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    home_default = Path.home() / ".codex"
    if home_default.is_dir():
        return home_default.resolve()
    return Path(__file__).resolve().parent.parent


def _default_store_root() -> Path:
    return _default_codex_home() / "user-inline-assets"


def _git_stdout(cwd: Path, *args: str) -> str | None:
    proc = subprocess.run(
        ["git", "-C", str(cwd), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip()
    return out or None


def _resolve_repo_root(cwd: Path) -> Path:
    repo_root = _git_stdout(cwd, "rev-parse", "--show-toplevel")
    if repo_root:
        return Path(repo_root).expanduser().resolve()
    return cwd.resolve()


def _resolve_source(source: str, cwd: Path) -> Path:
    candidate = Path(source).expanduser()
    if not candidate.is_absolute():
        candidate = cwd / candidate
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"source image not found: {candidate}") from exc
    if not resolved.is_file():
        raise FileNotFoundError(f"source image is not a file: {resolved}")
    return resolved


def _repo_scope(cwd: Path) -> dict[str, str]:
    repo_root = _resolve_repo_root(cwd)
    repo_slug = _slugify(repo_root.name, "repo")
    repo_hash8 = hashlib.sha256(str(repo_root).encode("utf-8")).hexdigest()[:8]
    return {
        "repo_root": str(repo_root),
        "repo_slug": repo_slug,
        "repo_hash8": repo_hash8,
        "repo_scope": f"{repo_slug}__{repo_hash8}",
    }


def _normalized_suffix(path: Path) -> str:
    suffix = unicodedata.normalize("NFKC", path.suffix).lower()
    if suffix:
        safe_body = _slugify(suffix.lstrip("."), "img")
        return f".{safe_body}"
    raise ValueError(f"source image must have a file extension: {path}")


def create_snapshot(
    *,
    source: str,
    cwd: str,
    now: datetime | None = None,
    rand8: str | None = None,
    store_root: str | Path | None = None,
) -> dict[str, str]:
    cwd_path = Path(cwd).expanduser().resolve()
    source_path = _resolve_source(source, cwd_path)
    scope = _repo_scope(cwd_path)
    suffix = _normalized_suffix(source_path)
    safe_source_stem = _slugify(source_path.stem, "image")
    ts = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    timestamp = ts.strftime("%Y%m%dT%H%M%SZ")
    target_root = Path(store_root).expanduser().resolve() if store_root else _default_store_root()
    target_dir = target_root / scope["repo_scope"] / ts.strftime("%Y") / ts.strftime("%m") / ts.strftime("%d")
    target_dir.mkdir(parents=True, exist_ok=True)

    while True:
        token = rand8 or token_hex(4)
        candidate = target_dir / f"{timestamp}-{safe_source_stem}-{token}{suffix}"
        if candidate.exists():
            if rand8:
                raise FileExistsError(f"snapshot path already exists: {candidate}")
            continue
        break

    shutil.copyfile(source_path, candidate)
    return {
        "snapshot_path": str(candidate),
        "source_path": str(source_path),
        "store_root": str(target_root),
        "repo_root": scope["repo_root"],
        "repo_scope": scope["repo_scope"],
        "repo_slug": scope["repo_slug"],
        "repo_hash8": scope["repo_hash8"],
        "created_at_utc": timestamp,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create an immutable local image snapshot for owner-facing chat markdown.")
    parser.add_argument("--source", required=True, help="Source local image path (absolute or relative to --cwd).")
    parser.add_argument("--cwd", required=True, help="Working directory used to resolve the source path and repo scope.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        payload = create_snapshot(source=args.source, cwd=args.cwd)
    except Exception as exc:  # pragma: no cover - CLI error path
        print(str(exc), file=sys.stderr)
        return 1
    dump = json.dumps(payload, indent=2 if args.pretty else None, sort_keys=True)
    print(dump)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
