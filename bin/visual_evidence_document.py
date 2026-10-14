#!/usr/bin/env python3
"""Migrate and check retired visual-evidence document markup.

The command is intentionally narrow: callers must identify the documents that
are already part of the current change.  It never walks the repository and it
never changes image assets.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


sys.dont_write_bytecode = True

CHECK_FAILED_EXIT = 20

TARGET_RE = re.compile(
    r"^docs/(?:specs/.+/(?:SPEC|PLAN)\.md|plan/.+/PLAN\.md)$"
)
HEADING_RE = re.compile(r"^(?P<hashes>#{1,6})\s+(?P<title>.*?)\s*$")
CANONICAL_HEADING = "## Visual Evidence"
LEGACY_HEADING = "## Visual Evidence (PR)"
SELECTOR_RE = re.compile(r"^PR:\s*(?:include|none)\s*$", re.IGNORECASE)
IMAGE_RE = re.compile(r"!\[[^\]]*\]\((?:<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)")
PATCH_PATH_RE = re.compile(r"^(?:\+\+\+|---)\s+(?P<path>[^\t\r\n]+)", re.MULTILINE)
APPLY_PATCH_PATH_RE = re.compile(
    r"^\*\*\*\s+(?P<action>Update|Add|Delete)\s+File:\s+(?P<path>[^\t\r\n]+)",
    re.MULTILINE,
)
APPLY_PATCH_MOVE_RE = re.compile(r"^\*\*\*\s+Move\s+to:\s+(?P<path>[^\t\r\n]+)", re.MULTILINE)


class DocumentError(RuntimeError):
    """A document cannot be safely migrated or checked."""


@dataclass(frozen=True)
class Section:
    kind: str
    level: int
    heading_index: int
    end_index: int
    has_images: bool


def _is_target_path(path: str) -> bool:
    return bool(TARGET_RE.fullmatch(path))


def _is_indented_code_line(line: str) -> bool:
    return line.startswith("    ") or line.startswith("\t")


def _normalize_heading_title(title: str) -> str:
    return re.sub(r"\s+#+\s*$", "", title).strip()


def _relative_path(raw_path: str, root: Path) -> str:
    candidate = Path(raw_path.strip())
    if candidate.is_absolute() or ".." in candidate.parts:
        raise DocumentError(f"target path is not repo-relative: {raw_path}")
    normalized = candidate.as_posix()
    if not _is_target_path(normalized):
        raise DocumentError(f"unsupported visual-evidence document: {normalized}")
    absolute = (root / candidate).resolve(strict=False)
    root_resolved = root.resolve()
    try:
        absolute.relative_to(root_resolved)
    except ValueError as exc:
        raise DocumentError(f"target path escapes repository: {raw_path}") from exc
    return normalized


def _read_document(path: Path) -> str:
    if path.is_symlink():
        raise DocumentError(f"target document is a symlink: {path}")
    if not path.is_file():
        raise DocumentError(f"target document is missing: {path}")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise DocumentError(f"target document is unreadable: {path}") from exc


def _sections(lines: list[str]) -> list[Section]:
    headings: list[tuple[int, int, str]] = []
    fence_char: str | None = None
    fence_length = 0
    for index, line in enumerate(lines):
        if _is_indented_code_line(line):
            continue
        stripped = line.strip()
        fence_match = re.match(r"^(`{3,}|~{3,})(.*)$", stripped)
        if fence_char is not None:
            if (
                fence_match
                and fence_match.group(1)[0] == fence_char
                and len(fence_match.group(1)) >= fence_length
                and not fence_match.group(2).strip()
            ):
                fence_char = None
                fence_length = 0
            continue
        if fence_match:
            fence_char = fence_match.group(1)[0]
            fence_length = len(fence_match.group(1))
            continue
        match = HEADING_RE.match(stripped)
        if match:
            headings.append((index, len(match.group("hashes")), _normalize_heading_title(match.group("title"))))

    found: list[Section] = []
    for heading_position, (index, level, title) in enumerate(headings):
        if title == "Visual Evidence":
            kind = "canonical"
        elif title == "Visual Evidence (PR)":
            kind = "legacy"
        else:
            continue
        end_index = len(lines)
        for next_index, next_level, _ in headings[heading_position + 1 :]:
            if next_level <= level:
                end_index = next_index
                break
        body_lines = lines[index + 1 : end_index]
        found.append(
            Section(
                kind=kind,
                level=level,
                heading_index=index,
                end_index=end_index,
                has_images=_has_active_images(body_lines),
            )
        )
    return found


def _active_selector_lines(lines: list[str]) -> list[int]:
    indexes: list[int] = []
    fence_char: str | None = None
    fence_length = 0
    for index, line in enumerate(lines):
        if _is_indented_code_line(line):
            continue
        stripped = line.strip()
        fence_match = re.match(r"^(`{3,}|~{3,})(.*)$", stripped)
        if fence_char is not None:
            if (
                fence_match
                and fence_match.group(1)[0] == fence_char
                and len(fence_match.group(1)) >= fence_length
                and not fence_match.group(2).strip()
            ):
                fence_char = None
                fence_length = 0
            continue
        if fence_match:
            fence_char = fence_match.group(1)[0]
            fence_length = len(fence_match.group(1))
            continue
        if SELECTOR_RE.fullmatch(stripped):
            indexes.append(index)
    return indexes


def _has_active_images(lines: list[str]) -> bool:
    fence_char: str | None = None
    fence_length = 0
    for line in lines:
        if _is_indented_code_line(line):
            continue
        stripped = line.strip()
        fence_match = re.match(r"^(`{3,}|~{3,})(.*)$", stripped)
        if fence_char is not None:
            if (
                fence_match
                and fence_match.group(1)[0] == fence_char
                and len(fence_match.group(1)) >= fence_length
                and not fence_match.group(2).strip()
            ):
                fence_char = None
                fence_length = 0
            continue
        if fence_match:
            fence_char = fence_match.group(1)[0]
            fence_length = len(fence_match.group(1))
            continue
        if IMAGE_RE.search(stripped):
            return True
    return False


def _has_unterminated_fence(lines: list[str]) -> bool:
    fence_char: str | None = None
    fence_length = 0
    for line in lines:
        if _is_indented_code_line(line):
            continue
        stripped = line.strip()
        fence_match = re.match(r"^(`{3,}|~{3,})(.*)$", stripped)
        if fence_char is not None:
            if (
                fence_match
                and fence_match.group(1)[0] == fence_char
                and len(fence_match.group(1)) >= fence_length
                and not fence_match.group(2).strip()
            ):
                fence_char = None
                fence_length = 0
            continue
        if fence_match:
            fence_char = fence_match.group(1)[0]
            fence_length = len(fence_match.group(1))
    return fence_char is not None


def _migration_conflict(sections: list[Section]) -> str | None:
    canonical = [section for section in sections if section.kind == "canonical"]
    legacy = [section for section in sections if section.kind == "legacy"]
    if any(section.level != 2 for section in (*canonical, *legacy)):
        return "visual_evidence_heading_level_ambiguous"
    if len(canonical) > 1:
        return "duplicate_canonical_visual_evidence_sections"
    if len(legacy) > 1:
        return "duplicate_legacy_visual_evidence_sections"
    if canonical and legacy and canonical[0].has_images and legacy[0].has_images:
        return "canonical_and_legacy_sections_both_have_images"
    return None


def _merge_legacy_into_canonical(lines: list[str], canonical: Section, legacy: Section) -> list[str]:
    """Keep all prose and images while retiring the duplicate legacy heading."""

    legacy_body = lines[legacy.heading_index + 1 : legacy.end_index]
    legacy_length = legacy.end_index - legacy.heading_index
    result = lines[: legacy.heading_index] + lines[legacy.end_index :]

    # Recompute the canonical range after removing the complete legacy block.
    canonical_end = canonical.end_index
    if legacy.heading_index < canonical.heading_index:
        canonical_end -= legacy_length

    # The legacy body is retained under the canonical section.  This handles
    # either source order without leaving prose attached to an unrelated
    # heading or the document preamble.
    if legacy_body:
        result[canonical_end:canonical_end] = legacy_body
    return result


def _migrate_text(text: str) -> tuple[str, list[str]]:
    had_final_newline = text.endswith("\n")
    lines = text.splitlines()
    if _has_unterminated_fence(lines):
        raise DocumentError("unterminated_code_fence")
    sections = _sections(lines)
    conflict = _migration_conflict(sections)
    if conflict:
        raise DocumentError(conflict)

    changed: list[str] = []
    selector_indexes = _active_selector_lines(lines)
    if selector_indexes:
        changed.append("retired_selector_lines_removed")
        lines = [line for index, line in enumerate(lines) if index not in set(selector_indexes)]
        sections = _sections(lines)

    canonical = [section for section in sections if section.kind == "canonical"]
    legacy = [section for section in sections if section.kind == "legacy"]
    if legacy:
        legacy_section = legacy[0]
        if not canonical:
            lines[legacy_section.heading_index] = CANONICAL_HEADING
            changed.append("legacy_heading_normalized")
        else:
            lines = _merge_legacy_into_canonical(lines, canonical[0], legacy_section)
            changed.append("legacy_heading_merged_into_canonical")

    migrated = "\n".join(lines)
    if had_final_newline:
        migrated += "\n"
    return migrated, changed


def migrate_path(root: Path, relative_path: str) -> dict[str, Any]:
    normalized = _relative_path(relative_path, root)
    path = root / normalized
    original = _read_document(path)
    migrated, changes = _migrate_text(original)
    if migrated != original:
        path.write_text(migrated, encoding="utf-8")
    return {"path": normalized, "changed": migrated != original, "changes": changes}


def check_path(root: Path, relative_path: str) -> dict[str, Any]:
    normalized = _relative_path(relative_path, root)
    text = _read_document(root / normalized)
    lines = text.splitlines()
    if _has_unterminated_fence(lines):
        raise DocumentError(f"{normalized}: unterminated_code_fence")
    sections = _sections(lines)
    conflict = _migration_conflict(sections)
    reasons: list[str] = []
    if conflict:
        reasons.append(conflict)
    if _active_selector_lines(lines):
        reasons.append("retired_selector_markup_present")
    if any(section.kind == "legacy" for section in sections):
        reasons.append("legacy_visual_evidence_heading_present")
    if reasons:
        raise DocumentError(f"{normalized}: {','.join(sorted(set(reasons)))}")
    return {"path": normalized, "state": "passed"}


def _changed_target_paths(root: Path, base_sha: str) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--name-status", "-z", "--find-renames", base_sha, "--"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise DocumentError(f"unable to inspect changed paths: {detail}")
    paths: set[str] = set()
    fields = proc.stdout.split("\0")
    index = 0
    while index < len(fields) and fields[index]:
        status = fields[index]
        index += 1
        code = status[:1]
        if code in {"R", "C"}:
            if index + 1 >= len(fields):
                raise DocumentError("unable to parse changed paths: incomplete rename/copy record")
            path = fields[index + 1]
            index += 2
        else:
            if index >= len(fields):
                raise DocumentError("unable to parse changed paths: missing path record")
            path = fields[index]
            index += 1
        if code == "D":
            continue
        path = path.strip()
        if path and _is_target_path(path):
            paths.add(path)
    return sorted(paths)


def _patch_paths(command: str) -> Iterable[str]:
    for match in PATCH_PATH_RE.finditer(command):
        path = match.group("path").strip().strip('"')
        if path == "/dev/null":
            continue
        if path.startswith(("a/", "b/")):
            path = path[2:]
        yield path
    native_paths: list[str] = []
    pending_update: str | None = None
    for line in command.splitlines():
        file_match = APPLY_PATCH_PATH_RE.match(line)
        if file_match:
            action = file_match.group("action")
            path = file_match.group("path").strip().strip('"')
            pending_update = path if action == "Update" else None
            if action != "Delete":
                native_paths.append(path)
            continue
        move_match = APPLY_PATCH_MOVE_RE.match(line)
        if move_match:
            destination = move_match.group("path").strip().strip('"')
            if pending_update is not None:
                native_paths.remove(pending_update)
            native_paths.append(destination)
            pending_update = None
    yield from native_paths


def _hook_paths(event: dict[str, Any], root: Path) -> list[str]:
    paths: set[str] = set()
    tool_input = event.get("tool_input", event.get("toolInput", event.get("input")))
    if isinstance(tool_input, str):
        paths.update(_patch_paths(tool_input))
    if isinstance(tool_input, dict):
        for key in ("file_path", "path"):
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                paths.add(value.strip())
        for key in ("command", "patch", "input", "text"):
            value = tool_input.get(key)
            if isinstance(value, str):
                paths.update(_patch_paths(value))
    for key in ("file_path", "path"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            paths.add(value.strip())

    normalized: set[str] = set()
    for raw_path in paths:
        candidate = Path(raw_path)
        if candidate.is_absolute():
            try:
                candidate = candidate.resolve().relative_to(root.resolve())
            except ValueError:
                continue
        path = candidate.as_posix()
        if _is_target_path(path):
            normalized.add(path)
    return sorted(normalized)


def run_hook(root: Path) -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    paths = _hook_paths(payload, root)
    if not paths:
        return 0

    results: list[dict[str, Any]] = []
    blockers: list[str] = []
    for path in paths:
        try:
            migration = migrate_path(root, path)
            check = check_path(root, path)
            results.append({"migration": migration, "check": check})
        except DocumentError as exc:
            blockers.append(str(exc))

    context_lines = ["Visual-evidence document hook inspected the edited target files."]
    if results:
        changed_paths = [item["migration"]["path"] for item in results if item["migration"]["changed"]]
        if changed_paths:
            context_lines.append("Safe migration applied: " + ", ".join(changed_paths) + ".")
        context_lines.append("Run the final document check before PR convergence.")
    if blockers:
        context_lines.append("BLOCKER: " + " | ".join(blockers))
        context_lines.append("Do not continue to PR convergence until the document ambiguity is resolved.")

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": " ".join(context_lines),
                }
            },
            ensure_ascii=False,
        )
    )
    return 0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("migrate", "check"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--path", action="append", default=[])
        if command == "check":
            subparser.add_argument("--changed-from")
    subparsers.add_parser("hook")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = args.repo_root.resolve()
    if args.command == "hook":
        return run_hook(root)

    paths = list(args.path)
    if args.command == "check" and args.changed_from:
        try:
            paths.extend(_changed_target_paths(root, args.changed_from))
        except DocumentError as exc:
            print(str(exc), file=sys.stderr)
            return CHECK_FAILED_EXIT
    if not paths:
        print("at least one --path or --changed-from is required", file=sys.stderr)
        return CHECK_FAILED_EXIT

    results: list[dict[str, Any]] = []
    try:
        for path in dict.fromkeys(paths):
            if args.command == "migrate":
                results.append(migrate_path(root, path))
            else:
                results.append(check_path(root, path))
    except DocumentError as exc:
        print(str(exc), file=sys.stderr)
        return CHECK_FAILED_EXIT
    print(json.dumps({"state": "passed", "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
