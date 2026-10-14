#!/usr/bin/env python3
"""Check that skills/README.md indexes every repository-local skill."""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path
from typing import NamedTuple


SKILL_NAME_PATTERN = re.compile(r"^`([a-z0-9-]+)`$")
EXTERNAL_PATH_PATTERN = re.compile(r"~?/?.*\.agents/skills/([a-z0-9-]+)(?:/|`)")


class IndexEntry(NamedTuple):
    name: str
    line_number: int
    external: bool


def repository_skills(skills_root: Path) -> set[str]:
    return {
        child.name
        for child in skills_root.iterdir()
        if child.is_dir() and not child.name.startswith(".") and (child / "SKILL.md").is_file()
    }


def index_entries(readme_path: Path) -> list[IndexEntry]:
    entries: list[IndexEntry] = []
    in_skill_table = False

    for line_number, raw_line in enumerate(readme_path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = raw_line.strip()
        if stripped.startswith("| Skill |"):
            in_skill_table = True
            continue
        if in_skill_table and (not stripped or not stripped.startswith("|")):
            in_skill_table = False
            continue
        if not in_skill_table or stripped.startswith("|---"):
            continue

        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells:
            continue
        match = SKILL_NAME_PATTERN.fullmatch(cells[0])
        if match is None:
            continue
        name = match.group(1)
        external_match = EXTERNAL_PATH_PATTERN.search(stripped)
        external = external_match is not None and external_match.group(1) == name
        entries.append(IndexEntry(name=name, line_number=line_number, external=external))

    return entries


def check(repo_root: Path) -> list[str]:
    skills_root = repo_root / "skills"
    readme_path = skills_root / "README.md"
    actual = repository_skills(skills_root)
    entries = index_entries(readme_path)
    local_entries = [entry for entry in entries if not entry.external]
    indexed = {entry.name for entry in local_entries}
    findings: list[str] = []

    for name in sorted(actual - indexed):
        findings.append(f"MISSING_INDEX_ENTRY skill={name}")
    for entry in local_entries:
        if entry.name not in actual:
            findings.append(f"STALE_INDEX_ENTRY skill={entry.name} line={entry.line_number}")

    counts = Counter(entry.name for entry in entries)
    for name, count in sorted(counts.items()):
        if count > 1:
            findings.append(f"DUPLICATE_INDEX_ENTRY skill={name} count={count}")

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    repo_root = args.repo_root.resolve()
    findings = check(repo_root)
    for finding in findings:
        print(f"FINDING {finding}")
    if findings:
        return 1
    print("PASS skills index: every repository-local skill is indexed exactly once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
