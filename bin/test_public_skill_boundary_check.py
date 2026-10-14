"""Tests for the public Skill coupling boundary."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("public_skill_boundary_check", ROOT / "bin/public_skill_boundary_check.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PublicSkillBoundaryTests(unittest.TestCase):
    def make_repo(self, content: str) -> tuple[Path, Path]:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        root = Path(temporary_directory.name)
        skill = root / "skills" / "alpha"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(content, encoding="utf-8")
        manifest = root / "PUBLIC_SKILLS.txt"
        manifest.write_text("alpha\n", encoding="utf-8")
        return root, manifest

    def test_accepts_standalone_skill(self) -> None:
        root, manifest = self.make_repo("# standalone\n")
        self.assertEqual(MODULE.check(root, manifest), [])

    def test_rejects_codex_runtime_marker(self) -> None:
        root, manifest = self.make_repo("Use $CODEX_HOME for the helper.\n")
        self.assertEqual(MODULE.check(root, manifest), ["skills/alpha/SKILL.md: forbidden public coupling codex-runtime-marker"])

    def test_rejects_codex_product_reference(self) -> None:
        root, manifest = self.make_repo("Use Codex Plan Mode.\n")
        self.assertEqual(MODULE.check(root, manifest), ["skills/alpha/SKILL.md: forbidden public coupling codex-product-reference"])

    def test_rejects_native_task_surface(self) -> None:
        root, manifest = self.make_repo("Use a native task Worktree.\n")
        self.assertEqual(MODULE.check(root, manifest), ["skills/alpha/SKILL.md: forbidden public coupling codex-native-surface"])

    def test_rejects_private_operator_reference_name(self) -> None:
        root, manifest = self.make_repo("# standalone\n")
        references = root / "skills" / "alpha" / "references"
        references.mkdir()
        (references / "hosts.txt").write_text("alias\n", encoding="utf-8")
        self.assertEqual(
            MODULE.check(root, manifest),
            ["skills/alpha/references/hosts.txt: private operator reference must stay outside repository"],
        )

    def test_rejects_skill_directory_missing_from_manifest(self) -> None:
        root, manifest = self.make_repo("# standalone\n")
        extra = root / "skills" / "private-looking"
        extra.mkdir()
        (extra / "SKILL.md").write_text("Use $CODEX_HOME.\n", encoding="utf-8")
        self.assertEqual(MODULE.check(root, manifest), ["UNLISTED_PUBLIC_SKILL private-looking"])


if __name__ == "__main__":
    unittest.main()
