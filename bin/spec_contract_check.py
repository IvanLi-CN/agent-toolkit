#!/usr/bin/env python3
"""Validate the structure of a canonical topic requirements specification."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


TOP_LEVEL_RE = re.compile(r"^##\s+(.+?)\s*$")
REQ_RE = re.compile(r"\bREQ-[A-Z0-9][A-Z0-9_-]*\b")
VER_RE = re.compile(r"\bVER-[A-Z0-9][A-Z0-9_-]*\b")
NORMATIVE_RE = re.compile(r"\b(MUST|SHALL|SHOULD|MAY NOT|MUST NOT)\b|必须|不得|仅可|只能|应当|不可", re.I)
UNRESOLVED_RE = re.compile(r"\b(TBD|TBA|TBC|TODO|TO BE DETERMINED|TO BE CONFIRMED|OPEN QUESTION)\b|待确认|待定|未决", re.I)

FORBIDDEN_HEADINGS = (
    "acceptance checklist",
    "quality gates",
    "related prs",
    "related pr",
    "pull requests",
    "pr checklist",
    "related changes",
    "test commands",
    "verification commands",
    "risks",
    "open questions",
    "assumptions",
    "task orchestration",
    "execution steps",
    "current status",
    "milestones",
    "implementation status",
    "delivery status",
    "execution",
)


def root_path() -> Path:
    return Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip())


def emit(path: str, code: str, message: str, line: int | None = None) -> str:
    suffix = f" line={line}" if line else ""
    return f"path={path} code={code} msg={message}{suffix}"


def check(path: Path, root: Path) -> list[str]:
    try:
        rel = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return [emit(str(path), "SPEC_PATH_INVALID", "Spec path must remain inside the repository root")]
    errors: list[str] = []
    if not re.fullmatch(r"docs/specs/[a-z0-9]+(?:-[a-z0-9]+)*/SPEC\.md", rel):
        return [emit(rel, "SPEC_PATH_INVALID", "strict checking only applies to canonical docs/specs/<slug>/SPEC.md")]
    if path.is_symlink() or not path.is_file():
        return [emit(rel, "SPEC_NOT_REGULAR_FILE", "Spec must be a regular file")]
    lines = path.read_text(encoding="utf-8").splitlines()
    headings: dict[str, tuple[int, list[str]]] = {}
    current: str | None = None
    body: list[str] = []
    start = 0
    for number, line in enumerate(lines, 1):
        match = TOP_LEVEL_RE.match(line)
        if match:
            if current is not None:
                headings[current] = (start, body)
            current = match.group(1).strip()
            start = number
            body = []
        elif current is not None:
            body.append(line)
    if current is not None:
        headings[current] = (start, body)

    for required in ("Context and Scope", "Requirements", "Verification", "Related ADRs"):
        if required not in headings:
            errors.append(emit(rel, "SPEC_SECTION_MISSING", f"missing required section: ## {required}"))
    for heading, (line, _) in headings.items():
        normalized = heading.lower().strip()
        if any(normalized == forbidden or normalized.startswith(forbidden + " ") for forbidden in FORBIDDEN_HEADINGS):
            errors.append(emit(rel, "SPEC_FORBIDDEN_SECTION", f"task-state or execution section is not allowed in SPEC.md: ## {heading}", line))

    for number, line in enumerate(lines, 1):
        if re.match(r"^\s*-\s*\[[ xX]\]", line):
            errors.append(emit(rel, "SPEC_CHECKBOX_FORBIDDEN", "SPEC.md cannot contain checkbox progress", number))

    requirements = "\n".join(headings.get("Requirements", (0, []))[1])
    verification = "\n".join(headings.get("Verification", (0, []))[1])
    req_ids = sorted(set(REQ_RE.findall(requirements)))
    ver_ids = sorted(set(VER_RE.findall(verification)))
    if not req_ids:
        errors.append(emit(rel, "SPEC_REQUIREMENTS_MISSING", "Requirements must declare stable REQ-* identifiers"))
    if not ver_ids:
        errors.append(emit(rel, "SPEC_VERIFICATION_MISSING", "Verification must declare stable VER-* identifiers"))
    if requirements and not NORMATIVE_RE.search(requirements):
        errors.append(emit(rel, "SPEC_NORMATIVE_BOUNDARY_MISSING", "Requirements must contain normative MUST/SHALL or Chinese normative language"))
    for req_id in req_ids:
        if not re.search(rf"(?:covers?|覆盖)\s*[:=]\s*[^\n]*\b{re.escape(req_id)}\b", verification, re.I):
            errors.append(emit(rel, "SPEC_TRACEABILITY_MISSING", f"no VER-* verification explicitly covers {req_id}"))
    for ver_id in ver_ids:
        occurrences = len(re.findall(rf"\b{re.escape(ver_id)}\b", verification))
        if occurrences < 1:
            errors.append(emit(rel, "SPEC_VERIFICATION_INVALID", f"verification id {ver_id} is not readable"))

    if "Related ADRs" in headings:
        adr_lines = [line for line in headings["Related ADRs"][1] if line.strip()]
        if not adr_lines:
            errors.append(emit(rel, "SPEC_RELATED_ADRS_INVALID", "Related ADRs must be exactly None or contain ADR links"))
        elif adr_lines != ["None"]:
            paths: list[str] = []
            for line in adr_lines:
                match = re.fullmatch(r"-\s+\[[^]]+\]\(\.\./\.\./(adr/[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)\)", line)
                if not match:
                    errors.append(emit(rel, "SPEC_RELATED_ADRS_INVALID", f"invalid Related ADRs entry: {line}"))
                    continue
                paths.append("docs/" + match.group(1))
                if not (root / paths[-1]).is_file():
                    errors.append(emit(rel, "SPEC_RELATED_ADRS_INVALID", f"missing ADR target: {paths[-1]}"))
            if paths != sorted(set(paths)):
                errors.append(emit(rel, "SPEC_RELATED_ADRS_INVALID", "Related ADRs must be path-sorted and duplicate-free"))

    for number, line in enumerate(lines, 1):
        if UNRESOLVED_RE.search(line) and not line.lstrip().startswith((">", "<!--")):
            errors.append(emit(rel, "SPEC_UNRESOLVED_DECISION", "unresolved decision markers do not belong in canonical SPEC.md", number))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", action="append", required=True)
    parser.add_argument("--repo-root", type=Path)
    args = parser.parse_args()
    root = args.repo_root.resolve() if args.repo_root else root_path()
    errors: list[str] = []
    for raw in args.path:
        candidate = (root / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
        errors.extend(check(candidate, root))
    if errors:
        for error in errors:
            print(error)
        return 1
    for raw in args.path:
        print(f"PASS path={raw} checks=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
