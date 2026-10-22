"""Permission and failure-state tests for the fixed release wrapper."""
from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "skills/agent-vm-ops/scripts"
if str(SCRIPTS) not in os.sys.path:
    os.sys.path.insert(0, str(SCRIPTS))
import agent_vm_release as RELEASE  # noqa: E402
import agent_vm_release_wrapper as WRAPPER  # noqa: E402


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle.tar"
        RELEASE.build_release(ROOT, self.bundle, "b" * 40)
        uid = os.getuid()
        self.config = {
            "release_root": str(self.root / "releases"),
            "staging_root": str(self.root / "staging"),
            "current_link": str(self.root / "current"),
            "previous_link": str(self.root / "previous"),
            "control_path": str(self.root / "installed" / "agent_vm_control.py"),
            "unit_dir": str(self.root / "units"),
            "state_root": str(self.root / "wrapper-state"),
            "owner_uid": uid,
            "require_drained": False,
        }
        self.config_path = self.root / "wrapper.json"
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.loaded = WRAPPER.load_config(self.config_path)
        self.payload = self.bundle.read_bytes()

    def test_unsafe_archive_members_are_rejected(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            member = tarfile.TarInfo("../escape")
            member.size = 1
            archive.addfile(member, io.BytesIO(b"x"))
        with self.assertRaises(WRAPPER.WrapperError) as failure:
            WRAPPER.safe_extract_archive(output.getvalue(), self.root / "unsafe")
        self.assertEqual(failure.exception.code, "unsafe_archive")

    def test_stage_verify_and_activate_only_install_fixed_targets(self):
        staged = WRAPPER.stage(self.loaded, "tx-one", "b" * 40, self.payload)
        self.assertTrue(staged["staged"])
        verified = WRAPPER.verify_transaction(self.loaded, "tx-one", "b" * 40)
        self.assertTrue(verified["verified"])
        with mock.patch.object(WRAPPER.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as run:
            activated = WRAPPER.activate(self.loaded, "tx-one", "b" * 40)
        self.assertTrue(activated["activated"])
        self.assertEqual(Path(self.loaded["current_link"]).resolve().name, "b" * 40)
        self.assertTrue(Path(self.loaded["control_path"]).is_file())
        self.assertTrue(Path(self.loaded["control_path"]).with_name("agent_vm.py").is_file())
        self.assertTrue(Path(self.loaded["control_path"]).with_name("release_manifest.py").is_file())
        self.assertTrue(Path(self.loaded["control_path"]).with_name("release-manifest.json").is_file())
        self.assertTrue(Path(self.loaded["control_path"]).with_name("client-release.json").is_file())
        self.assertEqual(run.call_args.args[0], ["systemctl", "daemon-reload"])
        self.assertFalse(any("stop" in arg or "disable" in arg for arg in run.call_args.args[0]))

    def test_activation_failure_restores_fixed_targets_and_pointers(self):
        WRAPPER.stage(self.loaded, "tx-failure", "b" * 40, self.payload)
        WRAPPER.verify_transaction(self.loaded, "tx-failure", "b" * 40)
        with mock.patch.object(
            WRAPPER,
            "_daemon_reload",
            side_effect=[WRAPPER.WrapperError("activation_failed", "injected"), None],
        ):
            with self.assertRaises(WRAPPER.WrapperError) as failure:
                WRAPPER.activate(self.loaded, "tx-failure", "b" * 40)
        self.assertEqual(failure.exception.code, "activation_failed")
        self.assertFalse(Path(self.loaded["current_link"]).exists())
        self.assertFalse(Path(self.loaded["control_path"]).exists())
        self.assertFalse(Path(self.loaded["control_path"]).with_name("agent_vm.py").exists())
        self.assertFalse(Path(self.loaded["control_path"]).with_name("client-release.json").exists())

    def test_rollback_is_bounded_and_keeps_previous_release(self):
        first = self.root / "first.tar"
        second = self.root / "second.tar"
        RELEASE.build_release(ROOT, first, "c" * 40)
        RELEASE.build_release(ROOT, second, "d" * 40)
        with mock.patch.object(WRAPPER.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")):
            WRAPPER.stage(self.loaded, "tx-first", "c" * 40, first.read_bytes())
            WRAPPER.activate(self.loaded, "tx-first", "c" * 40)
            WRAPPER.stage(self.loaded, "tx-second", "d" * 40, second.read_bytes())
            WRAPPER.activate(self.loaded, "tx-second", "d" * 40)
            result = WRAPPER.rollback(self.loaded, "tx-second", "d" * 40)
        self.assertTrue(result["rolled_back"])
        self.assertEqual(result["release_id"], "c" * 40)
        self.assertEqual(Path(self.loaded["current_link"]).resolve().name, "c" * 40)
        with self.assertRaises(WRAPPER.WrapperError) as failure:
            WRAPPER.rollback(self.loaded, "tx-second", "d" * 40)
        self.assertEqual(failure.exception.code, "rollback_already_attempted")


if __name__ == "__main__":
    unittest.main()
