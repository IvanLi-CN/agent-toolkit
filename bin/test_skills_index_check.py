#!/usr/bin/env python3
"""Unit tests for skills_index_check.py."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("skills_index_check.py")
MODULE_SPEC = importlib.util.spec_from_file_location("skills_index_check", SCRIPT)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
MODULE = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(MODULE)


class SkillsIndexCheckTests(unittest.TestCase):
    def make_repo(self, readme: str, skills: tuple[str, ...]) -> Path:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        repo_root = Path(temporary_directory.name)
        skills_root = repo_root / "skills"
        skills_root.mkdir()
        (skills_root / "README.md").write_text(readme, encoding="utf-8")
        for name in skills:
            skill_root = skills_root / name
            skill_root.mkdir()
            (skill_root / "SKILL.md").write_text(f"---\nname: {name}\ndescription: test\n---\n", encoding="utf-8")
        return repo_root

    def test_accepts_complete_local_index_and_explicit_external_skill(self) -> None:
        repo_root = self.make_repo(
            """| Skill | Description | Path |
|---|---|---|
| `alpha` | Local | `skills/alpha/**` |
| `external-beta` | External | `~/.agents/skills/external-beta/**` |

| `flow_type` | Route |
|---|---|
| `fast-track` | `$fast-flow` |
""",
            ("alpha",),
        )

        self.assertEqual(MODULE.check(repo_root), [])

    def test_reports_missing_and_stale_local_entries(self) -> None:
        repo_root = self.make_repo(
            """| Skill | Description | Path |
|---|---|---|
| `stale` | Missing directory | `skills/stale/**` |
""",
            ("alpha",),
        )

        self.assertEqual(
            MODULE.check(repo_root),
            [
                "MISSING_INDEX_ENTRY skill=alpha",
                "STALE_INDEX_ENTRY skill=stale line=3",
            ],
        )

    def test_reports_duplicate_entries(self) -> None:
        repo_root = self.make_repo(
            """| Skill | Description | Path |
|---|---|---|
| `alpha` | First | `skills/alpha/**` |
| `alpha` | Second | `skills/alpha/**` |
""",
            ("alpha",),
        )

        self.assertEqual(MODULE.check(repo_root), ["DUPLICATE_INDEX_ENTRY skill=alpha count=2"])


if __name__ == "__main__":
    unittest.main()
