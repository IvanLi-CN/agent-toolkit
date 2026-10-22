"""Publisher transaction tests with a deterministic fake SSH control surface."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "skills/agent-vm-ops/scripts"
if str(SCRIPTS) not in os.sys.path:
    os.sys.path.insert(0, str(SCRIPTS))
import agent_vm_release as RELEASE  # noqa: E402


class FakeTransport:
    def __init__(self, *, fail_health_once=False, pending=False, drain_enter=True, unknown_state=False):
        self.calls = []
        self.fail_health_once = fail_health_once
        self.pending = pending
        self.drain_enter = drain_enter
        self.unknown_state = unknown_state
        self.health_checks = 0

    def wrapper(self, host, wrapper_path, action, transaction_id, release_id, payload=None):
        self.calls.append(("wrapper", action, transaction_id, release_id, payload is not None))
        if action == "activate":
            return {"ok": True, "result": {"activated": True, "release_id": release_id}}
        if action == "rollback":
            return {"ok": True, "result": {"rolled_back": True, "release_id": "c" * 40}}
        if action == "stage":
            return {"ok": True, "result": {"staged": True}}
        if action == "verify":
            return {"ok": True, "result": {"verified": True}}
        return {"ok": True, "result": {action: True}}

    def control(self, host, remote_control, request):
        self.calls.append(("control", request["action"], request.get("operation_id")))
        action = request["action"]
        if action == "admin-metrics":
            return {"ok": True, "result": {
                "up": True,
                "draining": True,
                "pending_operations": [{"operation_id": "pending"}] if self.pending else [],
                "task_states": {"unknown": 1} if self.unknown_state else {"active": 1},
            }}
        if action == "doctor":
            self.health_checks += 1
            ready = not self.fail_health_once or self.health_checks > 1
            return {"ok": True, "result": {"ready": ready, "issues": [] if ready else ["injected"]}}
        return {"ok": True, "result": {"draining": self.drain_enter if action == "drain-enter" else action != "drain-exit"}}


class ReleasePublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle.tar"
        RELEASE.build_release(ROOT, self.bundle, "e" * 40)

    def publisher(self, transport, *, client_target=None, clock=None):
        elapsed = [0.0]
        return RELEASE.ReleasePublisher(
            bundle=self.bundle,
            control_host="staging-control",
            wrapper_path="/usr/local/sbin/agent-vm-release-wrapper",
            client_target=client_target,
            transport=transport,
            sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds),
            monotonic=clock or (lambda: elapsed[0]),
        )

    def test_publish_is_remote_first_and_exits_drain_after_local_client(self):
        transport = FakeTransport()
        target = self.root / "client" / "agent_vm.py"
        result = self.publisher(transport, client_target=target).publish(timeout=5, poll=1, transaction_id="tx-publish")
        self.assertTrue(result["published"])
        self.assertTrue(target.is_file())
        self.assertTrue((target.parent / "client-release.json").is_file())
        actions = [item[1] for item in transport.calls]
        self.assertEqual(actions[:3], ["stage", "verify", "drain-enter"])
        self.assertLess(actions.index("drain-enter"), actions.index("activate"))
        self.assertEqual(actions[-1], "drain-exit")

    def test_convergence_timeout_does_not_activate_or_exit_drain(self):
        transport = FakeTransport(pending=True)
        publisher = self.publisher(transport)
        with self.assertRaises(RELEASE.ReleaseError) as failure:
            publisher.publish(timeout=2, poll=1, transaction_id="tx-timeout")
        self.assertEqual(failure.exception.code, "convergence_timeout")
        actions = [item[1] for item in transport.calls]
        self.assertNotIn("activate", actions)
        self.assertNotIn("drain-exit", actions)

    def test_activation_requires_confirmed_drain(self):
        transport = FakeTransport(drain_enter=False)
        with self.assertRaises(RELEASE.ReleaseError) as failure:
            self.publisher(transport).publish(timeout=5, poll=1, transaction_id="tx-no-drain")
        self.assertEqual(failure.exception.code, "drain_unverified")
        self.assertNotIn("activate", [item[1] for item in transport.calls])

    def test_convergence_rejects_unknown_task_state(self):
        transport = FakeTransport(unknown_state=True)
        with self.assertRaises(RELEASE.ReleaseError) as failure:
            self.publisher(transport).publish(timeout=5, poll=1, transaction_id="tx-unknown-state")
        self.assertEqual(failure.exception.code, "state_unverified")
        self.assertNotIn("activate", [item[1] for item in transport.calls])

    def test_post_activation_health_failure_attempts_one_rollback(self):
        transport = FakeTransport(fail_health_once=True)
        target = self.root / "client" / "agent_vm.py"
        result = self.publisher(transport, client_target=target).publish(timeout=5, poll=1, transaction_id="tx-rollback")
        self.assertTrue(result["rolled_back"])
        actions = [item[1] for item in transport.calls]
        self.assertIn("rollback", actions)
        self.assertEqual(actions[-1], "drain-exit")

    def test_local_client_failure_keeps_remote_release_drained_without_rollback(self):
        transport = FakeTransport()
        publisher = self.publisher(transport, client_target=self.root / "client" / "agent_vm.py")
        publisher._install_local_client = lambda manifest: (_ for _ in ()).throw(RELEASE.ReleaseError("local_client_selfcheck_failed", "injected"))
        result = publisher.publish(timeout=5, poll=1, transaction_id="tx-local-failure")
        self.assertFalse(result["published"])
        self.assertTrue(result["draining"])
        actions = [item[1] for item in transport.calls]
        self.assertNotIn("rollback", actions)
        self.assertNotIn("drain-exit", actions)


if __name__ == "__main__":
    unittest.main()
