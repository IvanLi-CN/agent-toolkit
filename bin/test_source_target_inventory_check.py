"""Tests for public/private Skill inventory helpers."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("source_target_inventory_check", ROOT / "bin/source_target_inventory_check.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SourceTargetInventoryTests(unittest.TestCase):
    def test_manifest_ignores_comments_and_blank_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "PUBLIC_SKILLS.txt"
            manifest.write_text("# comment\n\nalpha\n beta \n", encoding="utf-8")
            self.assertEqual(MODULE.manifest_inventory(manifest), {"alpha", "beta"})

    def test_target_inventory_only_counts_skill_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skills" / "public").mkdir(parents=True)
            (root / "skills" / "private").mkdir()
            (root / "skills" / "public" / "SKILL.md").write_text("# public\n", encoding="utf-8")
            (root / "skills" / "private" / "README.md").write_text("private\n", encoding="utf-8")
            self.assertEqual(MODULE.target_inventory(root), {"public"})


if __name__ == "__main__":
    unittest.main()
