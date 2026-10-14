#!/usr/bin/env python3
"""Migrate legacy Task Orchestration blocks to wave/task format.

Supported migrations:
1) Legacy dispatch/assign format -> wave/task format.
2) Existing wave format with nested "assign:" prefix -> normalized nested task items.
3) Merge away "## Execution Steps" by removing that section.

The migrator tries to preserve/append task-level skill bindings so output can pass
current plan contract checks.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TASK_ORCH_SECTION_RE = re.compile(
    r"(^## Task Orchestration\s*\n)(.*?)(?=^## |\Z)",
    flags=re.MULTILINE | re.DOTALL,
)
EXECUTION_STEPS_SECTION_RE = re.compile(
    r"^## Execution Steps\s*\n.*?(?=^## |\Z)",
    flags=re.MULTILINE | re.DOTALL,
)
FLOW_TYPE_RE = re.compile(r"`?flow_type`?\s*:\s*`?([^`\s]+)`?", flags=re.IGNORECASE)
WAVE_LINE_RE = re.compile(r"^\s*-\s*wave:\s*(\d+)\s*$")
DISPATCH_LINE_RE = re.compile(r"^\s*-\s*dispatch:\s*(self-run|sub-agents)\s*$")
LEGACY_ASSIGN_RE = re.compile(
    r"^\s*-\s*assign:\s*(main-agent|sub-agent:[A-Za-z0-9_-]+|task:[A-Za-z0-9_-]+)(?:\s+(\[[^]]+\]))?\s*=>\s*(.+?)\s*$"
)
NESTED_LEGACY_ASSIGN_RE = re.compile(
    r"^(\s*)-\s*assign:\s*(main-agent|sub-agent:[A-Za-z0-9_-]+|task:[A-Za-z0-9_-]+)(?:\s+(\[[^]]+\]))?\s*=>\s*(.+?)\s*$"
)
NESTED_TASK_LINE_RE = re.compile(
    r"^(\s*)-\s*(main-agent|sub-agent:[A-Za-z0-9_-]+|task:[A-Za-z0-9_-]+)(?:\s+(\[[^]]+\]))?\s*=>\s*(.+?)\s*$"
)
TASK_LINE_RE = re.compile(
    r"^\s*-\s*(main-agent|sub-agent:[A-Za-z0-9_-]+|task:[A-Za-z0-9_-]+)(?:\s+(\[[^]]+\]))?\s*=>\s*(.+?)\s*$"
)
SKILL_BINDING_RE = re.compile(r"\(skill:[^)]+\)")
SUPPORTED_EFFORTS = {
    "gpt-5.6-luna": {"low", "medium", "high", "xhigh", "max"},
    "gpt-5.6-terra": {"low", "medium", "high", "xhigh", "max", "ultra"},
    "gpt-5.6-sol": {"low", "medium", "high", "xhigh", "max", "ultra"},
    "gpt-6.1-sol": {"low", "medium", "high", "xhigh", "max", "ultra"},
    "gpt-6-luna": {"low", "medium", "high", "xhigh", "max"},
    "gpt-6-sol": {"low", "medium", "high", "xhigh", "max", "ultra"},
    "gpt-6-astra": {"low", "medium", "high", "xhigh", "max", "ultra"},
}
COMPACT_PROFILE_RE = re.compile(r"^\[\s*([^,\]]+)\s*,\s*([^\]]+?)\s*\]$")
LEGACY_MODEL_RE = re.compile(r"\bmodel\s*=\s*(?P<model>gpt-[A-Za-z0-9.-]+)", flags=re.IGNORECASE)
LEGACY_EFFORT_RE = re.compile(
    r"\b(?:model_reasoning_effort|reasoning_effort|effort)\s*=\s*(?P<effort>[A-Za-z0-9_-]+)",
    flags=re.IGNORECASE,
)
LEGACY_PROFILE_MARKER_RE = re.compile(
    r"\b(?:model|model_reasoning_effort|reasoning_effort|effort)\s*=\s*[A-Za-z0-9_.-]+",
    flags=re.IGNORECASE,
)


def canonicalize_skill_name(skill: str) -> str:
    alias_map = {
        "$fast-pr-delivery": "$fast-flow",
        "$codex-review-loop": "$review-agent",
        "$parallel-pr": "$wave-thread-flow",
    }
    return alias_map.get(skill, skill)


def normalize_blank_lines(text: str) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def extract_flow_type(text: str) -> str | None:
    m = FLOW_TYPE_RE.search(text)
    if not m:
        return None
    return m.group(1).strip().lower()


def merge_skill_bindings(bindings: list[str]) -> str | None:
    unique_skills: list[str] = []
    for binding in bindings:
        inside = binding[len("(skill:") : -1].strip()
        for part in inside.split("+"):
            skill = canonicalize_skill_name(part.strip())
            if skill and skill not in unique_skills:
                unique_skills.append(skill)
    # Keep output concise: if primary flow skill exists, drop redundant shared baseline skill.
    if "$normal-flow" in unique_skills and "$project-engineering-workflow" in unique_skills:
        unique_skills = [s for s in unique_skills if s != "$project-engineering-workflow"]
    if "$fast-flow" in unique_skills and "$project-engineering-workflow" in unique_skills:
        unique_skills = [s for s in unique_skills if s != "$project-engineering-workflow"]
    if "$local-merge-flow" in unique_skills and "$project-engineering-workflow" in unique_skills:
        unique_skills = [s for s in unique_skills if s != "$project-engineering-workflow"]
    if "$wave-thread-flow" in unique_skills and "$project-engineering-workflow" in unique_skills:
        unique_skills = [s for s in unique_skills if s != "$project-engineering-workflow"]
    if not unique_skills:
        return None
    return "(skill: " + " + ".join(unique_skills) + ")"


def infer_skill_hint_from_execution_steps(text: str) -> str | None:
    section = EXECUTION_STEPS_SECTION_RE.search(text)
    if not section:
        return None
    bindings = SKILL_BINDING_RE.findall(section.group(0))
    if not bindings:
        return None
    return merge_skill_bindings(bindings)


def default_skill_hint(flow_type: str | None) -> str:
    if flow_type in {"wave-thread", "wave_thread", "wave-thread-flow"}:
        return "(skill: $wave-thread-flow)"
    if flow_type in {"initiative", "initiative-flow", "initiative_flow", "parallel-pr", "parallel_pr", "parallelpr", "parallel-pr-flow"}:
        return "(skill: $wave-thread-flow)"
    if flow_type in {"implement-only", "implement_only"}:
        return "(skill: $implement-only-flow)"
    if flow_type == "normal":
        return "(skill: $normal-flow)"
    if flow_type in {"fast-track", "fast_track", "fast-pr", "fastpr"}:
        return "(skill: $fast-flow)"
    if flow_type in {"local-merge", "local_merge", "localmerge", "local-merge-flow"}:
        return "(skill: $local-merge-flow)"
    return "(skill: $implement-only-flow)"


def ensure_skill(task: str, skill_hint: str) -> str:
    task = task.replace("$codex-review-loop", "$review-agent")
    if SKILL_BINDING_RE.search(task):
        return re.sub(
            r"\$codex-review-loop",
            "$review-agent",
            task.strip(),
        )
    return f"{task.strip()} {skill_hint}".strip()


def default_profile(executor: str, task: str) -> str | None:
    """Attach only the generic migration fallback to delegated tasks.

    The migration step cannot resolve a runtime reviewer or infer a model from
    task wording. Explicit valid profiles are preserved by ``format_executor``;
    everything else gets the same conservative fallback.
    """
    if executor == "main-agent":
        return None
    return "[gpt-5.6-luna, xhigh]"


def extract_legacy_profile(task: str) -> tuple[str | None, str]:
    """Translate old free-text model markers without carrying them forward."""
    markers = list(LEGACY_PROFILE_MARKER_RE.finditer(task))
    if not markers:
        return None, task

    # Treat markers as metadata only when the first one starts the task or
    # follows a metadata delimiter, and the remainder is a delimiter-separated
    # marker block. Inline field names in a legitimate task must survive.
    first = markers[0]
    prefix = task[: first.start()]
    if prefix.strip() and prefix.rstrip()[-1] not in ",;":
        return None, task
    block_end = first.end()
    for marker in markers[1:]:
        between = task[block_end : marker.start()]
        if not re.fullmatch(r"[\s,;]*", between):
            return None, task
        block_end = marker.end()
    suffix = task[block_end:]
    if not re.fullmatch(r"[\s,;]*(?:\(skill:[^)]+\))?[\s,;]*", suffix):
        return None, task

    block = task[first.start() : block_end]
    model_match = LEGACY_MODEL_RE.search(block)
    effort_match = LEGACY_EFFORT_RE.search(block)
    cleaned = prefix.rstrip(" ,;")
    skill_suffix = suffix.strip(" ,;")
    if skill_suffix:
        cleaned = f"{cleaned} {skill_suffix}".strip()

    if model_match is None or effort_match is None:
        # Partial legacy markers are still removed. The caller then supplies
        # the generic fallback instead of emitting text that the new checker
        # would reject.
        return None, cleaned

    profile = f"[{model_match.group('model')}, {effort_match.group('effort')}]"
    return profile, cleaned


def normalize_profile(profile: str | None, task: str) -> str | None:
    """Keep migrated profiles inside the current model and skill matrices."""
    if not profile:
        return None
    match = COMPACT_PROFILE_RE.fullmatch(profile.strip())
    if match is None:
        return None
    model = match.group(1).strip()
    effort = match.group(2).strip()
    if effort not in SUPPORTED_EFFORTS.get(model, set()):
        return None
    return f"[{model}, {effort}]"


def format_executor(executor: str, profile: str | None, task: str) -> str:
    legacy_profile, task = extract_legacy_profile(task)
    if profile is None:
        profile = legacy_profile
    if executor == "main-agent":
        return f"{executor} => {task}"
    profile = normalize_profile(profile, task)
    if profile:
        return f"{executor} {profile} => {task}"
    fallback = default_profile(executor, task)
    if fallback:
        return f"{executor} {fallback} => {task}"
    return f"{executor} => {task}"


def convert_or_normalize_orchestration_body(body: str, skill_hint: str) -> tuple[str, bool, str]:
    lines = body.splitlines()

    has_wave = any(WAVE_LINE_RE.match(line) for line in lines if line.strip())

    if has_wave:
        changed = False
        normalized_lines: list[str] = []
        unsupported_existing: list[str] = []
        for raw in lines:
            m = NESTED_LEGACY_ASSIGN_RE.match(raw)
            if m is None:
                m = NESTED_TASK_LINE_RE.match(raw)
            if m:
                indent, executor, profile, task = m.groups()
                normalized_task = ensure_skill(task.strip(), skill_hint)
                normalized_lines.append(f"{indent}- {format_executor(executor, profile, normalized_task)}")
                changed = True
                continue
            if raw.strip() and not WAVE_LINE_RE.match(raw):
                unsupported_existing.append(raw)
            normalized_lines.append(raw)
        if unsupported_existing:
            return body, False, f"unsupported-existing-wave-lines:{len(unsupported_existing)}"
        new_body = "\n".join(normalized_lines)
        if body.endswith("\n"):
            new_body += "\n"
        return new_body, changed, "normalized-existing-wave-format" if changed else "already-wave-format"

    migrated_items: list[str] = []
    unsupported: list[str] = []

    for raw in lines:
        if not raw.strip():
            continue
        if DISPATCH_LINE_RE.match(raw):
            continue
        m = LEGACY_ASSIGN_RE.match(raw)
        if m:
            executor, profile, task = m.groups()
            task = ensure_skill(task.strip(), skill_hint)
            migrated_items.append(f"  - {format_executor(executor, profile, task)}")
            continue
        m2 = TASK_LINE_RE.match(raw)
        if m2:
            executor, profile, task = m2.groups()
            task = ensure_skill(task.strip(), skill_hint)
            migrated_items.append(f"  - {format_executor(executor, profile, task)}")
            continue
        unsupported.append(raw)

    if unsupported:
        return body, False, f"unsupported-lines:{len(unsupported)}"
    if not migrated_items:
        return body, False, "no-migratable-task-items"

    new_body = "- wave: 1\n" + "\n".join(migrated_items)
    if body.endswith("\n"):
        new_body += "\n"
    return new_body, True, "migrated-to-wave-format"


def migrate_text(text: str) -> tuple[str, int, list[str]]:
    notes: list[str] = []
    converted_count = 0

    flow_type = extract_flow_type(text)
    skill_hint = infer_skill_hint_from_execution_steps(text) or default_skill_hint(flow_type)

    def repl(match: re.Match[str]) -> str:
        nonlocal converted_count
        header = match.group(1)
        body = match.group(2)
        new_body, changed, reason = convert_or_normalize_orchestration_body(body, skill_hint)
        notes.append(reason)
        if changed:
            converted_count += 1
        return header + new_body

    updated = TASK_ORCH_SECTION_RE.sub(repl, text)

    updated, removed_exec = EXECUTION_STEPS_SECTION_RE.subn("", updated)
    if removed_exec > 0:
        converted_count += removed_exec
        notes.append(f"removed-execution-steps:{removed_exec}")

    updated = normalize_blank_lines(updated)
    return updated, converted_count, notes


def process_file(path: Path, in_place: bool) -> int:
    if not path.exists():
        print(f"ERROR {path}: file not found", file=sys.stderr)
        return 1

    original = path.read_text(encoding="utf-8")
    updated, converted, notes = migrate_text(original)

    if in_place and updated != original:
        path.write_text(updated, encoding="utf-8")

    if converted > 0:
        print(f"MIGRATED {path} changes={converted} notes={','.join(notes)}")
    else:
        note = notes[0] if notes else "no-task-orchestration-section"
        print(f"SKIPPED {path} reason={note}")

    if not in_place:
        sys.stdout.write(updated)

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate Task Orchestration from legacy format to wave/task format.",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite files in place. Without this flag, migrated content is printed to stdout.",
    )
    parser.add_argument("files", nargs="+", help="Markdown files to migrate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rc = 0
    for raw in args.files:
        file_rc = process_file(Path(raw), args.in_place)
        if file_rc != 0:
            rc = file_rc
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
