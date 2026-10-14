#!/usr/bin/env python3
"""Focused contract checks for task-scoped PR body image gate."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_SCRIPT_DIR = Path(__file__).resolve().parents[1] / "skills" / "ui-visual-evidence" / "scripts"
if str(SKILL_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_SCRIPT_DIR))

import pr_body_image_gate as gate


def _write(root: str, path: str, content: str | bytes) -> None:
    target = Path(root, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        target.write_bytes(content)
    else:
        target.write_text(content, encoding="utf-8")


def _repo(root: str, owner: str = "octo", repo: str = "demo") -> gate.RepoContext:
    return gate.RepoContext(host="github.com", owner=owner, repo=repo, repo_root=root)


def _git_head_with_fixture(root: str) -> str:
    tracked = [path for path in Path(root).rglob("*") if path.is_file() and ".git" not in path.parts]
    if not tracked:
        return "a" * 40
    subprocess.run(["git", "init", "-q", root], check=True)
    subprocess.run(["git", "-C", root, "config", "user.email", "test@example.invalid"], check=True)
    subprocess.run(["git", "-C", root, "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", root, "add", "-A"], check=True)
    subprocess.run(["git", "-C", root, "commit", "-qm", "fixture"], check=True)
    return subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()


def _html_for_body(body: str) -> str:
    marker = "## Visual Evidence"
    section = body.split(marker, 1)[1] if marker in body else ""
    section = section.split("\n## ", 1)[0]
    images = []
    for match in gate.IMAGE_MARKDOWN_RE.finditer(section):
        url = match.group("path").strip("<>")
        alt = match.group("alt") or "visual evidence"
        images.append(f'<p><a href="{url}"><img src="{url}" alt="{alt}"></a></p>')
    if not images and "None" in section:
        images.append("<p>None</p>")
    return "<h2>Visual Evidence</h2>" + "".join(images)


class FakeGateway:
    def __init__(self, pr: gate.PrContext) -> None:
        self.pr = pr
        self.pr.body_html = _html_for_body(pr.body)

    def read_pr(self, base_repo: gate.RepoContext, pr_number: int) -> gate.PrContext:
        return gate.PrContext(**self.pr.__dict__)

    def edit_pr_body(self, base_repo: gate.RepoContext, pr_number: int, body: str) -> None:
        self.pr.body = body
        self.pr.body_html = _html_for_body(body)


def _run_case(case: dict[str, object]) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as root:
        for repo_path, content in dict(case.get("source_files", {})).items():
            _write(root, str(repo_path), str(content))
        for repo_path in case.get("image_files", []):
            _write(root, str(repo_path), b"image")
        head_sha = _git_head_with_fixture(root)
        base_repo = _repo(root)
        head_repo = _repo(root, owner="forker", repo="demo-fork")
        pr = gate.PrContext(
            number=int(case.get("pr_number", 123)),
            url="https://github.com/octo/demo/pull/123",
            state=str(case.get("state", "OPEN")),
            body=str(case.get("pr_body", "")),
            body_html="",
            head_sha=str(case.get("head_sha", head_sha)),
            head_ref=str(case.get("head_ref", "th/replay")),
            merge_sha=str(case.get("merge_sha", head_sha)),
            head_repo=head_repo,
            base_repo=base_repo,
        )
        result = gate.run_gate(
            FakeGateway(pr),
            base_repo=base_repo,
            pr_number=pr.number,
            phase=str(case["phase"]),
            evidence_paths=case.get("evidence_paths"),
            no_evidence=bool(case.get("no_evidence", False)),
        )
        expected_state = str(case["expected_state"])
        expected_reasons = [str(reason) for reason in case.get("expected_reasons", [])]
        expected_paths = [str(path) for path in case.get("expected_paths", [])]
        actual_paths = [str(item["repo_path"]) for item in result.selected_images]
        ok = result.state == expected_state and all(reason in result.reasons for reason in expected_reasons) and (not expected_paths or actual_paths == expected_paths)
        return ok, f"{case['name']}: state={result.state} reasons={result.reasons} paths={actual_paths}"


def _run_status_text_case(case: dict[str, object]) -> tuple[bool, str]:
    text = str(case["text"])
    required = [str(item) for item in case.get("required", [])]
    forbidden = [str(item) for item in case.get("forbidden", [])]
    ok = all(token in text for token in required) and all(token not in text for token in forbidden)
    return ok, f"{case['name']}: status text contract {'satisfied' if ok else 'failed'}"


def run_cases(cases_path: Path) -> int:
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    overall_ok = True
    for case in cases:
        if case["type"] == "gate":
            ok, message = _run_case(case)
        elif case["type"] == "status_text":
            ok, message = _run_status_text_case(case)
        else:
            ok, message = False, f"{case['name']}: unknown case type {case['type']}"
        print(("PASS" if ok else "FAIL") + " " + message)
        overall_ok = overall_ok and ok
    return 0 if overall_ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    default_cases = Path(__file__).resolve().parents[1] / "skills" / "ui-visual-evidence" / "replay" / "cases.json"
    parser.add_argument("--cases", type=Path, default=default_cases)
    return run_cases(parser.parse_args().cases.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
