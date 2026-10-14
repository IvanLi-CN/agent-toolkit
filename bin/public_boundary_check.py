#!/usr/bin/env python3
"""Reject private environment markers from public repository files."""

from __future__ import annotations

import subprocess
import sys
import re
from pathlib import Path


FORBIDDEN_MARKERS = (
    "CODEX_" + "THREAD_ID",
)
_SECRET_NAME = rb"(?:api[_-]?key|apikey|access[_-]?key|accesskey|token|secret|secret[_-]?key|secretkey|secret[_-]?access[_-]?key|secretaccesskey|password|passwd|private[_-]?key|privatekey|credential)"
# Shell variables and template placeholders are not concrete secret values.
_SECRET_VALUE = rb"(?![$<\{])[^'\"\r\n]{16,}"
_REGEX_HELPER_ASSIGNMENT = re.compile(rb"(?i)^[ \t]*(?:local[ \t]+)?(?:re|regex|pattern)[_-][A-Za-z0-9_-]*[ \t]*=")
_COMPOUND_ASSIGNMENT = re.compile(rb"(?i)(?<![A-Za-z0-9_-])(?P<name>[A-Za-z0-9_-]+)\s*=\s*['\"]" + _SECRET_VALUE + rb"['\"]")
_JSON_SECRET_FIELD = re.compile(rb"(?i)[\"'](?P<name>[A-Za-z0-9_-]+)[\"']\s*:\s*[\"']" + _SECRET_VALUE + rb"[\"']")
_SECRET_SUFFIXES = (
    "api_key", "apikey", "access_key", "accesskey", "token", "secret",
    "secret_key", "secretkey", "secret_access_key", "secretaccesskey", "password", "passwd",
    "private_key", "privatekey", "credential",
)
FORBIDDEN_PATTERNS = (
    ("absolute-home-path", re.compile(rb"/(?:Users|home)/[A-Za-z0-9._-]+")),
    ("private-hostname", re.compile(rb"\b[A-Za-z0-9-]+\.(?:internal|lan|local)\b")),
    ("jwt-like-secret", re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("quoted-secret-assignment", re.compile(rb"(?i)(?<![A-Za-z0-9_-])" + _SECRET_NAME + rb"\s*=\s*['\"]" + _SECRET_VALUE + rb"['\"]")),
    ("prefixed-quoted-secret-assignment", _COMPOUND_ASSIGNMENT),
    ("json-secret-field", _JSON_SECRET_FIELD),
)
IGNORED_PRIVATE_HOSTNAMES = frozenset((b"config.local", b"threading.local"))


def _is_regex_helper_assignment(content: bytes, match: re.Match[bytes]) -> bool:
    """Ignore an explicit regex helper definition, not a secret value's punctuation."""
    line_start = content.rfind(b"\n", 0, match.start()) + 1
    line_end = content.find(b"\n", match.end())
    if line_end < 0:
        line_end = len(content)
    line = content[line_start:line_end]
    return bool(_REGEX_HELPER_ASSIGNMENT.match(line)) and any(marker in match.group(0) for marker in (b"(", b"[", b"|"))


def _normalize_secret_field(name: bytes) -> str:
    value = name.decode("ascii").replace("-", "_")
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)
    return value.lower()


def _is_secret_field(name: bytes) -> bool:
    normalized = _normalize_secret_field(name)
    return any(normalized == suffix or normalized.endswith("_" + suffix) or normalized.endswith(suffix)
               for suffix in _SECRET_SUFFIXES)


def _is_simple_secret_field(name: bytes) -> bool:
    return _normalize_secret_field(name) in _SECRET_SUFFIXES


def tracked_files(repo_root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.PIPE,
        text=False,
    )
    return [repo_root / item for item in result.stdout.decode().split("\0") if item]


def check(repo_root: Path) -> list[str]:
    findings: list[str] = []
    for path in tracked_files(repo_root):
        if not path.is_file():
            continue
        try:
            content = path.read_bytes()
        except OSError:
            continue
        for marker in FORBIDDEN_MARKERS:
            if marker.encode("utf-8") in content:
                findings.append(f"{path.relative_to(repo_root)}: forbidden marker {marker}")
        for label, pattern in FORBIDDEN_PATTERNS:
            matches = [
                match for match in pattern.finditer(content)
                if match.group(0) not in IGNORED_PRIVATE_HOSTNAMES
                and not (label == "prefixed-quoted-secret-assignment" and not _is_secret_field(match.group("name")))
                and not (label == "prefixed-quoted-secret-assignment" and _is_simple_secret_field(match.group("name")))
                and not (label == "json-secret-field" and not _is_secret_field(match.group("name")))
                and not (label == "prefixed-quoted-secret-assignment" and _is_regex_helper_assignment(content, match))
            ]
            if matches:
                findings.append(f"{path.relative_to(repo_root)}: forbidden pattern {label}")
    return findings


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    findings = check(repo_root)
    for finding in findings:
        print(f"FINDING {finding}")
    if findings:
        return 1
    print("PASS public boundary: no forbidden private markers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
