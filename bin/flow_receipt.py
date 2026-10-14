#!/usr/bin/env python3
"""Maintain non-tracked validation and review receipts for engineering flows."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import fnmatch
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping


try:
    from agent_profile_runtime import (
        ProfileError,
        attest_native_profile,
        canonical_sessions_root,
        normalise_profile_resolution,
        profile_override_unavailable,
    )
except ModuleNotFoundError:  # Direct package execution.
    from bin.agent_profile_runtime import (
        ProfileError,
        attest_native_profile,
        canonical_sessions_root,
        normalise_profile_resolution,
        profile_override_unavailable,
    )

try:
    from code_hosting import backend_for, resolve_repository_for_pr, resolve_unique_repository
except ModuleNotFoundError:  # Direct package execution.
    from bin.code_hosting import backend_for, resolve_repository_for_pr, resolve_unique_repository


DEFAULT_COMMAND_BUDGET_SECONDS = 1800
MAX_CONVERGENCE_ROUNDS = 3
FLOW_SCHEMA_VERSION = 7
REVIEW_RECEIPT_SCHEMA_VERSION = 6
MAX_DYNAMIC_REVIEW_LANES = 2
REVIEW_INIT_TIMEOUT_SECONDS = 300
REVIEW_STALL_TIMEOUT_SECONDS = 900
KNOWN_LONG_CONFIG = ".codex-flow.json"
TERMINAL_STATES = frozenset(("complete", "failed", "cancelled", "NON_CONVERGENT"))
TRANSIENT_VALIDATION_EXIT_CODES = frozenset((75, 124))
RECEIPT_CONTRACT_TEST_COMMAND_RE = re.compile(
    r"(?:^|[\s/])bin(?:[/.])test_flow_receipt(?:\.py)?(?=$|[\s:.])"
)
FIXED_REVIEW_LANES = frozenset(
    ("contract", "state-concurrency", "failure-data-safety", "test-platform")
)
DYNAMIC_REVIEW_LANES = frozenset(
    ("ui-accessibility", "security", "database-migration", "release-infra")
)
REVIEW_SCOPE_CLASSES = frozenset(("code", "document", "mechanical"))
PR_BOUND_FLOW_TYPES = frozenset(("wave-thread", "fast-track", "normal"))
# Initiative keeps its independent review-proof state machine. Direct review
# receipts cover only the owner-facing delivery flows.
DIRECT_REVIEW_FLOW_TYPES = frozenset(("wave-thread", "fast-track", "normal", "local-merge"))
REVIEW_NECESSITY_TIERS = frozenset((1, 2, 3, 4))
PR_REF_PATTERN = re.compile(
    r"(?:PR#\d+|[^\s/]+/[^\s#]+#\d+|https?://[^\s]+/pulls?/\d+)"
)
REVIEW_SUGGESTED_MODEL_EFFORTS = {
    "gpt-5.6-luna": frozenset(("low", "medium", "high", "xhigh", "max")),
    "gpt-5.6-terra": frozenset(("low", "medium", "high", "xhigh", "max", "ultra")),
    "gpt-5.6-sol": frozenset(("low", "medium", "high", "xhigh", "max", "ultra")),
}
# The direct-review defaults are ordered by quality/cost.  The order is a
# contract: a Luna startup failure may move to the Terra fallback pair, but a
# Terra failure must remain a blocker instead of silently becoming Luna-only.
REVIEW_MODEL_LADDER = (
    ("gpt-5.6-luna", "medium"),
    ("gpt-5.6-luna", "xhigh"),
    ("gpt-5.6-luna", "max"),
    ("gpt-5.6-terra", "xhigh"),
)
DIRECT_REVIEW_LANE_PROFILES = {
    "contract": ("gpt-5.6-luna", "medium"),
    "state-concurrency": ("gpt-5.6-luna", "xhigh"),
    "failure-data-safety": ("gpt-5.6-luna", "max"),
    "test-platform": ("gpt-5.6-terra", "xhigh"),
}
REVIEW_LUNA_FALLBACKS = (
    ("gpt-5.6-terra", "medium"),
    ("gpt-5.6-terra", "xhigh"),
)
REVIEW_TERRA_FALLBACKS = (("gpt-5.6-terra", "xhigh"),)
DIRECT_REVIEW_PROFILES = frozenset(REVIEW_MODEL_LADDER + REVIEW_LUNA_FALLBACKS)
SUBAGENT_STARTUP_UNAVAILABLE = "startup-unavailable"


def review_model_fallbacks(model: str, effort: str | None = None) -> tuple[tuple[str, str], ...]:
    """Return the only permitted provider fallback sequence for a review."""
    if model == "gpt-5.6-luna":
        return REVIEW_LUNA_FALLBACKS
    if model == "gpt-5.6-terra" and effort == "medium":
        return REVIEW_TERRA_FALLBACKS
    return ()


def is_direct_review_model(model: str, effort: str) -> bool:
    """Whether a pair is one of the mandatory direct-review defaults."""
    return (model, effort) in REVIEW_MODEL_LADDER


def is_allowed_direct_review_profile(model: str, effort: str) -> bool:
    """Whether a pair may be declared for a direct review lane."""
    return (model, effort) in DIRECT_REVIEW_PROFILES


def direct_review_profile_resolution(
    declared_model: str,
    declared_effort: str,
    resolved_model: str,
    resolved_effort: str,
) -> dict[str, Any]:
    """Record the exact direct-review model path selected for one lane."""
    preferred = {"model": declared_model, "effort": declared_effort}
    resolved = {"model": resolved_model, "effort": resolved_effort}
    if (declared_model, declared_effort) == (resolved_model, resolved_effort):
        return {
            "preferred": preferred,
            "resolved": resolved,
            "fallback_reason": None,
            "attempts": 1,
        }
    if declared_model == "gpt-5.6-luna" and (resolved_model, resolved_effort) == (
        "gpt-5.6-terra",
        "medium",
    ):
        return {
            "preferred": preferred,
            "resolved": resolved,
            "fallback_reason": "luna-startup-unavailable",
            "attempts": 2,
        }
    if declared_model == "gpt-5.6-luna" and (resolved_model, resolved_effort) == (
        "gpt-5.6-terra",
        "xhigh",
    ):
        return {
            "preferred": preferred,
            "resolved": resolved,
            "fallback_reason": "luna-and-terra-medium-startup-unavailable",
            "attempts": 3,
        }
    raise RuntimeError("direct review profile resolution is not on the allowed fallback ladder")


def direct_wave_lane_profile_is_authorized(
    ledger: dict[str, Any],
    *,
    repo_path: Path,
    head_sha: str,
    base_sha: str,
    wave_id: str,
    lane: str,
    declared_model: str,
    declared_effort: str,
    review_model: str,
    review_effort: str,
) -> bool:
    """Require the ordered fallback history for one direct review lane."""
    def has_unavailable_attempt(model: str, effort: str) -> bool:
        expected_profile_resolution = {
            "preferred": {"model": model, "effort": effort},
            "resolved": {"model": "unavailable", "effort": "unavailable"},
            "fallback_reason": "sub-agent-unavailable",
            "attempts": 1,
        }
        for receipt in ledger.get("receipts", []):
            if not isinstance(receipt, dict):
                continue
            review_profile = receipt.get("review_profile")
            if review_profile not in {"pr-convergence", "risk-arbitration"}:
                continue
            proof_key = f"{repo_path}:{head_sha}:{base_sha}:{review_profile}"
            wave_proof_key = f"{proof_key}:{wave_id}:{lane}"
            identity = stable_hash(
                ["sub-agent-review-unavailable", wave_proof_key, model, effort]
            )
            expected_receipt_id = stable_hash(
                [ledger.get("run_id"), "sub-agent-review-unavailable", identity]
            )
            if (
                receipt.get("receipt_id") == expected_receipt_id
                and receipt.get("kind") == "review_attempt"
                and receipt.get("review_receipt_schema") == REVIEW_RECEIPT_SCHEMA_VERSION
                and receipt.get("proof_key") == proof_key
                and receipt.get("wave_proof_key") == wave_proof_key
                and receipt.get("head_sha") == head_sha
                and receipt.get("base_sha") == base_sha
                and receipt.get("review_model") == model
                and receipt.get("review_effort") == effort
                and receipt.get("resolved_model") == "unavailable"
                and receipt.get("resolved_effort") == "unavailable"
                and receipt.get("profile_resolution") == expected_profile_resolution
                and receipt.get("profile_proof_status") == "sub-agent-declared"
                and receipt.get("review_execution_source") == "sub-agent"
                and receipt.get("provenance_boundary") == "sub-agent-structured-result"
                and receipt.get("evidence_source") == "sub-agent-structured-result"
                and receipt.get("terminal_state") == "unavailable"
                and receipt.get("unavailability_classification")
                == SUBAGENT_STARTUP_UNAVAILABLE
                and receipt.get("wave_id") == wave_id
                and receipt.get("lane") == lane
                and receipt.get("finding_fingerprints") == []
                and receipt.get("review_findings") == []
                and receipt.get("review_clear") is False
                and receipt.get("overall_correctness") == "unavailable"
                and receipt.get("evidence_valid") is False
                and receipt.get("post_execution_clean") is True
                and receipt.get("exit_code") == 75
                and isinstance(receipt.get("recorded_at"), str)
                and receipt["recorded_at"].strip()
            ):
                return True
        return False

    if (review_model, review_effort) == (declared_model, declared_effort):
        return not has_unavailable_attempt(declared_model, declared_effort)
    if declared_model != "gpt-5.6-luna":
        return False
    if (review_model, review_effort) == ("gpt-5.6-terra", "medium"):
        return has_unavailable_attempt(declared_model, declared_effort) and not has_unavailable_attempt(
            "gpt-5.6-terra", "medium"
        )
    if (review_model, review_effort) == ("gpt-5.6-terra", "xhigh"):
        return has_unavailable_attempt(declared_model, declared_effort) and has_unavailable_attempt(
            "gpt-5.6-terra", "medium"
        ) and not has_unavailable_attempt("gpt-5.6-terra", "xhigh")
    return False


PROFILE_FALLBACK_BLOCKERS_RE = re.compile(
    r"authentication|authorization|auth[ _-]*(?:failed|error|denied)|unauthori[sz]ed|"
    r"(?:invalid|expired|rejected|failed|failure)[ _-]*(?:api[ _-]*)?(?:key|token|credential)|"
    r"(?:api[ _-]*)?(?:key|token|credential)(?:[ _-]+(?:is|was))?[ _-]*"
    r"(?:invalid|expired|rejected|failed|failure)|"
    r"permission[ _-]*denied|access[ _-]*denied|forbidden|not[ _-]*permitted|"
    r"quota|rate[ _-]*limit|billing|api[ _-]*(?:unavailable|error|failure|outage)|"
    r"provider|upstream|gateway|network|connection|timeout|sandbox|"
    r"(?:http(?:[ _-]*status)?|status|code)\D{0,24}\b[45][0-9]{2}\b|"
    r"(?:internal|server|service)[ _-]*(?:error|failure|unavailable)",
    re.IGNORECASE,
)
ACCEPTANCE_CLASSES = frozenset(
    ("behavior", "contract", "safety", "migration", "data-integrity", "permission", "mechanical")
)
ACCEPTANCE_MODES = frozenset(("direct", "composed"))
ACCEPTANCE_GATES = frozenset(("validation", "delivery"))
HIGH_RISK_ACCEPTANCE_CLASSES = frozenset(
    ("safety", "migration", "data-integrity", "permission")
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_hash(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def default_review_state() -> dict[str, Any]:
    return {
        "next_epoch": 1,
        "pr_ref": None,
        "pr_base_sha": None,
        "pr_head_sha": None,
        "pr_bound_at": None,
        "base_ref": None,
        "base_ref_identity": None,
        "authorization_message_ids": [],
        "terra_authorization_message_ids": [],
        "active_epoch_id": None,
        "active_wave_id": None,
        "epochs": [],
        "waves": {},
        "cumulative": {
            "finding_to_group": {},
            "blocker_fingerprints": [],
            "invariants": [],
            "coverage_lanes": [],
            "conflicts": [],
            "conflict_dispositions": [],
        },
    }


def pending_review_assessment() -> dict[str, Any]:
    """Return the explicit, Agent-owned review-necessity decision surface."""
    return {
        "tier": None,
        "reason": None,
        "assessed_at": None,
        "assessed_head_sha": None,
        "source": "pending",
    }


def migrated_review_assessment() -> dict[str, Any]:
    """Preserve the stronger pre-tier contract for active legacy receipts."""
    return {
        "tier": 3,
        "reason": "Migrated from the pre-tier mandatory direct review contract.",
        "assessed_at": None,
        "assessed_head_sha": None,
        "source": "pre-tier-migration",
    }


def review_mode_for_tier(tier: int | None) -> str:
    if tier is None:
        return "assessment-required"
    if tier == 1:
        return "not-required"
    if tier == 2:
        return "advisory"
    return f"mandatory-tier-{tier}"


def normalize_acceptance_manifest(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"plan_digest", "items"}:
        raise RuntimeError("acceptance manifest does not match the required schema")
    plan_digest = payload.get("plan_digest")
    items = payload.get("items")
    if not isinstance(plan_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", plan_digest):
        raise RuntimeError("acceptance manifest plan digest is invalid")
    if not isinstance(items, list) or not items:
        raise RuntimeError("acceptance manifest items are invalid")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        required = {"id", "category", "mode", "target", "evidence", "assertions"}
        allowed = required | {"gate"}
        if not isinstance(item, dict) or set(item) not in (required, allowed):
            raise RuntimeError("acceptance manifest item does not match the required schema")
        acceptance_id = item.get("id")
        category = item.get("category")
        mode = item.get("mode")
        target = item.get("target")
        evidence = item.get("evidence")
        assertions = item.get("assertions")
        gate = item.get("gate", "validation")
        if (
            not isinstance(acceptance_id, str)
            or not re.fullmatch(r"[A-Z][A-Z0-9_-]*", acceptance_id)
            or acceptance_id in seen
            or category not in ACCEPTANCE_CLASSES
            or mode not in ACCEPTANCE_MODES
            or gate not in ACCEPTANCE_GATES
            or not isinstance(target, str)
            or not target.strip()
            or not isinstance(evidence, list)
            or not evidence
            or any(not isinstance(value, str) or not value.strip() for value in evidence)
            or len(evidence) != len(set(evidence))
            or not isinstance(assertions, list)
            or not assertions
            or any(not isinstance(value, str) or not value.strip() for value in assertions)
            or len(assertions) != len(set(assertions))
        ):
            raise RuntimeError("acceptance manifest item is invalid")
        if category in HIGH_RISK_ACCEPTANCE_CLASSES and mode != "direct":
            raise RuntimeError("high-risk acceptance requires direct evidence")
        seen.add(acceptance_id)
        normalized.append(
            {
                "id": acceptance_id,
                "category": category,
                "mode": mode,
                "gate": gate,
                "target": target.strip(),
                "evidence": sorted(evidence),
                "assertions": sorted(assertions),
            }
        )
    normalized.sort(key=lambda value: value["id"])
    return {"plan_digest": plan_digest, "items": normalized}


def restore_current_candidate_receipt_test_evidence(ledger: dict[str, Any]) -> None:
    """Restore candidate-worktree receipt-test evidence removed by the retired migration."""
    manifest = ledger.get("acceptance_manifest")
    if not isinstance(manifest, dict):
        return
    migration = ledger.get("acceptance_manifest_migration")
    if not isinstance(migration, dict) or migration.get("kind") != (
        "synthetic-delivery-validation-retired"
    ):
        return
    historical_manifest = ledger.get("legacy_acceptance_manifest")
    if not isinstance(historical_manifest, dict):
        return
    normalized = normalize_acceptance_manifest(manifest)
    historical = normalize_acceptance_manifest(historical_manifest)
    historical_by_id = {item["id"]: item for item in historical["items"]}
    restored_item_ids: list[str] = []
    for item in normalized["items"]:
        historical_item = historical_by_id.get(item["id"])
        if not historical_item:
            continue
        test_evidence = {
            value
            if value.startswith("PYTHONDONTWRITEBYTECODE=1 ")
            else f"PYTHONDONTWRITEBYTECODE=1 {value}"
            for value in historical_item["evidence"]
            if RECEIPT_CONTRACT_TEST_COMMAND_RE.search(value)
        }
        if not test_evidence or any(
            RECEIPT_CONTRACT_TEST_COMMAND_RE.search(value) for value in item["evidence"]
        ):
            continue
        item["evidence"] = sorted(set(item["evidence"]) | test_evidence)
        restored_item_ids.append(item["id"])
    if not restored_item_ids:
        return
    ledger["acceptance_manifest"] = normalize_acceptance_manifest(normalized)
    migration_history = ledger.setdefault("acceptance_manifest_migration_history", [])
    if not isinstance(migration_history, list):
        raise RuntimeError("acceptance manifest migration history is invalid")
    migration_history.append(json.loads(json.dumps(migration)))
    ledger["acceptance_manifest_migration"] = {
        "kind": "current-candidate-receipt-test-evidence-restored",
        "restored_item_ids": sorted(restored_item_ids),
    }


def migrate_retired_pre_pr_acceptance_manifest(ledger: dict[str, Any]) -> None:
    """Move active receipts from the retired pre-PR contract to merge proof."""
    manifest = ledger.get("acceptance_manifest")
    if not isinstance(manifest, dict):
        return
    normalized = normalize_acceptance_manifest(manifest)
    retired_assertions = frozenset(
        ("high_risk_pre_pr_required", "pr_merge_four_lane_proof_required")
    )
    if not any(
        retired_assertions.intersection(item["assertions"])
        for item in normalized["items"]
    ):
        return
    if "legacy_review_acceptance_manifest" not in ledger:
        ledger["legacy_review_acceptance_manifest"] = json.loads(json.dumps(manifest))
    for item in normalized["items"]:
        if not retired_assertions.intersection(item["assertions"]):
            continue
        item["assertions"] = sorted(
            {
                "pr_merge_assessed_review_proof_required"
                if assertion in retired_assertions
                else assertion
                for assertion in item["assertions"]
            }
        )
    ledger["acceptance_manifest"] = normalize_acceptance_manifest(normalized)
    ledger["review_acceptance_manifest_migration"] = {
        "kind": "review-proof-requirement-tiered",
        "replacement_assertion": "pr_merge_assessed_review_proof_required",
    }


POST_MERGE_FINALITY_STATUSES = {
    "target_ci": frozenset(("passed",)),
    "release": frozenset(("published", "not-applicable")),
}


def _normalize_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", value):
        raise RuntimeError(f"post-merge {label} is invalid")
    return value.lower()


POST_MERGE_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _normalize_merged_at(value: Any) -> str:
    if not isinstance(value, str):
        raise RuntimeError("post-merge merged_at is invalid")
    timestamp = value.strip()
    if not POST_MERGE_TIMESTAMP_PATTERN.fullmatch(timestamp):
        raise RuntimeError("post-merge merged_at is invalid")
    try:
        parsed = datetime.fromisoformat(
            timestamp[:-1] + "+00:00" if timestamp.endswith("Z") else timestamp
        )
    except ValueError as error:
        raise RuntimeError("post-merge merged_at is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError("post-merge merged_at is invalid")
    return timestamp


def _repository_binding_identity(value: Any) -> tuple[str, str, str] | None:
    if hasattr(value, "as_dict"):
        value = value.as_dict()
    if not isinstance(value, Mapping):
        return None
    provider = value.get("provider")
    host = value.get("host")
    full_name = value.get("full_name")
    if not all(
        isinstance(item, str) and item.strip()
        for item in (provider, host, full_name)
    ):
        return None
    return provider.strip().lower(), host.strip().lower(), full_name.strip().lower()


def _require_repository_binding_match(expected: Any, actual: Any) -> None:
    expected_identity = _repository_binding_identity(expected)
    actual_identity = _repository_binding_identity(actual)
    if (
        expected_identity is None
        or actual_identity is None
        or expected_identity != actual_identity
    ):
        raise RuntimeError("repository binding does not match the active ledger")


def normalize_post_merge_evidence(payload: Any) -> dict[str, Any]:
    """Validate the immutable external facts needed to seal a merged PR."""
    required = {"pr_ref", "head_sha", "base_sha", "merge_sha", "merged_at", "finality"}
    if not isinstance(payload, dict) or set(payload) != required:
        raise RuntimeError("post-merge evidence does not match the required schema")
    pr_ref = payload.get("pr_ref")
    if not isinstance(pr_ref, str) or not PR_REF_PATTERN.fullmatch(pr_ref.strip()):
        raise RuntimeError("post-merge pr_ref is invalid")
    merged_at = _normalize_merged_at(payload.get("merged_at"))
    finality = payload.get("finality")
    if not isinstance(finality, dict) or set(finality) != {"target_ci", "release"}:
        raise RuntimeError("post-merge finality is invalid")
    normalized_finality: dict[str, dict[str, Any]] = {}
    for surface, allowed_statuses in POST_MERGE_FINALITY_STATUSES.items():
        fact = finality.get(surface)
        if not isinstance(fact, dict):
            raise RuntimeError(f"post-merge finality.{surface} is invalid")
        status = fact.get("status")
        if status == "not_applicable":
            status = "not-applicable"
        if status not in allowed_statuses:
            raise RuntimeError(f"post-merge finality.{surface} is not terminal")
        normalized_fact = dict(fact)
        normalized_fact["status"] = status
        normalized_fact["bound_sha"] = _normalize_sha(
            fact.get("bound_sha"), f"finality.{surface}.bound_sha"
        )
        if not isinstance(fact.get("run_id", ""), str):
            raise RuntimeError(f"post-merge finality.{surface}.run_id is invalid")
        normalized_finality[surface] = normalized_fact
    merge_sha = _normalize_sha(payload.get("merge_sha"), "merge_sha")
    if any(fact["bound_sha"] != merge_sha for fact in normalized_finality.values()):
        raise RuntimeError("post-merge finality facts must bind the merge SHA")
    return {
        "pr_ref": pr_ref.strip(),
        "head_sha": _normalize_sha(payload.get("head_sha"), "head_sha"),
        "base_sha": _normalize_sha(payload.get("base_sha"), "base_sha"),
        "merge_sha": merge_sha,
        "merged_at": merged_at,
        "finality": normalized_finality,
    }


def normalize_ledger(payload: dict[str, Any]) -> dict[str, Any]:
    """Accept schema v5/v6 history and normalize new ledgers to schema v7."""
    if not isinstance(payload, dict):
        raise RuntimeError("ledger payload is invalid")
    schema_version = payload.get("schema_version", 1)
    if type(schema_version) is not int:
        raise RuntimeError("ledger schema_version is invalid")
    if payload.get("flow_type") == "initiative":
        # Initiative owns a separate review-proof state machine and schema.
        return payload
    if schema_version not in {5, 6, FLOW_SCHEMA_VERSION}:
        raise RuntimeError("flow receipt supports only schema v5/v6 migration or schema v7")
    if schema_version == 5:
        state = payload.get("state")
        if state != "active":
            if isinstance(state, str) and state in TERMINAL_STATES:
                return payload
            raise RuntimeError("schema v5 receipt state is invalid")
        if "review" in payload and "legacy_review" not in payload:
            payload["legacy_review"] = json.loads(json.dumps(payload["review"]))
        if "review_assessment" in payload and "legacy_review_assessment" not in payload:
            payload["legacy_review_assessment"] = json.loads(
                json.dumps(payload["review_assessment"])
            )
        legacy_review = payload.get("legacy_review")
        payload.setdefault("legacy_compatibility", True)
        payload.setdefault("legacy_schema_version", schema_version)
        payload["schema_version"] = FLOW_SCHEMA_VERSION
        payload["review"] = default_review_state()
        if isinstance(legacy_review, dict):
            for key in (
                "pr_ref",
                "pr_base_sha",
                "pr_head_sha",
                "pr_bound_at",
                "pr_base_ref_identity",
                "base_ref",
                "base_ref_identity",
            ):
                if key in legacy_review:
                    payload["review"][key] = legacy_review[key]
        payload["review_assessment"] = migrated_review_assessment()
    elif schema_version == 6:
        payload.setdefault("review_assessment", pending_review_assessment())
        payload.setdefault("legacy_compatibility", True)
        payload.setdefault("legacy_schema_version", schema_version)
        payload["schema_version"] = FLOW_SCHEMA_VERSION
        payload.setdefault("repository_binding", None)
        payload.setdefault("provider_facts", None)
    else:
        payload.setdefault("review_assessment", pending_review_assessment())
    if payload.get("schema_version") == FLOW_SCHEMA_VERSION:
        payload.setdefault("repository_binding", None)
        payload.setdefault("provider_facts", None)
    assessment = payload["review_assessment"]
    if not isinstance(assessment, dict):
        raise RuntimeError("ledger review assessment is invalid")
    tier = assessment.get("tier")
    if tier is not None and (type(tier) is not int or tier not in REVIEW_NECESSITY_TIERS):
        raise RuntimeError("ledger review assessment tier is invalid")
    reason = assessment.get("reason")
    if tier is None:
        if (
            reason is not None
            or assessment.get("assessed_at") is not None
            or assessment.get("assessed_head_sha") is not None
            or assessment.get("source") != "pending"
        ):
            raise RuntimeError("pending review assessment is invalid")
    elif not isinstance(reason, str) or not reason.strip():
        raise RuntimeError("recorded review assessment reason is invalid")
    elif assessment.get("source") == "pre-tier-migration":
        if assessment != migrated_review_assessment():
            raise RuntimeError("migrated review assessment is invalid")
    else:
        assessed_at = assessment.get("assessed_at")
        assessed_head_sha = assessment.get("assessed_head_sha")
        if assessment.get("source") != "agent-assessment":
            raise RuntimeError("recorded review assessment source is invalid")
        if not isinstance(assessed_at, str) or not assessed_at.strip():
            raise RuntimeError("recorded review assessment timestamp is invalid")
        try:
            parsed_assessment_time = datetime.fromisoformat(assessed_at)
        except ValueError as error:
            raise RuntimeError("recorded review assessment timestamp is invalid") from error
        if parsed_assessment_time.tzinfo is None:
            raise RuntimeError("recorded review assessment timestamp is invalid")
        if not isinstance(assessed_head_sha, str) or not re.fullmatch(
            r"[0-9a-f]{40}", assessed_head_sha
        ):
            raise RuntimeError("recorded review assessment head is invalid")
    payload["review_mode"] = review_mode_for_tier(tier)
    payload["acceptance_required"] = True
    payload.setdefault("acceptance_manifest", None)
    if payload.get("state") == "active":
        restore_current_candidate_receipt_test_evidence(payload)
        migrate_retired_pre_pr_acceptance_manifest(payload)
    review = payload.setdefault("review", {})
    if not isinstance(review, dict):
        raise RuntimeError("ledger review state is invalid")
    defaults = default_review_state()
    for key, value in defaults.items():
        review.setdefault(key, value.copy() if isinstance(value, (dict, list)) else value)
    return payload


def project_status_payload(value: Any) -> Any:
    """Keep retained legacy metadata out of the active status contract."""
    if isinstance(value, list):
        return [project_status_payload(item) for item in value]
    if not isinstance(value, dict):
        return value
    projected: dict[str, Any] = {}
    for key, item in value.items():
        retired_scope = key.startswith("validation") and key.endswith("_scope")
        retired_full_control = key.startswith("full_") and "validation" in key
        if retired_scope or retired_full_control:
            continue
        projected[key] = project_status_payload(item)
    return projected


def parse_lane_spec(raw: str) -> dict[str, str]:
    parts = raw.split(":")
    if len(parts) != 3 or not all(part.strip() for part in parts):
        raise RuntimeError("review lane must use NAME:MODEL:EFFORT")
    lane, model, effort = (part.strip() for part in parts)
    allowed_efforts = REVIEW_SUGGESTED_MODEL_EFFORTS.get(model)
    if allowed_efforts is None or effort not in allowed_efforts:
        raise RuntimeError(f"unsupported review model/effort: {model}+{effort}")
    return {"lane": lane, "model": model, "effort": effort}


def review_model_matches_lane(
    declared_model: str,
    declared_effort: str,
    actual_model: str,
    actual_effort: str,
    *,
    enforce_direct: bool = False,
) -> bool:
    """Validate resolved metadata, including the ordered sub-agent fallback policy."""
    if not all(
        isinstance(value, str) and value.strip()
        for value in (declared_model, declared_effort, actual_model, actual_effort)
    ):
        return False
    declared = (declared_model, declared_effort)
    actual = (actual_model, actual_effort)
    if enforce_direct:
        if not is_allowed_direct_review_profile(*declared) or not is_allowed_direct_review_profile(
            *actual
        ):
            return False
        return actual == declared or actual in review_model_fallbacks(*declared)
    if is_direct_review_model(*declared):
        return actual == declared or actual in review_model_fallbacks(declared_model)
    return not enforce_direct


def requires_live_pr_facts_for_review_stage(
    stage: str, pr_ref: Any, *, pr_required: bool = False
) -> bool:
    """Direct PR waves are bound to one live PR; local merge waves are not."""
    if stage not in {"initial", "repair"}:
        return False
    return pr_required or (isinstance(pr_ref, str) and bool(pr_ref.strip()))


def repair_authorization_has_no_active_wave(review: dict[str, Any]) -> bool:
    """A repair permit is valid only after its entire source wave is closed."""
    return not bool(review.get("active_wave_id"))


def repair_budget_exhausted(epoch: dict[str, Any]) -> bool:
    return int(epoch.get("repair_rounds_used", 0)) >= MAX_CONVERGENCE_ROUNDS


def review_convergence_started(review: dict[str, Any]) -> bool:
    """Keep a direct-flow tier immutable after any review epoch exists."""
    return bool(review.get("active_wave_id") or review.get("active_epoch_id") or review.get("epochs"))


def is_current_clear_required_review_wave(
    wave: Any, *, head_sha: Any, base_sha: Any, review_tier: int
) -> bool:
    if not isinstance(wave, dict) or wave.get("stage") not in {"initial", "repair"}:
        return False
    lanes = wave.get("lanes")
    if not isinstance(lanes, dict):
        return False
    lane_names = set(lanes)
    dynamic_lanes = lane_names.difference(FIXED_REVIEW_LANES)
    if review_tier == 3:
        required_lanes = lane_names == FIXED_REVIEW_LANES
    elif review_tier == 4:
        required_lanes = (
            FIXED_REVIEW_LANES.issubset(lane_names)
            and dynamic_lanes.issubset(DYNAMIC_REVIEW_LANES)
            and 1 <= len(dynamic_lanes) <= MAX_DYNAMIC_REVIEW_LANES
        )
    else:
        return False
    return (
        required_lanes
        and wave.get("state") == "finalized"
        and not wave.get("blockers")
        and wave.get("head_sha") == head_sha
        and wave.get("base_sha") == base_sha
        and bool(wave.get("synthesis_sha256"))
    )


def retire_legacy_high_requirement(epoch: dict[str, Any]) -> bool:
    """Retain the old pre-PR flag for audit without letting it gate v6 waves."""
    if epoch.get("high_requirement") is not True:
        return False
    epoch["legacy_high_requirement"] = True
    epoch["high_requirement"] = False
    return True


def profile_override_is_unavailable(
    *,
    startup_success: bool,
    returncode: int,
    stderr: str,
    requested_model: str,
    requested_effort: str,
) -> bool:
    """Identify a pre-start profile error that requires an explicit replacement."""
    return (
        not startup_success
        and returncode not in {0, 124}
        and not PROFILE_FALLBACK_BLOCKERS_RE.search(stderr)
        and profile_override_unavailable(
            {"error": stderr}, model=requested_model, effort=requested_effort
        )
    )


def normalize_review_synthesis(payload: Any) -> dict[str, Any]:
    """Validate and normalize the cross-lane synthesis artifact.

    The four required lists are intentionally small and stable so old v2
    callers remain readable.  Cumulative mappings are derived here instead of
    trusting a caller-supplied blocker digest.
    """
    if not isinstance(payload, dict):
        raise RuntimeError("review synthesis must be an object")
    required = {"groups", "invariants", "coverage", "conflicts"}
    if not required.issubset(payload) or any(
        key not in required and key not in {"conflict_dispositions", "acceptance"} for key in payload
    ):
        raise RuntimeError("review synthesis does not match the required schema")
    groups = payload["groups"]
    if not isinstance(groups, list):
        raise RuntimeError("review synthesis groups are invalid")
    normalized_groups: list[dict[str, Any]] = []
    seen_group_ids: set[str] = set()
    finding_to_group: dict[str, str] = {}
    for group in groups:
        if not isinstance(group, dict) or set(group) != {
            "group_id",
            "finding_fingerprints",
            "blocker",
            "invariant",
        }:
            raise RuntimeError("review synthesis groups are invalid")
        group_id = group["group_id"]
        fingerprints = group["finding_fingerprints"]
        invariant = group["invariant"]
        if (
            not isinstance(group_id, str)
            or not group_id.strip()
            or group_id in seen_group_ids
            or not isinstance(fingerprints, list)
            or any(not isinstance(item, str) or not item.strip() for item in fingerprints)
            or not isinstance(group["blocker"], bool)
            or not isinstance(invariant, str)
            or not invariant.strip()
            or (group["blocker"] and not fingerprints)
        ):
            raise RuntimeError("review synthesis groups are invalid")
        seen_group_ids.add(group_id)
        if len(fingerprints) != len(set(fingerprints)):
            raise RuntimeError("review synthesis repeats a finding fingerprint")
        normalized_fingerprints = sorted(fingerprints)
        for fingerprint in normalized_fingerprints:
            previous = finding_to_group.get(fingerprint)
            if previous is not None and previous != group_id:
                raise RuntimeError("review synthesis maps one finding to multiple root groups")
            finding_to_group[fingerprint] = group_id
        normalized_groups.append(
            {
                "group_id": group_id,
                "finding_fingerprints": normalized_fingerprints,
                "blocker": group["blocker"],
                "invariant": invariant,
            }
        )

    lists: dict[str, list[str]] = {}
    for key in ("invariants", "coverage", "conflicts"):
        value = payload[key]
        if (
            not isinstance(value, list)
            or any(not isinstance(item, str) or not item.strip() for item in value)
            or len(value) != len(set(value))
        ):
            raise RuntimeError("review synthesis lists are invalid")
        lists[key] = sorted(value)
    dispositions = payload.get("conflict_dispositions", [])
    if not isinstance(dispositions, list) or any(
        not isinstance(item, dict)
        or set(item) != {"conflict", "disposition"}
        or not isinstance(item["conflict"], str)
        or not isinstance(item["disposition"], str)
        or not item["conflict"].strip()
        or not item["disposition"].strip()
        for item in dispositions
    ):
        raise RuntimeError("review synthesis conflict dispositions are invalid")
    if len({item["conflict"] for item in dispositions}) != len(dispositions):
        raise RuntimeError("review synthesis repeats a conflict disposition")
    if {item["conflict"] for item in dispositions} - set(lists["conflicts"]):
        raise RuntimeError("review synthesis has a disposition for an undeclared conflict")
    blockers = [group for group in normalized_groups if group["blocker"]]
    blocker_fingerprints = sorted(
        stable_hash(
            {
                "group_id": group["group_id"],
                "finding_fingerprints": group["finding_fingerprints"],
                "invariant": group["invariant"],
            }
        )
        for group in blockers
    )
    acceptance = payload.get("acceptance", [])
    if not isinstance(acceptance, list):
        raise RuntimeError("review synthesis acceptance coverage is invalid")
    normalized_acceptance: list[dict[str, Any]] = []
    seen_acceptance: set[str] = set()
    for item in acceptance:
        if not isinstance(item, dict) or set(item) != {
            "id", "status", "receipt_ids", "assertions"
        }:
            raise RuntimeError("review synthesis acceptance coverage is invalid")
        acceptance_id = item.get("id")
        receipt_ids = item.get("receipt_ids")
        assertions = item.get("assertions")
        if (
            not isinstance(acceptance_id, str)
            or not acceptance_id
            or acceptance_id in seen_acceptance
            or item.get("status") not in {"covered", "partial", "missing"}
            or not isinstance(receipt_ids, list)
            or any(not isinstance(value, str) or not value for value in receipt_ids)
            or len(receipt_ids) != len(set(receipt_ids))
            or not isinstance(assertions, list)
            or any(not isinstance(value, str) or not value for value in assertions)
            or len(assertions) != len(set(assertions))
        ):
            raise RuntimeError("review synthesis acceptance coverage is invalid")
        seen_acceptance.add(acceptance_id)
        normalized_acceptance.append(
            {
                "id": acceptance_id,
                "status": item["status"],
                "receipt_ids": sorted(receipt_ids),
                "assertions": sorted(assertions),
            }
        )
    return {
        "groups": normalized_groups,
        "invariants": lists["invariants"],
        "coverage": lists["coverage"],
        "conflicts": lists["conflicts"],
        "conflict_dispositions": sorted(
            dispositions, key=lambda item: (item["conflict"], item["disposition"])
        ),
        "blockers": sorted(group["group_id"] for group in blockers),
        "blocker_fingerprints": blocker_fingerprints,
        "finding_to_group": finding_to_group,
        "acceptance": sorted(normalized_acceptance, key=lambda value: value["id"]),
        "scope_fingerprint": stable_hash(
            {
                "groups": normalized_groups,
                "invariants": lists["invariants"],
                "coverage": lists["coverage"],
                "conflicts": lists["conflicts"],
                "conflict_dispositions": dispositions,
            }
        ),
    }


def review_synthesis_input(synthesis: dict[str, Any]) -> dict[str, Any]:
    """Return the durable, caller-schema portion of a normalized synthesis."""
    return {
        key: synthesis[key]
        for key in (
            "groups",
            "invariants",
            "coverage",
            "conflicts",
            "conflict_dispositions",
            "acceptance",
        )
    }


def normalize_input_paths(patterns: Iterable[str]) -> list[str]:
    normalized: set[str] = set()
    for raw_pattern in patterns:
        pattern = raw_pattern.strip()
        while pattern.startswith("./"):
            pattern = pattern[2:]
        if not pattern or pattern.startswith("/") or ".." in pattern.split("/"):
            raise RuntimeError(
                "validation input paths must be repository-relative without '..'"
            )
        normalized.add(pattern)
    return sorted(normalized)


def normalize_acceptance_evidence(payload: Any) -> list[dict[str, Any]]:
    if payload is None:
        return []
    if not isinstance(payload, list):
        raise RuntimeError("acceptance evidence must be a list")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in payload:
        if not isinstance(item, dict) or set(item) != {"id", "target", "assertions"}:
            raise RuntimeError("acceptance evidence item is invalid")
        acceptance_id = item.get("id")
        target = item.get("target")
        assertions = item.get("assertions")
        if (
            not isinstance(acceptance_id, str)
            or not acceptance_id
            or acceptance_id in seen
            or not isinstance(target, str)
            or not target.strip()
            or not isinstance(assertions, list)
            or not assertions
            or any(not isinstance(value, str) or not value.strip() for value in assertions)
            or len(assertions) != len(set(assertions))
        ):
            raise RuntimeError("acceptance evidence item is invalid")
        seen.add(acceptance_id)
        normalized.append(
            {"id": acceptance_id, "target": target.strip(), "assertions": sorted(assertions)}
        )
    return sorted(normalized, key=lambda value: value["id"])


def validate_acceptance_evidence(
    manifest: dict[str, Any] | None, acceptance_evidence: list[dict[str, Any]]
) -> None:
    """Validate receipt evidence without assigning it a validation category."""
    if not acceptance_evidence:
        return
    if not isinstance(manifest, dict):
        raise RuntimeError("acceptance evidence requires a registered manifest")
    manifest = normalize_acceptance_manifest(manifest)
    manifest_items = {item["id"]: item for item in manifest["items"]}
    for evidence in acceptance_evidence:
        expected = manifest_items.get(evidence["id"])
        if expected is None:
            raise RuntimeError("acceptance evidence references an unknown ID")
        if expected["gate"] != "validation":
            raise RuntimeError("delivery acceptance cannot be covered by local validation")
        if evidence["target"] not in expected["evidence"]:
            raise RuntimeError("acceptance evidence target does not match the manifest")
        assertions = set(evidence["assertions"])
        if not assertions.issubset(expected["assertions"]):
            raise RuntimeError("acceptance evidence assertions do not match the manifest")


def validation_proof_key(
    command: str,
    toolchain_fingerprint: str,
    declared_input_fingerprint: str,
    declared_input_paths: Iterable[str] = (),
) -> str:
    return stable_hash(
        {
            "kind": "validation",
            "command": command,
            "toolchain": toolchain_fingerprint,
            "declared_input_scope": declared_input_fingerprint,
            "declared_input_paths": normalize_input_paths(declared_input_paths),
        }
    )


def validation_execution_identity(
    proof_key: str, effective_inputs: str, acceptance_evidence: list[dict[str, Any]]
) -> str:
    return stable_hash(
        {
            "proof_key": proof_key,
            "effective_inputs": effective_inputs,
            "acceptance_evidence": acceptance_evidence,
        }
    )


def legacy_validation_receipt_matches(
    receipt: Any,
    *,
    command: str,
    toolchain_fingerprint: str,
    declared_input_fingerprint: str,
    declared_input_paths: list[str],
    effective_inputs: str,
    acceptance_evidence: list[dict[str, Any]],
) -> bool:
    """Reuse older receipts by their retained evidence rather than retired metadata."""
    if not isinstance(receipt, dict):
        return False
    stored_paths = receipt.get("declared_input_paths")
    if not isinstance(stored_paths, list):
        return False
    try:
        normalized_paths = normalize_input_paths(stored_paths)
    except (RuntimeError, TypeError, ValueError):
        return False
    return (
        receipt.get("kind") == "validation"
        and receipt.get("command") == command
        and receipt.get("toolchain_fingerprint") == toolchain_fingerprint
        and receipt.get("declared_input_fingerprint") == declared_input_fingerprint
        and normalized_paths == declared_input_paths
        and receipt.get("input_fingerprint") == effective_inputs
        and receipt.get("acceptance_evidence", []) == acceptance_evidence
    )


def path_matches_declared_inputs(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def file_snapshot(status: os.stat_result) -> tuple[int, int, int, int, int]:
    """Return the mutable file fields that must not change during evidence reads."""
    return (
        status.st_dev,
        status.st_ino,
        status.st_size,
        status.st_mtime_ns,
        status.st_ctime_ns,
    )


def stable_file_bytes(path: Path, label: str) -> bytes:
    """Read a review artifact only if the opened inode stays stable."""
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        raise RuntimeError(f"{label} cannot be opened safely on this platform")
    try:
        descriptor = os.open(path, os.O_RDONLY | no_follow)
    except OSError as error:
        raise RuntimeError(f"{label} must be a regular non-symlink file") from error
    with os.fdopen(descriptor, "rb") as handle:
        handle_before = file_snapshot(os.fstat(handle.fileno()))
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise RuntimeError(f"{label} must be a regular non-symlink file")
        payload = handle.read()
        handle_after = file_snapshot(os.fstat(handle.fileno()))
    try:
        path_status = path.lstat()
    except OSError as error:
        raise RuntimeError(f"{label} changed while being read") from error
    path_after = file_snapshot(path_status)
    if not stat.S_ISREG(path_status.st_mode) or len({handle_before, handle_after, path_after}) != 1:
        raise RuntimeError(f"{label} changed while being read")
    return payload


def file_sha256(path: Path) -> str:
    return hashlib.sha256(stable_file_bytes(path, "review evidence")).hexdigest()


def write_once_review_artifact(path: Path, text: str, label: str) -> str:
    """Persist review evidence once, rejecting a conflicting pre-existing artifact."""
    payload = text.encode("utf-8")
    expected_sha256 = hashlib.sha256(payload).hexdigest()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
    except FileExistsError:
        if path.read_bytes() != payload:
            raise RuntimeError(f"{label} conflicts with an existing persisted artifact")
    finally:
        temporary.unlink(missing_ok=True)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha256:
        raise RuntimeError(f"{label} changed while being persisted")
    return expected_sha256


def review_artifact_path(review_root: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"review receipt has no {label}")
    path = Path(value)
    if path.is_symlink():
        raise RuntimeError(f"review receipt {label} must not be a symlink")
    path = path.resolve()
    try:
        path.relative_to(review_root.resolve())
    except ValueError as error:
        raise RuntimeError(f"review receipt {label} escapes the review artifact root") from error
    if not path.is_file():
        raise RuntimeError(f"review receipt {label} does not exist")
    return path


def audit_review_artifacts(review_root: Path) -> list[str]:
    """Accept only the helper's declared durable direct-review artifacts."""
    expected = {"output-schema.json", "final-message.json"}
    violations: list[str] = []
    for path in review_root.iterdir():
        if path.name not in expected:
            violations.append(f"unexpected review artifact: {path.name}")
            continue
        if path.is_symlink() or not path.is_file():
            violations.append(f"review artifact is not a regular file: {path.name}")
    if not (review_root / "output-schema.json").is_file():
        violations.append("review output schema is missing")
    return violations


def remove_regular_review_artifact(path: Path, label: str) -> None:
    """Remove a generated artifact without ever following a symlink."""
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"{label} is not a removable regular file")
    path.unlink()


def review_finding_fingerprint(finding: dict[str, Any]) -> str:
    location = finding["code_location"]
    title = " ".join(finding["title"].split()).lower()
    body = re.sub(r"\b\d+\b", "<number>", " ".join(finding["body"].split()).lower())
    return stable_hash(
        {
            "title": title,
            "absolute_file_path": location["absolute_file_path"],
            "body": body,
        }
    )


REVIEW_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "findings",
        "overall_correctness",
        "overall_explanation",
        "overall_confidence_score",
    ],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "title",
                    "body",
                    "priority",
                    "confidence_score",
                    "code_location",
                ],
                "properties": {
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "priority": {"type": "integer", "minimum": 0, "maximum": 3},
                    "confidence_score": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                    "code_location": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["absolute_file_path", "line_range"],
                        "properties": {
                            "absolute_file_path": {"type": "string"},
                            "line_range": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["start", "end"],
                                "properties": {
                                    "start": {"type": "integer", "minimum": 1},
                                    "end": {"type": "integer", "minimum": 1},
                                },
                            },
                        },
                    },
                },
            },
        },
        "overall_correctness": {
            "type": "string",
            "enum": ["patch is correct", "patch is incorrect"],
        },
        "overall_explanation": {"type": "string"},
        "overall_confidence_score": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
        },
    },
}

REVIEW_EVIDENCE_UNAVAILABLE_RE = re.compile(
    r"(?:\b(?:repository|repo|workspace|filesystem|environment|sandbox|git|inspection|review|access)"
    r"\s+(?:is|was)?\s*unavailable\b|\bunavailable\s+(?:repository|repo|workspace|"
    r"filesystem|environment|sandbox|git|inspection|review|access)\b|\bno\s+(?:reliable|"
    r"inspection\s+)?evidence\b(?!-)|(?:unable|cannot|could not|无法|不能).{0,120}"
    r"(?:inspect|review|access|read|sandbox|environment|repository|filesystem|git|"
    r"command|审查|读取|沙箱|环境|仓库|命令))",
    re.IGNORECASE,
)
REVIEW_NO_CONCLUSION_RE = re.compile(
    r"(?:\bno\s+(?:evidence-based\s+)?(?:conclusion|assessment)\b|"
    r"\b(?:unable|cannot|could not)\s+to\s+(?:reach|make|provide).{0,80}"
    r"(?:conclusion|assessment)|无法.{0,80}(?:结论|判断)|不能.{0,80}(?:结论|判断))",
    re.IGNORECASE,
)
REVIEW_EVIDENCE_BEARING_RE = re.compile(
    r"(?:\b(?:inspect(?:ed|ion)?|review(?:ed)?|analy[sz](?:ed|is|e)?|verify|verified|"
    r"check(?:ed)?|test(?:ed)?|validat(?:e|ed|ion)|read)\b.{0,160}\b(?:diff|change|"
    r"patch|code|implementation|test|contract|base|head|repository)\b|"
    r"\b(?:diff|change|patch|code|implementation|test|contract|base|head|repository)"
    r"\b.{0,160}\b(?:inspect(?:ed|ion)?|review(?:ed)?|analy[sz](?:ed|is|e)?|verify|"
    r"verified|check(?:ed)?|test(?:ed)?|validat(?:e|ed|ion)|read)\b|"
    r"(?:审查|检查|验证|测试|阅读).{0,160}(?:差异|变更|补丁|代码|实现|合同|仓库)|"
    r"(?:差异|变更|补丁|代码|实现|合同|仓库).{0,160}(?:审查|检查|验证|测试|阅读))",
    re.IGNORECASE,
)


AGENT_REVIEW_FINDING_KEYS = {
    "title",
    "body",
    "priority",
    "confidence_score",
    "code_location",
    "scenario",
    "evidence",
    "scope",
}
AGENT_REVIEW_TASK_RECEIPT_KEYS = {
    "review_agent_id",
    "review_task_id",
    "terminal_status",
    "head_sha",
    "base_sha",
    "review_profile",
    "result_sha256",
}
V2_AGENT_REVIEW_TASK_RECEIPT_KEYS = AGENT_REVIEW_TASK_RECEIPT_KEYS | {
    "wave_id",
    "lane",
    "review_model",
    "review_effort",
}
V3_AGENT_REVIEW_TASK_RECEIPT_KEYS = V2_AGENT_REVIEW_TASK_RECEIPT_KEYS | {
    "resolved_model",
    "resolved_effort",
}
V4_AGENT_REVIEW_TASK_RECEIPT_KEYS = V2_AGENT_REVIEW_TASK_RECEIPT_KEYS | {
    "profile_resolution",
}


def structured_review_prompt(resolved_base: str, lane: str | None = None) -> str:
    lane_instruction = (
        " Focus on the review lane '" + lane + "' while still reporting any "
        "actionable cross-cutting correctness or contract finding."
        if lane
        else ""
    )
    return (
        "Review only the supplied current-candidate bundle from merge base "
        f"{resolved_base} through the current HEAD. Inspect its complete Git diff and "
        "applicable repository standards. Report only actionable correctness or contract "
        "findings caused by the current diff. Every finding must use the supplied absolute "
        "repository root and cite a line changed by that diff. The supplied location index "
        "marks old-side ranges for every deletion; cite that deleted base-side range when "
        "base-side range for deletion findings. Omit any concern that cannot be tied to a "
        "listed changed line."
        + lane_instruction
        + " Do not inspect process environments, runtime configuration, or credentials. "
        "Do not invoke tools or modify files. Return only the JSON object "
        "required by the supplied output schema."
    )


def parse_review_result(final_message: str) -> tuple[dict[str, Any], list[str]]:
    try:
        result = json.loads(final_message)
    except json.JSONDecodeError as error:
        raise RuntimeError("review final message is not valid structured JSON") from error
    if not isinstance(result, dict) or set(result) != {
        "findings",
        "overall_correctness",
        "overall_explanation",
        "overall_confidence_score",
    }:
        raise RuntimeError("review final message does not match the required schema")
    findings = result["findings"]
    if not isinstance(findings, list):
        raise RuntimeError("review findings must be an array")
    normalized: list[dict[str, Any]] = []
    for finding in findings:
        if not isinstance(finding, dict) or set(finding) != {
            "title",
            "body",
            "priority",
            "confidence_score",
            "code_location",
        }:
            raise RuntimeError("review finding does not match the required schema")
        location = finding["code_location"]
        line_range = location.get("line_range") if isinstance(location, dict) else None
        valid = (
            isinstance(finding["title"], str)
            and isinstance(finding["body"], str)
            and type(finding["priority"]) is int
            and 0 <= finding["priority"] <= 3
            and type(finding["confidence_score"]) in {int, float}
            and 0 <= finding["confidence_score"] <= 1
            and isinstance(location, dict)
            and set(location) == {"absolute_file_path", "line_range"}
            and isinstance(location["absolute_file_path"], str)
            and bool(location["absolute_file_path"].strip())
            and Path(location["absolute_file_path"]).is_absolute()
            and isinstance(line_range, dict)
            and set(line_range) == {"start", "end"}
            and all(type(line_range[key]) is int and line_range[key] >= 1 for key in ("start", "end"))
            and line_range["end"] >= line_range["start"]
        )
        if not valid:
            raise RuntimeError("review finding contains invalid field values")
        normalized.append(finding)
    if (
        result["overall_correctness"]
        not in {"patch is correct", "patch is incorrect"}
        or not isinstance(result["overall_explanation"], str)
        or not result["overall_explanation"].strip()
        or type(result["overall_confidence_score"]) not in {int, float}
        or not 0 <= result["overall_confidence_score"] <= 1
    ):
        raise RuntimeError("review summary does not match the required schema")
    blocking = [finding for finding in normalized if finding["priority"] <= 2]
    fingerprints = sorted(review_finding_fingerprint(finding) for finding in blocking)
    if result["overall_correctness"] == "patch is incorrect" and not fingerprints:
        raise RuntimeError("review rejects the patch without an actionable blocking finding")
    if REVIEW_EVIDENCE_UNAVAILABLE_RE.search(result["overall_explanation"]):
        raise RuntimeError("review reports unavailable inspection evidence")
    if REVIEW_NO_CONCLUSION_RE.search(result["overall_explanation"]):
        raise RuntimeError("review does not contain an evidence-based conclusion")
    if not REVIEW_EVIDENCE_BEARING_RE.search(result["overall_explanation"]):
        raise RuntimeError("review summary does not contain evidence of candidate inspection")
    return result, fingerprints


def parse_agent_review_result(
    final_message: str, repo: Path | None = None
) -> tuple[dict[str, Any], list[str]]:
    try:
        result = json.loads(final_message)
    except json.JSONDecodeError as error:
        raise RuntimeError("agent review result is not valid structured JSON") from error
    if not isinstance(result, dict) or set(result) != {
        "findings",
        "overall_correctness",
        "overall_explanation",
        "overall_confidence_score",
    }:
        raise RuntimeError("agent review result does not match the required schema")
    findings = result["findings"]
    if not isinstance(findings, list):
        raise RuntimeError("agent review findings must be an array")
    normalized: list[dict[str, Any]] = []
    for finding in findings:
        if not isinstance(finding, dict) or set(finding) != AGENT_REVIEW_FINDING_KEYS:
            raise RuntimeError("agent review finding does not match the required schema")
        location = finding["code_location"]
        line_range = location.get("line_range") if isinstance(location, dict) else None
        valid = (
            isinstance(finding["title"], str)
            and bool(finding["title"].strip())
            and isinstance(finding["body"], str)
            and bool(finding["body"].strip())
            and type(finding["priority"]) is int
            and 0 <= finding["priority"] <= 3
            and type(finding["confidence_score"]) in {int, float}
            and 0 <= finding["confidence_score"] <= 1
            and isinstance(finding["scenario"], str)
            and bool(finding["scenario"].strip())
            and isinstance(finding["evidence"], str)
            and bool(finding["evidence"].strip())
            and finding["scope"] in {"in-scope", "out-of-scope"}
            and isinstance(location, dict)
            and set(location) == {"absolute_file_path", "line_range"}
            and isinstance(location["absolute_file_path"], str)
            and bool(location["absolute_file_path"].strip())
            and Path(location["absolute_file_path"]).is_absolute()
            and isinstance(line_range, dict)
            and set(line_range) == {"start", "end"}
            and all(
                type(line_range[key]) is int and line_range[key] >= 1
                for key in ("start", "end")
            )
            and line_range["end"] >= line_range["start"]
        )
        if not valid:
            raise RuntimeError("agent review finding contains invalid field values")
        if repo is not None:
            finding_path = Path(location["absolute_file_path"]).resolve()
            repo_path = repo.resolve()
            try:
                finding_path.relative_to(repo_path)
            except ValueError as error:
                raise RuntimeError("agent review finding is outside the repository") from error
        normalized.append(finding)
    if (
        result["overall_correctness"]
        not in {"patch is correct", "patch is incorrect"}
        or not isinstance(result["overall_explanation"], str)
        or type(result["overall_confidence_score"]) not in {int, float}
        or not 0 <= result["overall_confidence_score"] <= 1
    ):
        raise RuntimeError("agent review summary does not match the required schema")
    blocking = [
        finding
        for finding in normalized
        if finding["priority"] <= 2 and finding["scope"] == "in-scope"
    ]
    fingerprints = sorted(review_finding_fingerprint(finding) for finding in blocking)
    return result, fingerprints


def parse_helper_task_receipt(
    receipt_text: str,
    *,
    result_sha256: str,
    review_agent_id: str,
    review_task_id: str,
    agent_status: str,
    head_sha: str,
    base_sha: str,
    review_profile: str,
    review_model: str,
    review_effort: str,
    wave_id: str | None,
    lane: str | None,
) -> dict[str, Any]:
    """Validate the fixed-helper terminal envelope used by agent-review.

    The caller-provided status is only an input consistency check.  A current
    proof is accepted only when the helper envelope independently binds the
    terminal status, result digest, repository inputs, and requested profile.
    """
    try:
        payload = json.loads(receipt_text)
    except json.JSONDecodeError as error:
        raise RuntimeError("helper task receipt is not valid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("helper task receipt does not match the required schema")
    required = {
        "review_agent_id",
        "review_task_id",
        "terminal_status",
        "head_sha",
        "base_sha",
        "review_profile",
        "result_sha256",
        "provenance_boundary",
    }
    if not required.issubset(payload):
        raise RuntimeError("helper task receipt does not match the required schema")
    if payload.get("provenance_boundary") != "fixed-review-helper":
        raise RuntimeError("helper task receipt is not fixed-helper proof")
    expected = {
        "review_agent_id": review_agent_id,
        "review_task_id": review_task_id,
        "terminal_status": agent_status,
        "head_sha": head_sha,
        "base_sha": base_sha,
        "review_profile": review_profile,
        "result_sha256": result_sha256,
    }
    if any(payload.get(key) != value for key, value in expected.items()):
        raise RuntimeError("helper task receipt does not match review evidence")
    if payload.get("terminal_status") != "completed":
        raise RuntimeError("helper task receipt requires terminal status=completed")
    if wave_id is not None:
        if payload.get("wave_id") != wave_id or payload.get("lane") != lane:
            raise RuntimeError("helper task receipt does not match review wave")
        if payload.get("review_model") != review_model or payload.get("review_effort") != review_effort:
            raise RuntimeError("helper task receipt does not match review profile")
    return payload


def validate_agent_finding_diff_locations(
    review_result: dict[str, Any], repo: Path, base_sha: str, head_sha: str
) -> None:
    merge_base = subprocess.run(
        ["git", "merge-base", base_sha, head_sha],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    for finding in review_result["findings"]:
        location = finding["code_location"]
        finding_path = Path(location["absolute_file_path"]).resolve()
        relative_path = finding_path.relative_to(repo.resolve())
        diff = subprocess.run(
            [
                "git",
                "diff",
                "--unified=0",
                "--format=",
                f"{base_sha}...{head_sha}",
                "--",
                str(relative_path),
            ],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        current_file = finding_path.is_file()
        base_file = git_file_text(repo, merge_base, str(relative_path))
        if current_file:
            current_line_count = len(finding_path.read_text(encoding="utf-8").splitlines())
        else:
            current_line_count = 0
        base_line_count = len(base_file.splitlines()) if base_file is not None else 0
        if not current_file and base_file is None:
            raise RuntimeError("agent review finding file does not exist")
        finding_range = location["line_range"]
        if finding_range["end"] > max(1, current_line_count, base_line_count):
            raise RuntimeError("agent review finding line range exceeds the file")
        changed_ranges: list[tuple[int, int]] = []
        for match in re.finditer(
            r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@",
            diff,
            re.MULTILINE,
        ):
            old_start = int(match.group(1))
            old_count = int(match.group(2) or "1")
            new_start = int(match.group(3))
            new_count = int(match.group(4) or "1")
            if current_file and new_count > 0:
                changed_ranges.append((new_start, new_start + new_count - 1))
            # Every removed old-side line remains a citable part of the candidate
            # diff, including deletions mixed with additions in one hunk.
            if old_count > 0:
                changed_ranges.append((old_start, old_start + old_count - 1))
        if not any(
            finding_range["start"] <= changed_end
            and finding_range["end"] >= changed_start
            for changed_start, changed_end in changed_ranges
        ):
            raise RuntimeError("agent review finding does not overlap the candidate diff")


def review_is_clear(
    evidence_valid: bool,
    finding_fingerprints: Iterable[str],
    review_result: dict[str, Any] | None,
) -> bool:
    return (
        evidence_valid
        and isinstance(review_result, dict)
        and not list(finding_fingerprints)
        and review_result["overall_correctness"] == "patch is correct"
    )


def validation_subprocess_environment(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """Preserve the normal current-worktree environment for validation commands."""
    return dict(os.environ if environ is None else environ)


def is_project_doc_path(path: str) -> bool:
    if path.startswith(("docs/", "screenshots/")):
        return True
    return "/" not in path and path.startswith(("README", "CONTRIBUTING", "OPERATIONS"))


def classify_review_scope(repo: Path, base_sha: str, head_sha: str) -> str:
    """Derive the narrow one-lane scope only for provable documentation deltas.

    Mechanical source edits cannot be proven from Git metadata alone, so the
    conservative default is the four-lane code scope.  This prevents a caller
    from downgrading a behavioral change by merely passing a CLI flag.
    """
    paths = git_changed_paths(repo, base_sha, head_sha)
    contract_changed = spec_contract_changed(repo, base_sha, head_sha, paths)
    contract_surface_changed = any(
        path.startswith(("docs/specs/", "docs/plan/")) for path in paths
    )
    if paths and all(is_project_doc_path(path) for path in paths) and not contract_changed:
        return "document"
    if paths and not all(is_project_doc_path(path) for path in paths):
        mechanical = subprocess.run(
            [
                "git",
                "diff",
                "--quiet",
                "--ignore-all-space",
                "--ignore-blank-lines",
                base_sha,
                head_sha,
            ],
            cwd=repo,
            capture_output=True,
        ).returncode == 0
        if mechanical and not contract_changed and not contract_surface_changed:
            return "mechanical"
    return "code"


def git_commit(repo: Path, revision: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", f"{revision}^{{commit}}"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def git_is_moving_ref(repo: Path, revision: str) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--symbolic-full-name", "--verify", revision],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False
    symbolic_ref = result.stdout.strip()
    return symbolic_ref.startswith(("refs/heads/", "refs/remotes/"))


def git_ref_identity(repo: Path, revision: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--symbolic-full-name", "--verify", revision],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        symbolic_ref = result.stdout.strip()
        if symbolic_ref.startswith(("refs/heads/", "refs/remotes/")):
            return symbolic_ref
    return "commit:" + git_commit(repo, revision)


def _platform_pr_facts(repo: Path, pr_ref: str, error_message: str) -> dict[str, Any]:
    try:
        binding, number = resolve_repository_for_pr(repo, pr_ref)
        return backend_for(binding, cwd=str(repo)).get_pr_facts(number)
    except Exception as error:
        if isinstance(error, RuntimeError) and str(error) == error_message:
            raise
        raise RuntimeError(error_message) from error


def gh_pr_binding_facts(
    repo: Path,
    pr_ref: str,
    *,
    error_message: str = "bind-pr requires live PR base and head facts",
) -> dict[str, str]:
    payload = _platform_pr_facts(repo, pr_ref, error_message)
    base_sha = payload.get("base_sha")
    head_sha = payload.get("head_sha")
    if not all(
        isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{40}", value)
        for value in (base_sha, head_sha)
    ):
        raise RuntimeError(error_message)
    if payload.get("state") != "OPEN":
        raise RuntimeError(error_message)
    return {"base_sha": base_sha, "head_sha": head_sha}


def gh_pr_merged_facts(
    repo: Path,
    pr_ref: str,
    *,
    error_message: str = "post-merge requires live MERGED PR facts",
    expected_repository_binding: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """Read and validate immutable merge facts without weakening OPEN binding."""
    try:
        binding, number = resolve_repository_for_pr(repo, pr_ref)
        if expected_repository_binding is not None:
            _require_repository_binding_match(expected_repository_binding, binding)
        payload = backend_for(binding, cwd=str(repo)).get_pr_facts(number)
    except Exception as error:
        if isinstance(error, RuntimeError) and str(error) == error_message:
            raise
        raise RuntimeError(error_message) from error
    if not isinstance(payload, Mapping):
        raise RuntimeError(error_message)
    base_sha = payload.get("base_sha")
    head_sha = payload.get("head_sha")
    merge_sha = payload.get("merge_sha")
    merged_at = payload.get("merged_at")
    if payload.get("state") != "MERGED":
        raise RuntimeError(error_message + ": PR is not MERGED")
    try:
        return {
            "base_sha": _normalize_sha(base_sha, "base_sha"),
            "head_sha": _normalize_sha(head_sha, "head_sha"),
            "merge_sha": _normalize_sha(merge_sha, "merge_sha"),
            "merged_at": _normalize_merged_at(merged_at),
        }
    except RuntimeError as error:
        raise RuntimeError(error_message) from error


def gh_authenticated_user(repo: Path) -> str:
    """Return the authenticated login for the bound code-hosting platform."""
    try:
        binding = resolve_unique_repository(repo)
        login = backend_for(binding, cwd=str(repo)).get_identity()
    except Exception as error:
        raise RuntimeError("convergence reopen requires an authenticated code-hosting owner") from error
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", login):
        raise RuntimeError("convergence reopen requires an authenticated code-hosting owner")
    return login


def gh_pr_base_ref_identity(repo: Path, pr_ref: str) -> str | None:
    """Resolve a live PR target branch to the local canonical ref identity."""
    payload = _platform_pr_facts(repo, pr_ref, "bind-pr requires live PR target ref facts")
    if payload.get("state") != "OPEN":
        raise RuntimeError("bind-pr requires a live open PR")
    base_name = payload.get("base_ref")
    if not isinstance(base_name, str) or not base_name.strip():
        return None
    for candidate in (f"origin/{base_name}", base_name):
        try:
            identity = git_ref_identity(repo, candidate)
        except subprocess.CalledProcessError:
            continue
        if identity:
            return identity
    return None


def git_is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=repo,
        capture_output=True,
    )
    if result.returncode not in {0, 1}:
        raise RuntimeError("failed to compare review base ancestry")
    return result.returncode == 0


def git_changed_paths(repo: Path, before: str, after: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "-z", before, after],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    return sorted(path.decode("utf-8") for path in result.stdout.split(b"\0") if path)


def git_patch_fingerprint(repo: Path, before: str, after: str) -> str:
    result = subprocess.run(
        [
            "git",
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-renames",
            "--unified=0",
            before,
            after,
        ],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    # Blob IDs and hunk positions vary when an unchanged candidate is rebased.
    normalized_lines = (
        b"@@"
        if line.startswith(b"@@ ")
        else line
        for line in result.stdout.splitlines()
        if not line.startswith(b"index ")
    )
    return hashlib.sha256(b"\n".join(normalized_lines)).hexdigest()


def git_rebased_candidate_matches(
    repo: Path, previous_base: str, previous_head: str, current_base: str, current_head: str
) -> bool:
    """Check that a rebase preserved the candidate delta without writing Git objects."""
    common_base = subprocess.run(
        ["git", "merge-base", current_base, previous_head],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if common_base != previous_base:
        return False
    return git_patch_fingerprint(repo, previous_base, previous_head) == git_patch_fingerprint(
        repo, current_base, current_head
    )


def git_tree(repo: Path, revision: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", f"{revision}^{{tree}}"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def require_clean_current_head(repo: Path, requested_head: str | None = None) -> tuple[str, str]:
    current_head = git_commit(repo, "HEAD")
    if requested_head is not None and git_commit(repo, requested_head) != current_head:
        raise RuntimeError("validation head must equal the repository current HEAD")
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if status:
        raise RuntimeError("validation requires a clean repository worktree")
    return current_head, git_tree(repo, current_head)


def git_file_text(repo: Path, revision: str, path: str) -> str | None:
    result = subprocess.run(
        ["git", "show", f"{revision}:{path}"],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    return result.stdout if result.returncode == 0 else None


def without_visual_evidence(text: str | None) -> str | None:
    if text is None:
        return None
    kept: list[str] = []
    skipping = False
    for line in text.splitlines(keepends=True):
        if line.rstrip() == "## Visual Evidence":
            skipping = True
            continue
        if skipping and line.startswith("## "):
            skipping = False
        if not skipping:
            kept.append(line)
    return "".join(kept)


def spec_contract_changed(repo: Path, before: str, after: str, paths: Iterable[str]) -> bool:
    spec_paths = [
        path
        for path in paths
        if (
            path.startswith("docs/specs/")
            and path.endswith("/SPEC.md")
        ) or (
            path.startswith("docs/plan/")
            and path.endswith(("/PLAN.md", "/SPEC.md"))
        )
    ]
    return any(
        without_visual_evidence(git_file_text(repo, before, path))
        != without_visual_evidence(git_file_text(repo, after, path))
        for path in spec_paths
    )


def git_effective_merge_fingerprint(repo: Path, base: str, head: str) -> str:
    """Fingerprint non-document candidate delta without writing Git state."""
    effective_paths = [
        path for path in git_changed_paths(repo, base, head) if not is_project_doc_path(path)
    ]
    if not effective_paths:
        return stable_hash([])
    result = subprocess.run(
        [
            "git",
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-renames",
            base,
            head,
            "--",
            *effective_paths,
        ],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def known_long_budget(repo: Path, command: str, default_budget: int) -> tuple[int, bool]:
    config_result = subprocess.run(
        ["git", "show", f"HEAD:{KNOWN_LONG_CONFIG}"],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    if config_result.returncode != 0:
        return default_budget, False
    try:
        config = json.loads(config_result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{KNOWN_LONG_CONFIG} is not valid JSON: {error.msg}") from error
    if not isinstance(config, dict):
        raise RuntimeError(f"{KNOWN_LONG_CONFIG} root must be a JSON object")
    entries = config.get("known_long_commands", [])
    if not isinstance(entries, list):
        raise RuntimeError(f"{KNOWN_LONG_CONFIG} known_long_commands must be a list")
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError(f"{KNOWN_LONG_CONFIG} known_long_commands entries must be objects")
        if entry.get("command") != command:
            continue
        budget = entry.get("budget_seconds")
        if not isinstance(budget, int) or budget <= default_budget:
            raise RuntimeError(
                f"{KNOWN_LONG_CONFIG} known-long budget must exceed {default_budget} seconds"
            )
        return budget, True
    return default_budget, False


class DeltaClassification:
    def __init__(self, reusable: bool, needs_attestation: bool, reasons: Iterable[str]):
        self.reusable = reusable
        self.needs_attestation = needs_attestation
        self.reasons = list(reasons)

    def as_dict(self) -> dict[str, Any]:
        return {
            "reusable": self.reusable,
            "needs_attestation": self.needs_attestation,
            "reasons": self.reasons,
        }


def classify_delta(
    paths: Iterable[str],
    spec_contract_changed: bool,
    effective_merge_before: str,
    effective_merge_after: str,
) -> DeltaClassification:
    normalized = []
    for raw_path in paths:
        path = raw_path.strip()
        if path.startswith("./"):
            path = path[2:]
        if path:
            normalized.append(path)
    reasons: list[str] = []
    if effective_merge_before != effective_merge_after:
        reasons.append("effective_merge_result_changed")
    if spec_contract_changed:
        reasons.append("spec_contract_changed")

    invalidating_prefixes = (
        ".github/workflows/",
        "bin/",
        "src/",
        "lib/",
        "app/",
        "tests/",
        "test/",
        "skills/",
        "prompts/",
    )
    invalidating_names = {
        "AGENTS.md",
        "Dockerfile",
        "Makefile",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "Cargo.toml",
        "Cargo.lock",
        "pyproject.toml",
        "requirements.txt",
    }
    for path in normalized:
        if path in invalidating_names or path.startswith(invalidating_prefixes):
            reasons.append(f"effective_input_changed:{path}")

    if reasons:
        return DeltaClassification(False, False, sorted(set(reasons)))
    if not normalized:
        return DeltaClassification(True, False, ["no_delta"])

    allowed = all(is_project_doc_path(path) for path in normalized)
    if allowed:
        return DeltaClassification(True, True, ["scoped_non_effective_delta"])
    return DeltaClassification(False, False, ["unclassified_effective_input_delta"])


class FlowLedger:
    def __init__(self, root: Path, repo: Path | None = None):
        self.root = root
        self.path = root / "active.json"
        self.repo = repo.resolve() if repo is not None else None
        self._ledger_lock_handle: Any | None = None
        self._finalization_lifecycle = threading.local()

    def _write(self, payload: dict[str, Any]) -> None:
        normalize_ledger(payload)
        self._write_raw(payload)

    def _write_raw(self, payload: dict[str, Any]) -> None:
        """Atomically restore an already-validated ledger without migrating it."""
        self.root.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="active.", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(temporary_name, self.path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    def _archive(self, payload: dict[str, Any]) -> Path:
        return self._archive_bytes(self._archive_content(payload), payload["run_id"])

    def _archive_content(self, payload: dict[str, Any]) -> bytes:
        return json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True).encode("utf-8") + b"\n"

    def _archive_path(self, run_id: str) -> Path:
        return self.root / "runs" / f"{stable_hash(run_id)}.json"

    def _rollback_terminal_seal(
        self, pre_close_ledger: dict[str, Any], terminal_ledger: dict[str, Any]
    ) -> None:
        self._write_raw(pre_close_ledger)
        archive_path = self._archive_path(terminal_ledger["run_id"])
        if not archive_path.exists():
            return
        expected = self._archive_content(terminal_ledger)
        if stable_file_bytes(archive_path, "terminal ledger archive") != expected:
            raise RuntimeError("terminal seal rollback found an unexpected archive")
        archive_path.unlink()

    def _recover_stale_terminal_archive(self, active_ledger: dict[str, Any]) -> None:
        """Remove only an archive provably left by an interrupted rollback."""
        archive_path = self._archive_path(active_ledger["run_id"])
        if not archive_path.exists():
            return
        try:
            archived = json.loads(stable_file_bytes(archive_path, "terminal ledger archive"))
        except json.JSONDecodeError as error:
            raise RuntimeError("active ledger conflicts with an invalid terminal archive") from error
        if (
            not isinstance(archived, dict)
            or archived.get("run_id") != active_ledger.get("run_id")
            or archived.get("state") not in TERMINAL_STATES
            or not isinstance(archived.get("closed_at"), str)
        ):
            raise RuntimeError("active ledger conflicts with a terminal archive")
        try:
            restored = normalize_ledger(json.loads(json.dumps(archived)))
            active_identity = normalize_ledger(json.loads(json.dumps(active_ledger)))
        except RuntimeError as error:
            raise RuntimeError("active ledger conflicts with a terminal archive") from error
        for key in ("state", "closed_at", "updated_at"):
            restored.pop(key, None)
        for key in ("state", "closed_at", "updated_at"):
            active_identity.pop(key, None)
        if restored != active_identity:
            raise RuntimeError("active ledger conflicts with a terminal archive")
        archive_path.unlink()

    def _archive_bytes(self, content: bytes, run_id: str) -> Path:
        archive_root = self.root / "runs"
        archive_root.mkdir(parents=True, exist_ok=True)
        archive_path = self._archive_path(run_id)
        if archive_path.exists():
            if archive_path.read_bytes() != content:
                raise RuntimeError(f"run_id already has a different archived ledger: {run_id}")
            return archive_path
        fd, temporary_name = tempfile.mkstemp(
            prefix="run.", suffix=".tmp", dir=archive_root
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary_name, archive_path)
            except FileExistsError:
                if archive_path.read_bytes() != content:
                    raise RuntimeError(
                        f"run_id already has a different archived ledger: {run_id}"
                    )
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return archive_path

    def read(self) -> dict[str, Any]:
        return normalize_ledger(self.read_raw())

    def read_raw(self) -> dict[str, Any]:
        if not self.path.is_file():
            raise RuntimeError("flow receipt ledger is not initialized")
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("ledger payload is invalid")
        return payload

    @staticmethod
    def _require_active(ledger: dict[str, Any]) -> None:
        if ledger.get("state") != "active":
            raise RuntimeError(f"flow receipt ledger is terminal: {ledger.get('state')}")

    @staticmethod
    def _review_state(ledger: dict[str, Any]) -> dict[str, Any]:
        review = ledger.setdefault("review", {})
        defaults = default_review_state()
        for key, value in defaults.items():
            review.setdefault(key, value.copy() if isinstance(value, (dict, list)) else value)
        return review

    def _reject_retired_review_write(self) -> None:
        """Reject only writes that explicitly target an archived legacy ledger."""
        raw = self.read_raw()
        if raw.get("legacy_compatibility") and raw.get("schema_version", 1) < FLOW_SCHEMA_VERSION:
            raise RuntimeError(
                "legacy review receipts are read-only; migrate the active ledger before recording proof"
            )

    @staticmethod
    def _active_epoch(ledger: dict[str, Any]) -> dict[str, Any]:
        review = FlowLedger._review_state(ledger)
        epoch_id = review.get("active_epoch_id")
        if not epoch_id:
            raise RuntimeError("no active review epoch")
        for epoch in review.get("epochs", []):
            if epoch.get("epoch_id") == epoch_id:
                return epoch
        raise RuntimeError("active review epoch is missing from the ledger")

    @staticmethod
    def _review_wave(ledger: dict[str, Any], wave_id: str) -> dict[str, Any]:
        wave = FlowLedger._review_state(ledger).get("waves", {}).get(wave_id)
        if not isinstance(wave, dict):
            raise RuntimeError(f"review wave does not exist: {wave_id}")
        return wave

    @staticmethod
    def _validate_lane_specs(
        stage: str,
        scope_class: str,
        lane_specs: list[dict[str, str]],
        high_requirement: bool,
        enforce_direct: bool = False,
        review_tier: int | None = None,
    ) -> None:
        if high_requirement:
            raise RuntimeError(
                "high-requirement is retired: direct review proof is required at merge convergence"
            )
        if enforce_direct and any(
            (spec.get("model", ""), spec.get("effort", "")) not in REVIEW_MODEL_LADDER
            for spec in lane_specs
        ):
            raise RuntimeError(
                "direct review wave lanes must use the mandatory Luna/Terra model ladder"
            )
        if enforce_direct and any(
            spec.get("lane") in DIRECT_REVIEW_LANE_PROFILES
            and (spec.get("model"), spec.get("effort"))
            != DIRECT_REVIEW_LANE_PROFILES[spec["lane"]]
            for spec in lane_specs
        ):
            raise RuntimeError("direct fixed review lanes must use their assigned model profiles")
        names = [spec["lane"] for spec in lane_specs]
        if len(names) != len(set(names)):
            raise RuntimeError("review wave contains duplicate lanes")
        if stage in {"initial", "repair"}:
            missing = sorted(FIXED_REVIEW_LANES.difference(names))
            dynamic = [name for name in names if name in DYNAMIC_REVIEW_LANES]
            invalid = [
                name
                for name in names
                if name not in FIXED_REVIEW_LANES and name not in DYNAMIC_REVIEW_LANES
            ]
            tier_shape_invalid = (
                review_tier == 3 and set(names) != FIXED_REVIEW_LANES
            ) or (
                review_tier == 4
                and (
                    not FIXED_REVIEW_LANES.issubset(names)
                    or not (1 <= len(dynamic) <= MAX_DYNAMIC_REVIEW_LANES)
                )
            )
            if missing or invalid or len(dynamic) > MAX_DYNAMIC_REVIEW_LANES or tier_shape_invalid:
                raise RuntimeError(
                    "required review wave lane topology does not match its review tier"
                )
            return
        if stage == "risk-arbitration":
            if names != ["risk-arbitration"]:
                raise RuntimeError("risk arbitration requires one risk-arbitration lane")
            return
        raise RuntimeError(f"unsupported review wave stage: {stage}")

    def _stale_active_review_wave(
        self, ledger: dict[str, Any], actual_head: str, resolved_base: str
    ) -> dict[str, Any] | None:
        """Invalidate a bound wave when its candidate SHA is no longer current.

        The stale wave remains in the ledger for audit, while the unfinished
        epoch is returned to the status it had before the wave was opened.
        A repair permit remains consumed once its repair head exists. Any later
        stale transition requires a new permit and still counts toward the cap.
        """
        review = self._review_state(ledger)
        active_wave_id = review.get("active_wave_id")
        if not active_wave_id:
            return None
        wave = self._review_wave(ledger, active_wave_id)
        if wave.get("head_sha") == actual_head and wave.get("base_sha") == resolved_base:
            raise RuntimeError("another review wave is already active")
        self._require_live_pr_facts(
            review,
            actual_head,
            resolved_base,
            error_message="stale review transition requires live PR base and head facts",
        )
        epoch = next(
            (
                item
                for item in review.get("epochs", [])
                if item.get("epoch_id") == wave.get("epoch_id")
            ),
            None,
        )
        wave.update(
            {
                "state": "stale",
                "stale_reason": "input_stale",
                "stale_head_sha": actual_head,
                "stale_base_sha": resolved_base,
                "staled_at": now(),
            }
        )
        review["active_wave_id"] = None
        if epoch is not None:
            if wave.get("stage") == "repair":
                permit_id = wave.get("repair_permit_id")
                permit = next(
                    (
                        item
                        for item in epoch.get("permits", [])
                        if item.get("permit_id") == permit_id
                    ),
                    None,
                )
                if permit is not None and permit.get("status") == "used":
                    ledger["head_sha"] = actual_head
                    epoch["status"] = "repair_pending"
                else:
                    epoch["status"] = "repair_authorized"
            elif wave.get("stage") == "risk-arbitration":
                epoch["status"] = "repair_pending"
                epoch["risk_arbitration_used"] = False
                ledger["head_sha"] = actual_head
            else:
                epoch["status"] = "active"
                ledger["head_sha"] = actual_head
        if resolved_base != ledger.get("base_sha") and git_is_ancestor(
            self.repo, ledger["base_sha"], resolved_base
        ):
            previous_base = ledger["base_sha"]
            ledger["base_sha"] = resolved_base
            if epoch is not None and epoch.get("status") not in {"blocked", "complete"}:
                epoch["base_sha"] = resolved_base
            ledger.setdefault("events", []).append(
                {
                    "type": "review_base_advanced",
                    "from_base_sha": previous_base,
                    "to_base_sha": resolved_base,
                    "reason": "input_stale",
                    "at": now(),
                }
            )
        ledger.setdefault("events", []).append(
            {
                "type": "review_wave_stale",
                "wave_id": active_wave_id,
                "reason": "input_stale",
                "from_head_sha": wave.get("head_sha"),
                "to_head_sha": actual_head,
                "from_base_sha": wave.get("base_sha"),
                "to_base_sha": resolved_base,
                "at": now(),
            }
        )
        return wave

    def _require_live_pr_facts(
        self,
        review: dict[str, Any],
        head_sha: str,
        base_sha: str,
        *,
        error_message: str,
    ) -> None:
        """Refresh live facts for a PR before consuming convergence state."""
        pr_ref = review.get("pr_ref")
        if not isinstance(pr_ref, str) or not pr_ref:
            return
        live_pr_facts = gh_pr_binding_facts(
            self.repo,
            pr_ref,
            error_message=error_message,
        )
        if live_pr_facts["base_sha"] != base_sha or live_pr_facts["head_sha"] != head_sha:
            raise RuntimeError("live PR facts do not match the current flow")
        review["pr_base_sha"] = base_sha
        review["pr_head_sha"] = head_sha
        review["pr_bound_at"] = review.get("pr_bound_at") or now()

    def _advance_initial_pr_bound_head(
        self, ledger: dict[str, Any], actual_head: str, resolved_base: str, stage: str
    ) -> bool:
        """Open a first direct PR review epoch on its verified live head.

        A bound PR can receive a later candidate commit before its first
        convergence wave.  That commit cannot inherit the prior binding or
        any prior proof, but it can be the input to a newly opened initial
        wave once the live PR facts and clean candidate have been rechecked.
        """
        if stage != "initial" or not self._requires_current_review_proof(ledger):
            return False
        review = self._review_state(ledger)
        if not review.get("pr_ref") or review.get("epochs") or review.get("active_wave_id"):
            return False
        if ledger.get("base_sha") != resolved_base or ledger.get("head_sha") == actual_head:
            return False
        if (
            review.get("pr_base_sha") != resolved_base
            or review.get("pr_head_sha") != actual_head
            or not review.get("pr_bound_at")
        ):
            raise RuntimeError("initial review wave requires current live PR binding")
        previous_head = ledger.get("head_sha")
        if not isinstance(previous_head, str):
            raise RuntimeError("initial review wave has no prior ledger head")
        ledger["head_sha"] = actual_head
        ledger.setdefault("events", []).append(
            {
                "type": "initial_pr_bound_head_advanced",
                "pr_ref": review["pr_ref"],
                "from_head_sha": previous_head,
                "to_head_sha": actual_head,
                "base_sha": resolved_base,
                "at": now(),
            }
        )
        return True

    def _advance_head_after_clear_wave(
        self, ledger: dict[str, Any], actual_head: str, resolved_base: str, stage: str
    ) -> bool:
        """Advance stale clear inputs only while opening a fresh ordinary wave."""
        review = self._review_state(ledger)
        if stage != "initial" or review.get("active_wave_id"):
            return False
        if ledger.get("head_sha") == actual_head and ledger.get("base_sha") == resolved_base:
            return False
        reactivated_completed_epoch = False
        if review.get("active_epoch_id"):
            epoch = self._active_epoch(ledger)
            if epoch.get("status") not in {"ready_for_merge", "ready_for_merge_proof"}:
                return False
        elif review.get("epochs") and review["epochs"][-1].get("status") == "complete":
            epoch = review["epochs"][-1]
            review["active_epoch_id"] = epoch["epoch_id"]
            epoch["status"] = "active"
            reactivated_completed_epoch = True
        else:
            return False
        if not isinstance(ledger.get("head_sha"), str):
            raise RuntimeError("current clear epoch has no ledger head")
        wave_id = epoch.get("waves", [])[-1] if epoch.get("waves") else None
        if not wave_id:
            raise RuntimeError("current clear epoch has no finalized review wave")
        wave = self._review_wave(ledger, wave_id)
        if wave.get("state") != "finalized" or wave.get("blockers"):
            raise RuntimeError("current review proof requires a finalized clear review wave")
        wave.update(
            {
                "stale_reason": "input_stale",
                "stale_head_sha": actual_head,
                "stale_base_sha": resolved_base,
                "evidence_state": "input_stale",
            }
        )
        self._require_live_pr_facts(
            review,
            actual_head,
            resolved_base,
            error_message="stale review transition requires live PR base and head facts",
        )
        previous_head = ledger["head_sha"]
        ledger["head_sha"] = actual_head
        epoch["status"] = "active"
        if reactivated_completed_epoch:
            epoch.pop("review_proof_wave_id", None)
            ledger.setdefault("events", []).append(
                {
                    "type": "review_epoch_reactivated",
                    "epoch_id": epoch["epoch_id"],
                    "reason": "input_stale",
                    "at": now(),
                }
            )
        ledger["convergence"]["state"] = "initial"
        ledger["convergence"]["blockers"] = []
        if resolved_base != ledger.get("base_sha"):
            if not isinstance(ledger.get("base_sha"), str) or not git_is_ancestor(
                self.repo, ledger["base_sha"], resolved_base
            ):
                raise RuntimeError("review wave base changed non-linearly from the ledger base")
            previous_base = ledger["base_sha"]
            ledger["base_sha"] = resolved_base
            epoch["base_sha"] = resolved_base
            ledger.setdefault("events", []).append(
                {
                    "type": "review_base_advanced",
                    "from_base_sha": previous_base,
                    "to_base_sha": resolved_base,
                    "reason": "input_stale",
                    "at": now(),
                }
            )
        ledger.setdefault("events", []).append(
            {
                "type": "review_wave_stale",
                "wave_id": wave_id,
                "reason": "input_stale",
                "finalized_clear_wave": True,
                "from_head_sha": previous_head,
                "to_head_sha": actual_head,
                "from_base_sha": wave.get("base_sha"),
                "to_base_sha": resolved_base,
                "at": now(),
            }
        )
        return True

    def _advance_head_after_authorized_reopen(
        self, ledger: dict[str, Any], actual_head: str, resolved_base: str, stage: str
    ) -> bool:
        """Bridge one pushed repair head into a freshly owner-reopened epoch."""
        review = self._review_state(ledger)
        if stage != "initial" or review.get("active_wave_id"):
            return False
        if ledger.get("head_sha") == actual_head or ledger.get("base_sha") != resolved_base:
            return False
        epoch = self._active_epoch(ledger)
        authorization = epoch.get("authorization")
        if (
            epoch.get("status") != "active"
            or epoch.get("waves")
            or not isinstance(authorization, dict)
            or authorization.get("kind") != "owner-explicit-reopen"
        ):
            return False
        previous_head = ledger.get("head_sha")
        if (
            not isinstance(previous_head, str)
            or epoch.get("start_head_sha") != previous_head
            or authorization.get("start_head_sha") != previous_head
            or actual_head == previous_head
            or not git_is_ancestor(self.repo, previous_head, actual_head)
        ):
            return False
        delta_paths = git_changed_paths(self.repo, previous_head, actual_head)
        if not delta_paths:
            raise RuntimeError("authorized reopen repair head must contain a non-empty delta")
        epochs = review.get("epochs", [])
        try:
            epoch_index = epochs.index(epoch)
        except ValueError as error:
            raise RuntimeError("authorized reopen epoch is missing from review history") from error
        if epoch_index == 0:
            raise RuntimeError("authorized reopen repair has no prior blocker epoch")
        source_epoch = epochs[epoch_index - 1]
        source_head_aliases = {previous_head}
        source_epoch_head = source_epoch.get("head_sha")
        if not isinstance(source_epoch_head, str):
            source_wave_ids = source_epoch.get("waves", [])
            if isinstance(source_wave_ids, list) and source_wave_ids:
                source_epoch_head = self._review_wave(
                    ledger, source_wave_ids[-1]
                ).get("head_sha")
        if isinstance(source_epoch_head, str):
            for event in ledger.get("events", []):
                if (
                    event.get("type") == "convergence_reopen_inputs_rebound"
                    and event.get("from_head_sha") == source_epoch_head
                    and event.get("to_head_sha") == previous_head
                ):
                    source_head_aliases.add(source_epoch_head)
        source_scope_paths = {
            path
            for permit in source_epoch.get("permits", [])
            if permit.get("status") == "used"
            and permit.get("to_head_sha") in source_head_aliases
            for path in permit.get("scope_paths", [])
            if isinstance(path, str) and path
        }
        if not source_scope_paths:
            raise RuntimeError("authorized reopen repair has no recorded source scope")
        if not source_scope_paths.intersection(delta_paths):
            raise RuntimeError("authorized reopen repair delta does not overlap the source scope")
        pr_ref = review.get("pr_ref")
        if not isinstance(pr_ref, str) or not pr_ref:
            raise RuntimeError("authorized reopen repair requires a bound PR")
        live_pr_facts = gh_pr_binding_facts(
            self.repo,
            pr_ref,
            error_message="authorized reopen repair requires live PR base and head facts",
        )
        if (
            live_pr_facts["base_sha"] != resolved_base
            or live_pr_facts["head_sha"] != actual_head
        ):
            raise RuntimeError(
                "authorized reopen repair head does not match the current PR head"
            )
        ledger["head_sha"] = actual_head
        review["pr_head_sha"] = actual_head
        ledger.setdefault("events", []).append(
            {
                "type": "reopen_authorized_head_advanced",
                "epoch_id": epoch["epoch_id"],
                "authorization_ref": authorization.get("ref"),
                "pr_ref": pr_ref,
                "from_head_sha": previous_head,
                "to_head_sha": actual_head,
                "paths": delta_paths,
                "source_scope_paths": sorted(source_scope_paths),
                "at": now(),
            }
        )
        return True

    def open_review_wave(
        self,
        *,
        stage: str,
        base_ref: str,
        head_sha: str | None,
        lane_specs: list[dict[str, str]],
        scope_class: str | None = None,
        previous_head_sha: str | None = None,
        repair_permit_id: str | None = None,
        high_requirement: bool = False,
        arbitration_conflicts: list[str] | None = None,
        arbitration_blocker_fingerprints: list[str] | None = None,
    ) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("review waves require a repository-bound ledger")
        requested_base_ref = str(base_ref).strip()
        if not git_is_moving_ref(self.repo, requested_base_ref):
            raise RuntimeError(
                "review wave base ref must be a moving local or remote branch ref"
            )
        actual_head, _ = require_clean_current_head(self.repo, head_sha)
        resolved_base = git_commit(self.repo, requested_base_ref)
        if previous_head_sha is not None:
            previous_head_sha = git_commit(self.repo, previous_head_sha)
        derived_scope = classify_review_scope(self.repo, resolved_base, actual_head)
        if scope_class is None:
            scope_class = derived_scope
        if scope_class not in REVIEW_SCOPE_CLASSES:
            raise RuntimeError("unsupported review scope class")
        if scope_class != derived_scope:
            raise RuntimeError(
                f"review scope class does not match Git delta: expected {derived_scope}"
            )
        arbitration_conflicts = sorted(set(arbitration_conflicts or []))
        arbitration_blocker_fingerprints = sorted(
            set(arbitration_blocker_fingerprints or [])
        )
        if any(not isinstance(item, str) or not item.strip() for item in arbitration_conflicts):
            raise RuntimeError("arbitration conflicts must be non-empty strings")
        if any(
            not isinstance(item, str) or not item.strip()
            for item in arbitration_blocker_fingerprints
        ):
            raise RuntimeError("arbitration blocker fingerprints must be non-empty strings")
        if stage != "risk-arbitration" and (
            arbitration_conflicts or arbitration_blocker_fingerprints
        ):
            raise RuntimeError("arbitration metadata is only valid for risk arbitration")
        identity = stable_hash(
            [
                "review-wave",
                actual_head,
                resolved_base,
                stage,
                lane_specs,
                arbitration_conflicts,
                arbitration_blocker_fingerprints,
            ]
        )
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                locked_head, _ = require_clean_current_head(self.repo, head_sha)
                if not git_is_moving_ref(self.repo, requested_base_ref):
                    raise RuntimeError(
                        "review wave base ref must remain a moving local or remote branch ref"
                    )
                locked_base = git_commit(self.repo, requested_base_ref)
                if locked_head != actual_head or locked_base != resolved_base:
                    raise RuntimeError(
                        "review wave inputs changed before opening; refresh head/base and retry"
                    )
                ledger = self.read()
                self._require_active(ledger)
                self._require_review_assessment(ledger, "opening a review wave")
                review_tier = self._review_tier(ledger)
                if review_tier not in {3, 4}:
                    raise RuntimeError(
                        "the recorded review necessity tier does not require a review wave"
                    )
                self._validate_lane_specs(
                    stage,
                    scope_class,
                    lane_specs,
                    high_requirement,
                    enforce_direct=True,
                    review_tier=review_tier,
                )
                review = self._review_state(ledger)
                current_base = ledger.get("base_sha")
                base_advanced = current_base != resolved_base
                if current_base != resolved_base:
                    if not isinstance(current_base, str) or not git_is_ancestor(
                        self.repo, current_base, resolved_base
                    ):
                        raise RuntimeError(
                            "review wave base changed non-linearly from the ledger base"
                        )
                requested_base_identity = git_ref_identity(self.repo, requested_base_ref)
                candidate_ref_identity = git_ref_identity(self.repo, "HEAD")
                if requested_base_identity == candidate_ref_identity or resolved_base == actual_head:
                    raise RuntimeError("review wave base ref cannot be the candidate HEAD")
                bound_base_identity = review.get("base_ref_identity")
                if bound_base_identity is None and review.get("base_ref"):
                    bound_base_identity = git_ref_identity(self.repo, str(review["base_ref"]))
                    review["base_ref_identity"] = bound_base_identity
                if (
                    bound_base_identity is not None
                    and bound_base_identity != requested_base_identity
                ):
                    raise RuntimeError("review wave base ref does not match the bound PR target")
                pr_base_ref_identity = review.get("pr_base_ref_identity")
                if (
                    pr_base_ref_identity is not None
                    and pr_base_ref_identity != requested_base_identity
                ):
                    raise RuntimeError("review wave base ref does not match the live PR target")
                pr_required_for_stage = ledger.get("flow_type") in PR_BOUND_FLOW_TYPES
                direct_pr_review = (
                    self._requires_current_review_proof(ledger)
                    and ledger.get("flow_type") != "local-merge"
                )
                if direct_pr_review and not review.get("pr_ref"):
                    raise RuntimeError(
                        "direct PR review requires a bound live PR before the review wave opens"
                    )
                if requires_live_pr_facts_for_review_stage(
                    stage, review.get("pr_ref"), pr_required=pr_required_for_stage
                ):
                    self._require_live_pr_facts(
                        review,
                        actual_head,
                        resolved_base,
                        error_message=(
                            "PR-bound review waves require live PR base and head facts"
                        ),
                    )
                if bound_base_identity is None:
                    review["base_ref"] = requested_base_ref
                    review["base_ref_identity"] = requested_base_identity
                active_wave_id = review.get("active_wave_id")
                stale_wave = self._stale_active_review_wave(
                    ledger, actual_head, resolved_base
                )
                initial_pr_head_advanced = False
                reopen_head_advanced = False
                clear_wave_inputs_advanced = False
                if stale_wave is None:
                    initial_pr_head_advanced = self._advance_initial_pr_bound_head(
                        ledger, actual_head, resolved_base, stage
                    )
                    clear_wave_inputs_advanced = self._advance_head_after_clear_wave(
                        ledger, actual_head, resolved_base, stage
                    )
                    reopen_head_advanced = self._advance_head_after_authorized_reopen(
                        ledger, actual_head, resolved_base, stage
                    )
                if stage != "repair" and ledger.get("head_sha") != actual_head:
                    raise RuntimeError("review wave head does not match the ledger head")
                if resolved_base != ledger.get("base_sha"):
                    if not git_is_ancestor(self.repo, ledger["base_sha"], resolved_base):
                        raise RuntimeError("review wave base changed non-linearly from the ledger base")
                    previous_base = ledger["base_sha"]
                    ledger["base_sha"] = resolved_base
                    active_epoch = self._active_epoch(ledger) if review.get("active_epoch_id") else None
                    if active_epoch is not None and active_epoch.get("status") not in {"blocked", "complete"}:
                        active_epoch["base_sha"] = resolved_base
                    ledger.setdefault("events", []).append(
                        {
                            "type": "review_base_advanced",
                            "from_base_sha": previous_base,
                            "to_base_sha": resolved_base,
                            "reason": "review_wave_open",
                            "at": now(),
                        }
                    )
                if ledger.get("base_sha") != resolved_base:
                    raise RuntimeError("review wave base does not match the ledger base")
                if stage == "repair" and not repair_permit_id:
                    raise RuntimeError("repair review wave requires a repair permit")
                if stage != "repair" and repair_permit_id:
                    raise RuntimeError("repair permit is only valid for a repair wave")
                if stage == "repair" and base_advanced and repair_permit_id:
                    # A fast-forward of the PR base invalidates old review evidence, but a
                    # still-issued permit may launch the required fresh repair review.
                    candidate_epoch = self._active_epoch(ledger)
                    candidate_permit = next(
                        (
                            item
                            for item in candidate_epoch.get("permits", [])
                            if item.get("permit_id") == repair_permit_id
                        ),
                        None,
                    )
                    if (
                        candidate_permit is not None
                        and candidate_permit.get("status") == "issued"
                        and candidate_permit.get("base_sha") == current_base
                    ):
                        candidate_permit["base_sha"] = resolved_base
                        candidate_permit["base_advanced_from"] = current_base
                        candidate_permit["base_advanced_at"] = now()
                        ledger.setdefault("events", []).append(
                            {
                                "type": "repair_permit_base_advanced",
                                "permit_id": repair_permit_id,
                                "from_base_sha": current_base,
                                "to_base_sha": resolved_base,
                                "at": now(),
                            }
                        )
                epoch: dict[str, Any]
                if stage == "initial":
                    if review.get("epochs"):
                        epoch = self._active_epoch(ledger)
                        base_refresh = base_advanced and epoch.get("status") in {
                            "repair_pending",
                            "repair_authorized",
                        }
                        if stale_wave is not None:
                            if (
                                stale_wave.get("stage") not in {"initial", "repair"}
                                or review.get("active_epoch_id") != stale_wave.get("epoch_id")
                                or (
                                    stale_wave.get("stage") == "repair"
                                    and not base_refresh
                                )
                            ):
                                raise RuntimeError(
                                    "an initial review wave already exists; use explicit convergence-reopen"
                                )
                        if base_refresh:
                            for prior_wave_id in epoch.get("waves", []):
                                prior_wave = self._review_wave(ledger, prior_wave_id)
                                if prior_wave.get("state") == "finalized" and prior_wave.get("blockers"):
                                    prior_wave.update(
                                        {
                                            "evidence_state": "input_stale",
                                            "stale_reason": "base_advanced",
                                            "stale_base_sha": resolved_base,
                                        }
                                    )
                            for permit in epoch.get("permits", []):
                                if permit.get("status") == "issued":
                                    permit.update(
                                        {
                                            "status": "revoked",
                                            "revoked_reason": "base_advanced",
                                            "revoked_base_sha": resolved_base,
                                            "revoked_at": now(),
                                        }
                                    )
                            epoch["status"] = "active"
                            epoch["no_progress_count"] = 0
                            ledger["convergence"]["state"] = "initial"
                            ledger["convergence"]["blockers"] = []
                        elif (
                            stale_wave is None
                            and not initial_pr_head_advanced
                            and not reopen_head_advanced
                            and not clear_wave_inputs_advanced
                        ):
                            raise RuntimeError(
                                "an initial review wave already exists; use explicit convergence-reopen"
                            )
                        if epoch.get("status") != "active":
                            raise RuntimeError("stale initial review wave cannot reopen a terminal epoch")
                    else:
                        epoch_number = int(review.get("next_epoch", 1))
                        epoch_id = stable_hash(
                            [ledger["run_id"], "epoch", epoch_number, actual_head, resolved_base]
                        )[:16]
                        epoch = {
                            "epoch_id": epoch_id,
                            "number": epoch_number,
                            "base_sha": resolved_base,
                            "start_head_sha": actual_head,
                            "status": "active",
                            "repair_rounds_used": 0,
                            "risk_arbitration_used": False,
                            "blocker_history": [],
                            "arbitration_history": [],
                            "invariants": [],
                            "waves": [],
                            "permits": [],
                            "authorization": {"kind": "initial", "at": now()},
                        }
                        review["epochs"].append(epoch)
                        review["active_epoch_id"] = epoch_id
                        review["next_epoch"] = epoch_number + 1
                else:
                    epoch = self._active_epoch(ledger)
                    if epoch.get("status") in {"blocked", "complete"}:
                        raise RuntimeError("active review epoch is not writable")
                    if stage == "repair" and epoch.get("status") != "repair_authorized":
                        raise RuntimeError("repair wave requires an authorized repair permit")
                    if stage == "risk-arbitration" and epoch.get("status") != "repair_pending":
                        raise RuntimeError("risk arbitration requires an active blocker set")
                    if stage == "risk-arbitration":
                        if not arbitration_conflicts or not arbitration_blocker_fingerprints:
                            raise RuntimeError(
                                "risk arbitration requires declared conflicts and blocker fingerprints"
                            )
                        source_wave = None
                        for candidate_id in reversed(epoch.get("waves", [])):
                            candidate = self._review_wave(ledger, candidate_id)
                            if (
                                candidate.get("state") == "finalized"
                                and candidate.get("blockers")
                            ):
                                source_wave = candidate
                                break
                        if source_wave is None:
                            raise RuntimeError(
                                "risk arbitration requires a finalized blocker source wave"
                            )
                        if not source_wave.get("conflicts"):
                            raise RuntimeError(
                                "risk arbitration requires an unresolved reviewer conflict"
                            )
                        if set(arbitration_conflicts) != set(source_wave.get("conflicts", [])):
                            raise RuntimeError(
                                "risk arbitration conflicts must match the source wave"
                            )
                        if set(arbitration_blocker_fingerprints) != set(
                            source_wave.get("blocker_fingerprints", [])
                        ):
                            raise RuntimeError(
                                "risk arbitration blocker fingerprints must match the source wave"
                            )
                    if stage == "repair":
                        if not repair_permit_id:
                            raise RuntimeError("repair review wave requires a repair permit")
                        permit = next(
                            (
                                item
                                for item in epoch.get("permits", [])
                                if item.get("permit_id") == repair_permit_id
                            ),
                            None,
                        )
                        if permit is None or permit.get("status") != "issued":
                            raise RuntimeError("repair permit is missing or already used")
                        if permit.get("base_sha") != resolved_base:
                            raise RuntimeError("repair permit does not match the current review base")
                        source_wave = self._review_wave(ledger, permit.get("source_wave_id", ""))
                        if (
                            source_wave.get("epoch_id") != epoch.get("epoch_id")
                            or source_wave.get("state") != "finalized"
                            or not source_wave.get("blockers")
                            or permit.get("source_wave_id") != source_wave.get("wave_id")
                        ):
                            raise RuntimeError("repair permit source wave is not an active blocker wave")
                        if permit.get("from_head_sha") != previous_head_sha:
                            raise RuntimeError("repair permit does not match previous_head_sha")
                        expected_scope_fingerprint = stable_hash(
                            {
                                "source_wave_id": permit.get("source_wave_id"),
                                "blocker_digest": permit.get("blocker_digest"),
                                "source_scope_fingerprint": permit.get("source_scope_fingerprint"),
                                "scope_paths": permit.get("scope_paths", []),
                            }
                        )
                        if permit.get("scope_fingerprint") != expected_scope_fingerprint:
                            raise RuntimeError("repair permit scope fingerprint is invalid")
                        if ledger.get("head_sha") != previous_head_sha:
                            raise RuntimeError("repair permit source SHA does not match ledger head")
                        if actual_head == previous_head_sha or not git_is_ancestor(
                            self.repo, previous_head_sha, actual_head
                        ):
                            raise RuntimeError("repair head must be a new descendant of the permit source SHA")
                        delta_paths = git_changed_paths(self.repo, previous_head_sha, actual_head)
                        if not delta_paths:
                            raise RuntimeError("repair head must contain a non-empty repair delta")
                        permit_scope_paths = set(permit.get("scope_paths", []))
                        if permit_scope_paths and not permit_scope_paths.intersection(delta_paths):
                            raise RuntimeError("repair delta does not overlap the permit scope")
                        repair_scope_fingerprint = stable_hash(
                            {
                                "permit_scope_fingerprint": permit.get("scope_fingerprint"),
                                "delta_paths": delta_paths,
                            }
                        )
                        permit["delta_paths"] = delta_paths
                        permit["repair_scope_fingerprint"] = repair_scope_fingerprint
                        permit["to_head_sha"] = actual_head
                        ledger["head_sha"] = actual_head
                        ledger["events"].append(
                            {
                                "type": "repair_head_advanced",
                                "from_head_sha": previous_head_sha,
                                "to_head_sha": actual_head,
                                "permit_id": repair_permit_id,
                                "paths": delta_paths,
                                "at": now(),
                            }
                        )
                        permit["status"] = "used"
                        permit["used_head_sha"] = actual_head
                    if stage == "risk-arbitration" and epoch.get("risk_arbitration_used"):
                        raise RuntimeError("risk arbitration budget is exhausted for this epoch")
                    if stage == "risk-arbitration":
                        epoch["risk_arbitration_used"] = True
                    if stage == "repair" and not previous_head_sha:
                        raise RuntimeError("repair review wave requires previous_head_sha")
                if stage == "initial":
                    if retire_legacy_high_requirement(epoch):
                        ledger.setdefault("events", []).append(
                            {
                                "type": "legacy_high_requirement_retired",
                                "epoch_id": epoch["epoch_id"],
                                "at": now(),
                            }
                        )
                    declared_high_requirement = epoch.get("high_requirement")
                    if declared_high_requirement is None:
                        epoch["high_requirement"] = False
                    elif declared_high_requirement is not False or high_requirement:
                        raise RuntimeError(
                            "initial review wave contains an invalid retired high-risk requirement"
                        )
                wave_id = stable_hash(
                    [
                        ledger["run_id"],
                        epoch["epoch_id"],
                        stage,
                        actual_head,
                        resolved_base,
                        lane_specs,
                    ]
                )[:20]
                wave = {
                    "wave_id": wave_id,
                    "epoch_id": epoch["epoch_id"],
                    "stage": stage,
                    "scope_class": scope_class,
                    "head_sha": actual_head,
                    "base_sha": resolved_base,
                    "base_ref": review.get("base_ref"),
                    "base_ref_identity": review.get("base_ref_identity"),
                    "previous_head_sha": previous_head_sha,
                    "state": "open",
                    "opened_at": now(),
                    "repair_permit_id": repair_permit_id,
                    "arbitration_source_wave_id": (
                        source_wave.get("wave_id")
                        if stage == "risk-arbitration" and source_wave is not None
                        else None
                    ),
                    "arbitration_conflicts": arbitration_conflicts,
                    "arbitration_blocker_fingerprints": arbitration_blocker_fingerprints,
                    "cumulative_invariants": list(
                        self._review_state(ledger).get("cumulative", {}).get("invariants", [])
                    ),
                    "lanes": {
                        spec["lane"]: {
                            "model": spec["model"],
                            "effort": spec["effort"],
                            "receipt_id": None,
                        }
                        for spec in lane_specs
                    },
                }
                review["waves"][wave_id] = wave
                review["active_wave_id"] = wave_id
                epoch["waves"].append(wave_id)
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"wave": wave, "epoch": epoch}

    def authorize_terra(
        self,
        *,
        wave_id: str,
        lanes: list[str],
        failure_file: str,
        failure_task_receipt_file: str,
        authorization_ref: str,
        authorization_text_sha256: str,
        reason: str,
        pr_ref: str,
        user_message_id: str,
    ) -> dict[str, Any]:
        raise RuntimeError(
            "authorize-terra receipt production is retired; only sub-agent unavailable results "
            "may authorize a review fallback"
        )
        if self.repo is None:
            raise RuntimeError("Terra authorization requires a repository-bound ledger")
        current_ledger = self.read()
        if current_ledger.get("flow_type") in DIRECT_REVIEW_FLOW_TYPES:
            raise RuntimeError(
                "direct review fallback requires a helper-observed unavailable review_attempt"
            )
        if not current_ledger.get("legacy_compatibility"):
            raise RuntimeError(
                "authorize-terra is retained only for legacy compatibility"
            )
        failure_path = Path(failure_file)
        if not failure_path.is_absolute():
            failure_path = (self.repo / failure_path).resolve()
        if not failure_path.is_file():
            raise RuntimeError("Luna failure artifact does not exist")
        failure_bytes = failure_path.read_bytes()
        failure_sha256 = hashlib.sha256(failure_bytes).hexdigest()
        try:
            failure = json.loads(failure_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Luna failure artifact is not valid JSON") from error
        task_receipt_path = Path(failure_task_receipt_file)
        if not task_receipt_path.is_absolute():
            task_receipt_path = (self.repo / task_receipt_path).resolve()
        if not task_receipt_path.is_file():
            raise RuntimeError("Luna failure task receipt does not exist")
        task_receipt_bytes = task_receipt_path.read_bytes()
        task_receipt_sha256 = hashlib.sha256(task_receipt_bytes).hexdigest()
        expected_failure_keys = {
            "wave_id", "epoch_id", "lane", "model", "effort", "failure_kind",
            "task_id", "terminal_status", "provenance_boundary"
        }
        if (
            not isinstance(failure, dict)
            or set(failure) != expected_failure_keys
            or failure.get("wave_id") != wave_id
            or failure.get("model") not in {"gpt-5.6-luna", "gpt-5.6-terra"}
            or (
                failure.get("model") == "gpt-5.6-luna"
                and failure.get("effort") not in {"medium", "xhigh", "max"}
            )
            or (
                failure.get("model") == "gpt-5.6-terra"
                and failure.get("effort") != "medium"
            )
            or failure.get("failure_kind") != "model_unavailable"
            or failure.get("terminal_status") != "model_unavailable"
            or failure.get("provenance_boundary") != "tool-observed-spawn-agent-result"
            or not isinstance(failure.get("task_id"), str)
            or not failure["task_id"].strip()
        ):
            raise RuntimeError("Terra authorization requires a Luna model_unavailable failure")
        try:
            task_receipt = json.loads(task_receipt_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Luna failure task receipt is not valid JSON") from error
        expected_task_receipt = {
            "wave_id": failure["wave_id"],
            "epoch_id": failure["epoch_id"],
            "lane": failure["lane"],
            "model": failure["model"],
            "effort": failure["effort"],
            "failure_kind": failure["failure_kind"],
            "task_id": failure["task_id"],
            "terminal_status": failure["terminal_status"],
            "provenance_boundary": failure["provenance_boundary"],
            "failure_sha256": failure_sha256,
        }
        if task_receipt != expected_task_receipt:
            raise RuntimeError(
                "Luna failure task receipt does not match the tool-observed terminal envelope"
            )
        normalized_lanes = sorted(set(lanes))
        normalized_reason = reason.strip()
        normalized_message_id = user_message_id.strip()
        normalized_pr_ref = pr_ref.strip()
        if (
            not normalized_lanes
            or len(normalized_lanes) != len(lanes)
            or not normalized_reason
            or not normalized_message_id
            or not re.fullmatch(r"[0-9a-f]{64}", authorization_text_sha256)
            or not PR_REF_PATTERN.fullmatch(normalized_pr_ref)
        ):
            raise RuntimeError("Terra authorization metadata is invalid")
        if hashlib.sha256(normalized_reason.encode("utf-8")).hexdigest() != authorization_text_sha256:
            raise RuntimeError("Terra authorization text digest does not match the reason")
        identity = stable_hash(
            ["authorize-terra", wave_id, normalized_lanes, normalized_message_id]
        )
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                if (
                    file_sha256(failure_path) != failure_sha256
                    or file_sha256(task_receipt_path) != task_receipt_sha256
                ):
                    raise RuntimeError("Luna failure evidence changed during authorization")
                ledger = self.read()
                self._require_active(ledger)
                review = self._review_state(ledger)
                epoch = self._active_epoch(ledger)
                wave = self._review_wave(ledger, wave_id)
                if (
                    review.get("active_wave_id") != wave_id
                    or wave.get("state") != "open"
                    or wave.get("epoch_id") != epoch.get("epoch_id")
                    or failure.get("epoch_id") != epoch.get("epoch_id")
                    or wave.get("stage") not in {"initial", "repair"}
                ):
                    raise RuntimeError("Terra authorization is not bound to the active routine wave")
                if failure.get("lane") not in normalized_lanes:
                    raise RuntimeError("Terra authorization must include the failed Luna lane")
                if review.get("pr_ref") != normalized_pr_ref:
                    raise RuntimeError("Terra authorization PR does not match the bound PR")
                live_facts = gh_pr_binding_facts(self.repo, normalized_pr_ref)
                if (
                    live_facts.get("base_sha") != ledger.get("base_sha")
                    or live_facts.get("head_sha") != ledger.get("head_sha")
                ):
                    raise RuntimeError("Terra authorization PR facts are stale")
                authenticated_user = gh_authenticated_user(self.repo)
                if authorization_ref != f"owner:{authenticated_user}:{normalized_message_id}":
                    raise RuntimeError("Terra authorization is not issued by the authenticated owner")
                consumed = review.setdefault("terra_authorization_message_ids", [])
                if normalized_message_id in consumed:
                    raise RuntimeError("Terra authorization message was already consumed")
                existing_terra_authorization = epoch.get("terra_authorization")
                if existing_terra_authorization is not None and failure.get("model") == "gpt-5.6-luna":
                    raise RuntimeError("Terra authorization already exists for this epoch")
                for lane in normalized_lanes:
                    lane_state = wave.get("lanes", {}).get(lane)
                    if not isinstance(lane_state, dict):
                        raise RuntimeError("Terra authorization lane is not declared")
                    if lane_state.get("receipt_id"):
                        raise RuntimeError("Terra authorization cannot rebind a receipted lane")
                    if failure.get("model") == "gpt-5.6-luna":
                        if lane_state.get("model") != "gpt-5.6-luna" or lane_state.get("effort") not in {
                            "medium",
                            "xhigh",
                            "max",
                        }:
                            raise RuntimeError("Terra authorization lane is not pending an allowed Luna profile")
                    elif lane_state.get("model") != "gpt-5.6-terra" or lane_state.get("effort") != "medium":
                        raise RuntimeError("Terra xhigh authorization lane is not pending Terra+medium")
                authorization = {
                    "kind": "owner-explicit-terra",
                    "authorization_ref": authorization_ref,
                    "authorization_text_sha256": authorization_text_sha256,
                    "reason": normalized_reason,
                    "reason_sha256": hashlib.sha256(normalized_reason.encode("utf-8")).hexdigest(),
                    "pr_ref": normalized_pr_ref,
                    "user_message_id": normalized_message_id,
                    "failure_sha256": failure_sha256,
                    "failure_task_id": failure["task_id"],
                    "lanes": normalized_lanes,
                    "at": now(),
                }
                next_terra_effort = "medium" if failure.get("model") == "gpt-5.6-luna" else "xhigh"
                for lane in normalized_lanes:
                    wave["lanes"][lane]["model"] = "gpt-5.6-terra"
                    wave["lanes"][lane]["effort"] = next_terra_effort
                epoch["routine_review_model"] = "gpt-5.6-terra"
                authorization["resolved_effort"] = next_terra_effort
                epoch.setdefault("terra_authorizations", []).append(authorization)
                epoch["terra_authorization"] = authorization
                consumed.append(normalized_message_id)
                ledger["receipts"].append(
                    {
                        "receipt_id": stable_hash(
                            [ledger["run_id"], "review-model-unavailable", failure]
                        ),
                        "kind": "review-model-unavailable",
                        "wave_id": wave_id,
                        "epoch_id": epoch["epoch_id"],
                        "lane": failure["lane"],
                        "head_sha": ledger["head_sha"],
                        "base_sha": ledger["base_sha"],
                        "review_model": failure["model"],
                        "review_effort": failure["effort"],
                        "review_task_id": failure["task_id"],
                        "terminal_status": failure["terminal_status"],
                        "provenance_boundary": failure["provenance_boundary"],
                        "artifact_sha256": failure_sha256,
                        "task_receipt_sha256": task_receipt_sha256,
                        "recorded_at": now(),
                    }
                )
                ledger["events"].append({"type": "terra_authorized", **authorization})
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"epoch": epoch, "wave": wave, "authorization": authorization}

    def authorize_repair(self, wave_id: str) -> dict[str, Any]:
        identity = stable_hash(["review-repair", wave_id])
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                ledger = self.read()
                self._require_active(ledger)
                requested_wave = self._review_wave(ledger, wave_id)
                review = self._review_state(ledger)
                if not repair_authorization_has_no_active_wave(review):
                    raise RuntimeError(
                        "repair authorization requires all lanes in the active review wave to finalize"
                    )
                epoch = self._active_epoch(ledger)
                wave = requested_wave
                arbitration_source_id = requested_wave.get("arbitration_source_wave_id")
                if requested_wave.get("stage") == "risk-arbitration":
                    if requested_wave.get("state") != "finalized":
                        raise RuntimeError("repair authorization requires a finalized review wave")
                    if not isinstance(arbitration_source_id, str) or not arbitration_source_id:
                        raise RuntimeError("risk arbitration is missing its source wave")
                    wave = self._review_wave(ledger, arbitration_source_id)
                if wave.get("epoch_id") != epoch.get("epoch_id") or wave_id not in epoch.get(
                    "waves", []
                ):
                    raise RuntimeError("repair authorization wave is not in the active epoch")
                if wave.get("wave_id") not in epoch.get("waves", []):
                    raise RuntimeError("repair authorization source wave is not in the active epoch")
                if wave.get("state") != "finalized":
                    raise RuntimeError("repair authorization requires a finalized review wave")
                latest_blocker_wave = None
                for candidate_id in reversed(epoch.get("waves", [])):
                    candidate = self._review_wave(ledger, candidate_id)
                    if candidate.get("state") == "finalized" and candidate.get("blockers"):
                        latest_blocker_wave = candidate
                        break
                if latest_blocker_wave is None or latest_blocker_wave.get("wave_id") != wave.get("wave_id"):
                    raise RuntimeError(
                        "repair authorization requires the latest finalized blocker wave"
                    )
                if sorted(ledger.get("convergence", {}).get("blockers", [])) != sorted(
                    wave.get("blockers", [])
                ):
                    raise RuntimeError("repair authorization blocker set is stale")
                existing_permit = None
                refreshing_permit = False
                repair_from_head = wave["head_sha"]
                if wave.get("repair_permit_id"):
                    existing_permit = next(
                        (
                            item
                            for item in epoch.get("permits", [])
                            if item.get("permit_id") == wave.get("repair_permit_id")
                        ),
                        None,
                    )
                    stale_repair_wave = next(
                        (
                            candidate
                            for candidate_id in epoch.get("waves", [])
                            for candidate in (self._review_wave(ledger, candidate_id),)
                            if candidate.get("stage") == "repair"
                            and candidate.get("state") == "stale"
                            and candidate.get("repair_permit_id")
                            == wave.get("repair_permit_id")
                        ),
                        None,
                    )
                    consumed_by_stale_repair_wave = (
                        existing_permit is not None
                        and existing_permit.get("status") == "used"
                        and existing_permit.get("source_wave_id") == wave.get("wave_id")
                        and isinstance(stale_repair_wave, dict)
                        and existing_permit.get("from_head_sha")
                        == stale_repair_wave.get("previous_head_sha")
                        and existing_permit.get("to_head_sha") == stale_repair_wave.get("head_sha")
                        and existing_permit.get("used_head_sha") == stale_repair_wave.get("head_sha")
                    )
                    if consumed_by_stale_repair_wave:
                        repair_from_head = ledger["head_sha"]
                    elif (
                        existing_permit is not None
                        and existing_permit.get("status") == "used"
                        and wave.get("stage") == "repair"
                    ):
                        # A finalized repair wave with residual blockers consumes its
                        # own permit. The next authorized repair must use a new permit.
                        existing_permit = None
                    else:
                        if (
                            existing_permit is None
                            or existing_permit.get("status") != "issued"
                            or existing_permit.get("base_sha") == ledger.get("base_sha")
                        ):
                            if not (
                                requested_wave.get("stage") == "risk-arbitration"
                                and existing_permit is not None
                                and existing_permit.get("status") == "used"
                            ):
                                raise RuntimeError("repair authorization has already been issued for this wave")
                        else:
                            refreshing_permit = True
                blockers = list(wave.get("blockers", []))
                if not blockers:
                    raise RuntimeError("cannot authorize repair for a clear review wave")
                self._require_live_pr_facts(
                    review,
                    ledger["head_sha"],
                    ledger["base_sha"],
                    error_message="repair authorization requires live PR base and head facts",
                )
                used = int(epoch.get("repair_rounds_used", 0))
                if repair_budget_exhausted(epoch):
                    epoch["status"] = "blocked"
                    ledger["convergence"]["state"] = "NON_CONVERGENT"
                    ledger["convergence"]["blockers"] = blockers
                    ledger["updated_at"] = now()
                    self._write(ledger)
                    raise RuntimeError("convergence drag blocker: repair budget exhausted")
                if epoch.get("status") not in {"repair_pending", "diagnostic_required"}:
                    raise RuntimeError("repair authorization requires an active blocker wave")
                base_ref = review.get("base_ref")
                if isinstance(base_ref, str) and base_ref.strip() and self.repo is not None:
                    current_base = git_commit(self.repo, base_ref)
                    if current_base != ledger.get("base_sha"):
                        raise RuntimeError(
                            "repair authorization requires a fresh review at the current base"
                        )
                permit_number = used if refreshing_permit else used + 1
                permit_id = stable_hash(
                    [ledger["run_id"], epoch["epoch_id"], wave.get("wave_id"), permit_number, blockers, ledger.get("base_sha")]
                )[:20]
                blocker_digest = stable_hash(blockers)
                source_scope_fingerprint = wave.get("scope_fingerprint")
                if not isinstance(source_scope_fingerprint, str) or not source_scope_fingerprint:
                    source_scope_fingerprint = stable_hash(
                        {
                            "stage": wave.get("stage"),
                            "base_sha": wave.get("base_sha"),
                            "head_sha": wave.get("head_sha"),
                            "finding_to_group": wave.get("finding_to_group", {}),
                        }
                    )
                blocker_groups = set(wave.get("blockers", []))
                blocker_findings = {
                    fingerprint
                    for fingerprint, group_id in wave.get("finding_to_group", {}).items()
                    if group_id in blocker_groups
                }
                scope_paths = sorted(
                    {
                        str(
                            Path(finding["code_location"]["absolute_file_path"])
                            .resolve()
                            .relative_to(self.repo.resolve())
                        )
                        for receipt in ledger.get("receipts", [])
                        if receipt.get("wave_id") == wave.get("wave_id")
                        for finding in receipt.get("review_findings", [])
                        if isinstance(finding, dict)
                        and isinstance(finding.get("code_location"), dict)
                        and isinstance(
                            finding["code_location"].get("absolute_file_path"), str
                        )
                        and review_finding_fingerprint(finding) in blocker_findings
                    }
                )
                scope_fingerprint = stable_hash(
                    {
                        "source_wave_id": wave.get("wave_id"),
                        "blocker_digest": blocker_digest,
                        "source_scope_fingerprint": source_scope_fingerprint,
                        "scope_paths": scope_paths,
                    }
                )
                permit = {
                    "permit_id": permit_id,
                    "source_wave_id": wave.get("wave_id"),
                    "from_head_sha": repair_from_head,
                    "base_sha": ledger.get("base_sha"),
                    "blocker_digest": blocker_digest,
                    "source_scope_fingerprint": source_scope_fingerprint,
                    "scope_paths": scope_paths,
                    "scope_fingerprint": scope_fingerprint,
                    "scope": "root-cause-repair",
                    "status": "issued",
                    "issued_at": now(),
                }
                if refreshing_permit and existing_permit is not None:
                    existing_permit.update(permit)
                    permit = existing_permit
                else:
                    epoch.setdefault("permits", []).append(permit)
                wave["repair_permit_id"] = permit_id
                epoch["repair_rounds_used"] = permit_number
                epoch["status"] = "repair_authorized"
                ledger["convergence"]["repair_round"] = permit_number
                ledger["convergence"]["blockers"] = blockers
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"repair_permit": permit, "epoch": epoch}

    def _rederive_current_review_receipt(
        self,
        receipt: dict[str, Any],
        *,
        wave_id: str,
        lane: str,
    ) -> tuple[dict[str, Any], list[str]]:
        """Rebuild all mutable review fields from ledger-owned evidence artifacts."""
        assert self.repo is not None
        if receipt.get("review_execution_source") == "sub-agent":
            if (
                receipt.get("provenance_boundary") != "sub-agent-structured-result"
                or receipt.get("evidence_source") != "sub-agent-structured-result"
                or receipt.get("profile_proof_status") != "sub-agent-declared"
                or receipt.get("terminal_state") != "completed"
            ):
                raise RuntimeError("sub-agent review receipt has invalid provenance")
            raw_result = receipt.get("review_result")
            canonical_result = json.dumps(raw_result, ensure_ascii=True, sort_keys=True)
            if receipt.get("review_result_sha256") != hashlib.sha256(
                canonical_result.encode("utf-8")
            ).hexdigest():
                raise RuntimeError("sub-agent review result digest is invalid")
            review_result, fingerprints = parse_review_result(canonical_result)
            validate_agent_finding_diff_locations(
                review_result,
                self.repo,
                receipt.get("base_sha", ""),
                receipt.get("head_sha", ""),
            )
            if (
                receipt.get("finding_fingerprints") != fingerprints
                or receipt.get("review_findings") != review_result["findings"]
                or receipt.get("review_clear")
                != review_is_clear(True, fingerprints, review_result)
                or receipt.get("overall_correctness")
                != review_result["overall_correctness"]
            ):
                raise RuntimeError("sub-agent review findings do not match its structured result")
            profile_resolution = receipt.get("profile_resolution")
            if (
                receipt.get("review_receipt_schema") != REVIEW_RECEIPT_SCHEMA_VERSION
                or not isinstance(profile_resolution, dict)
                or profile_resolution.get("resolved")
                != {
                    "model": receipt.get("resolved_model"),
                    "effort": receipt.get("resolved_effort"),
                }
            ):
                raise RuntimeError("sub-agent review profile proof is invalid")
            return profile_resolution, fingerprints
        if receipt.get("runtime_sandbox") == "network-only-direct-api":
            raise RuntimeError("direct provider review receipts are retired and cannot satisfy proof")
        raise RuntimeError(
            "only sub-agent structured review receipts can satisfy current proof; "
            "legacy review receipts are audit history only"
        )

        review_root = (self.root / "reviews").resolve()
        artifact_path = review_artifact_path(review_root, receipt.get("artifact_path"), "artifact")
        artifact_sha256 = receipt.get("artifact_sha256")
        artifact_bytes = stable_file_bytes(artifact_path, "review receipt artifact")
        if (
            not isinstance(artifact_sha256, str)
            or artifact_sha256 != hashlib.sha256(artifact_bytes).hexdigest()
        ):
            raise RuntimeError("review receipt artifact digest is invalid")
        try:
            artifact_text = artifact_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            raise RuntimeError("review receipt artifact is not UTF-8") from error
        if receipt.get("kind") == "review":
            review_result, fingerprints = parse_review_result(artifact_text)
        elif receipt.get("kind") == "agent-review":
            review_result, fingerprints = parse_agent_review_result(artifact_text, self.repo)
        else:
            raise RuntimeError("review receipt has an invalid kind")
        validate_agent_finding_diff_locations(
            review_result, self.repo, receipt.get("base_sha", ""), receipt.get("head_sha", "")
        )
        if (
            receipt.get("finding_fingerprints") != fingerprints
            or receipt.get("review_findings") != review_result["findings"]
            or receipt.get("review_clear")
            != review_is_clear(True, fingerprints, review_result)
            or receipt.get("overall_correctness") != review_result["overall_correctness"]
        ):
            raise RuntimeError("review receipt findings do not match its persisted artifact")

        if receipt.get("kind") == "agent-review":
            task_receipt_path = review_artifact_path(
                review_root, receipt.get("task_receipt_path"), "helper task receipt"
            )
            task_receipt_bytes = stable_file_bytes(task_receipt_path, "helper task receipt")
            if (
                receipt.get("task_receipt_sha256")
                != hashlib.sha256(task_receipt_bytes).hexdigest()
            ):
                raise RuntimeError("helper task receipt digest is invalid")
            try:
                task_receipt_text = task_receipt_bytes.decode("utf-8")
            except UnicodeDecodeError as error:
                raise RuntimeError("helper task receipt is not UTF-8") from error
            parse_helper_task_receipt(
                task_receipt_text,
                result_sha256=artifact_sha256,
                review_agent_id=receipt.get("review_agent_id", ""),
                review_task_id=receipt.get("review_task_id", ""),
                agent_status=receipt.get("agent_status", ""),
                head_sha=receipt.get("head_sha", ""),
                base_sha=receipt.get("base_sha", ""),
                review_profile=receipt.get("review_profile", ""),
                review_model=receipt.get("review_model", ""),
                review_effort=receipt.get("review_effort", ""),
                wave_id=wave_id,
                lane=lane,
            )

        raw_profile_resolution = receipt.get("profile_resolution")
        if receipt.get("provenance_boundary") == "helper-owned-structured-result":
            if not isinstance(raw_profile_resolution, dict):
                raise RuntimeError("review receipt profile proof is missing")
            preferred = raw_profile_resolution.get("preferred")
            resolved = raw_profile_resolution.get("resolved")
            if (
                not isinstance(preferred, dict)
                or set(preferred) != {"model", "effort"}
                or not isinstance(resolved, dict)
                or set(resolved) != {"model", "effort"}
            ):
                raise RuntimeError("review receipt profile proof is malformed")
            profile_resolution = raw_profile_resolution
        else:
            profile_resolution = normalise_profile_resolution(raw_profile_resolution)
        if (
            receipt.get("review_receipt_schema") != REVIEW_RECEIPT_SCHEMA_VERSION
            or
            receipt.get("provenance_boundary") != "helper-owned-structured-result"
            or receipt.get("profile_proof_status") != "helper-verified"
            or not (
                receipt.get("profile_resolution") == profile_resolution
                or receipt.get("profile_resolution") == raw_profile_resolution
            )
            or profile_resolution.get("resolved")
            != {"model": receipt.get("resolved_model"), "effort": receipt.get("resolved_effort")}
        ):
            raise RuntimeError("review receipt profile proof is not helper-owned")
        return profile_resolution, fingerprints

    def _direct_acceptance_synthesis(
        self, ledger: dict[str, Any], wave: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Derive direct validation coverage from current-head receipts only."""
        manifest = ledger.get("acceptance_manifest")
        if manifest is None:
            return []
        expected = {
            item["id"]: item
            for item in normalize_acceptance_manifest(manifest)["items"]
            if item["gate"] == "validation"
        }
        synthesis: list[dict[str, Any]] = []
        for acceptance_id, item in sorted(expected.items()):
            candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for receipt in reversed(ledger.get("receipts", [])):
                if (
                    not isinstance(receipt, dict)
                    or receipt.get("kind") != "validation"
                    or receipt.get("exit_code") != 0
                    or receipt.get("head_sha") != wave.get("head_sha")
                ):
                    continue
                evidence = next(
                    (
                        value
                        for value in receipt.get("acceptance_evidence", [])
                        if isinstance(value, dict)
                        and value.get("id") == acceptance_id
                        and value.get("target") in item["evidence"]
                    ),
                    None,
                )
                if evidence is not None:
                    candidates.append((receipt, evidence))
            required = set(item["assertions"])
            selected: list[tuple[dict[str, Any], dict[str, Any]]] = []
            if item["mode"] == "direct":
                selected = next(
                    (
                        [candidate]
                        for candidate in candidates
                        if required.issubset(set(candidate[1].get("assertions", [])))
                    ),
                    candidates[:1],
                )
            else:
                selected = candidates
            observed = set().union(
                *(set(evidence.get("assertions", [])) for _receipt, evidence in selected)
            ) if selected else set()
            covered = (
                any(required.issubset(set(evidence.get("assertions", []))) for _receipt, evidence in selected)
                if item["mode"] == "direct"
                else required.issubset(observed)
            )
            synthesis.append(
                {
                    "id": acceptance_id,
                    "status": "covered" if covered else ("partial" if observed else "missing"),
                    "receipt_ids": [receipt["receipt_id"] for receipt, _evidence in selected],
                    "assertions": sorted(observed),
                }
            )
        return synthesis

    def _derive_direct_review_synthesis(
        self,
        ledger: dict[str, Any],
        wave: dict[str, Any],
        lane_findings: dict[str, set[str]],
    ) -> dict[str, Any]:
        """Derive one deterministic, blocking group for every direct finding."""
        fingerprints = sorted({item for findings in lane_findings.values() for item in findings})
        return normalize_review_synthesis(
            {
                "groups": [
                    {
                        "group_id": "finding-" + fingerprint,
                        "finding_fingerprints": [fingerprint],
                        "blocker": True,
                        "invariant": "Resolve mandatory review finding " + fingerprint,
                    }
                    for fingerprint in fingerprints
                ],
                "invariants": [],
                "coverage": sorted(wave["lanes"]),
                "conflicts": [],
                "conflict_dispositions": [],
                "acceptance": self._direct_acceptance_synthesis(ledger, wave),
            }
        )

    def finalize_review_wave(
        self, wave_id: str, synthesis_file: str | None = None
    ) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("review waves require a repository-bound ledger")
        supplied_synthesis: dict[str, Any] | None = None
        if synthesis_file is not None:
            synthesis_path = Path(synthesis_file)
            if not synthesis_path.is_absolute():
                synthesis_path = (self.repo / synthesis_path).resolve()
            if not synthesis_path.is_file():
                raise RuntimeError("review synthesis file does not exist")
            try:
                supplied_synthesis = normalize_review_synthesis(
                    json.loads(synthesis_path.read_text(encoding="utf-8"))
                )
            except json.JSONDecodeError as error:
                raise RuntimeError("review synthesis file is not valid JSON") from error
        identity = stable_hash(["review-wave-finalize", wave_id])
        with self._exclusive_finalization(identity):
            with self._exclusive_ledger_update():
                ledger = self.read()
                self._require_active(ledger)
                review = self._review_state(ledger)
                if review.get("active_wave_id") != wave_id:
                    raise RuntimeError("review wave is not the active wave")
                wave = self._review_wave(ledger, wave_id)
                if wave.get("state") != "open":
                    raise RuntimeError("review wave is already finalized")
                direct_synthesis = self._requires_current_review_proof(ledger)
                if direct_synthesis and supplied_synthesis is not None:
                    raise RuntimeError(
                        "direct review finalization derives synthesis from sub-agent receipts"
                    )
                if not direct_synthesis and supplied_synthesis is None:
                    raise RuntimeError("review synthesis file is required for this legacy flow")
                epoch = self._active_epoch(ledger)
                if wave.get("epoch_id") != epoch.get("epoch_id"):
                    raise RuntimeError("review wave is not in the active epoch")
                expected_stage_status = {
                    "initial": "active",
                    "repair": "repair_authorized",
                    "risk-arbitration": "repair_pending",
                }
                stage_status = expected_stage_status[wave["stage"]]
                if isinstance(stage_status, set):
                    valid_stage_status = epoch.get("status") in stage_status
                else:
                    valid_stage_status = epoch.get("status") == stage_status
                if not valid_stage_status:
                    raise RuntimeError("review wave stage is not writable in the active epoch")
                actual_head, _ = require_clean_current_head(self.repo, wave["head_sha"])
                if actual_head != wave["head_sha"] or ledger["head_sha"] != actual_head:
                    raise RuntimeError("review wave head changed before finalization")
                wave_base_ref = wave.get("base_ref") or review.get("base_ref")
                if not isinstance(wave_base_ref, str) or not wave_base_ref.strip():
                    raise RuntimeError("review wave has no bound base ref")
                current_base = git_commit(self.repo, wave_base_ref)
                if current_base != wave.get("base_sha") or current_base != ledger.get("base_sha"):
                    raise RuntimeError("review wave base changed before finalization")
                if review.get("pr_ref"):
                    with self._release_ledger_lock_for_revalidation(
                        ledger,
                        changed_error="review wave changed during finalization revalidation",
                    ):
                        self._require_live_pr_facts(
                            review,
                            actual_head,
                            current_base,
                            error_message="review finalization requires live PR base and head facts",
                        )
                missing = [
                    lane for lane, spec in wave["lanes"].items() if not spec.get("receipt_id")
                ]
                if missing:
                    raise RuntimeError("review wave is missing lanes: " + ", ".join(sorted(missing)))
                lane_findings: dict[str, set[str]] = {}
                all_fingerprints: set[str] = set()
                for lane, lane_state in wave["lanes"].items():
                    receipt = next(
                        (
                            item
                            for item in ledger["receipts"]
                            if item.get("receipt_id") == lane_state.get("receipt_id")
                        ),
                        None,
                    )
                    if receipt is None or receipt.get("wave_id") != wave_id or receipt.get("lane") != lane:
                        raise RuntimeError("review wave lane receipt does not match its wave")
                    expected_receipt_kind = (
                        "review"
                        if self._requires_current_review_proof(ledger)
                        else "agent-review"
                    )
                    if receipt.get("kind") != expected_receipt_kind:
                        raise RuntimeError("review wave lane receipt has an invalid kind")
                    if int(ledger.get("schema_version", 1)) >= FLOW_SCHEMA_VERSION:
                        with self._release_ledger_lock_for_revalidation(
                            ledger,
                            changed_error="review wave changed during finalization revalidation",
                        ):
                            try:
                                profile_resolution, _artifact_fingerprints = (
                                    self._rederive_current_review_receipt(
                                        receipt, wave_id=wave_id, lane=lane
                                    )
                                )
                            except ProfileError as error:
                                raise RuntimeError(
                                    "review wave lane receipt has invalid runtime profile attestation"
                                ) from error
                            except RuntimeError as error:
                                raise RuntimeError(
                                    "review wave lane receipt has invalid persisted evidence"
                                ) from error
                        preferred_profile = {
                            "model": lane_state.get("model"),
                            "effort": lane_state.get("effort"),
                        }
                        resolved_profile = profile_resolution["resolved"]
                        if (
                            receipt.get("review_execution_source") != "sub-agent"
                            or receipt.get("provenance_boundary")
                            != "sub-agent-structured-result"
                            or receipt.get("profile_proof_status") != "sub-agent-declared"
                            or receipt.get("profile_resolution") != profile_resolution
                            or profile_resolution["preferred"] != preferred_profile
                            or profile_resolution
                            != direct_review_profile_resolution(
                                lane_state.get("model", ""),
                                lane_state.get("effort", ""),
                                receipt.get("review_model", ""),
                                receipt.get("review_effort", ""),
                            )
                            or receipt.get("resolved_model") != resolved_profile["model"]
                            or receipt.get("resolved_effort") != resolved_profile["effort"]
                        ):
                            raise RuntimeError(
                                "review wave lane receipt has invalid sub-agent profile proof"
                            )
                    if (
                        receipt.get("head_sha") != wave.get("head_sha")
                        or receipt.get("base_sha") != wave.get("base_sha")
                        or receipt.get("evidence_valid") is not True
                        or receipt.get("terminal_state") != "completed"
                        or type(receipt.get("exit_code")) is not int
                        or receipt.get("exit_code") != 0
                        or receipt.get("post_execution_clean") is not True
                    ):
                        raise RuntimeError("review wave lane receipt is not valid current-head evidence")
                    expected_profile = {
                        "initial": "pr-convergence",
                        "repair": "pr-convergence",
                        "risk-arbitration": "risk-arbitration",
                    }[wave["stage"]]
                    if receipt.get("review_profile") != expected_profile:
                        raise RuntimeError("review wave lane receipt has an invalid review profile")
                    if not review_model_matches_lane(
                        lane_state.get("model", ""),
                        lane_state.get("effort", ""),
                        receipt.get("review_model", ""),
                        receipt.get("review_effort", ""),
                        enforce_direct=self._requires_current_review_proof(ledger),
                    ):
                        raise RuntimeError("review wave lane receipt has invalid profile metadata")
                    if self._requires_current_review_proof(ledger) and not direct_wave_lane_profile_is_authorized(
                        ledger,
                        repo_path=self.repo,
                        head_sha=wave.get("head_sha", ""),
                        base_sha=wave.get("base_sha", ""),
                        wave_id=wave_id,
                        lane=lane,
                        declared_model=lane_state.get("model", ""),
                        declared_effort=lane_state.get("effort", ""),
                        review_model=receipt.get("review_model", ""),
                        review_effort=receipt.get("review_effort", ""),
                    ):
                        raise RuntimeError("review wave lane fallback is not authorized by ordered failure evidence")
                    fingerprints = receipt.get("finding_fingerprints", [])
                    if not isinstance(fingerprints, list) or len(fingerprints) != len(set(fingerprints)):
                        raise RuntimeError("review wave lane findings are invalid")
                    if not fingerprints and not receipt.get("review_clear"):
                        raise RuntimeError("review wave lane is not clear")
                    if receipt.get("review_clear") and fingerprints:
                        raise RuntimeError("review wave lane clear state does not match its findings")
                    fingerprints = set(fingerprints)
                    lane_findings[lane] = fingerprints
                    all_fingerprints |= fingerprints
                synthesis = (
                    self._derive_direct_review_synthesis(ledger, wave, lane_findings)
                    if direct_synthesis
                    else supplied_synthesis
                )
                assert synthesis is not None
                blockers = synthesis["blockers"]
                acceptance_manifest = ledger.get("acceptance_manifest")
                acceptance_closure = self._validate_acceptance_synthesis(
                    ledger, wave, synthesis.get("acceptance", []), acceptance_manifest
                )
                mapped = set(synthesis["finding_to_group"])
                if mapped != all_fingerprints:
                    raise RuntimeError("review synthesis must map every lane finding exactly once")
                if set(synthesis["coverage"]) != set(wave["lanes"]):
                    raise RuntimeError("review synthesis coverage must match all declared lanes")
                if synthesis["conflicts"] and {
                    item["conflict"] for item in synthesis["conflict_dispositions"]
                } != set(synthesis["conflicts"]):
                    raise RuntimeError("review synthesis conflicts require dispositions")
                blocker_receipts = {
                    fingerprint
                    for lane in wave["lanes"]
                    for fingerprint in lane_findings[lane]
                }
                synthesized_blockers = {
                    fingerprint
                    for group in synthesis["groups"]
                    if group["blocker"]
                    for fingerprint in group["finding_fingerprints"]
                }
                if blocker_receipts != synthesized_blockers:
                    raise RuntimeError("review synthesis blocker disposition does not match lane findings")
                if wave["stage"] == "risk-arbitration" and blockers:
                    raise RuntimeError("risk arbitration must resolve its blocker conflict before finalization")
                arbitration_source = None
                if wave["stage"] == "risk-arbitration":
                    source_wave_id = wave.get("arbitration_source_wave_id")
                    if not isinstance(source_wave_id, str) or not source_wave_id:
                        raise RuntimeError("risk arbitration is missing its source wave")
                    arbitration_source = self._review_wave(ledger, source_wave_id)
                    if (
                        arbitration_source.get("epoch_id") != epoch.get("epoch_id")
                        or arbitration_source.get("state") != "finalized"
                        or not arbitration_source.get("blockers")
                    ):
                        raise RuntimeError("risk arbitration source wave is no longer an active blocker wave")
                    if set(wave.get("arbitration_conflicts", [])) != set(
                        arbitration_source.get("conflicts", [])
                    ) or not arbitration_source.get("conflicts"):
                        raise RuntimeError("risk arbitration conflicts do not match its source wave")
                    if set(wave.get("arbitration_blocker_fingerprints", [])) != set(
                        arbitration_source.get("blocker_fingerprints", [])
                    ):
                        raise RuntimeError(
                            "risk arbitration blocker fingerprints do not match its source wave"
                        )
                    if set(synthesis["conflicts"]) != set(wave.get("arbitration_conflicts", [])):
                        raise RuntimeError(
                            "risk arbitration synthesis must cover every declared conflict"
                        )
                    if {
                        item["conflict"] for item in synthesis["conflict_dispositions"]
                    } != set(wave.get("arbitration_conflicts", [])):
                        raise RuntimeError(
                            "risk arbitration synthesis must dispose every declared conflict"
                        )
                cumulative = self._review_state(ledger).setdefault(
                    "cumulative", default_review_state()["cumulative"]
                )
                for fingerprint, group_id in synthesis["finding_to_group"].items():
                    previous_group = cumulative.get("finding_to_group", {}).get(fingerprint)
                    if previous_group is not None and previous_group != group_id:
                        raise RuntimeError(
                            "review synthesis remaps a cumulative finding to another root group"
                        )
                inline_synthesis = review_synthesis_input(synthesis)
                artifact_path: Path | None = None
                if not direct_synthesis:
                    artifact_root = self.root / "reviews" / "waves"
                    artifact_root.mkdir(parents=True, exist_ok=True)
                    artifact_path = artifact_root / f"{wave_id}-synthesis.json"
                    artifact_path.write_text(
                        json.dumps(synthesis, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )

                def revalidate_finalization_evidence() -> None:
                    synthesis_digest = wave.get("synthesis_sha256")
                    if direct_synthesis:
                        stored_synthesis = wave.get("synthesis")
                        if stored_synthesis is not None or synthesis_digest is not None:
                            if (
                                not isinstance(stored_synthesis, dict)
                                or not isinstance(synthesis_digest, str)
                                or stable_hash(stored_synthesis) != synthesis_digest
                                or normalize_review_synthesis(stored_synthesis) != synthesis
                            ):
                                raise RuntimeError(
                                    "review wave synthesis evidence changed before finalization"
                                )
                    else:
                        synthesis_artifact = wave.get("synthesis_path")
                        if synthesis_digest is not None or synthesis_artifact is not None:
                            if not isinstance(synthesis_digest, str) or not isinstance(synthesis_artifact, str):
                                raise RuntimeError("review wave synthesis evidence changed before finalization")
                            try:
                                current_synthesis = stable_file_bytes(
                                    review_artifact_path(
                                        self.root / "reviews", synthesis_artifact, "review wave synthesis"
                                    ),
                                    "review wave synthesis",
                                )
                            except OSError as error:
                                raise RuntimeError(
                                    "review wave synthesis evidence changed before finalization"
                                ) from error
                            if hashlib.sha256(current_synthesis).hexdigest() != synthesis_digest:
                                raise RuntimeError("review wave synthesis evidence changed before finalization")
                    if int(ledger.get("schema_version", 1)) < FLOW_SCHEMA_VERSION:
                        return
                    for lane, lane_state in wave["lanes"].items():
                        receipt = next(
                            item
                            for item in ledger["receipts"]
                            if item.get("receipt_id") == lane_state.get("receipt_id")
                        )
                        try:
                            profile_resolution, _artifact_fingerprints = (
                                self._rederive_current_review_receipt(
                                    receipt, wave_id=wave_id, lane=lane
                                )
                            )
                        except RuntimeError as error:
                            raise RuntimeError(
                                "review wave lane evidence changed before finalization"
                            ) from error

                def require_finalization_candidate() -> None:
                    try:
                        latest_head, _ = require_clean_current_head(self.repo, wave["head_sha"])
                    except RuntimeError as error:
                        raise RuntimeError("review wave head changed before finalization") from error
                    if latest_head != wave["head_sha"] or ledger["head_sha"] != latest_head:
                        raise RuntimeError("review wave head changed before finalization")
                    latest_base = git_commit(self.repo, wave_base_ref)
                    if latest_base != wave.get("base_sha") or latest_base != ledger.get("base_sha"):
                        raise RuntimeError("review wave base changed before finalization")
                    if review.get("pr_ref"):
                        self._require_live_pr_facts(
                            review,
                            latest_head,
                            latest_base,
                            error_message="review finalization requires live PR base and head facts",
                        )

                with self._release_ledger_lock_for_revalidation(
                    ledger,
                    changed_error="review wave changed during finalization revalidation",
                ):
                    revalidate_finalization_evidence()
                    require_finalization_candidate()
                    revalidate_finalization_evidence()
                    require_finalization_candidate()
                pre_finalization_ledger = json.loads(json.dumps(ledger))
                wave.update(
                    {
                        "state": "finalized",
                        "blockers": blockers,
                        "blocker_fingerprints": synthesis["blocker_fingerprints"],
                        "scope_fingerprint": synthesis["scope_fingerprint"],
                        "finding_to_group": synthesis["finding_to_group"],
                        "coverage": synthesis["coverage"],
                        "conflicts": synthesis["conflicts"],
                        "conflict_dispositions": synthesis["conflict_dispositions"],
                        "invariants": synthesis["invariants"],
                        "acceptance": acceptance_closure,
                        "acceptance_manifest_digest": (
                            stable_hash(acceptance_manifest)
                            if acceptance_manifest is not None
                            else None
                        ),
                        "synthesis": inline_synthesis if direct_synthesis else None,
                        "synthesis_path": None if direct_synthesis else str(artifact_path),
                        "synthesis_sha256": (
                            stable_hash(inline_synthesis)
                            if direct_synthesis
                            else file_sha256(artifact_path)
                        ),
                        "finalized_at": now(),
                    }
                )
                if wave["stage"] == "risk-arbitration":
                    epoch.setdefault("arbitration_history", []).append(
                        {
                            "wave_id": wave_id,
                            "source_wave_id": arbitration_source["wave_id"],
                            "conflicts": list(wave.get("arbitration_conflicts", [])),
                            "blocker_fingerprints": list(
                                wave.get("arbitration_blocker_fingerprints", [])
                            ),
                            "dispositions": synthesis["conflict_dispositions"],
                            "at": now(),
                        }
                    )
                    wave["arbitration_resolution"] = {
                        "source_wave_id": arbitration_source["wave_id"],
                        "conflicts": list(wave.get("arbitration_conflicts", [])),
                        "blocker_fingerprints": list(
                            wave.get("arbitration_blocker_fingerprints", [])
                        ),
                        "dispositions": synthesis["conflict_dispositions"],
                    }
                else:
                    epoch["blocker_history"].append(
                        {
                            "wave_id": wave_id,
                            "blockers": blockers,
                            "blocker_fingerprints": synthesis["blocker_fingerprints"],
                            "finding_to_group": synthesis["finding_to_group"],
                            "invariants": synthesis["invariants"],
                            "at": now(),
                        }
                    )
                epoch["invariants"] = sorted(
                    set(epoch.get("invariants", [])) | set(synthesis["invariants"])
                )
                cumulative["finding_to_group"].update(synthesis["finding_to_group"])
                cumulative["blocker_fingerprints"] = sorted(
                    set(cumulative.get("blocker_fingerprints", []))
                    | set(synthesis["blocker_fingerprints"])
                )
                cumulative["invariants"] = sorted(
                    set(cumulative.get("invariants", [])) | set(synthesis["invariants"])
                )
                cumulative["coverage_lanes"] = sorted(
                    set(cumulative.get("coverage_lanes", []))
                    | set(synthesis["coverage"])
                    | set(wave.get("lanes", {}).keys())
                )
                cumulative["conflicts"] = sorted(
                    set(cumulative.get("conflicts", [])) | set(synthesis["conflicts"])
                )
                disposition_by_conflict = {
                    item["conflict"]: item
                    for item in cumulative.get("conflict_dispositions", [])
                    if isinstance(item, dict) and isinstance(item.get("conflict"), str)
                }
                disposition_by_conflict.update(
                    {
                        item["conflict"]: item
                        for item in synthesis["conflict_dispositions"]
                    }
                )
                cumulative["conflict_dispositions"] = [
                    disposition_by_conflict[key]
                    for key in sorted(disposition_by_conflict)
                ]
                if wave["stage"] == "risk-arbitration":
                    epoch["status"] = "repair_pending"
                elif blockers:
                    epoch["status"] = "repair_pending"
                else:
                    epoch["status"] = "complete"
                    epoch["review_proof_wave_id"] = wave_id
                    review["active_epoch_id"] = None
                review["active_wave_id"] = None
                ledger["convergence"]["round"] += 1
                if wave["stage"] == "risk-arbitration":
                    ledger["convergence"]["state"] = "repair_pending"
                    ledger["convergence"]["blockers"] = list(
                        arbitration_source.get("blockers", [])
                    )
                elif blockers:
                    prior = []
                    if len(epoch["blocker_history"]) > 1:
                        prior = epoch["blocker_history"][-2].get("blocker_fingerprints", [])
                    current_counts = Counter(synthesis["blocker_fingerprints"])
                    prior_counts = Counter(prior)
                    strict_shrink = bool(prior) and sum(current_counts.values()) < sum(
                        prior_counts.values()
                    ) and all(
                        count <= prior_counts[fingerprint]
                        for fingerprint, count in current_counts.items()
                    )
                    if prior and not strict_shrink:
                        epoch["no_progress_count"] = int(epoch.get("no_progress_count", 0)) + 1
                    else:
                        epoch["no_progress_count"] = 0
                    ledger["convergence"]["state"] = (
                        "diagnostic_required"
                        if epoch.get("no_progress_count", 0)
                        else "initial"
                    )
                    if (
                        wave["stage"] == "repair"
                        and int(epoch.get("repair_rounds_used", 0)) >= MAX_CONVERGENCE_ROUNDS
                    ):
                        ledger["convergence"]["state"] = "NON_CONVERGENT"
                        epoch["status"] = "blocked"
                else:
                    ledger["convergence"]["state"] = "complete"
                if wave["stage"] != "risk-arbitration":
                    ledger["convergence"]["blockers"] = blockers
                ledger["updated_at"] = now()
                try:
                    with self._terminal_seal_locks(
                        pre_finalization_ledger,
                        changed_error="review wave changed during terminal sealing",
                    ):
                        try:
                            self._write(ledger)
                            with self._release_ledger_lock_for_revalidation(
                                ledger,
                                changed_error="review wave changed during terminal sealing",
                            ):
                                revalidate_finalization_evidence()
                                require_finalization_candidate()
                        except (KeyboardInterrupt, ProfileError, RuntimeError, subprocess.CalledProcessError, OSError):
                            # Restore while the terminal seal still owns both locks.
                            self._write(pre_finalization_ledger)
                            raise
                except KeyboardInterrupt:
                    raise
                except (ProfileError, RuntimeError, subprocess.CalledProcessError, OSError) as error:
                    raise RuntimeError(
                        "review wave proof changed during terminal sealing"
                    ) from error
                return {
                    "wave": wave,
                    "blockers": blockers,
                    "epoch": epoch,
                    "next": (
                        "convergence-drag-blocker"
                        if epoch.get("status") == "blocked"
                        else "authorize-repair"
                        if wave["stage"] == "risk-arbitration" or blockers
                        else "merge-ready"
                    ),
                }

    def _validate_acceptance_synthesis(
        self,
        ledger: dict[str, Any],
        wave: dict[str, Any],
        synthesis_items: list[dict[str, Any]],
        manifest: Any,
        *,
        epoch: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        if manifest is None:
            if synthesis_items:
                raise RuntimeError("acceptance synthesis requires a registered manifest")
            return []
        manifest = normalize_acceptance_manifest(manifest)
        expected = {
            item["id"]: item for item in manifest["items"] if item["gate"] == "validation"
        }
        supplied = {item["id"]: item for item in synthesis_items}
        if len(supplied) != len(synthesis_items) or set(supplied) != set(expected):
            raise RuntimeError("review synthesis must cover every acceptance ID exactly once")
        receipts = {receipt.get("receipt_id"): receipt for receipt in ledger.get("receipts", [])}
        normalized: list[dict[str, Any]] = []
        for acceptance_id, item in expected.items():
            declared = supplied[acceptance_id]
            selected: list[dict[str, Any]] = []
            for receipt_id in declared["receipt_ids"]:
                receipt = receipts.get(receipt_id)
                if (
                    not isinstance(receipt, dict)
                    or receipt.get("kind") != "validation"
                    or receipt.get("exit_code") != 0
                    or receipt.get("head_sha") != wave.get("head_sha")
                ):
                    raise RuntimeError("acceptance synthesis references stale or invalid evidence")
                evidence = next(
                    (
                        value
                        for value in receipt.get("acceptance_evidence", [])
                        if value.get("id") == acceptance_id
                    ),
                    None,
                )
                if evidence is None or evidence.get("target") not in item["evidence"]:
                    raise RuntimeError("acceptance synthesis evidence does not match its manifest item")
                selected.append(evidence)
            assertion_sets = [set(value["assertions"]) for value in selected]
            required = set(item["assertions"])
            observed = set().union(*assertion_sets) if assertion_sets else set()
            if (
                item["category"] in HIGH_RISK_ACCEPTANCE_CLASSES
                and item["mode"] == "direct"
                and len(selected) != 1
            ):
                raise RuntimeError(
                    "high-risk direct acceptance requires exactly one validation receipt"
                )
            covered = (
                any(required.issubset(assertions) for assertions in assertion_sets)
                if item["mode"] == "direct"
                else required.issubset(observed)
            )
            computed_status = "covered" if covered else ("partial" if observed else "missing")
            if declared["status"] != computed_status or set(declared["assertions"]) != observed:
                raise RuntimeError("acceptance synthesis status/assertions do not match receipt evidence")
            normalized.append(declared)
        normalized.sort(key=lambda value: value["id"])
        if any(item["status"] != "covered" for item in normalized):
            raise RuntimeError("acceptance closure is partial or missing")
        return normalized

    def reopen_convergence(
        self,
        *,
        authorization_ref: str,
        authorization_text_sha256: str,
        reason: str,
        pr_ref: str,
        user_message_id: str,
        base_ref: str | None = None,
        head_sha: str | None = None,
    ) -> dict[str, Any]:
        normalized_reason = reason.strip()
        normalized_pr_ref = pr_ref.strip()
        normalized_message_id = user_message_id.strip()
        if not base_ref or not str(base_ref).strip():
            raise RuntimeError("convergence reopen requires the current base ref")
        explicit_reopen_language = (
            (
                "continue current pr" in normalized_reason.lower()
                and (
                    "reopen" in normalized_reason.lower()
                    or "explicit owner approval" in normalized_reason.lower()
                )
            )
            or ("继续当前" in normalized_reason and "重开" in normalized_reason)
        )
        if (
            not re.fullmatch(r"owner:[A-Za-z0-9-]+(?::[^\s:]+)?", authorization_ref)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", authorization_text_sha256)
            or hashlib.sha256(normalized_reason.encode("utf-8")).hexdigest().lower()
            != authorization_text_sha256.lower()
            or authorization_ref not in {
                f"owner:{normalized_message_id}",
                f"owner:{authorization_ref.split(':')[1]}:{normalized_message_id}"
                if authorization_ref.count(":") == 2
                else "",
            }
            or not explicit_reopen_language
            or not re.fullmatch(
                r"(?:PR#\d+|[^\s/]+/[^\s#]+#\d+|https?://[^\s]+/pulls?/\d+)",
                normalized_pr_ref,
            )
        ):
            raise RuntimeError(
                "convergence reopen requires explicit owner authorization, PR ref, "
                "user message id, matching text digest, and explicit reopen reason"
            )
        if self.repo is None:
            raise RuntimeError("convergence reopen requires a repository-bound ledger")
        actual_head, _ = require_clean_current_head(self.repo, head_sha)
        resolved_base = git_commit(self.repo, base_ref)
        identity = stable_hash(["convergence-reopen", actual_head, resolved_base, authorization_ref])
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                locked_head, _ = require_clean_current_head(self.repo, head_sha)
                locked_base = git_commit(self.repo, base_ref)
                if locked_head != actual_head or locked_base != resolved_base:
                    raise RuntimeError(
                        "convergence reopen inputs changed; refresh base/head and retry"
                    )
                ledger = self.read()
                self._require_active(ledger)
                review = self._review_state(ledger)
                if review.get("active_wave_id"):
                    raise RuntimeError("cannot reopen convergence while a review wave is active")
                consumed_message_ids = set(review.get("authorization_message_ids", []))
                if normalized_message_id in consumed_message_ids:
                    raise RuntimeError("convergence reopen user message id was already consumed")
                previous_base = ledger.get("base_sha")
                previous_head = ledger.get("head_sha")
                if not isinstance(previous_base, str) or not isinstance(previous_head, str):
                    raise RuntimeError("convergence reopen ledger inputs are invalid")
                inputs_rebound = (
                    resolved_base != previous_base or actual_head != previous_head
                )
                if inputs_rebound:
                    if (
                        resolved_base == previous_base
                        or actual_head == previous_head
                        or not git_is_ancestor(self.repo, previous_base, resolved_base)
                    ):
                        raise RuntimeError(
                            "convergence reopen inputs are not a rebased current PR"
                        )
                    if not git_rebased_candidate_matches(
                        self.repo,
                        previous_base,
                        previous_head,
                        resolved_base,
                        actual_head,
                    ):
                        raise RuntimeError(
                            "convergence reopen rebase changed the candidate delta"
                        )
                if (
                    not review.get("epochs")
                    or review.get("active_epoch_id")
                    != review["epochs"][-1].get("epoch_id")
                    or review["epochs"][-1].get("status") != "blocked"
                    or ledger.get("convergence", {}).get("state") != "NON_CONVERGENT"
                ):
                    raise RuntimeError("convergence reopen requires a blocked review epoch")
                bound_pr_ref = review.get("pr_ref")
                if not bound_pr_ref:
                    raise RuntimeError(
                        "convergence reopen requires a PR ref bound during flow initialization"
                    )
                if bound_pr_ref != normalized_pr_ref:
                    raise RuntimeError("convergence reopen PR ref does not match the active PR")
                if bound_pr_ref:
                    live_pr_facts = gh_pr_binding_facts(
                        self.repo,
                        normalized_pr_ref,
                        error_message="convergence reopen requires live PR base and head facts",
                    )
                    if (
                        live_pr_facts["base_sha"] != resolved_base
                        or live_pr_facts["head_sha"] != actual_head
                        or (
                            not inputs_rebound
                            and review.get("pr_base_sha") is not None
                            and live_pr_facts["base_sha"] != review.get("pr_base_sha")
                        )
                        or (
                            not inputs_rebound
                            and review.get("pr_head_sha") is not None
                            and live_pr_facts["head_sha"] != review.get("pr_head_sha")
                        )
                    ):
                        raise RuntimeError("convergence reopen PR facts do not match the current flow")
                    authenticated_user = gh_authenticated_user(self.repo)
                    if authorization_ref != f"owner:{authenticated_user}:{normalized_message_id}":
                        raise RuntimeError(
                            "convergence reopen authorization is not issued by the authenticated owner"
                        )
                if inputs_rebound:
                    blocked_epoch = review["epochs"][-1]
                    blocked_epoch.update(
                        {
                            "evidence_state": "input_stale",
                            "stale_reason": "base_advanced",
                            "stale_base_sha": resolved_base,
                            "stale_head_sha": actual_head,
                        }
                    )
                    ledger["base_sha"] = resolved_base
                    ledger["head_sha"] = actual_head
                    review["pr_base_sha"] = resolved_base
                    review["pr_head_sha"] = actual_head
                    ledger.setdefault("events", []).append(
                        {
                            "type": "convergence_reopen_inputs_rebound",
                            "from_base_sha": previous_base,
                            "to_base_sha": resolved_base,
                            "from_head_sha": previous_head,
                            "to_head_sha": actual_head,
                            "patch_fingerprint": git_patch_fingerprint(
                                self.repo, previous_base, previous_head
                            ),
                            "reason": "owner_authorized_reopen_after_base_advance",
                            "at": now(),
                        }
                    )
                epoch_number = int(review.get("next_epoch", 1))
                epoch_id = stable_hash(
                    [ledger["run_id"], "epoch", epoch_number, actual_head, ledger["base_sha"]]
                )[:16]
                epoch = {
                    "epoch_id": epoch_id,
                    "number": epoch_number,
                    "base_sha": ledger["base_sha"],
                    "start_head_sha": actual_head,
                    "status": "active",
                    "repair_rounds_used": 0,
                    "risk_arbitration_used": False,
                    "blocker_history": [],
                    "arbitration_history": [],
                    "invariants": list(review.get("cumulative", {}).get("invariants", [])),
                    "waves": [],
                    "permits": [],
                    "authorization": {
                        "kind": "owner-explicit-reopen",
                        "ref": authorization_ref,
                        "text_sha256": authorization_text_sha256,
                        "reason": normalized_reason,
                        "reason_sha256": hashlib.sha256(
                            normalized_reason.encode("utf-8")
                        ).hexdigest(),
                        "pr_ref": normalized_pr_ref,
                        "user_message_id": normalized_message_id,
                        "start_head_sha": actual_head,
                        "at": now(),
                    },
                }
                review["epochs"].append(epoch)
                review["next_epoch"] = epoch_number + 1
                review["active_epoch_id"] = epoch_id
                review.setdefault("authorization_message_ids", []).append(
                    normalized_message_id
                )
                ledger["convergence"] = {
                    "state": "pending",
                    "round": 0,
                    "repair_round": 0,
                    "diagnostic_used": False,
                    "blockers": [],
                }
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"epoch": epoch}

    def _resolve_log_path(
        self, log_path: str | None, identity: str, attempt: int
    ) -> Path:
        logs_root = (self.root / "logs").resolve()
        identity_root = (logs_root / identity / f"attempt-{attempt}").resolve()
        relative = Path(log_path) if log_path else Path("command.log")
        if relative.is_absolute():
            raise RuntimeError(
                "log path must be relative to the execution identity log directory"
            )
        resolved = (identity_root / relative).resolve()
        if not resolved.is_relative_to(identity_root):
            raise RuntimeError("log path escapes the execution identity log directory")
        return resolved

    @contextmanager
    def _exclusive_execution(self, identity: str) -> Iterator[None]:
        with self._shared_lifecycle(), self._exclusive_identity(identity):
            yield

    @contextmanager
    def _exclusive_finalization(self, identity: str) -> Iterator[None]:
        """Keep terminal writers out while a finalization revalidates evidence."""
        self.root.mkdir(parents=True, exist_ok=True)
        # Serialize finalizers for one wave before taking a shared lifecycle
        # lock. A competing finalizer must not retain a shared lock while it
        # waits for this identity, or the active finalizer cannot upgrade.
        with self._exclusive_identity(identity):
            with (self.root / "execution-lifecycle.lock").open("a+b") as lifecycle_handle:
                fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_SH)
                previous_handle = getattr(self._finalization_lifecycle, "handle", None)
                self._finalization_lifecycle.handle = lifecycle_handle
                try:
                    yield
                finally:
                    if previous_handle is None:
                        del self._finalization_lifecycle.handle
                    else:
                        self._finalization_lifecycle.handle = previous_handle
                    fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_UN)

    @contextmanager
    def _exclusive_identity(self, identity: str) -> Iterator[None]:
        locks_root = self.root / "locks"
        locks_root.mkdir(parents=True, exist_ok=True)
        identity_path = locks_root / f"{identity}.lock"
        with identity_path.open("a+b") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)

    @contextmanager
    def _shared_lifecycle(self) -> Iterator[None]:
        """Coordinate ordinary ledger writers with terminal revalidation."""
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "execution-lifecycle.lock").open("a+b") as lifecycle_handle:
            fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_SH)
            try:
                yield
            finally:
                fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_UN)

    @contextmanager
    def _exclusive_lifecycle(self) -> Iterator[None]:
        """Isolate terminal review sealing while the ledger lock is released."""
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "execution-lifecycle.lock").open("a+b") as lifecycle_handle:
            fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _upgrade_finalization_lifecycle(lifecycle_handle: Any) -> None:
        fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_EX)

    @contextmanager
    def _exclusive_ledger_update(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "ledger.lock").open("a+b") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            previous_handle = self._ledger_lock_handle
            self._ledger_lock_handle = lock_handle
            try:
                yield
            finally:
                self._ledger_lock_handle = previous_handle
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)

    @contextmanager
    def _release_ledger_lock_for_revalidation(
        self, ledger: dict[str, Any], *, changed_error: str
    ) -> Iterator[None]:
        """Run runtime/Git reads without serializing unrelated ledger writers."""
        lock_handle = self._ledger_lock_handle
        if lock_handle is None:
            yield
            return
        expected = json.dumps(ledger, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        self._ledger_lock_handle = None
        try:
            yield
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            self._ledger_lock_handle = lock_handle
            current = json.dumps(
                self.read(), ensure_ascii=True, sort_keys=True, separators=(",", ":")
            )
            if current != expected:
                raise RuntimeError(changed_error)

    @contextmanager
    def _terminal_seal_locks(
        self, ledger: dict[str, Any], *, changed_error: str
    ) -> Iterator[None]:
        """Upgrade a short mutation into a rollback-safe terminal seal.

        The active finalizer holds a lifecycle shared lock throughout
        revalidation. Releasing the ledger lock before upgrading that same
        handle avoids lock inversion with terminal writers; an exact snapshot
        comparison rejects any ordinary writer that wins the upgrade gap.
        """
        lock_handle = self._ledger_lock_handle
        if lock_handle is None:
            raise RuntimeError("terminal sealing requires the ledger lock")
        lifecycle_handle = getattr(self._finalization_lifecycle, "handle", None)
        if lifecycle_handle is None:
            raise RuntimeError("terminal sealing requires the finalization lifecycle lock")
        expected = json.dumps(ledger, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        self._ledger_lock_handle = None
        upgraded = False
        try:
            self._upgrade_finalization_lifecycle(lifecycle_handle)
            upgraded = True
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            self._ledger_lock_handle = lock_handle
            current = json.dumps(
                self.read(), ensure_ascii=True, sort_keys=True, separators=(",", ":")
            )
            if current != expected:
                raise RuntimeError(changed_error)
            yield
        finally:
            if self._ledger_lock_handle is None:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
                self._ledger_lock_handle = lock_handle
            if upgraded:
                fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_SH)

    def init(
        self,
        run_id: str | None,
        flow_type: str,
        base_sha: str,
        head_sha: str,
        pr_ref: str | None = None,
        acceptance_manifest_file: str | None = None,
    ) -> dict[str, Any]:
        with self._shared_lifecycle():
            with self._exclusive_ledger_update():
                return self._init_locked(
                    run_id, flow_type, base_sha, head_sha, pr_ref, acceptance_manifest_file
                )

    def _init_locked(
        self,
        run_id: str | None,
        flow_type: str,
        base_sha: str,
        head_sha: str,
        pr_ref: str | None = None,
        acceptance_manifest_file: str | None = None,
    ) -> dict[str, Any]:
        manifest = self._load_acceptance_manifest(acceptance_manifest_file)
        normalized_pr_ref = pr_ref.strip() if pr_ref else None
        if normalized_pr_ref and not re.fullmatch(
            r"(?:PR#\d+|[^\s/]+/[^\s#]+#\d+|https?://[^\s]+/pulls?/\d+)",
            normalized_pr_ref,
        ):
            raise RuntimeError("flow initialization PR ref is invalid")
        if self.path.is_file():
            raw_bytes = self.path.read_bytes()
            raw_current = json.loads(raw_bytes.decode("utf-8"))
            current = normalize_ledger(json.loads(json.dumps(raw_current)))
            if current.get("state") == "active":
                requested = {
                    "flow_type": flow_type,
                    "base_sha": base_sha,
                    "head_sha": head_sha,
                }
                mismatches = [
                    key for key, value in requested.items() if current.get(key) != value
                ]
                if run_id is not None and current.get("run_id") != run_id:
                    mismatches.append("run_id")
                current_pr_ref = self._review_state(current).get("pr_ref")
                if normalized_pr_ref is not None and current_pr_ref != normalized_pr_ref:
                    mismatches.append("pr_ref")
                current_manifest = current.get("acceptance_manifest")
                if manifest is not None and current_manifest != manifest:
                    mismatches.append("acceptance_manifest")
                if mismatches:
                    raise RuntimeError(
                        "active flow receipt identity mismatch: "
                        + ", ".join(sorted(mismatches))
                    )
                return current
            # Archive the original bytes for v1 compatibility; lazy schema
            # upgrade is applied only to the next active write.
            self._archive_bytes(raw_bytes, raw_current["run_id"])
        candidate_run_id = run_id or str(uuid.uuid4())
        candidate_archive = self.root / "runs" / f"{stable_hash(candidate_run_id)}.json"
        if candidate_archive.exists():
            raise RuntimeError(f"run_id is already archived: {candidate_run_id}")
        payload = {
            "schema_version": FLOW_SCHEMA_VERSION,
            "run_id": candidate_run_id,
            "flow_type": flow_type,
            "base_sha": base_sha,
            "head_sha": head_sha,
            "state": "active",
            "created_at": now(),
            "updated_at": now(),
            "command_budget_seconds": DEFAULT_COMMAND_BUDGET_SECONDS,
            "retry_budget_per_identity": 1,
            "convergence": {
                "state": "pending",
                "round": 0,
                "repair_round": 0,
                "diagnostic_used": False,
                "blockers": [],
            },
            "review": default_review_state(),
            "acceptance_manifest": manifest,
            "acceptance_required": True,
            "receipts": [],
            "events": [],
            "review_assessment": pending_review_assessment(),
            "review_mode": "assessment-required",
            "repository_binding": None,
            "provider_facts": None,
        }
        payload["review"]["pr_ref"] = normalized_pr_ref
        self._write(payload)
        return payload

    def _load_acceptance_manifest(self, manifest_file: str | None) -> dict[str, Any] | None:
        if not manifest_file:
            return None
        path = Path(manifest_file)
        if not path.is_absolute() and self.repo is not None:
            path = (self.repo / path).resolve()
        if not path.is_file():
            raise RuntimeError("acceptance manifest file does not exist")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise RuntimeError("acceptance manifest file is not valid JSON") from error
        return normalize_acceptance_manifest(payload)

    def register_acceptance_manifest(self, manifest_file: str) -> dict[str, Any]:
        manifest = self._load_acceptance_manifest(manifest_file)
        assert manifest is not None
        identity = stable_hash(["acceptance-manifest", manifest])
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                ledger = self.read()
                self._require_active(ledger)
                existing = ledger.get("acceptance_manifest")
                if existing is not None:
                    if existing == manifest:
                        return {"reused": True, "acceptance_manifest": existing}
                    raise RuntimeError("acceptance manifest is immutable once registered")
                ledger["acceptance_manifest"] = manifest
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"reused": False, "acceptance_manifest": manifest}

    def bind_pr(self, pr_ref: str) -> dict[str, Any]:
        normalized_pr_ref = pr_ref.strip()
        if not PR_REF_PATTERN.fullmatch(normalized_pr_ref):
            raise RuntimeError("PR binding ref is invalid")
        if self.repo is None:
            raise RuntimeError("PR binding requires a repository-bound ledger")
        actual_head, _ = require_clean_current_head(self.repo)
        try:
            binding, _ = resolve_repository_for_pr(self.repo, normalized_pr_ref)
        except Exception as error:
            raise RuntimeError("PR binding repository could not be resolved") from error
        facts = gh_pr_binding_facts(self.repo, normalized_pr_ref)
        if facts["head_sha"] != actual_head:
            raise RuntimeError("PR binding head does not match the current HEAD")
        identity = stable_hash(["bind-pr", normalized_pr_ref, actual_head, facts["base_sha"]])
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                locked_head, _ = require_clean_current_head(self.repo)
                locked_binding, _ = resolve_repository_for_pr(self.repo, normalized_pr_ref)
                locked_facts = gh_pr_binding_facts(self.repo, normalized_pr_ref)
                locked_pr_base_ref_identity = gh_pr_base_ref_identity(
                    self.repo, normalized_pr_ref
                )
                if locked_head != actual_head or locked_facts != facts or locked_binding != binding:
                    raise RuntimeError("PR binding facts changed; refresh and retry")
                ledger = self.read()
                self._require_active(ledger)
                review = self._review_state(ledger)
                bound_pr_ref = review.get("pr_ref")
                if bound_pr_ref and bound_pr_ref != normalized_pr_ref:
                    raise RuntimeError("PR binding ref does not match the active PR")
                stored_pr_base_ref_identity = review.get("pr_base_ref_identity")
                if (
                    stored_pr_base_ref_identity is not None
                    and locked_pr_base_ref_identity is not None
                    and stored_pr_base_ref_identity != locked_pr_base_ref_identity
                ):
                    raise RuntimeError("PR binding target ref does not match the active PR")
                if facts["base_sha"] != ledger.get("base_sha") or locked_head != ledger.get(
                    "head_sha"
                ):
                    previous_base = ledger.get("base_sha")
                    previous_head = ledger.get("head_sha")
                    ledger["base_sha"] = facts["base_sha"]
                    ledger["head_sha"] = locked_head
                    ledger["events"].append(
                        {
                            "type": "pr_binding_inputs_advanced",
                            "from_base_sha": previous_base,
                            "to_base_sha": facts["base_sha"],
                            "from_head_sha": previous_head,
                            "to_head_sha": locked_head,
                            "pr_ref": normalized_pr_ref,
                            "at": now(),
                        }
                    )
                review["pr_ref"] = normalized_pr_ref
                review["pr_base_sha"] = facts["base_sha"]
                review["pr_head_sha"] = facts["head_sha"]
                if locked_pr_base_ref_identity is not None:
                    review["pr_base_ref_identity"] = locked_pr_base_ref_identity
                review["pr_bound_at"] = review.get("pr_bound_at") or now()
                ledger["repository_binding"] = binding.as_dict()
                ledger["provider_facts"] = {"pr": facts}
                ledger["events"].append(
                    {
                        "type": "pr_bound",
                        "pr_ref": normalized_pr_ref,
                        "base_sha": facts["base_sha"],
                        "head_sha": facts["head_sha"],
                        "at": now(),
                    }
                )
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"pr_ref": normalized_pr_ref, "facts": facts}

    def assess_review_necessity(self, tier: int, reason: str) -> dict[str, Any]:
        """Record the Agent's non-prescriptive review necessity decision."""
        if type(tier) is not int or tier not in REVIEW_NECESSITY_TIERS:
            raise RuntimeError("review assessment tier must be one of 1, 2, 3, or 4")
        normalized_reason = reason.strip()
        if not normalized_reason:
            raise RuntimeError("review assessment requires a non-empty Agent rationale")
        if self.repo is None:
            raise RuntimeError("review assessment requires a repository-bound ledger")
        actual_head, _ = require_clean_current_head(self.repo)
        identity = stable_hash(["review-assess", actual_head, tier, normalized_reason])
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                locked_head, _ = require_clean_current_head(self.repo)
                if locked_head != actual_head:
                    raise RuntimeError("review assessment inputs changed; refresh and retry")
                ledger = self.read()
                self._require_active(ledger)
                if ledger.get("flow_type") not in DIRECT_REVIEW_FLOW_TYPES:
                    raise RuntimeError("review assessment is only used by direct delivery flows")
                assessment = ledger["review_assessment"]
                review = self._review_state(ledger)
                if review.get("pr_ref"):
                    raise RuntimeError("review assessment is locked once bound to a PR")
                if review_convergence_started(review):
                    raise RuntimeError("review assessment is locked once review convergence starts")
                if assessment.get("source") == "pre-tier-migration":
                    raise RuntimeError(
                        "pre-tier direct review assessment is immutable for the active flow"
                    )
                previous_assessment = None
                if assessment.get("tier") is not None:
                    previous_assessment = json.loads(json.dumps(assessment))
                    ledger.setdefault("review_assessment_history", []).append(
                        previous_assessment
                    )
                assessment.update(
                    {
                        "tier": tier,
                        "reason": normalized_reason,
                        "assessed_at": now(),
                        "assessed_head_sha": actual_head,
                        "source": "agent-assessment",
                    }
                )
                ledger["review_mode"] = review_mode_for_tier(tier)
                ledger["events"].append(
                    {
                        "type": (
                            "review_necessity_reassessed"
                            if previous_assessment is not None
                            else "review_necessity_assessed"
                        ),
                        "tier": tier,
                        "reason": normalized_reason,
                        "head_sha": actual_head,
                        "at": now(),
                    }
                )
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"review_assessment": assessment, "review_mode": ledger["review_mode"]}

    def _load_post_merge_evidence(self, evidence_file: str) -> dict[str, Any]:
        path = Path(evidence_file)
        if not path.is_absolute() and self.repo is not None:
            path = (self.repo / path).resolve()
        if not path.is_file():
            raise RuntimeError("post-merge evidence file does not exist")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("post-merge evidence file is not valid JSON") from error
        return normalize_post_merge_evidence(payload)

    @staticmethod
    def _post_merge_receipt(
        ledger: dict[str, Any], evidence: dict[str, Any]
    ) -> dict[str, Any] | None:
        identity = stable_hash(
            [
                "post-merge",
                evidence["pr_ref"],
                evidence["base_sha"],
                evidence["head_sha"],
                evidence["merge_sha"],
            ]
        )
        for receipt in ledger.get("receipts", []):
            if isinstance(receipt, dict) and receipt.get("kind") == "post-merge":
                if receipt.get("identity") == identity:
                    return receipt
        return None

    def record_post_merge(self, evidence_file: str) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("post-merge receipt requires a repository-bound ledger")
        evidence = self._load_post_merge_evidence(evidence_file)
        with self._shared_lifecycle():
            with self._exclusive_ledger_update():
                return self._record_post_merge_locked(evidence)

    def _record_post_merge_locked(self, evidence: dict[str, Any]) -> dict[str, Any]:
        ledger = self.read()
        self._require_active(ledger)
        review = self._review_state(ledger)
        pr_ref = review.get("pr_ref")
        if not pr_ref or pr_ref != evidence["pr_ref"]:
            raise RuntimeError("post-merge receipt PR does not match the bound PR")
        try:
            binding, _ = resolve_repository_for_pr(self.repo, str(pr_ref))
        except Exception as error:
            raise RuntimeError("post-merge receipt repository binding is unavailable") from error
        stored_binding = ledger.get("repository_binding")
        if stored_binding is not None:
            try:
                _require_repository_binding_match(stored_binding, binding)
            except RuntimeError as error:
                raise RuntimeError(
                    "post-merge receipt repository binding does not match the ledger"
                ) from error
        live = gh_pr_merged_facts(
            self.repo,
            pr_ref,
            expected_repository_binding=binding.as_dict(),
        )
        if any(
            live[key] != evidence[key]
            for key in ("base_sha", "head_sha", "merge_sha", "merged_at")
        ):
            raise RuntimeError("post-merge head/base/merge facts changed; refresh and retry")
        if stored_binding is None:
            ledger["repository_binding"] = binding.as_dict()
        binding_matches_ledger = not (
            review.get("pr_base_sha") != ledger.get("base_sha")
            or review.get("pr_head_sha") != ledger.get("head_sha")
        )
        evidence_matches_ledger = (
            evidence["base_sha"] == ledger.get("base_sha")
            and evidence["head_sha"] == ledger.get("head_sha")
        )
        if not binding_matches_ledger or not evidence_matches_ledger:
            previous_base = ledger.get("base_sha")
            previous_head = ledger.get("head_sha")
            ledger["base_sha"] = evidence["base_sha"]
            ledger["head_sha"] = evidence["head_sha"]
            review["pr_base_sha"] = evidence["base_sha"]
            review["pr_head_sha"] = evidence["head_sha"]
            ledger["events"].append(
                {
                    "type": "post_merge_binding_inputs_recovered",
                    "pr_ref": pr_ref,
                    "from_base_sha": previous_base,
                    "to_base_sha": evidence["base_sha"],
                    "from_head_sha": previous_head,
                    "to_head_sha": evidence["head_sha"],
                    "at": now(),
                }
            )
        existing = self._post_merge_receipt(ledger, evidence)
        if existing is not None:
            if (
                existing.get("pr_ref") != evidence["pr_ref"]
                or existing.get("base_sha") != evidence["base_sha"]
                or existing.get("head_sha") != evidence["head_sha"]
                or existing.get("merge_sha") != evidence["merge_sha"]
                or existing.get("merged_at") != evidence["merged_at"]
                or existing.get("finality") != evidence["finality"]
            ):
                raise RuntimeError("post-merge receipt is immutable for this merge identity")
            ledger["events"].append(
                {"type": "reuse", "receipt_id": existing["receipt_id"], "at": now()}
            )
            ledger["updated_at"] = now()
            self._write(ledger)
            return {"reused": True, "receipt": existing}
        identity = stable_hash(
            [
                "post-merge",
                evidence["pr_ref"],
                evidence["base_sha"],
                evidence["head_sha"],
                evidence["merge_sha"],
            ]
        )
        receipt = {
            "receipt_id": stable_hash([ledger["run_id"], identity, len(ledger["receipts"])]),
            "identity": identity,
            "kind": "post-merge",
            **evidence,
            "recorded_at": now(),
        }
        ledger["receipts"].append(receipt)
        ledger["events"].append(
            {
                "type": "post_merge_recorded",
                "receipt_id": receipt["receipt_id"],
                "pr_ref": evidence["pr_ref"],
                "merge_sha": evidence["merge_sha"],
                "at": now(),
            }
        )
        ledger["updated_at"] = now()
        self._write(ledger)
        return {"reused": False, "receipt": receipt}

    def _validate_post_merge_receipt(
        self, ledger: dict[str, Any], review: dict[str, Any]
    ) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("complete requires a repository-bound merged PR")
        pr_ref = review.get("pr_ref")
        if not isinstance(pr_ref, str) or not pr_ref:
            raise RuntimeError("complete requires a post-merge receipt")
        candidates = [
            receipt
            for receipt in ledger.get("receipts", [])
            if isinstance(receipt, dict)
            and receipt.get("kind") == "post-merge"
            and receipt.get("pr_ref") == pr_ref
        ]
        if len(candidates) != 1:
            raise RuntimeError("complete requires a post-merge receipt")
        receipt = candidates[0]
        try:
            evidence = normalize_post_merge_evidence(
                {
                    key: receipt.get(key)
                    for key in (
                        "pr_ref",
                        "head_sha",
                        "base_sha",
                        "merge_sha",
                        "merged_at",
                        "finality",
                    )
                }
            )
        except RuntimeError as error:
            raise RuntimeError("complete requires an untampered post-merge receipt") from error
        if (
            evidence["base_sha"] != ledger.get("base_sha")
            or evidence["head_sha"] != ledger.get("head_sha")
            or review.get("pr_base_sha") != evidence["base_sha"]
            or review.get("pr_head_sha") != evidence["head_sha"]
        ):
            raise RuntimeError("complete requires a post-merge receipt matching the PR identity")
        repository_binding = ledger.get("repository_binding")
        if _repository_binding_identity(repository_binding) is None:
            raise RuntimeError("complete requires a post-merge receipt matching the repository binding")
        live = gh_pr_merged_facts(
            self.repo,
            pr_ref,
            error_message="complete requires live MERGED PR facts",
            expected_repository_binding=repository_binding,
        )
        if any(
            live[key] != evidence[key]
            for key in ("base_sha", "head_sha", "merge_sha", "merged_at")
        ):
            raise RuntimeError("complete requires a post-merge receipt matching live merge facts")
        return receipt

    def record_validation(
        self,
        command: str,
        toolchain_fingerprint: str,
        input_fingerprint: str,
        exit_code: int,
        log_path: str,
        *,
        kind: str = "validation",
        head_sha: str | None = None,
        duration_seconds: int = 0,
        known_long: bool = False,
        retry_state_fingerprint: str | None = None,
        timed_out: bool = False,
        preflight_only: bool = False,
        execution_verified: bool = False,
        observed_tree: str | None = None,
        post_execution_clean: bool = True,
        log_sha256: str | None = None,
        input_paths: Iterable[str] = (),
        acceptance_evidence: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        with self._shared_lifecycle():
            with self._exclusive_ledger_update():
                return self._record_validation_locked(
                    command,
                    toolchain_fingerprint,
                    input_fingerprint,
                    exit_code,
                    log_path,
                    kind=kind,
                    head_sha=head_sha,
                    duration_seconds=duration_seconds,
                    known_long=known_long,
                    retry_state_fingerprint=retry_state_fingerprint,
                    timed_out=timed_out,
                    preflight_only=preflight_only,
                    execution_verified=execution_verified,
                    observed_tree=observed_tree,
                    post_execution_clean=post_execution_clean,
                    log_sha256=log_sha256,
                    input_paths=input_paths,
                    acceptance_evidence=acceptance_evidence,
                )

    def _record_validation_locked(
        self,
        command: str,
        toolchain_fingerprint: str,
        input_fingerprint: str,
        exit_code: int,
        log_path: str,
        *,
        kind: str = "validation",
        head_sha: str | None = None,
        duration_seconds: int = 0,
        known_long: bool = False,
        retry_state_fingerprint: str | None = None,
        timed_out: bool = False,
        preflight_only: bool = False,
        execution_verified: bool = False,
        observed_tree: str | None = None,
        post_execution_clean: bool = True,
        log_sha256: str | None = None,
        input_paths: Iterable[str] = (),
        acceptance_evidence: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if kind != "validation":
            raise RuntimeError("validation receipts require kind=validation")
        ledger = self.read()
        self._require_active(ledger)
        requested_head = head_sha or ledger["head_sha"]
        declared_input_fingerprint = input_fingerprint
        declared_input_paths = normalize_input_paths(input_paths)
        acceptance_evidence = normalize_acceptance_evidence(acceptance_evidence)
        manifest = ledger.get("acceptance_manifest")
        validate_acceptance_evidence(manifest, acceptance_evidence)
        if self.repo is not None:
            if execution_verified and observed_tree is not None:
                requested_head = git_commit(self.repo, head_sha or requested_head)
                tree = observed_tree
            else:
                requested_head, tree = require_clean_current_head(self.repo, head_sha)
            input_fingerprint = stable_hash(
                {"declared_scope": declared_input_fingerprint, "git_tree": tree}
            )
            if not preflight_only and not execution_verified:
                raise RuntimeError(
                    "repository-bound validation results must be produced by run_validation"
                )
        proof_key = validation_proof_key(
            command,
            toolchain_fingerprint,
            declared_input_fingerprint,
            declared_input_paths,
        )
        identity = validation_execution_identity(
            proof_key, input_fingerprint, acceptance_evidence
        )
        passed_receipts = [
            receipt
            for receipt in ledger["receipts"]
            if isinstance(receipt, dict) and receipt.get("exit_code") == 0
        ]
        for receipt in reversed(passed_receipts):
            stored_proof_key = receipt.get("proof_key", receipt.get("identity"))
            legacy_match = (
                stored_proof_key != proof_key
                and legacy_validation_receipt_matches(
                    receipt,
                    command=command,
                    toolchain_fingerprint=toolchain_fingerprint,
                    declared_input_fingerprint=declared_input_fingerprint,
                    declared_input_paths=declared_input_paths,
                    effective_inputs=input_fingerprint,
                    acceptance_evidence=acceptance_evidence,
                )
            )
            if stored_proof_key != proof_key and not legacy_match:
                continue
            if receipt.get("acceptance_evidence", []) != acceptance_evidence:
                continue
            if receipt["head_sha"] == requested_head:
                if receipt.get("identity") == identity or legacy_match:
                    reused_receipt = receipt
                else:
                    continue
            else:
                attestation = next(
                    (
                        item
                        for item in ledger["receipts"]
                        if item.get("kind") == "attestation"
                        and item.get("source_receipt_id") == receipt["receipt_id"]
                        and item.get("head_sha") == requested_head
                    ),
                    None,
                )
                if attestation is not None:
                    reused_receipt = attestation
                elif self.repo is not None:
                    delta = self.classify_git_delta(
                        receipt["head_sha"], requested_head, require_current=True
                    )
                    if delta["classification"]["reusable"]:
                        raise RuntimeError(
                            "passed receipt is bound to another head; "
                            "record a current-head attestation before reuse"
                        )
                    continue
                else:
                    continue
            event = {
                "type": "reuse",
                "receipt_id": reused_receipt["receipt_id"],
                "at": now(),
            }
            ledger["events"].append(event)
            ledger["updated_at"] = now()
            self._write(ledger)
            return {"reused": True, "receipt": reused_receipt}
        failed_attempts = [
            receipt
            for receipt in ledger["receipts"]
            if receipt.get("exit_code") != 0
            and (
                receipt.get("identity") == identity
                or legacy_validation_receipt_matches(
                    receipt,
                    command=command,
                    toolchain_fingerprint=toolchain_fingerprint,
                    declared_input_fingerprint=declared_input_fingerprint,
                    declared_input_paths=declared_input_paths,
                    effective_inputs=input_fingerprint,
                    acceptance_evidence=acceptance_evidence,
                )
            )
        ]
        if failed_attempts:
            if len(failed_attempts) >= 2:
                raise RuntimeError("transient retry budget is exhausted for this identity")
            if failed_attempts[-1]["exit_code"] not in TRANSIENT_VALIDATION_EXIT_CODES:
                raise RuntimeError("validation failure is not classified as transient")
            if not retry_state_fingerprint:
                raise RuntimeError("transient retry requires an observable state change fingerprint")
            if retry_state_fingerprint == failed_attempts[-1].get(
                "retry_state_fingerprint"
            ):
                raise RuntimeError(
                    "transient retry state fingerprint is unchanged from the failed attempt"
                )
        if (
            duration_seconds > ledger["command_budget_seconds"]
            and not known_long
            and not timed_out
        ):
            raise RuntimeError(
                f"command exceeded the {ledger['command_budget_seconds']}-second hard budget"
            )
        if preflight_only:
            return {
                "reused": False,
                "ready": True,
                "identity": identity,
                "proof_key": proof_key,
                "attempt": len(failed_attempts) + 1,
            }
        receipt = {
            "receipt_id": stable_hash([ledger["run_id"], identity, len(ledger["receipts"])]),
            "identity": identity,
            "proof_key": proof_key,
            "kind": kind,
            "head_sha": requested_head,
            "command": command,
            "toolchain_fingerprint": toolchain_fingerprint,
            "declared_input_fingerprint": declared_input_fingerprint,
            "declared_input_paths": declared_input_paths,
            "input_fingerprint": input_fingerprint,
            "exit_code": exit_code,
            "log_path": log_path,
            "log_sha256": log_sha256,
            "duration_seconds": duration_seconds,
            "known_long": known_long,
            "timed_out": timed_out,
            "post_execution_clean": post_execution_clean,
            "retry_state_fingerprint": retry_state_fingerprint,
            "acceptance_evidence": acceptance_evidence,
            "recorded_at": now(),
        }
        ledger["receipts"].append(receipt)
        candidate_head_advanced = False
        review = self._review_state(ledger)
        candidate_is_current_clean_head = False
        if self.repo is not None and execution_verified and post_execution_clean:
            try:
                require_clean_current_head(self.repo, requested_head)
                candidate_is_current_clean_head = True
            except RuntimeError:
                candidate_is_current_clean_head = False
        if (
            execution_verified
            and exit_code == 0
            and post_execution_clean
            and candidate_is_current_clean_head
            and not review.get("pr_ref")
            and not review.get("epochs")
            and not review.get("active_wave_id")
            and ledger.get("head_sha") != requested_head
        ):
            previous_head = ledger["head_sha"]
            ledger["head_sha"] = requested_head
            ledger["events"].append(
                {
                    "type": "candidate_head_advanced",
                    "from_head_sha": previous_head,
                    "to_head_sha": requested_head,
                    "receipt_id": receipt["receipt_id"],
                    "at": now(),
                }
            )
            candidate_head_advanced = True
        ledger["updated_at"] = now()
        self._write(ledger)
        return {
            "reused": False,
            "retry": bool(failed_attempts),
            "candidate_head_advanced": candidate_head_advanced,
            "receipt": receipt,
        }

    def run_validation(
        self,
        command: str,
        toolchain_fingerprint: str,
        input_fingerprint: str,
        *,
        kind: str,
        head_sha: str | None = None,
        log_path: str | None = None,
        retry_state_fingerprint: str | None = None,
        input_paths: Iterable[str] = (),
        acceptance_evidence: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("command execution requires a repository-bound ledger")
        if kind != "validation":
            raise RuntimeError("validation runner only accepts kind=validation")
        acceptance_evidence = normalize_acceptance_evidence(acceptance_evidence)
        ledger = self.read()
        self._require_active(ledger)
        validate_acceptance_evidence(ledger.get("acceptance_manifest"), acceptance_evidence)
        actual_head, tree = require_clean_current_head(self.repo, head_sha)
        normalized_input_paths = normalize_input_paths(input_paths)
        proof_key = validation_proof_key(
            command,
            toolchain_fingerprint,
            input_fingerprint,
            normalized_input_paths,
        )
        effective_inputs = stable_hash(
            {"declared_scope": input_fingerprint, "git_tree": tree}
        )
        identity = validation_execution_identity(
            proof_key, effective_inputs, acceptance_evidence
        )
        with self._exclusive_execution(identity):
            return self._run_validation_locked(
                command,
                toolchain_fingerprint,
                input_fingerprint,
                kind=kind,
                head_sha=actual_head,
                log_path=log_path,
                retry_state_fingerprint=retry_state_fingerprint,
                input_paths=normalized_input_paths,
                acceptance_evidence=acceptance_evidence,
            )

    def record_subagent_review(
        self,
        *,
        review_profile: str,
        base_ref: str,
        review_model: str,
        review_effort: str,
        review_result_json: str,
        review_terminal_state: str = "completed",
        unavailability_classification: str | None = None,
        head_sha: str | None = None,
        wave_id: str | None = None,
        lane: str | None = None,
    ) -> dict[str, Any]:
        """Record a completed, read-only sub-agent review without launching a runner.

        The main flow supplies the sub-agent's structured terminal result in
        memory.  This helper never starts a model, reads a task transcript, or
        relies on child identity; it validates the result against the candidate
        diff and binds it to the clean current base/head.
        """
        if self.repo is None:
            raise RuntimeError("sub-agent review evidence requires a repository-bound ledger")
        if not wave_id or not lane:
            raise RuntimeError("sub-agent review evidence requires a review wave and lane")
        if review_terminal_state == "unavailable":
            if review_result_json.strip():
                raise RuntimeError("unavailable sub-agent review must not include a review result")
            if unavailability_classification != SUBAGENT_STARTUP_UNAVAILABLE:
                raise RuntimeError(
                    "unavailable sub-agent review requires explicit startup-unavailable classification"
                )
            return self.record_subagent_review_unavailable(
                review_profile=review_profile,
                base_ref=base_ref,
                review_model=review_model,
                review_effort=review_effort,
                unavailability_classification=unavailability_classification,
                head_sha=head_sha,
                wave_id=wave_id,
                lane=lane,
            )
        if review_terminal_state != "completed":
            raise RuntimeError("only completed or unavailable sub-agent review terminal states are accepted")
        if unavailability_classification is not None:
            raise RuntimeError("completed sub-agent review cannot declare unavailability")
        required = {
            "review profile": review_profile,
            "review model": review_model,
            "review effort": review_effort,
            "review result": review_result_json,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise RuntimeError("sub-agent review evidence is missing " + ", ".join(missing))
        review_result, findings = parse_review_result(review_result_json)
        actual_head, _ = require_clean_current_head(self.repo, head_sha)
        resolved_base = git_commit(self.repo, base_ref)
        validate_agent_finding_diff_locations(
            review_result, self.repo, resolved_base, actual_head
        )
        proof_key = f"{self.repo}:{actual_head}:{resolved_base}:{review_profile}"
        wave_proof_key = f"{proof_key}:{wave_id}:{lane}"
        result_sha256 = hashlib.sha256(
            json.dumps(review_result, ensure_ascii=True, sort_keys=True).encode("utf-8")
        ).hexdigest()
        identity = stable_hash(["sub-agent-review", wave_proof_key, result_sha256])
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                verified_head, _ = require_clean_current_head(self.repo, actual_head)
                if git_commit(self.repo, base_ref) != resolved_base:
                    raise RuntimeError("review base changed while waiting for sub-agent evidence")
                ledger = self.read()
                self._require_active(ledger)
                if not self._requires_current_review_proof(ledger):
                    raise RuntimeError("sub-agent review proof is only used by Tier 3/4 direct delivery")
                if ledger.get("base_sha") != resolved_base:
                    raise RuntimeError("review base differs from the ledger base")
                review = self._review_state(ledger)
                if review.get("active_wave_id") != wave_id:
                    raise RuntimeError("sub-agent review evidence is not bound to the active review wave")
                wave = self._review_wave(ledger, wave_id)
                if (
                    wave.get("state") != "open"
                    or wave.get("head_sha") != verified_head
                    or wave.get("base_sha") != resolved_base
                    or lane not in wave.get("lanes", {})
                ):
                    raise RuntimeError("sub-agent review evidence does not match its review wave")
                lane_state = wave["lanes"][lane]
                existing_receipt_id = lane_state.get("receipt_id")
                if not review_model_matches_lane(
                    lane_state.get("model", ""),
                    lane_state.get("effort", ""),
                    review_model,
                    review_effort,
                    enforce_direct=True,
                ):
                    raise RuntimeError("sub-agent review profile does not match its review lane")
                expected_profile = {
                    "initial": "pr-convergence",
                    "repair": "pr-convergence",
                    "risk-arbitration": "risk-arbitration",
                }[wave["stage"]]
                if review_profile != expected_profile:
                    raise RuntimeError("sub-agent review profile does not match its review wave stage")
                if not direct_wave_lane_profile_is_authorized(
                    ledger,
                    repo_path=self.repo,
                    head_sha=verified_head,
                    base_sha=resolved_base,
                    wave_id=wave_id,
                    lane=lane,
                    declared_model=lane_state["model"],
                    declared_effort=lane_state["effort"],
                    review_model=review_model,
                    review_effort=review_effort,
                ):
                    raise RuntimeError("sub-agent review lane fallback is not authorized")
                expected_profile_resolution = direct_review_profile_resolution(
                    lane_state["model"],
                    lane_state["effort"],
                    review_model,
                    review_effort,
                )
                receipt_id = stable_hash(
                    [ledger["run_id"], "sub-agent-review", wave_proof_key, result_sha256]
                )
                if existing_receipt_id:
                    existing = next(
                        (
                            item
                            for item in ledger.get("receipts", [])
                            if item.get("receipt_id") == existing_receipt_id
                        ),
                        None,
                    )
                    if not isinstance(existing, dict) or existing.get("receipt_id") != receipt_id:
                        raise RuntimeError("review lane already has a different recorded receipt")
                    try:
                        profile_resolution, existing_findings = self._rederive_current_review_receipt(
                            existing, wave_id=wave_id, lane=lane
                        )
                    except RuntimeError as error:
                        raise RuntimeError("review lane has an invalid recorded receipt") from error
                    if (
                        existing.get("kind") != "review"
                        or existing.get("head_sha") != verified_head
                        or existing.get("base_sha") != resolved_base
                        or existing.get("review_profile") != review_profile
                        or existing.get("review_model") != review_model
                        or existing.get("review_effort") != review_effort
                        or existing.get("review_result_sha256") != result_sha256
                        or existing.get("finding_fingerprints") != findings
                        or existing_findings != findings
                        or profile_resolution != expected_profile_resolution
                    ):
                        raise RuntimeError("review lane already has a different recorded receipt")
                    return {"reused": True, "receipt": existing}
                receipt = {
                    "receipt_id": receipt_id,
                    "kind": "review",
                    "review_receipt_schema": REVIEW_RECEIPT_SCHEMA_VERSION,
                    "proof_key": proof_key,
                    "wave_proof_key": wave_proof_key,
                    "head_sha": verified_head,
                    "base_sha": resolved_base,
                    "review_profile": review_profile,
                    "review_model": review_model,
                    "review_effort": review_effort,
                    "resolved_model": review_model,
                    "resolved_effort": review_effort,
                    "profile_resolution": expected_profile_resolution,
                    "profile_proof_status": "sub-agent-declared",
                    "review_execution_source": "sub-agent",
                    "provenance_boundary": "sub-agent-structured-result",
                    "evidence_source": "sub-agent-structured-result",
                    "terminal_state": "completed",
                    "wave_id": wave_id,
                    "lane": lane,
                    "finding_fingerprints": findings,
                    "review_result": review_result,
                    "review_result_sha256": result_sha256,
                    "review_findings": review_result["findings"],
                    "review_clear": review_is_clear(True, findings, review_result),
                    "overall_correctness": review_result["overall_correctness"],
                    "evidence_valid": True,
                    "post_execution_clean": True,
                    "exit_code": 0,
                    "recorded_at": now(),
                }
                ledger["receipts"].append(receipt)
                lane_state["receipt_id"] = receipt["receipt_id"]
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"reused": False, "receipt": receipt}

    def record_subagent_review_unavailable(
        self,
        *,
        review_profile: str,
        base_ref: str,
        review_model: str,
        review_effort: str,
        unavailability_classification: str,
        head_sha: str | None,
        wave_id: str,
        lane: str,
    ) -> dict[str, Any]:
        """Record a sub-agent startup-unavailable fact for the ordered fallback ladder."""
        if self.repo is None:
            raise RuntimeError("sub-agent review evidence requires a repository-bound ledger")
        if unavailability_classification != SUBAGENT_STARTUP_UNAVAILABLE:
            raise RuntimeError(
                "unavailable sub-agent review requires explicit startup-unavailable classification"
            )
        required = {
            "review profile": review_profile,
            "review model": review_model,
            "review effort": review_effort,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise RuntimeError("sub-agent review evidence is missing " + ", ".join(missing))
        actual_head, _ = require_clean_current_head(self.repo, head_sha)
        resolved_base = git_commit(self.repo, base_ref)
        proof_key = f"{self.repo}:{actual_head}:{resolved_base}:{review_profile}"
        wave_proof_key = f"{proof_key}:{wave_id}:{lane}"
        identity = stable_hash(
            ["sub-agent-review-unavailable", wave_proof_key, review_model, review_effort]
        )
        with self._exclusive_execution(identity):
            with self._exclusive_ledger_update():
                verified_head, _ = require_clean_current_head(self.repo, actual_head)
                if git_commit(self.repo, base_ref) != resolved_base:
                    raise RuntimeError("review base changed while waiting for sub-agent evidence")
                ledger = self.read()
                self._require_active(ledger)
                if not self._requires_current_review_proof(ledger):
                    raise RuntimeError("sub-agent review proof is only used by Tier 3/4 direct delivery")
                if ledger.get("base_sha") != resolved_base:
                    raise RuntimeError("review base differs from the ledger base")
                review = self._review_state(ledger)
                if review.get("active_wave_id") != wave_id:
                    raise RuntimeError("sub-agent review evidence is not bound to the active review wave")
                wave = self._review_wave(ledger, wave_id)
                if (
                    wave.get("state") != "open"
                    or wave.get("head_sha") != verified_head
                    or wave.get("base_sha") != resolved_base
                    or lane not in wave.get("lanes", {})
                ):
                    raise RuntimeError("sub-agent review evidence does not match its review wave")
                lane_state = wave["lanes"][lane]
                expected_profile = {
                    "initial": "pr-convergence",
                    "repair": "pr-convergence",
                    "risk-arbitration": "risk-arbitration",
                }[wave["stage"]]
                if review_profile != expected_profile:
                    raise RuntimeError("sub-agent review profile does not match its review wave stage")
                expected_profile_resolution = {
                    "preferred": {"model": review_model, "effort": review_effort},
                    "resolved": {"model": "unavailable", "effort": "unavailable"},
                    "fallback_reason": "sub-agent-unavailable",
                    "attempts": 1,
                }
                receipt_id = stable_hash(
                    [ledger["run_id"], "sub-agent-review-unavailable", identity]
                )
                existing = next(
                    (
                        item
                        for item in ledger.get("receipts", [])
                        if item.get("receipt_id") == receipt_id
                    ),
                    None,
                )
                if existing is not None:
                    if (
                        not isinstance(existing, dict)
                        or existing.get("kind") != "review_attempt"
                        or existing.get("head_sha") != verified_head
                        or existing.get("base_sha") != resolved_base
                        or existing.get("review_profile") != review_profile
                        or existing.get("review_model") != review_model
                        or existing.get("review_effort") != review_effort
                        or existing.get("profile_resolution") != expected_profile_resolution
                        or existing.get("terminal_state") != "unavailable"
                        or existing.get("unavailability_classification")
                        != unavailability_classification
                        or existing.get("review_execution_source") != "sub-agent"
                    ):
                        raise RuntimeError("unavailable review attempt does not match its recorded receipt")
                    return {"reused": True, "receipt": existing}
                if not review_model_matches_lane(
                    lane_state.get("model", ""),
                    lane_state.get("effort", ""),
                    review_model,
                    review_effort,
                    enforce_direct=True,
                ) or not direct_wave_lane_profile_is_authorized(
                    ledger,
                    repo_path=self.repo,
                    head_sha=verified_head,
                    base_sha=resolved_base,
                    wave_id=wave_id,
                    lane=lane,
                    declared_model=lane_state["model"],
                    declared_effort=lane_state["effort"],
                    review_model=review_model,
                    review_effort=review_effort,
                ):
                    raise RuntimeError("sub-agent review lane fallback is not authorized")
                receipt = {
                    "receipt_id": receipt_id,
                    "kind": "review_attempt",
                    "review_receipt_schema": REVIEW_RECEIPT_SCHEMA_VERSION,
                    "proof_key": proof_key,
                    "wave_proof_key": wave_proof_key,
                    "head_sha": verified_head,
                    "base_sha": resolved_base,
                    "review_profile": review_profile,
                    "review_model": review_model,
                    "review_effort": review_effort,
                    "resolved_model": "unavailable",
                    "resolved_effort": "unavailable",
                    "profile_resolution": expected_profile_resolution,
                    "profile_proof_status": "sub-agent-declared",
                    "review_execution_source": "sub-agent",
                    "provenance_boundary": "sub-agent-structured-result",
                    "evidence_source": "sub-agent-structured-result",
                    "terminal_state": "unavailable",
                    "unavailability_classification": unavailability_classification,
                    "wave_id": wave_id,
                    "lane": lane,
                    "finding_fingerprints": [],
                    "review_findings": [],
                    "review_clear": False,
                    "overall_correctness": "unavailable",
                    "evidence_valid": False,
                    "post_execution_clean": True,
                    "exit_code": 75,
                    "recorded_at": now(),
                }
                ledger["receipts"].append(receipt)
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"reused": False, "receipt": receipt}

    def record_agent_review(
        self,
        *,
        review_profile: str,
        base_ref: str,
        review_model: str,
        review_effort: str,
        review_agent_id: str,
        review_task_id: str,
        agent_status: str,
        review_result_file: str,
        review_task_receipt_file: str,
        native_sessions_root: str = "",
        native_agent_type: str = "reviewer",
        head_sha: str | None = None,
        wave_id: str | None = None,
        lane: str | None = None,
    ) -> dict[str, Any]:
        raise RuntimeError(
            "agent-review receipt production is retired; only inline sub-agent review results "
            "may be recorded"
        )
        if self.repo is None:
            raise RuntimeError("agent review evidence requires a repository-bound ledger")
        if bool(wave_id) != bool(lane):
            raise RuntimeError(
                "agent review evidence requires both review wave id and review lane"
            )
        if wave_id and lane and native_agent_type != "reviewer":
            raise RuntimeError("shared native review evidence requires agent_type=reviewer")
        required = {
            "review profile": review_profile,
            "review model": review_model,
            "review effort": review_effort,
            "review result file": review_result_file,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise RuntimeError("agent review evidence is missing " + ", ".join(missing))
        if agent_status != "completed":
            raise RuntimeError("agent review evidence requires terminal status=completed")
        result_path = Path(review_result_file)
        if not result_path.is_absolute():
            result_path = (self.repo / result_path).resolve()
        if not result_path.is_file():
            raise RuntimeError("agent review result file does not exist")
        result_text = result_path.read_text(encoding="utf-8")
        result_sha256 = hashlib.sha256(result_text.encode("utf-8")).hexdigest()
        review_result, findings = parse_agent_review_result(result_text, self.repo)
        actual_head, _ = require_clean_current_head(self.repo, head_sha)
        resolved_base = git_commit(self.repo, base_ref)
        ledger = self.read()
        self._require_active(ledger)
        if self._requires_current_review_proof(ledger):
            raise RuntimeError(
                "direct delivery requires helper-run review proof, not agent-review evidence"
            )
        # These labels are compatibility metadata only. Proof is never
        # accepted or rejected from child IDs, PTC envelopes, or transcripts.
        review_agent_id = review_agent_id.strip() or "helper-owned-reviewer"
        review_task_id = review_task_id.strip() or "helper-owned-review-task"
        if not review_task_receipt_file:
            raise RuntimeError("agent review evidence requires a fixed-helper task receipt")
        task_receipt_path = Path(review_task_receipt_file)
        if not task_receipt_path.is_absolute():
            task_receipt_path = (self.repo / task_receipt_path).resolve()
        if not task_receipt_path.is_file():
            raise RuntimeError("agent review task receipt file does not exist")
        helper_task_receipt_text = task_receipt_path.read_text(encoding="utf-8")
        parse_helper_task_receipt(
            helper_task_receipt_text,
            result_sha256=result_sha256,
            review_agent_id=review_agent_id,
            review_task_id=review_task_id,
            agent_status=agent_status,
            head_sha=actual_head,
            base_sha=resolved_base,
            review_profile=review_profile,
            review_model=review_model,
            review_effort=review_effort,
            wave_id=wave_id,
            lane=lane,
        )
        verified_terminal_status = "completed"
        task_receipt_payload = {
            "schema_version": FLOW_SCHEMA_VERSION,
            "review_agent_id": review_agent_id,
            "review_task_id": review_task_id,
            "terminal_status": verified_terminal_status,
            "provenance_boundary": "fixed-review-helper",
            "head_sha": actual_head,
            "base_sha": resolved_base,
            "review_profile": review_profile,
            "result_sha256": result_sha256,
        }
        if wave_id is not None:
            task_receipt_payload.update(
                {
                    "wave_id": wave_id,
                    "lane": lane,
                    "review_model": review_model,
                    "review_effort": review_effort,
                }
            )
        task_receipt_text = json.dumps(task_receipt_payload, ensure_ascii=True, sort_keys=True) + "\n"
        task_receipt_sha256 = hashlib.sha256(task_receipt_text.encode("utf-8")).hexdigest()
        validate_agent_finding_diff_locations(
            review_result, self.repo, resolved_base, actual_head
        )
        proof_key = f"{self.repo}:{actual_head}:{resolved_base}:{review_profile}"
        wave_proof_key = f"{proof_key}:{wave_id}:{lane}"
        scoped_proof_key = wave_proof_key if wave_id and lane else proof_key
        review_identity = stable_hash(["agent-review", scoped_proof_key])
        with self._exclusive_execution(review_identity):
            with self._exclusive_ledger_update():
                verified_head, _ = require_clean_current_head(self.repo, actual_head)
                locked_base = git_commit(self.repo, base_ref)
                raw_ledger = self.read_raw()
                ledger = normalize_ledger(raw_ledger)
                self._require_active(ledger)
                if result_path.read_text(encoding="utf-8") != result_text:
                    raise RuntimeError("agent review result changed before receipt persistence")
                if task_receipt_path.read_text(encoding="utf-8") != helper_task_receipt_text:
                    raise RuntimeError("helper task receipt changed before receipt persistence")
                if locked_base != resolved_base:
                    raise RuntimeError(
                        "repository base changed while waiting for review evidence lock"
                    )
                if not wave_id or not lane:
                    if self._review_state(ledger).get("epochs"):
                        raise RuntimeError(
                            "agent review evidence is missing review wave id, review lane"
                        )
                    if resolved_base != ledger["base_sha"]:
                        previous_base = ledger["base_sha"]
                        if not git_is_ancestor(self.repo, previous_base, resolved_base):
                            raise RuntimeError("agent review base changed non-linearly from the ledger base")
                        ledger["base_sha"] = resolved_base
                        ledger["events"].append(
                            {
                                "type": "base_advanced",
                                "from_base_sha": previous_base,
                                "to_base_sha": resolved_base,
                                "at": now(),
                            }
                        )
                    if verified_head != ledger["head_sha"]:
                        previous_head = ledger["head_sha"]
                        ledger["head_sha"] = verified_head
                        ledger["events"].append(
                            {
                                "type": "head_advanced",
                                "from_head_sha": previous_head,
                                "to_head_sha": verified_head,
                                "at": now(),
                            }
                        )
                    for source in reversed(ledger["receipts"]):
                        if (
                            source.get("kind") == "agent-review"
                            and source.get("proof_key") == proof_key
                            and source.get("wave_id") is None
                            and source.get("evidence_source")
                            == "helper-owned-structured-result"
                        ):
                            if (
                                source.get("review_agent_id") == review_agent_id
                                and source.get("review_task_id") == review_task_id
                                and source.get("artifact_sha256") == result_sha256
                                and source.get("provenance_boundary")
                                == "helper-owned-structured-result"
                            ):
                                return {"reused": True, "receipt": source}
                            raise RuntimeError("conflicting helper review evidence for the same proof key")
                    review_root = self.root / "reviews" / stable_hash(
                        [ledger["run_id"], scoped_proof_key, review_agent_id, review_task_id]
                    )
                    review_root.mkdir(parents=True, exist_ok=True)
                    artifact_path = review_root / "agent-result.json"
                    artifact_sha256 = write_once_review_artifact(
                        artifact_path, result_text, "agent review result"
                    )
                    task_artifact_path = review_root / "task-receipt.json"
                    stored_task_receipt_sha256 = write_once_review_artifact(
                        task_artifact_path, task_receipt_text, "agent review task receipt"
                    )
                    if stored_task_receipt_sha256 != task_receipt_sha256:
                        raise RuntimeError("agent review task receipt changed before receipt persistence")
                    receipt = {
                        "receipt_id": stable_hash(
                            [ledger["run_id"], "agent-review", wave_proof_key, review_agent_id, review_task_id]
                        ),
                        "kind": "agent-review",
                        "review_receipt_schema": REVIEW_RECEIPT_SCHEMA_VERSION,
                        "proof_key": proof_key,
                        "wave_proof_key": wave_proof_key,
                        "head_sha": verified_head,
                        "base_sha": resolved_base,
                        "review_profile": review_profile,
                        "review_model": review_model,
                        "review_effort": review_effort,
                        "resolved_model": review_model,
                        "resolved_effort": review_effort,
                        "review_agent_id": review_agent_id,
                        "review_task_id": review_task_id,
                        "agent_status": verified_terminal_status,
                        "terminal_state": "completed",
                        "evidence_source": "helper-owned-structured-result",
                        "provenance_boundary": "helper-owned-structured-result",
                        "profile_proof_status": "helper-verified",
                        "profile_resolution": {
                            "preferred": {"model": review_model, "effort": review_effort},
                            "resolved": {"model": review_model, "effort": review_effort},
                            "fallback_reason": None,
                            "attempts": 1,
                        },
                        "finding_fingerprints": findings,
                        "review_findings": review_result["findings"],
                        "review_clear": review_is_clear(True, findings, review_result),
                        "overall_correctness": review_result["overall_correctness"],
                        "evidence_valid": True,
                        "post_execution_clean": True,
                        "artifact_path": str(artifact_path),
                        "artifact_sha256": artifact_sha256,
                        "task_receipt_path": str(task_artifact_path),
                        "task_receipt_sha256": stored_task_receipt_sha256,
                        "recorded_at": now(),
                    }
                    ledger["receipts"].append(receipt)
                    ledger["updated_at"] = now()
                    self._write(ledger)
                    return {"reused": False, "receipt": receipt}
                wave = self._review_wave(ledger, wave_id)
                review = self._review_state(ledger)
                epoch = next(
                    (item for item in review.get("epochs", []) if item.get("epoch_id") == wave.get("epoch_id")),
                    None,
                )
                if epoch is None:
                    raise RuntimeError("review wave epoch is missing")
                if review.get("active_wave_id") != wave_id or wave.get("state") != "open":
                    raise RuntimeError("agent review evidence is not bound to the active review wave")
                if (
                    wave.get("head_sha") != verified_head
                    or wave.get("base_sha") != resolved_base
                    or lane not in wave.get("lanes", {})
                ):
                    raise RuntimeError("agent review evidence does not match its review wave")
                lane_state = wave["lanes"][lane]
                if lane_state.get("receipt_id"):
                    raise RuntimeError("review lane already has a recorded receipt")
                current_native_proof = False
                if not review_model_matches_lane(
                    lane_state.get("model", ""),
                    lane_state.get("effort", ""),
                    review_model,
                    review_effort,
                    enforce_direct=self._requires_current_review_proof(ledger),
                ):
                    raise RuntimeError("agent review profile metadata is invalid")
                expected_profile = {
                    "initial": "pr-convergence",
                    "repair": "pr-convergence",
                    "risk-arbitration": "risk-arbitration",
                }[wave["stage"]]
                if review_profile != expected_profile:
                    raise RuntimeError("agent review profile does not match its review wave stage")
                for source in reversed(ledger["receipts"]):
                    if (
                        source.get("kind") == "agent-review"
                        and source.get("proof_key") == proof_key
                        and source.get("wave_proof_key") == wave_proof_key
                        and source.get("evidence_source")
                        == "helper-owned-structured-result"
                    ):
                        if (
                            source.get("review_agent_id") == review_agent_id
                            and source.get("review_task_id") == review_task_id
                            and source.get("artifact_sha256") == result_sha256
                            and source.get("provenance_boundary")
                            == "helper-owned-structured-result"
                        ):
                            return {"reused": True, "receipt": source}
                        raise RuntimeError(
                            "conflicting helper review evidence for the same proof key"
                        )
                review_root = self.root / "reviews" / stable_hash(
                    [ledger["run_id"], scoped_proof_key, review_agent_id, review_task_id]
                )
                review_root.mkdir(parents=True, exist_ok=True)
                artifact_path = review_root / "agent-result.json"
                artifact_sha256 = write_once_review_artifact(
                    artifact_path, result_text, "agent review result"
                )
                task_artifact_path = review_root / "task-receipt.json"
                stored_task_receipt_sha256 = write_once_review_artifact(
                    task_artifact_path, task_receipt_text, "agent review task receipt"
                )
                if stored_task_receipt_sha256 != task_receipt_sha256:
                    raise RuntimeError("agent review task receipt changed before receipt persistence")
                receipt = {
                    "receipt_id": stable_hash(
                        [
                            ledger["run_id"],
                            "agent-review",
                            wave_proof_key,
                            review_agent_id,
                            review_task_id,
                        ]
                    ),
                    "kind": "agent-review",
                    "review_receipt_schema": REVIEW_RECEIPT_SCHEMA_VERSION,
                    "proof_key": proof_key,
                    "wave_proof_key": wave_proof_key,
                    "head_sha": verified_head,
                    "base_sha": resolved_base,
                    "review_profile": review_profile,
                    "review_model": review_model,
                    "review_effort": review_effort,
                    "resolved_model": review_model,
                    "resolved_effort": review_effort,
                    "profile_resolution": {
                        "preferred": {
                            "model": lane_state["model"],
                            "effort": lane_state["effort"],
                        },
                        "resolved": {
                            "model": review_model,
                            "effort": review_effort,
                        },
                        "fallback_reason": None,
                        "attempts": 1,
                    },
                    "profile_proof_status": "helper-verified",
                    "review_agent_id": review_agent_id,
                    "review_task_id": review_task_id,
                    "wave_id": wave_id,
                    "lane": lane,
                    "agent_status": verified_terminal_status,
                    "terminal_state": "completed",
                    "evidence_source": "helper-owned-structured-result",
                    "provenance_boundary": "helper-owned-structured-result",
                    "finding_fingerprints": findings,
                    "review_findings": review_result["findings"],
                    "review_clear": review_is_clear(True, findings, review_result),
                    "overall_correctness": review_result["overall_correctness"],
                    "evidence_valid": True,
                    "post_execution_clean": True,
                    "artifact_path": str(artifact_path),
                    "artifact_sha256": artifact_sha256,
                    "task_receipt_path": str(task_artifact_path),
                    "task_receipt_sha256": stored_task_receipt_sha256,
                    "recorded_at": now(),
                }
                ledger["receipts"].append(receipt)
                lane_state["receipt_id"] = receipt["receipt_id"]
                ledger["updated_at"] = now()
                self._write(ledger)
                return {"reused": False, "receipt": receipt}

    def _run_validation_locked(
        self,
        command: str,
        toolchain_fingerprint: str,
        input_fingerprint: str,
        *,
        kind: str,
        head_sha: str | None,
        log_path: str | None,
        retry_state_fingerprint: str | None,
        input_paths: Iterable[str],
        acceptance_evidence: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        assert self.repo is not None
        actual_head, initial_tree = require_clean_current_head(self.repo, head_sha)
        preflight = self.record_validation(
            command,
            toolchain_fingerprint,
            input_fingerprint,
            0,
            log_path or "",
            kind=kind,
            head_sha=actual_head,
            retry_state_fingerprint=retry_state_fingerprint,
            preflight_only=True,
            input_paths=input_paths,
            acceptance_evidence=acceptance_evidence,
        )
        if preflight.get("reused"):
            return preflight

        ledger = self.read()
        budget, known_long = known_long_budget(
            self.repo, command, ledger["command_budget_seconds"]
        )
        resolved_log = self._resolve_log_path(
            log_path, preflight["identity"], preflight["attempt"]
        )
        resolved_log.parent.mkdir(parents=True, exist_ok=True)

        started = time.monotonic()
        timed_out = False
        with resolved_log.open("wb") as log_handle:
            process = subprocess.Popen(
                ["/bin/sh", "-c", command],
                cwd=self.repo,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                env=validation_subprocess_environment(),
                start_new_session=True,
            )
            try:
                exit_code = process.wait(timeout=budget)
            except subprocess.TimeoutExpired:
                timed_out = True
                terminate_process_group(process)
                exit_code = 124
                log_handle.write(
                    f"\nflow_receipt: command timed out after {budget} seconds\n".encode()
                )
        duration = int(time.monotonic() - started)
        post_execution_clean = True
        try:
            require_clean_current_head(self.repo, actual_head)
        except RuntimeError as error:
            post_execution_clean = False
            if exit_code == 0:
                exit_code = 125
            with resolved_log.open("ab") as log_handle:
                log_handle.write(
                    f"\nflow_receipt: post-execution repository check failed: {error}\n".encode()
                )
        log_digest = file_sha256(resolved_log)
        return self.record_validation(
            command,
            toolchain_fingerprint,
            input_fingerprint,
            exit_code,
            str(resolved_log),
            kind=kind,
            head_sha=actual_head,
            duration_seconds=duration,
            known_long=known_long,
            retry_state_fingerprint=retry_state_fingerprint,
            timed_out=timed_out,
            execution_verified=True,
            observed_tree=initial_tree,
            post_execution_clean=post_execution_clean,
            log_sha256=log_digest,
            input_paths=input_paths,
            acceptance_evidence=acceptance_evidence,
        )

    def record_attestation(
        self,
        source_receipt_id: str,
        head_sha: str,
        base_ref: str,
    ) -> dict[str, Any]:
        with self._shared_lifecycle():
            with self._exclusive_ledger_update():
                return self._record_attestation_locked(source_receipt_id, head_sha, base_ref)

    def _record_attestation_locked(
        self,
        source_receipt_id: str,
        head_sha: str,
        base_ref: str,
    ) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("attestation requires a repository-bound ledger")
        ledger = self.read()
        self._require_active(ledger)
        review = self._review_state(ledger)
        if review.get("epochs"):
            raise RuntimeError(
                "current-head attestation cannot advance a wave-bound review ledger"
            )
        source = next(
            (item for item in ledger["receipts"] if item["receipt_id"] == source_receipt_id),
            None,
        )
        if (
            source is None
            or source["exit_code"] != 0
            or source.get("kind") not in {"validation", "review", "attestation"}
            or (
                source.get("kind") == "review"
                and (
                    not source.get(
                        "evidence_valid", source.get("direct_launch_verified", False)
                    )
                    or not source.get("review_clear", False)
                )
            )
        ):
            raise RuntimeError("source receipt is missing or did not pass")
        previous_receipt_id = source_receipt_id
        if source.get("kind") == "attestation":
            origin_receipt_id = source.get(
                "origin_receipt_id", source.get("source_receipt_id")
            )
            origin = next(
                (
                    item
                    for item in ledger["receipts"]
                    if item["receipt_id"] == origin_receipt_id
                ),
                None,
            )
            if (
                origin is None
                or origin.get("kind") not in {"validation", "review"}
                or (
                    origin.get("kind") == "review"
                    and not origin.get("review_clear", False)
                )
            ):
                raise RuntimeError("attestation origin receipt is missing or invalid")
        else:
            origin = source
            origin_receipt_id = source_receipt_id
        current_base = git_commit(self.repo, base_ref)
        if current_base != ledger["base_sha"]:
            raise RuntimeError("attestation base differs from the ledger base")
        git_delta = self.classify_git_delta(source["head_sha"], head_sha, require_current=True)
        target_head = git_delta["target_head"]
        scoped_paths = git_delta["paths"]
        classification = git_delta["classification"]
        if not classification["reusable"]:
            raise RuntimeError(
                "delta is not eligible for current-head attestation: "
                + ", ".join(classification["reasons"])
            )
        if origin.get("kind") == "validation":
            declared_input_paths = origin.get("declared_input_paths", [])
            if not declared_input_paths:
                raise RuntimeError(
                    "validation attestation requires declared input paths"
                )
            affected_inputs = [
                path
                for path in scoped_paths
                if path_matches_declared_inputs(path, declared_input_paths)
            ]
            if affected_inputs:
                raise RuntimeError(
                    "delta changes declared validation inputs: "
                    + ", ".join(affected_inputs)
                )
        receipt_id = stable_hash([origin_receipt_id, target_head, scoped_paths])
        existing = next(
            (item for item in ledger["receipts"] if item["receipt_id"] == receipt_id),
            None,
        )
        if existing is not None:
            return existing
        receipt = {
            "receipt_id": receipt_id,
            "kind": "attestation",
            "head_sha": target_head,
            "source_receipt_id": origin_receipt_id,
            "origin_receipt_id": origin_receipt_id,
            "previous_receipt_id": previous_receipt_id,
            "paths": scoped_paths,
            "classification": classification,
            "exit_code": 0,
            "recorded_at": now(),
        }
        if origin.get("kind") == "review":
            receipt.update(
                {
                    "source_kind": "review",
                    "source_proof_key": origin.get("proof_key"),
                    "review_profile": origin.get("review_profile"),
                    "base_sha": origin.get("base_sha"),
                    "review_clear": origin.get("review_clear", False),
                    "finding_fingerprints": origin.get("finding_fingerprints", []),
                }
            )
        ledger["receipts"].append(receipt)
        ledger["head_sha"] = target_head
        ledger["updated_at"] = now()
        self._write(ledger)
        return receipt

    def classify_git_delta(
        self, source_head: str, target_head: str, *, require_current: bool = False
    ) -> dict[str, Any]:
        if self.repo is None:
            raise RuntimeError("Git delta classification requires a repository-bound ledger")
        ledger = self.read()
        resolved_source = git_commit(self.repo, source_head)
        resolved_target = git_commit(self.repo, target_head)
        if require_current and resolved_target != git_commit(self.repo, "HEAD"):
            raise RuntimeError("attestation target must be the repository current HEAD")
        paths = git_changed_paths(self.repo, resolved_source, resolved_target)
        contract_changed = spec_contract_changed(
            self.repo, resolved_source, resolved_target, paths
        )
        effective_merge_before = git_effective_merge_fingerprint(
            self.repo, ledger["base_sha"], resolved_source
        )
        effective_merge_after = git_effective_merge_fingerprint(
            self.repo, ledger["base_sha"], resolved_target
        )
        classification = classify_delta(
            paths,
            contract_changed,
            effective_merge_before,
            effective_merge_after,
        )
        return {
            "source_head": resolved_source,
            "target_head": resolved_target,
            "paths": paths,
            "spec_contract_changed": contract_changed,
            "effective_merge_before": effective_merge_before,
            "effective_merge_after": effective_merge_after,
            "classification": classification.as_dict(),
        }

    def status(self) -> dict[str, Any]:
        ledger = self.read()
        status_ledger = project_status_payload(ledger)
        convergence = ledger["convergence"]
        review = self._review_state(ledger)
        status_ledger["review_mode"] = ledger.get("review_mode")
        if ledger.get("legacy_review") is not None:
            status_ledger["legacy_review_history"] = project_status_payload(
                ledger["legacy_review"]
            )
        active_epoch = None
        if review.get("active_epoch_id"):
            active_epoch = self._active_epoch(ledger)
        failed_by_identity: dict[str, list[dict[str, Any]]] = {}
        for receipt in ledger["receipts"]:
            identity = receipt.get("identity")
            if (
                receipt.get("kind") == "validation"
                and identity
                and receipt["exit_code"] != 0
            ):
                failed_by_identity.setdefault(identity, []).append(receipt)
        status_ledger["budget_status"] = {
            "command_budget_seconds": ledger["command_budget_seconds"],
            "convergence_repair_rounds_remaining": max(
                0,
                MAX_CONVERGENCE_ROUNDS - convergence.get("repair_round", 0),
            ),
            "transient_retries_remaining_by_identity": {
                identity: (
                    1
                    if len(attempts) == 1
                    and attempts[-1]["exit_code"] in TRANSIENT_VALIDATION_EXIT_CODES
                    else 0
                )
                for identity, attempts in failed_by_identity.items()
            },
            "active_review_epoch": (
                active_epoch.get("epoch_id") if active_epoch else None
            ),
            "review_repair_rounds_remaining": (
                max(
                    0,
                    MAX_CONVERGENCE_ROUNDS
                    - int(active_epoch.get("repair_rounds_used", 0)),
                )
                if active_epoch
                else MAX_CONVERGENCE_ROUNDS
            ),
            "active_review_wave": review.get("active_wave_id"),
        }
        status_ledger["recent_receipts"] = status_ledger["receipts"][-5:]
        return status_ledger

    def record_convergence(self, blockers: Iterable[str]) -> dict[str, Any]:
        lifecycle_path = self.root / "execution-lifecycle.lock"
        self.root.mkdir(parents=True, exist_ok=True)
        with lifecycle_path.open("a+b") as lifecycle_handle:
            try:
                fcntl.flock(lifecycle_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError(
                    "cannot record terminal convergence while execution is in flight"
                ) from error
            with self._exclusive_ledger_update():
                return self._record_convergence_locked(blockers)

    def _record_convergence_locked(self, blockers: Iterable[str]) -> dict[str, Any]:
        raw_ledger = self.read_raw()
        stored_schema_version = raw_ledger.get("schema_version", 1)
        ledger = normalize_ledger(raw_ledger)
        self._require_active(ledger)
        if self._review_state(ledger).get("epochs") or (
            stored_schema_version >= FLOW_SCHEMA_VERSION
            and not ledger.get("legacy_compatibility")
        ):
            raise RuntimeError(
                "review convergence is wave-bound; use review-wave finalize instead"
            )
        convergence = ledger["convergence"]
        current = sorted(blockers)
        previous = list(convergence["blockers"])
        current_counts = Counter(current)
        previous_counts = Counter(previous)
        repair_round = convergence.get("repair_round", 0)
        if convergence["round"] == 0:
            if current:
                state = "initial"
            else:
                state = "complete"
        elif repair_round >= MAX_CONVERGENCE_ROUNDS:
            state = "NON_CONVERGENT"
            ledger["state"] = state
        elif (
            all(count <= previous_counts[fingerprint] for fingerprint, count in current_counts.items())
            and current_counts != previous_counts
        ):
            next_repair_round = repair_round + 1
            convergence["repair_round"] = next_repair_round
            if not current:
                state = "complete"
            elif next_repair_round >= MAX_CONVERGENCE_ROUNDS:
                state = "NON_CONVERGENT"
                ledger["state"] = state
            else:
                state = "progress"
        elif convergence["diagnostic_used"]:
            state = "NON_CONVERGENT"
            ledger["state"] = state
        else:
            state = "diagnostic_required"
            convergence["diagnostic_used"] = True
            convergence["repair_round"] = repair_round + 1
        convergence["round"] += 1
        convergence["state"] = state
        convergence["blockers"] = current
        ledger["events"].append(
            {"type": "convergence", "state": state, "blockers": current, "at": now()}
        )
        ledger["updated_at"] = now()
        self._write(ledger)
        return {"state": state, **convergence}

    def close(self, state: str) -> dict[str, Any]:
        if state not in TERMINAL_STATES:
            raise RuntimeError(
                "close state must be terminal: " + ", ".join(sorted(TERMINAL_STATES))
            )
        self.root.mkdir(parents=True, exist_ok=True)
        lifecycle_path = self.root / "execution-lifecycle.lock"
        with lifecycle_path.open("a+b") as lifecycle_handle:
            try:
                fcntl.flock(
                    lifecycle_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB
                )
            except BlockingIOError as error:
                raise RuntimeError(
                    "cannot close flow receipt while execution is in flight"
                ) from error
            with self._exclusive_ledger_update():
                return self._close_locked(state)

    def _requires_current_review_proof(self, raw_ledger: dict[str, Any]) -> bool:
        """Only assessed Tier 3/4 direct delivery requires a fresh proof."""
        return self._review_tier(raw_ledger) in {3, 4}

    @staticmethod
    def _review_tier(ledger: dict[str, Any]) -> int | None:
        if ledger.get("flow_type") not in DIRECT_REVIEW_FLOW_TYPES:
            return None
        assessment = ledger.get("review_assessment")
        if not isinstance(assessment, dict):
            return None
        tier = assessment.get("tier")
        return tier if type(tier) is int and tier in REVIEW_NECESSITY_TIERS else None

    def _require_review_assessment(
        self,
        ledger: dict[str, Any],
        gate: str,
        *,
        candidate_head_sha: str | None = None,
    ) -> None:
        if ledger.get("flow_type") not in DIRECT_REVIEW_FLOW_TYPES:
            return
        review_tier = self._review_tier(ledger)
        if review_tier is None:
            raise RuntimeError(f"direct delivery requires review-assess before {gate}")
        assessment = ledger.get("review_assessment")
        if not isinstance(assessment, dict):
            raise RuntimeError(f"direct delivery requires review-assess before {gate}")
        if assessment.get("source") == "pre-tier-migration":
            if assessment != migrated_review_assessment():
                raise RuntimeError("migrated review assessment is invalid")
            return
        if assessment.get("source") != "agent-assessment":
            raise RuntimeError("recorded review assessment source is invalid")
        if review_tier in {1, 2} and assessment.get("assessed_head_sha") != (
            candidate_head_sha or ledger.get("head_sha")
        ):
            raise RuntimeError(
                f"review assessment is stale for the current candidate before {gate}"
            )

    def _revalidate_current_review_set(
        self,
        ledger: dict[str, Any],
        epoch: dict[str, Any],
        proof_wave_id: str,
        proof_wave: dict[str, Any],
    ) -> None:
        """Rebuild the clear tier-required review set from stable receipt evidence."""
        review_tier = self._review_tier(ledger)
        lanes = proof_wave.get("lanes")
        if (
            proof_wave.get("stage") not in {"initial", "repair"}
            or not isinstance(lanes, dict)
            or review_tier not in {3, 4}
            or not is_current_clear_required_review_wave(
                proof_wave,
                head_sha=ledger.get("head_sha"),
                base_sha=ledger.get("base_sha"),
                review_tier=review_tier,
            )
        ):
            raise RuntimeError("complete requires a finalized current-head required review proof")
        try:
            if self._requires_current_review_proof(ledger):
                synthesis_input = proof_wave.get("synthesis")
                if (
                    not isinstance(synthesis_input, dict)
                    or proof_wave.get("synthesis_path") is not None
                    or proof_wave.get("synthesis_sha256") != stable_hash(synthesis_input)
                ):
                    raise RuntimeError("review proof synthesis digest is invalid")
                synthesis = normalize_review_synthesis(synthesis_input)
            else:
                review_root = (self.root / "reviews").resolve()
                synthesis_path = review_artifact_path(
                    review_root, proof_wave.get("synthesis_path"), "review proof synthesis"
                )
                synthesis_bytes = stable_file_bytes(synthesis_path, "review proof synthesis")
                if proof_wave.get("synthesis_sha256") != hashlib.sha256(synthesis_bytes).hexdigest():
                    raise RuntimeError("review proof synthesis digest is invalid")
                synthesis = json.loads(synthesis_bytes.decode("utf-8"))
                if not isinstance(synthesis, dict):
                    raise RuntimeError("review proof synthesis is not an object")
        except (RuntimeError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("complete requires an untampered current-head required review proof") from error
        acceptance_manifest = ledger.get("acceptance_manifest")
        try:
            manifest = normalize_acceptance_manifest(acceptance_manifest)
            acceptance = self._validate_acceptance_synthesis(
                ledger,
                proof_wave,
                synthesis.get("acceptance", []),
                manifest,
                epoch=epoch,
            )
        except RuntimeError as error:
            raise RuntimeError("complete requires an untampered current-head required review proof") from error
        if (
            proof_wave.get("acceptance_manifest_digest") != stable_hash(acceptance_manifest)
            or proof_wave.get("acceptance") != acceptance
            or synthesis.get("acceptance") != acceptance
            or synthesis.get("blockers")
            or proof_wave.get("blockers")
            or set(proof_wave.get("coverage", [])) != set(lanes)
            or set(synthesis.get("coverage", [])) != set(lanes)
            or proof_wave.get("finding_to_group") != synthesis.get("finding_to_group")
            or proof_wave.get("scope_fingerprint") != synthesis.get("scope_fingerprint")
        ):
            raise RuntimeError("complete requires an untampered current-head required review proof")
        for lane, lane_state in lanes.items():
            if not isinstance(lane_state, dict):
                raise RuntimeError("complete requires an untampered current-head required review proof")
            receipt = next(
                (
                    item
                    for item in ledger.get("receipts", [])
                    if item.get("receipt_id") == lane_state.get("receipt_id")
                ),
                None,
            )
            if (
                not isinstance(receipt, dict)
                or receipt.get("kind") != "review"
                or receipt.get("terminal_state") != "completed"
                or receipt.get("evidence_valid") is not True
                or receipt.get("review_clear") is not True
                or type(receipt.get("exit_code")) is not int
                or receipt.get("exit_code") != 0
                or receipt.get("post_execution_clean") is not True
                or receipt.get("wave_id") != proof_wave_id
                or receipt.get("lane") != lane
                or receipt.get("review_profile") != "pr-convergence"
                or receipt.get("head_sha") != proof_wave.get("head_sha")
                or receipt.get("base_sha") != proof_wave.get("base_sha")
                or not review_model_matches_lane(
                    lane_state.get("model", ""),
                    lane_state.get("effort", ""),
                    receipt.get("review_model", ""),
                    receipt.get("review_effort", ""),
                    enforce_direct=self._requires_current_review_proof(ledger),
                )
                or (
                    self._requires_current_review_proof(ledger)
                    and not direct_wave_lane_profile_is_authorized(
                        ledger,
                        repo_path=self.repo,
                        head_sha=proof_wave.get("head_sha", ""),
                        base_sha=proof_wave.get("base_sha", ""),
                        wave_id=proof_wave_id,
                        lane=lane,
                        declared_model=lane_state.get("model", ""),
                        declared_effort=lane_state.get("effort", ""),
                        review_model=receipt.get("review_model", ""),
                        review_effort=receipt.get("review_effort", ""),
                    )
                )
            ):
                raise RuntimeError("complete requires an untampered current-head required review proof")
            try:
                profile_resolution, _artifact_fingerprints = self._rederive_current_review_receipt(
                    receipt, wave_id=proof_wave_id, lane=lane
                )
            except RuntimeError as error:
                raise RuntimeError(
                    "complete requires an untampered current-head required review proof"
                ) from error
            resolved_profile = profile_resolution["resolved"]
            if (
                receipt.get("review_execution_source") != "sub-agent"
                or receipt.get("provenance_boundary") != "sub-agent-structured-result"
                or receipt.get("profile_proof_status") != "sub-agent-declared"
                or receipt.get("profile_resolution") != profile_resolution
                or profile_resolution["preferred"]
                != {"model": lane_state.get("model"), "effort": lane_state.get("effort")}
                or profile_resolution
                != direct_review_profile_resolution(
                    lane_state.get("model", ""),
                    lane_state.get("effort", ""),
                    receipt.get("review_model", ""),
                    receipt.get("review_effort", ""),
                )
                or receipt.get("resolved_model") != resolved_profile["model"]
                or receipt.get("resolved_effort") != resolved_profile["effort"]
            ):
                raise RuntimeError("complete requires an untampered current-head required review proof")

    def _close_locked(self, state: str) -> dict[str, Any]:
        raw_ledger = self.read_raw()
        ledger = normalize_ledger(json.loads(json.dumps(raw_ledger)))
        if raw_ledger.get("state") != "active":
            if raw_ledger.get("state") == state:
                archive_path = self.root / "runs" / f"{stable_hash(raw_ledger['run_id'])}.json"
                expected_archive = self._archive_content(raw_ledger)
                if (
                    not archive_path.is_file()
                    or stable_file_bytes(archive_path, "terminal ledger archive") != expected_archive
                ):
                    raise RuntimeError("terminal ledger is missing its sealed archive")
                return ledger
            raise RuntimeError(f"flow receipt ledger is terminal: {raw_ledger.get('state')}")
        if raw_ledger != ledger:
            # Active legacy receipts persist their Tier 3 migration before a
            # terminal gate can reject stale or missing proof.
            self._write(ledger)
            raw_ledger = ledger
        self._recover_stale_terminal_archive(raw_ledger)
        review = self._review_state(ledger)
        if state == "complete":
            direct_pr_required = (
                ledger.get("flow_type") in DIRECT_REVIEW_FLOW_TYPES
                and ledger.get("flow_type") in PR_BOUND_FLOW_TYPES
            )
            if direct_pr_required:
                if not review.get("pr_ref"):
                    raise RuntimeError("complete requires a bound live PR")
                with self._release_ledger_lock_for_revalidation(
                    ledger,
                    changed_error="flow receipt changed during post-merge revalidation",
                ):
                    self._validate_post_merge_receipt(ledger, review)
        # Restore the exact active input if sealing fails. In particular, do
        # not migrate a v1-v3 ledger while rolling an interrupted close back.
        pre_close_ledger = json.loads(json.dumps(raw_ledger))
        ledger["state"] = state
        ledger["closed_at"] = now()
        ledger["updated_at"] = now()
        try:
            self._write(ledger)
            self._archive(ledger)
        except KeyboardInterrupt:
            self._rollback_terminal_seal(pre_close_ledger, ledger)
            raise
        except (RuntimeError, OSError) as error:
            self._rollback_terminal_seal(pre_close_ledger, ledger)
            raise RuntimeError("terminal sealing failed") from error
        return ledger


def git_ledger_root(repo: Path) -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--git-path", "codex-flow"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    path = Path(result.stdout.strip())
    return path if path.is_absolute() else (repo / path).resolve()


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise RuntimeError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    subparsers = parser.add_subparsers(
        dest="action", required=True, parser_class=JsonArgumentParser
    )

    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("--run-id")
    init_parser.add_argument(
        "--flow-type",
        choices=("wave-thread", "fast-track", "normal", "local-merge", "implement-only"),
        required=True,
    )
    init_parser.add_argument("--base-sha", required=True)
    init_parser.add_argument("--head-sha", required=True)
    init_parser.add_argument("--pr-ref")
    init_parser.add_argument("--acceptance-manifest", required=True)

    acceptance_register = subparsers.add_parser("acceptance-register")
    acceptance_register.add_argument("--manifest-file", required=True)

    bind_pr = subparsers.add_parser("bind-pr")
    bind_pr.add_argument("--pr-ref", required=True)

    review_assess = subparsers.add_parser("review-assess")
    review_assess.add_argument("--tier", type=int, choices=sorted(REVIEW_NECESSITY_TIERS), required=True)
    review_assess.add_argument("--reason", required=True)

    record = subparsers.add_parser("record")
    record.add_argument(
        "--kind",
        choices=(
            "validation",
            "review",
            "attestation",
            "convergence",
            "post-merge",
        ),
        required=True,
    )
    record.add_argument("--command", default="")
    record.add_argument("--toolchain-fingerprint", default="")
    record.add_argument("--input-fingerprint", default="")
    record.add_argument("--input-path", action="append", default=[])
    record.add_argument("--log-path")
    record.add_argument("--head-sha")
    record.add_argument("--retry-state-fingerprint")
    record.add_argument("--source-receipt-id")
    record.add_argument("--blocker", action="append", default=[])
    record.add_argument("--review-profile", default="")
    record.add_argument("--base-ref", default="")
    record.add_argument("--review-model", default="")
    record.add_argument("--review-effort", default="")
    record.add_argument("--review-result-json", default="")
    record.add_argument(
        "--review-terminal-state", choices=("completed", "unavailable"), default="completed"
    )
    record.add_argument("--review-unavailability-classification")
    record.add_argument("--wave-id", default="")
    record.add_argument("--lane", default="")
    acceptance_evidence = record.add_mutually_exclusive_group()
    acceptance_evidence.add_argument("--acceptance-evidence-file")
    acceptance_evidence.add_argument("--acceptance-evidence-json")
    record.add_argument("--post-merge-evidence-file")

    review_wave = subparsers.add_parser("review-wave")
    review_wave_subparsers = review_wave.add_subparsers(
        dest="review_wave_action", required=True, parser_class=JsonArgumentParser
    )
    review_wave_open = review_wave_subparsers.add_parser("open")
    review_wave_open.add_argument(
        "--stage", choices=("initial", "repair", "risk-arbitration"), required=True
    )
    review_wave_open.add_argument("--base-ref", required=True)
    review_wave_open.add_argument("--head-sha")
    review_wave_open.add_argument("--lane", action="append", required=True)
    review_wave_open.add_argument("--scope-class", choices=("code", "document", "mechanical"))
    review_wave_open.add_argument("--previous-head-sha")
    review_wave_open.add_argument("--repair-permit-id")
    review_wave_open.add_argument("--high-requirement", action="store_true")
    review_wave_open.add_argument("--arbitration-conflict", action="append", default=[])
    review_wave_open.add_argument(
        "--arbitration-blocker-fingerprint", action="append", default=[]
    )

    review_wave_finalize = review_wave_subparsers.add_parser("finalize")
    review_wave_finalize.add_argument("--wave-id", required=True)
    review_wave_finalize.add_argument("--synthesis-file")

    review_wave_repair = review_wave_subparsers.add_parser("authorize-repair")
    review_wave_repair.add_argument("--wave-id", required=True)

    reopen = subparsers.add_parser("convergence-reopen")
    reopen.add_argument("--authorization-ref", required=True)
    reopen.add_argument("--authorization-text-sha256", required=True)
    reopen.add_argument("--reason", required=True)
    reopen.add_argument("--pr-ref", required=True)
    reopen.add_argument("--user-message-id", required=True)
    reopen.add_argument("--base-ref", required=True)
    reopen.add_argument("--head-sha")

    classify = subparsers.add_parser("classify")
    classify.add_argument("--source-head", required=True)
    classify.add_argument("--head-sha", default="HEAD")

    subparsers.add_parser("status")
    close = subparsers.add_parser("close")
    close.add_argument("--state", choices=sorted(TERMINAL_STATES), required=True)
    return parser


def require_supported_python() -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError("flow_receipt requires Python 3.11 or newer")


def main(argv: list[str] | None = None) -> int:
    require_supported_python()
    args = build_parser().parse_args(argv)
    repo = args.repo.resolve()
    ledger = FlowLedger(git_ledger_root(repo), repo)
    if args.action == "init":
        verified_head, _ = require_clean_current_head(repo, args.head_sha)
        result = ledger.init(
            args.run_id,
            args.flow_type,
            git_commit(repo, args.base_sha),
            verified_head,
            args.pr_ref,
            args.acceptance_manifest,
        )
    elif args.action == "acceptance-register":
        result = ledger.register_acceptance_manifest(args.manifest_file)
    elif args.action == "bind-pr":
        result = ledger.bind_pr(args.pr_ref)
    elif args.action == "review-assess":
        result = ledger.assess_review_necessity(args.tier, args.reason)
    elif args.action == "status":
        result = ledger.status()
    elif args.action == "close":
        result = ledger.close(args.state)
    elif args.action == "classify":
        result = ledger.classify_git_delta(args.source_head, args.head_sha)
    elif args.action == "review-wave":
        if args.review_wave_action == "open":
            result = ledger.open_review_wave(
                stage=args.stage,
                base_ref=args.base_ref,
                head_sha=args.head_sha,
                lane_specs=[parse_lane_spec(raw) for raw in args.lane],
                scope_class=args.scope_class,
                previous_head_sha=args.previous_head_sha,
                repair_permit_id=args.repair_permit_id,
                high_requirement=args.high_requirement,
                arbitration_conflicts=args.arbitration_conflict,
                arbitration_blocker_fingerprints=args.arbitration_blocker_fingerprint,
            )
        elif args.review_wave_action == "finalize":
            result = ledger.finalize_review_wave(args.wave_id, args.synthesis_file)
        elif args.review_wave_action == "authorize-repair":
            result = ledger.authorize_repair(args.wave_id)
        else:
            raise RuntimeError("unsupported review-wave action")
    elif args.action == "convergence-reopen":
        result = ledger.reopen_convergence(
            authorization_ref=args.authorization_ref,
            authorization_text_sha256=args.authorization_text_sha256,
            reason=args.reason,
            pr_ref=args.pr_ref,
            user_message_id=args.user_message_id,
            base_ref=args.base_ref,
            head_sha=args.head_sha,
        )
    elif args.kind == "attestation":
        if not args.source_receipt_id or not args.head_sha or not args.base_ref:
            raise RuntimeError(
                "attestation requires --source-receipt-id, --head-sha, and --base-ref"
            )
        result = ledger.record_attestation(
            args.source_receipt_id,
            args.head_sha,
            args.base_ref,
        )
    elif args.kind == "post-merge":
        if not args.post_merge_evidence_file:
            raise RuntimeError("post-merge record requires --post-merge-evidence-file")
        result = ledger.record_post_merge(args.post_merge_evidence_file)
    elif args.kind == "convergence":
        result = ledger.record_convergence(args.blocker)
    elif args.kind == "review":
        if args.command:
            raise RuntimeError("review record does not accept --command")
        result = ledger.record_subagent_review(
            review_profile=args.review_profile,
            base_ref=args.base_ref,
            review_model=args.review_model,
            review_effort=args.review_effort,
            review_result_json=args.review_result_json,
            review_terminal_state=args.review_terminal_state,
            unavailability_classification=args.review_unavailability_classification,
            head_sha=args.head_sha,
            wave_id=args.wave_id or None,
            lane=args.lane or None,
        )
    else:
        if not args.command or not args.toolchain_fingerprint or not args.input_fingerprint:
            raise RuntimeError(
                "validation record requires --command, --toolchain-fingerprint, "
                "and --input-fingerprint"
            )
        acceptance_evidence = None
        if args.acceptance_evidence_file:
            evidence_path = Path(args.acceptance_evidence_file)
            if not evidence_path.is_absolute():
                evidence_path = (repo / evidence_path).resolve()
            if not evidence_path.is_file():
                raise RuntimeError("acceptance evidence file does not exist")
            acceptance_evidence = normalize_acceptance_evidence(
                json.loads(evidence_path.read_text(encoding="utf-8"))
            )
        elif args.acceptance_evidence_json:
            try:
                acceptance_evidence = normalize_acceptance_evidence(
                    json.loads(args.acceptance_evidence_json)
                )
            except json.JSONDecodeError as error:
                raise RuntimeError("acceptance evidence JSON is not valid") from error
        result = ledger.run_validation(
            args.command,
            args.toolchain_fingerprint,
            args.input_fingerprint,
            kind="validation",
            head_sha=args.head_sha,
            log_path=args.log_path,
            retry_state_fingerprint=args.retry_state_fingerprint,
            input_paths=args.input_path,
            acceptance_evidence=acceptance_evidence,
        )
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


def cli() -> int:
    try:
        return main()
    except KeyboardInterrupt:
        print(json.dumps({"error": "review execution interrupted"}, sort_keys=True))
        return 130
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())
