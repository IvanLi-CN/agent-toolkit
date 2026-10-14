#!/usr/bin/env python3
"""Compare a split public/private Skill inventory with this checkout."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def target_inventory(root: Path) -> set[str]:
    return {
        child.name
        for child in (root / "skills").iterdir()
        if child.is_dir() and not child.name.startswith(".") and (child / "SKILL.md").is_file()
    }


def manifest_inventory(path: Path) -> set[str]:
    return {
        line
        for raw_line in path.read_text(encoding="utf-8").splitlines()
        for line in [raw_line.strip()]
        if line and not line.startswith("#")
    }


def snapshot_inventory(source: Path, revision: str) -> set[str]:
    result = subprocess.run(
        ["git", "-C", str(source), "ls-tree", "-r", "--name-only", revision, "--", "skills"],
        check=True,
        capture_output=True,
        text=True,
    )
    prefix = "skills/"
    suffix = "/SKILL.md"
    return {
        item.removeprefix(prefix).removesuffix(suffix)
        for item in result.stdout.splitlines()
        if item.startswith(prefix) and item.endswith(suffix) and item.count("/") == 2
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--source-revision", default="HEAD")
    parser.add_argument("--target-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--public-manifest",
        type=Path,
        default=None,
        help="public Skill allowlist; defaults to <target-root>/PUBLIC_SKILLS.txt",
    )
    args = parser.parse_args()
    source = args.source_root.resolve()
    target = args.target_root.resolve()
    expected_source = snapshot_inventory(source, args.source_revision)
    actual = target_inventory(target)
    manifest_path = (args.public_manifest or target / "PUBLIC_SKILLS.txt").resolve()
    public = manifest_inventory(manifest_path)
    private = expected_source - public
    findings: list[str] = []
    for name in sorted(public - expected_source):
        findings.append(f"PUBLIC_SKILL_NOT_IN_SOURCE_SNAPSHOT {name}")
    for name in sorted(public - actual):
        findings.append(f"MISSING_PUBLIC_TARGET_SKILL {name}")
    for name in sorted(actual - public):
        findings.append(f"UNEXPECTED_PRIVATE_TARGET_SKILL {name}")

    source_skills = source / "skills"
    if source_skills.exists() and not source_skills.is_symlink():
        owned = sorted(
            child.name
            for child in source_skills.iterdir()
            if child.is_dir() and (child / "SKILL.md").is_file()
        )
        source_owned = set(owned)
        for name in sorted(public & source_owned):
            findings.append(f"PUBLIC_SKILL_SOURCE_DUPLICATE {name}")
        for name in sorted(private - source_owned):
            findings.append(f"MISSING_PRIVATE_SOURCE_SKILL {name}")
        for name in sorted(source_owned - private):
            findings.append(f"UNEXPECTED_SOURCE_SKILL {name}")
    elif private:
        findings.append(f"MISSING_PRIVATE_SOURCE_TREE count={len(private)}")

    if findings:
        for finding in findings:
            print(f"FINDING {finding}")
        return 1
    print(
        "PASS source-target inventory: "
        f"public={len(public)} target skills, private={len(private)} source skills, no duplicate source"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
