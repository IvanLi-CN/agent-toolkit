#!/usr/bin/env python3
"""Reject Codex-only runtime coupling from public Skills."""

from __future__ import annotations

import re
import sys
from pathlib import Path


PUBLIC_MANIFEST = Path(__file__).resolve().parents[1] / "PUBLIC_SKILLS.txt"
PRIVATE_REFERENCE_NAMES = frozenset(
    {"hosts.txt", "inventory.md", "deployment-policy.yaml"}
)
FORBIDDEN_PATTERNS = (
    ("codex-runtime-marker", re.compile(rb"(?i)(?:\bCODEX_[A-Z0-9_]+\b|\$CODEX_HOME|\.codex(?:/|\\|\b))")),
    ("codex-product-reference", re.compile(rb"(?i)\bCodex\b")),
    ("codex-native-surface", re.compile(rb"(?i)\b(?:TaskSpace|agent_session)\b|native\s+(?:task|worktree|background)")),
)


def public_skills(manifest: Path = PUBLIC_MANIFEST) -> list[str]:
    names: list[str] = []
    for raw_line in manifest.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            names.append(line)
    return names


def repository_skills(repo_root: Path) -> set[str]:
    skills_root = repo_root / "skills"
    if not skills_root.is_dir():
        return set()
    return {
        child.name
        for child in skills_root.iterdir()
        if child.is_dir() and not child.name.startswith(".") and (child / "SKILL.md").is_file()
    }


def check(repo_root: Path, manifest: Path = PUBLIC_MANIFEST) -> list[str]:
    findings: list[str] = []
    try:
        names = public_skills(manifest)
    except OSError as exc:
        return [f"MANIFEST_READ_ERROR {manifest}: {exc}"]

    if len(names) != len(set(names)):
        findings.append("DUPLICATE_PUBLIC_SKILL_NAME")

    actual = repository_skills(repo_root)
    listed = set(names)
    for name in sorted(actual - listed):
        findings.append(f"UNLISTED_PUBLIC_SKILL {name}")

    for name in names:
        skill_root = repo_root / "skills" / name
        skill_file = skill_root / "SKILL.md"
        if not skill_file.is_file():
            findings.append(f"MISSING_PUBLIC_SKILL {name}")
            continue
        for path in sorted(path for path in skill_root.rglob("*") if path.is_file()):
            if path.parent.name == "references" and path.name in PRIVATE_REFERENCE_NAMES:
                findings.append(
                    f"{path.relative_to(repo_root)}: private operator reference must stay outside repository"
                )
            try:
                content = path.read_bytes()
            except OSError as exc:
                findings.append(f"READ_ERROR {path.relative_to(repo_root)}: {exc}")
                continue
            for label, pattern in FORBIDDEN_PATTERNS:
                if pattern.search(content):
                    findings.append(f"{path.relative_to(repo_root)}: forbidden public coupling {label}")
    return findings


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    findings = check(repo_root)
    for finding in findings:
        print(f"FINDING {finding}")
    if findings:
        return 1
    print(f"PASS public Skill boundary: {len(public_skills())} standalone Skills")
    return 0


if __name__ == "__main__":
    sys.exit(main())
