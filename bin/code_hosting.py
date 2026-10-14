#!/usr/bin/env python3
"""Provider-neutral control-plane adapter for supported code hosts.

The adapter owns provider-specific commands and response shapes. Callers use
repository-bound semantic operations and consume the JSON envelope emitted by
the CLI or the typed backend methods.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit


SCHEMA_VERSION = 1
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SUPPORTED_HOSTS = {"github.com": "github"}
GITEA_HOST_ENV = "AGENT_GITEA_HOST"
REMOTE_RE = re.compile(r"^(?:[^@/]+@)?(?P<host>[^:/]+):(?P<path>.+)$")
HTTP_STATUS_RE = re.compile(r"HTTP/[0-9.]+\s+(\d{3})")
REPOSITORY_NAME_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
SENSITIVE_KEY_RE = re.compile(r"(?:token|authorization|password|passwd|secret|cookie|credential|private[_-]?key)", re.IGNORECASE)
GITHUB_PLAN_LIMITED_PROTECTION_MESSAGE = "Upgrade to GitHub Pro or make this repository public to enable this feature."


class AdapterError(RuntimeError):
    """A safe, structured adapter failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        operation: str = "unknown",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.operation = operation
        self.details = details or {}

    def envelope(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "operation": self.operation,
            "outcome": self.code,
            "error": {"code": self.code, "message": self.message, "details": self.details},
        }


@dataclass(frozen=True)
class RepositoryBinding:
    provider: str
    host: str
    owner: str
    repo: str
    remote: str
    web_origin: str
    api_origin: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def web_url(self) -> str:
        return f"{self.web_origin}/{self.full_name}"

    def as_dict(self) -> dict[str, str]:
        return {
            "provider": self.provider,
            "host": self.host,
            "owner": self.owner,
            "repo": self.repo,
            "full_name": self.full_name,
            "remote": self.remote,
            "web_origin": self.web_origin,
            "api_origin": self.api_origin,
            "web_url": self.web_url,
        }


@dataclass(frozen=True)
class ApiResponse:
    status: int | None
    payload: Any
    stdout: str
    stderr: str
    returncode: int
    observed_at: str


Runner = Callable[[list[str], str | None, str | None], subprocess.CompletedProcess[str]]


def _run_command(
    argv: list[str], cwd: str | None = None, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            argv,
            cwd=cwd,
            input=input_text,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise AdapterError("command_unavailable", "provider command could not be started") from error


def _status_from_output(stdout: str, stderr: str) -> int | None:
    matches = HTTP_STATUS_RE.findall(f"{stdout}\n{stderr}")
    return int(matches[-1]) if matches else None


def _safe_json(text: str) -> Any:
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # `--include` can prepend response headers. Only use this fallback for
        # response bodies that still contain one complete JSON value.
        for marker in ("{", "[", '"'):
            index = text.find(marker)
            if index < 0:
                continue
            try:
                return json.loads(text[index:])
            except json.JSONDecodeError:
                continue
    return text


def _redact_provider_value(value: Any, *, key: str | None = None) -> Any:
    """Keep provider evidence useful without serializing credential-like fields."""
    if key and SENSITIVE_KEY_RE.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(item_key): _redact_provider_value(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [_redact_provider_value(item) for item in value]
    if isinstance(value, tuple):
        return [_redact_provider_value(item) for item in value]
    if isinstance(value, str) and key and key.lower() in {"url", "html_url", "target_url", "details_url"}:
        try:
            parsed = urlsplit(value)
            # Provider links may contain basic-auth style userinfo. It is not
            # useful evidence and must never survive into a receipt.
            safe_netloc = parsed.netloc.rsplit("@", 1)[-1]
            query = []
            for query_key, query_value in parse_qsl(parsed.query, keep_blank_values=True):
                query.append((query_key, "[REDACTED]" if SENSITIVE_KEY_RE.search(query_key) else query_value))
            return urlunsplit((parsed.scheme, safe_netloc, parsed.path, urlencode(query), parsed.fragment))
        except ValueError:
            return value
    return value


def _require_repository_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not REPOSITORY_NAME_RE.fullmatch(value):
        raise AdapterError("provider_identity_mismatch", f"provider returned an invalid {label} repository identity", operation="pr-facts")
    owner, repo = value.split("/", 1)
    if any(
        part in {".", ".."}
        or "%2f" in part.lower()
        or "%5c" in part.lower()
        or any(ord(character) < 32 or ord(character) == 127 or character == "\\" for character in part)
        for part in (owner, repo)
    ):
        raise AdapterError("provider_identity_mismatch", f"provider returned an invalid {label} repository identity", operation="pr-facts")
    return value


def _require_sha(value: str, label: str) -> str:
    if not SHA_RE.fullmatch(value.strip()):
        raise AdapterError("invalid_sha", f"{label} must be a 40-character commit SHA")
    return value.strip().lower()


def _repo_parts(path: str) -> tuple[str, str]:
    raw_parts = [part for part in path.strip("/").split("/") if part]
    parts = [unquote(part) for part in raw_parts]
    if len(parts) != 2 or any(part in {".", ".."} for part in parts):
        raise AdapterError("invalid_repository", "remote URL must contain exactly owner/repo")
    owner, repo = parts
    if repo.endswith(".git"):
        repo = repo[:-4]
    if (
        not owner
        or not repo
        or any("/" in part or "\\" in part or "\x00" in part for part in parts)
        or "." in owner and owner == ".."
    ):
        raise AdapterError("invalid_repository", "remote URL contains an invalid owner/repo")
    return owner, repo


def parse_git_remote(raw: str) -> tuple[str, str, str]:
    """Parse standard Git SSH, scp-like, and HTTPS remote forms."""

    value = raw.strip()
    if not value:
        raise AdapterError("invalid_remote", "Git remote URL is empty")
    if "://" in value:
        parsed = urlsplit(value)
        try:
            port = parsed.port
        except ValueError as error:
            raise AdapterError("invalid_remote", "Git remote URL has an invalid port") from error
        allowed_port = {"http": 80, "https": 443, "ssh": 22}.get(parsed.scheme.lower())
        if allowed_port is None or not parsed.hostname or port not in {None, allowed_port}:
            raise AdapterError("invalid_remote", "Git remote URL has an unsupported scheme")
        host = parsed.hostname.lower()
        owner, repo = _repo_parts(parsed.path)
        return host, owner, repo
    match = REMOTE_RE.fullmatch(value)
    if match is None:
        raise AdapterError("invalid_remote", "Git remote URL is not SSH scp-like or URI form")
    host = match.group("host").lower()
    owner, repo = _repo_parts(match.group("path"))
    return host, owner, repo


def binding_from_remote(raw: str, remote: str) -> RepositoryBinding:
    host, owner, repo = parse_git_remote(raw)
    provider = SUPPORTED_HOSTS.get(host)
    if provider is None and host == os.environ.get(GITEA_HOST_ENV, "gitea.example.com").strip().lower():
        provider = "gitea"
    if provider is None:
        raise AdapterError("unsupported_host", f"code-hosting host is not allowlisted: {host}")
    web_origin = f"https://{host}"
    api_origin = "https://api.github.com" if provider == "github" else f"{web_origin}/api/v1"
    return RepositoryBinding(provider, host, owner, repo, remote, web_origin, api_origin)


def resolve_repository(
    repo_root: str | Path,
    remote: str,
    *,
    runner: Runner = _run_command,
) -> RepositoryBinding:
    root = str(Path(repo_root).resolve())
    result = runner(["git", "remote", "get-url", remote], root, None)
    if result.returncode != 0:
        raise AdapterError(
            "remote_unavailable",
            "selected Git remote could not be resolved",
            details={"remote": remote},
        )
    return binding_from_remote(result.stdout, remote)


def _remote_names(repo_root: str | Path, *, runner: Runner = _run_command) -> list[str]:
    result = runner(["git", "remote"], str(Path(repo_root).resolve()), None)
    if result.returncode != 0:
        raise AdapterError("remote_unavailable", "Git remotes could not be listed")
    return [name.strip() for name in result.stdout.splitlines() if name.strip()]


def repository_candidates(
    repo_root: str | Path, *, runner: Runner = _run_command
) -> list[RepositoryBinding]:
    candidates: list[RepositoryBinding] = []
    for remote in _remote_names(repo_root, runner=runner):
        try:
            candidates.append(resolve_repository(repo_root, remote, runner=runner))
        except AdapterError as error:
            if error.code not in {"unsupported_host", "invalid_remote"}:
                raise
    return candidates


def resolve_unique_repository(
    repo_root: str | Path,
    *,
    full_name: str | None = None,
    host: str | None = None,
    remote: str | None = None,
    runner: Runner = _run_command,
) -> RepositoryBinding:
    remote_names = _remote_names(repo_root, runner=runner)
    preferred_remote = remote or os.environ.get("BASE_REMOTE") or ("origin" if "origin" in remote_names else None)
    if preferred_remote:
        binding = resolve_repository(repo_root, preferred_remote, runner=runner)
        if full_name and binding.full_name.lower() != full_name.lower():
            raise AdapterError(
                "cross_repository",
                "PR or repository selector does not match the approved base remote",
                details={"expected": binding.full_name, "received": full_name},
            )
        if host and binding.host.lower() != host.lower():
            raise AdapterError(
                "cross_host",
                "URL host does not match the approved base remote",
                details={"expected": binding.host, "received": host},
            )
        return binding
    candidates: list[RepositoryBinding] = []
    for candidate_remote in remote_names:
        try:
            candidates.append(resolve_repository(repo_root, candidate_remote, runner=runner))
        except AdapterError as error:
            if error.code not in {"unsupported_host", "invalid_remote"}:
                raise
    if full_name:
        candidates = [candidate for candidate in candidates if candidate.full_name.lower() == full_name.lower()]
    if host:
        candidates = [candidate for candidate in candidates if candidate.host.lower() == host.lower()]
    if len(candidates) != 1:
        code = "remote_unavailable" if not candidates else "ambiguous_remote"
        raise AdapterError(code, "repository binding is not unique", details={"count": len(candidates)})
    return candidates[0]


def _pr_selector_identity(pr_ref: str) -> tuple[str | None, str | None, int]:
    value = pr_ref.strip()
    url_match = re.fullmatch(r"https?://([^/]+)/([^/]+)/([^/]+)/pulls?/([1-9][0-9]*)/?", value)
    if url_match:
        return url_match.group(1).lower(), f"{url_match.group(2)}/{url_match.group(3)}", int(url_match.group(4))
    owner_match = re.fullmatch(r"([^/]+/[^#]+)#([1-9][0-9]*)", value)
    if owner_match:
        return None, owner_match.group(1), int(owner_match.group(2))
    number_match = re.fullmatch(r"PR#([1-9][0-9]*)", value)
    if number_match:
        return None, None, int(number_match.group(1))
    raise AdapterError("invalid_pr_ref", "PR reference must be PR#N, owner/repo#N, or a PR URL")


def resolve_repository_for_pr(
    repo_root: str | Path,
    pr_ref: str,
    *,
    remote: str | None = None,
    runner: Runner = _run_command,
) -> tuple[RepositoryBinding, int]:
    host, full_name, number = _pr_selector_identity(pr_ref)
    return resolve_unique_repository(
        repo_root,
        full_name=full_name,
        host=host,
        remote=remote,
        runner=runner,
    ), number


def asset_url(binding: RepositoryBinding, revision: str, repo_path: str) -> str:
    revision = _require_sha(revision, "revision")
    normalized = repo_path.strip("/")
    if not normalized or ".." in normalized.split("/"):
        raise AdapterError("invalid_asset_path", "asset path must be repository-relative")
    encoded = quote(normalized, safe="/")
    if binding.provider == "github":
        return f"{binding.web_url}/blob/{revision}/{encoded}?raw=1"
    return f"{binding.web_url}/raw/{revision}/{encoded}"


def _full_name_from_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = urlsplit(value)
        parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
        if len(parts) >= 2:
            return f"{parts[0]}/{parts[1].removesuffix('.git')}"
    except ValueError:
        return None
    return None


class ProviderBackend:
    """Small semantic interface shared by the GitHub and Gitea adapters."""

    def __init__(self, binding: RepositoryBinding, *, runner: Runner = _run_command, cwd: str | None = None) -> None:
        self.binding = binding
        self.runner = runner
        self.cwd = cwd

    def _command(self, endpoint: str, method: str, include: bool) -> list[str]:
        raise NotImplementedError

    def _endpoint(self, path: str) -> str:
        return path.lstrip("/")

    def _body_args(self, body: str) -> list[str]:
        """Return provider-specific argv for a JSON request body."""
        return ["--input", "-"]

    def _request(
        self,
        endpoint: str,
        *,
        method: str = "GET",
        data: dict[str, Any] | None = None,
        include: bool = False,
        check: bool = True,
        operation: str = "api",
    ) -> ApiResponse:
        method = method.upper()
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if data is not None else None
        argv = self._command(self._endpoint(endpoint), method, include)
        if body is not None:
            argv.extend(self._body_args(body))
        result = self.runner(argv, self.cwd, body)
        observed_at = datetime.now(timezone.utc).isoformat()
        status = _status_from_output(result.stdout, result.stderr)
        if status is None and result.returncode == 0:
            status = 200
        if check and (result.returncode != 0 or (status is not None and status >= 400)):
            raise AdapterError(
                "provider_request_failed",
                f"{operation} provider request failed",
                operation=operation,
                details={"status": status, "provider": self.binding.provider},
            )
        return ApiResponse(
            status,
            _safe_json(result.stdout),
            result.stdout,
            result.stderr,
            result.returncode,
            observed_at,
        )

    def _json_request(self, endpoint: str, **kwargs: Any) -> Any:
        return self._request(endpoint, **kwargs).payload

    def get_identity(self) -> str:
        return self.get_identity_fact()["login"]

    def get_identity_fact(self) -> dict[str, Any]:
        response = self._request("user", operation="identity")
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "identity response is not an object", operation="identity")
        for key in ("login", "login_name", "username"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return {"login": value.strip(), "observed_at": response.observed_at, "raw": _redact_provider_value(payload)}
        raise AdapterError("invalid_provider_response", "identity response has no login", operation="identity")

    def get_pr_facts(self, number: int) -> dict[str, Any]:
        response = self._request(f"repos/{self.binding.full_name}/pulls/{number}", operation="pr-facts")
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "PR response is not an object", operation="pr-facts")
        # Validate the provider's repository/PR identity before reading any
        # related collection or allowing a response to influence callers.
        self._normalize_pr(payload, number, observed_at=response.observed_at, related={"reviews": [], "comments": []})
        related = self._get_pr_related_facts(number)
        return self._normalize_pr(payload, number, observed_at=response.observed_at, related=related)

    def _get_pr_related_facts(self, number: int) -> dict[str, Any]:
        related: dict[str, Any] = {}
        for kind, endpoint in (
            ("reviews", f"repos/{self.binding.full_name}/pulls/{number}/reviews"),
            ("comments", f"repos/{self.binding.full_name}/issues/{number}/comments"),
        ):
            response = self._request(endpoint, operation=f"pr-{kind}", check=False)
            if response.status in {404, 405, 501}:
                raise AdapterError("unsupported_capability", f"provider does not support PR {kind}", operation=f"pr-{kind}")
            if response.returncode != 0 or (response.status is not None and response.status >= 400):
                raise AdapterError("provider_request_failed", f"PR {kind} request failed", operation=f"pr-{kind}")
            if not isinstance(response.payload, list):
                raise AdapterError("invalid_provider_response", f"PR {kind} response is not an array", operation=f"pr-{kind}")
            related[kind] = response.payload
            related[f"{kind}_observed_at"] = response.observed_at
        return related

    def _normalize_pr(
        self,
        payload: dict[str, Any],
        number: int,
        *,
        observed_at: str | None = None,
        related: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response_number = payload.get("number")
        if response_number is not None:
            try:
                normalized_response_number = int(response_number)
            except (TypeError, ValueError) as error:
                raise AdapterError("invalid_provider_response", "provider returned an invalid PR number", operation="pr-facts") from error
            if normalized_response_number != number:
                raise AdapterError("provider_identity_mismatch", "provider returned a different PR number", operation="pr-facts")
        base = payload.get("base") if isinstance(payload.get("base"), dict) else {}
        head = payload.get("head") if isinstance(payload.get("head"), dict) else {}
        state = str(payload.get("state") or "").upper()
        merged = bool(payload.get("merged")) or state == "MERGED"
        if merged:
            state = "MERGED"
        elif state:
            state = state.upper()
        base_sha = str(base.get("sha") or payload.get("base_sha") or "").lower()
        head_sha = str(head.get("sha") or payload.get("sha") or "").lower()
        merge_sha = str(payload.get("merge_commit_sha") or payload.get("merge_commit_sha") or "").lower()
        if not merge_sha or merge_sha == "none":
            merge_sha = ""
        head_repo = head.get("repo") if isinstance(head.get("repo"), dict) else {}
        base_repo = base.get("repo") if isinstance(base.get("repo"), dict) else {}
        head_name = head_repo.get("full_name") or head_repo.get("name_with_owner") or _full_name_from_url(head_repo.get("html_url") or head_repo.get("url"))
        base_name = base_repo.get("full_name") or base_repo.get("name_with_owner") or _full_name_from_url(base_repo.get("html_url") or base_repo.get("url"))
        if head_name:
            head_name = _require_repository_name(head_name, "head")
        if base_name:
            base_name = _require_repository_name(base_name, "base")
            if base_name.lower() != self.binding.full_name.lower():
                raise AdapterError("provider_identity_mismatch", "provider returned a PR base repository different from the binding", operation="pr-facts")
        for label, repository_name in (("base", base_name), ("head", head_name)):
            repository_url = (base_repo if label == "base" else head_repo).get("html_url") or (base_repo if label == "base" else head_repo).get("url")
            if repository_url:
                parsed = urlsplit(str(repository_url))
                if parsed.hostname and parsed.hostname.lower() != self.binding.host.lower():
                    raise AdapterError("provider_identity_mismatch", f"provider returned a {label} repository on another host", operation="pr-facts")
                url_name = _full_name_from_url(repository_url)
                if repository_name and url_name and str(repository_name).lower() != url_name.lower():
                    raise AdapterError("provider_identity_mismatch", f"provider returned inconsistent {label} repository identity", operation="pr-facts")
        pr_url = str(payload.get("html_url") or payload.get("url") or "")
        if pr_url:
            parsed_pr_url = urlsplit(pr_url)
            path_parts = [unquote(part) for part in parsed_pr_url.path.strip("/").split("/") if part]
            if (
                parsed_pr_url.scheme.lower() != "https"
                or parsed_pr_url.hostname is None
                or parsed_pr_url.hostname.lower() != self.binding.host.lower()
                or parsed_pr_url.port not in {None, 443}
                or parsed_pr_url.username is not None
                or parsed_pr_url.password is not None
                or len(path_parts) != 4
                or path_parts[0].lower() != self.binding.owner.lower()
                or path_parts[1].lower() != self.binding.repo.lower()
                or path_parts[2] not in {"pull", "pulls"}
                or path_parts[3] != str(number)
            ):
                raise AdapterError("provider_identity_mismatch", "provider returned a non-canonical PR URL", operation="pr-facts")
        is_cross = bool(head_name and str(head_name).lower() != self.binding.full_name.lower())
        related = related or {}
        reviews = self._normalize_reviews(related.get("reviews", payload.get("reviews", [])), related.get("reviews_observed_at") or observed_at)
        comments = self._normalize_comments(related.get("comments", payload.get("comments", [])), related.get("comments_observed_at") or observed_at)
        return {
            "number": number,
            "url": pr_url,
            "state": state,
            "body": str(payload.get("body") or ""),
            "base_ref": str(base.get("ref") or ""),
            "base_sha": base_sha,
            "base_repository": base_name,
            "head_ref": str(head.get("ref") or ""),
            "head_sha": head_sha,
            "head_repository": head_name,
            "is_cross_repository": is_cross,
            "merge_sha": merge_sha,
            "merged_at": str(payload.get("merged_at") or ""),
            "mergeable": payload.get("mergeable"),
            "merge_state": payload.get("mergeable_state") or payload.get("merge_state_status"),
            "draft": bool(payload.get("draft") or payload.get("is_draft")),
            "reviews": reviews,
            "comments": comments,
            "observed_at": observed_at or datetime.now(timezone.utc).isoformat(),
            "raw": _redact_provider_value({"pr": payload, "reviews": related.get("reviews", payload.get("reviews", [])), "comments": related.get("comments", payload.get("comments", []))}),
        }

    @staticmethod
    def _normalize_reviews(payload: Any, observed_at: str | None) -> list[dict[str, Any]]:
        if not isinstance(payload, list):
            return []
        result: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            user = item.get("user") if isinstance(item.get("user"), dict) else {}
            result.append(
                {
                    "id": item.get("id"),
                    "state": item.get("state") or item.get("status"),
                    "body": item.get("body") or "",
                    "user": user.get("login") or user.get("username") or item.get("reviewer"),
                    "submitted_sha": item.get("commit_id") or item.get("commit_sha"),
                    "url": item.get("html_url") or item.get("url"),
                    "submitted_at": item.get("submitted_at") or item.get("created_at"),
                    "observed_at": observed_at,
                    "raw": _redact_provider_value(item),
                }
            )
        return result

    @staticmethod
    def _normalize_comments(payload: Any, observed_at: str | None) -> list[dict[str, Any]]:
        if not isinstance(payload, list):
            return []
        result: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            user = item.get("user") if isinstance(item.get("user"), dict) else {}
            result.append(
                {
                    "id": item.get("id"),
                    "body": item.get("body") or item.get("content") or "",
                    "user": user.get("login") or user.get("username") or item.get("author"),
                    "url": item.get("html_url") or item.get("url"),
                    "created_at": item.get("created_at"),
                    "updated_at": item.get("updated_at"),
                    "observed_at": observed_at,
                    "raw": _redact_provider_value(item),
                }
            )
        return result

    def create_pr(self, *, title: str, body: str, head: str, base: str, draft: bool = False) -> dict[str, Any]:
        response = self._request(
            f"repos/{self.binding.full_name}/pulls",
            method="POST",
            data={"title": title, "body": body, "head": head, "base": base, "draft": draft},
            operation="pr-create",
        )
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "PR create response is not an object", operation="pr-create")
        return self._normalize_pr(payload, int(payload.get("number") or 0), observed_at=response.observed_at)

    def edit_pr_body(self, number: int, body: str) -> dict[str, Any]:
        response = self._request(
            f"repos/{self.binding.full_name}/pulls/{number}",
            method="PATCH",
            data={"body": body},
            operation="pr-edit",
        )
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "PR edit response is not an object", operation="pr-edit")
        return self._normalize_pr(payload, number, observed_at=response.observed_at)

    def render_markdown(self, text: str, *, context: str | None = None) -> str:
        return self.render_markdown_fact(text, context=context)["html"]

    def render_markdown_fact(self, text: str, *, context: str | None = None) -> dict[str, Any]:
        payload = self._markdown_payload(text, context)
        response = self._request("markdown", method="POST", data=payload, operation="markdown")
        if isinstance(response.payload, str):
            return {"html": response.payload, "observed_at": response.observed_at, "raw": _redact_provider_value(response.payload)}
        if isinstance(response.payload, dict) and isinstance(response.payload.get("html"), str):
            return {"html": response.payload["html"], "observed_at": response.observed_at, "raw": _redact_provider_value(response.payload)}
        raise AdapterError("invalid_provider_response", "Markdown response is not rendered text", operation="markdown")

    def _markdown_payload(self, text: str, context: str | None) -> dict[str, Any]:
        return {"text": text, "mode": "gfm", "context": context or self.binding.full_name}

    def tree_facts(self, revision: str, repo_path: str) -> dict[str, Any]:
        revision = _require_sha(revision, "revision")
        response = self._request(
            f"repos/{self.binding.full_name}/git/trees/{revision}?recursive=true",
            operation="tree",
        )
        payload = response.payload
        raw_payloads = [_redact_provider_value(payload)]
        entries = payload.get("tree") if isinstance(payload, dict) else None
        if isinstance(entries, list) and not payload.get("truncated", False):
            exists = any(
                isinstance(entry, dict)
                and entry.get("path") == repo_path.strip("/")
                and entry.get("type") in {"blob", "file"}
                for entry in entries
            )
            return {"exists": exists, "sha": revision, "path": repo_path, "observed_at": response.observed_at, "raw": raw_payloads}
        if not isinstance(entries, list):
            raise AdapterError("invalid_provider_response", "tree response has no tree entries", operation="tree")
        tree_sha = revision
        components = [part for part in repo_path.strip("/").split("/") if part]
        for index, component in enumerate(components):
            response = self._request(
                f"repos/{self.binding.full_name}/git/trees/{tree_sha}",
                operation="tree",
            )
            payload = response.payload
            raw_payloads.append(_redact_provider_value(payload))
            current = payload.get("tree") if isinstance(payload, dict) else None
            if not isinstance(current, list):
                raise AdapterError("invalid_provider_response", "tree response has no tree entries", operation="tree")
            entry = next((item for item in current if isinstance(item, dict) and item.get("path") == component), None)
            if not isinstance(entry, dict):
                return {"exists": False, "sha": revision, "path": repo_path, "observed_at": response.observed_at, "raw": raw_payloads}
            if index == len(components) - 1:
                return {"exists": entry.get("type") in {"blob", "file"}, "sha": revision, "path": repo_path, "observed_at": response.observed_at, "raw": raw_payloads}
            if entry.get("type") not in {"tree", "directory"} or not entry.get("sha"):
                return {"exists": False, "sha": revision, "path": repo_path, "observed_at": response.observed_at, "raw": raw_payloads}
            tree_sha = str(entry["sha"])
        return {"exists": False, "sha": revision, "path": repo_path, "observed_at": response.observed_at, "raw": raw_payloads}

    def tree_contains(self, revision: str, repo_path: str) -> bool:
        return bool(self.tree_facts(revision, repo_path)["exists"])

    def get_ci_facts(self, branch: str, sha: str) -> dict[str, Any]:
        raise NotImplementedError

    def _branch_delete_result(
        self,
        branch: str,
        deleted: ApiResponse,
        verified: ApiResponse,
    ) -> dict[str, Any]:
        if verified.status != 404:
            raise AdapterError(
                "branch_delete_verify_failed",
                "bound branch is still present or verification is unavailable",
                operation="branch-verify",
                details={"status": verified.status, "delete_status": deleted.status},
            )
        state = "deleted" if deleted.status in {200, 204} else "already_absent"
        return {
            "state": state,
            "branch": branch,
            "repository": self.binding.full_name,
            "observed_at": verified.observed_at,
            "raw": {"delete_status": deleted.status, "verify_status": verified.status},
        }

    def _normalize_statuses(self, payload: Any, sha: str, observed_at: str) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "commit status response is not an object", operation="ci-status")
        response_sha = payload.get("sha") or payload.get("commit_id")
        if not response_sha:
            raise AdapterError("stale_ci_evidence", "commit status response has no exact SHA", operation="ci-status")
        if str(response_sha).lower() != sha:
            raise AdapterError("stale_ci_evidence", "commit status response is not bound to the requested SHA", operation="ci-status")
        statuses = payload.get("statuses")
        if not isinstance(statuses, list):
            statuses = []
        normalized: list[dict[str, Any]] = []
        for item in statuses:
            if not isinstance(item, dict):
                continue
            item_sha = item.get("sha") or item.get("commit_id") or item.get("commit_sha")
            if item_sha and str(item_sha).lower() != sha:
                raise AdapterError("stale_ci_evidence", "status row is not bound to the requested SHA", operation="ci-status")
            normalized.append(
                {
                    "context": str(item.get("context") or item.get("name") or ""),
                    "state": str(item.get("state") or item.get("status") or "").lower(),
                    "description": str(item.get("description") or ""),
                    "url": item.get("target_url") or item.get("url"),
                    "updated_at": item.get("updated_at") or item.get("created_at"),
                    "sha": sha,
                    "observed_at": observed_at,
                }
            )
        return normalized

    def _normalize_runs(self, payload: Any, sha: str, observed_at: str) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            runs = payload
        elif isinstance(payload, dict):
            runs = payload.get("workflow_runs") or payload.get("tasks") or payload.get("workflow_tasks")
        else:
            raise AdapterError("invalid_provider_response", "workflow run response is not an object or array", operation="ci-runs")
        if not isinstance(runs, list):
            runs = []
        normalized: list[dict[str, Any]] = []
        for item in runs:
            if not isinstance(item, dict):
                continue
            run_sha = item.get("head_sha") or item.get("sha")
            if not run_sha or str(run_sha).lower() != sha:
                # Gitea's task list may ignore the head_sha query parameter;
                # unrelated or unbound rows are not evidence for this SHA.
                continue
            normalized.append(
                {
                    "id": item.get("id"),
                    "name": item.get("name") or item.get("display_title") or item.get("workflow_name") or item.get("workflow_id"),
                    "status": item.get("status"),
                    "conclusion": item.get("conclusion"),
                    "url": item.get("html_url") or item.get("url"),
                    "head_sha": sha,
                    "completed_at": item.get("completed_at") or item.get("updated_at"),
                    "event": item.get("event"),
                    "observed_at": observed_at,
                }
            )
        return normalized

    def _normalize_checks(self, payload: Any, sha: str, observed_at: str) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "check response is not an object", operation="ci-checks")
        checks = payload.get("check_runs")
        if not isinstance(checks, list):
            checks = []
        normalized: list[dict[str, Any]] = []
        for item in checks:
            if not isinstance(item, dict):
                continue
            check_sha = item.get("head_sha") or item.get("sha")
            if not check_sha:
                raise AdapterError("stale_ci_evidence", "check run has no exact SHA", operation="ci-checks")
            if str(check_sha).lower() != sha:
                raise AdapterError("stale_ci_evidence", "check run is not bound to the requested SHA", operation="ci-checks")
            normalized.append(
                {
                    "name": item.get("name"),
                    "status": item.get("status"),
                    "conclusion": item.get("conclusion"),
                    "url": item.get("html_url") or item.get("details_url") or item.get("url"),
                    "sha": sha,
                    "completed_at": item.get("completed_at"),
                    "observed_at": observed_at,
                }
            )
        return normalized

    def _ci_result(
        self,
        *,
        branch: str,
        sha: str,
        required_contexts: list[str],
        protection: Any,
        status_response: ApiResponse,
        checks_response: ApiResponse | None,
        runs_response: ApiResponse,
    ) -> dict[str, Any]:
        observed_at = max(
            response.observed_at
            for response in (status_response, checks_response, runs_response)
            if response is not None
        )
        statuses = self._normalize_statuses(status_response.payload, sha, observed_at)
        checks = self._normalize_checks(checks_response.payload, sha, observed_at) if checks_response else []
        runs = self._normalize_runs(runs_response.payload, sha, observed_at)
        return {
            "sha": sha,
            "branch": branch,
            "required_contexts": required_contexts,
            "checks_expected": "yes" if required_contexts else "no",
            "statuses": statuses,
            "checks": checks,
            "runs": runs,
            "observed_at": observed_at,
            "raw": {
                "protection": _redact_provider_value(protection),
                "status": _redact_provider_value(status_response.payload),
                "checks": _redact_provider_value(checks_response.payload) if checks_response else None,
                "runs": _redact_provider_value(runs_response.payload),
            },
        }

    def _rerun_ci(self, run_id: int, expected_sha: str) -> dict[str, Any]:
        expected_sha = _require_sha(expected_sha, "expected_sha")
        endpoint = f"repos/{self.binding.full_name}/actions/runs/{int(run_id)}/rerun"
        response = self._request(
            endpoint,
            method="POST",
            check=False,
            operation="ci-rerun",
        )
        unsupported_text = f"{response.stdout}\n{response.stderr}"
        if response.status in {404, 405, 501} or re.search(r"\b(?:404|405|501)\b", unsupported_text):
            raise AdapterError("unsupported_capability", "provider does not support CI reruns", operation="ci-rerun")
        if response.returncode != 0 or (response.status is not None and response.status >= 400):
            raise AdapterError("provider_request_failed", "CI rerun request failed", operation="ci-rerun")
        verified = self._request(
            f"repos/{self.binding.full_name}/actions/runs/{int(run_id)}",
            operation="ci-rerun-verify",
            check=False,
        )
        verified_text = f"{verified.stdout}\n{verified.stderr}"
        if verified.status in {404, 405, 501} or re.search(r"\b(?:404|405|501)\b", verified_text):
            raise AdapterError("unsupported_capability", "provider cannot verify CI rerun identity", operation="ci-rerun")
        payload = verified.payload
        if not isinstance(payload, dict) or str(payload.get("head_sha") or payload.get("sha") or "").lower() != expected_sha:
            raise AdapterError("rerun_sha_mismatch", "rerun response is not bound to the expected SHA", operation="ci-rerun")
        return {
            "run_id": int(payload.get("id") or run_id),
            "head_sha": expected_sha,
            "state": "rerun_requested",
            "observed_at": verified.observed_at,
            "raw": {"request": _redact_provider_value(response.payload), "verification": _redact_provider_value(payload)},
        }

    def rerun_ci(self, run_id: int, expected_sha: str) -> dict[str, Any]:
        return self._rerun_ci(run_id, expected_sha)

    def merge_pr(self, number: int, expected_head: str, method: str) -> dict[str, Any]:
        expected_head = _require_sha(expected_head, "expected_head")
        if method not in {"merge", "squash", "rebase"}:
            raise AdapterError("invalid_merge_method", "merge method is not allowed", operation="pr-merge")
        live = self.get_pr_facts(number)
        if live.get("state") != "OPEN":
            raise AdapterError("pr_not_open", "guarded merge requires an open PR", operation="pr-merge")
        if str(live.get("head_sha") or "").lower() != expected_head:
            raise AdapterError("stale_head", "live PR head differs from expected head", operation="pr-merge")
        payload = self._merge_payload(expected_head, method)
        self._request(
            f"repos/{self.binding.full_name}/pulls/{number}/merge",
            method=self._merge_http_method,
            data=payload,
            operation="pr-merge",
        )
        final = self.get_pr_facts(number)
        if final.get("state") != "MERGED" or final.get("head_sha") != expected_head or not final.get("merge_sha"):
            raise AdapterError("merge_unconfirmed", "provider did not confirm the guarded merge", operation="pr-merge")
        return {
            "state": "merged",
            "number": number,
            "head_sha": expected_head,
            "merge_sha": final["merge_sha"],
            "merged_at": final.get("merged_at", ""),
            "observed_at": final.get("observed_at", ""),
            "raw": _redact_provider_value(final.get("raw")),
        }

    @property
    def _merge_http_method(self) -> str:
        return "PUT"

    def _merge_payload(self, expected_head: str, method: str) -> dict[str, Any]:
        return {"sha": expected_head, "merge_method": method}

    def delete_branch(self, branch: str) -> dict[str, Any]:
        branch = branch.strip()
        if not branch or branch in {".", ".."} or "\x00" in branch:
            raise AdapterError("invalid_branch", "branch name is invalid", operation="branch-delete")
        endpoint = f"repos/{self.binding.full_name}/branches/{quote(branch, safe='')}"
        deleted = self._request(endpoint, method="DELETE", include=True, check=False, operation="branch-delete")
        if deleted.status not in {200, 204, 404, 422}:
            raise AdapterError("branch_delete_failed", "provider did not accept branch deletion", operation="branch-delete", details={"status": deleted.status})
        verified = self._request(endpoint, method="GET", include=True, check=False, operation="branch-verify")
        return self._branch_delete_result(branch, deleted, verified)

    def get_issue(self, number: int) -> dict[str, Any]:
        response = self._request(f"repos/{self.binding.full_name}/issues/{number}", operation="issue-facts")
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "issue response is not an object", operation="issue-facts")
        return {"number": int(payload.get("number") or number), "url": payload.get("html_url") or payload.get("url"), "state": str(payload.get("state") or "").upper(), "title": payload.get("title") or "", "body": payload.get("body") or "", "observed_at": response.observed_at, "raw": _redact_provider_value(payload)}

    def create_issue(self, title: str, body: str) -> dict[str, Any]:
        response = self._request(f"repos/{self.binding.full_name}/issues", method="POST", data={"title": title, "body": body}, operation="issue-create")
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "issue create response is not an object", operation="issue-create")
        return {"number": int(payload.get("number") or 0), "url": payload.get("html_url") or payload.get("url"), "state": str(payload.get("state") or "OPEN").upper(), "title": payload.get("title") or title, "body": payload.get("body") or body, "observed_at": response.observed_at, "raw": _redact_provider_value(payload)}

    def submit_review(self, number: int, event: str, body: str = "") -> dict[str, Any]:
        event = event.upper()
        if event not in {"APPROVE", "REQUEST_CHANGES", "COMMENT"}:
            raise AdapterError("invalid_review_event", "review event is invalid", operation="review-submit")
        response = self._request(f"repos/{self.binding.full_name}/pulls/{number}/reviews", method="POST", data={"event": event, "body": body}, operation="review-submit")
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "review response is not an object", operation="review-submit")
        return {"id": payload.get("id"), "state": payload.get("state") or event, "url": payload.get("html_url") or payload.get("url"), "submitted_sha": payload.get("commit_id") or payload.get("commit_sha"), "observed_at": response.observed_at, "raw": _redact_provider_value(payload)}

    def list_releases(self) -> list[dict[str, Any]]:
        response = self._request(f"repos/{self.binding.full_name}/releases", operation="release-list")
        payload = response.payload
        if not isinstance(payload, list):
            raise AdapterError("invalid_provider_response", "release response is not an array", operation="release-list")
        return [{"id": item.get("id"), "tag": item.get("tag_name") or item.get("tag_name"), "url": item.get("html_url") or item.get("url"), "draft": bool(item.get("draft")), "prerelease": bool(item.get("prerelease")), "observed_at": response.observed_at, "raw": _redact_provider_value(item)} for item in payload if isinstance(item, dict)]

    def create_release(
        self,
        *,
        tag: str,
        title: str,
        note: str,
        target: str | None = None,
        draft: bool = False,
        prerelease: bool = False,
    ) -> dict[str, Any]:
        response = self._request(
            f"repos/{self.binding.full_name}/releases",
            method="POST",
            data={
                "tag_name": tag,
                "name": title,
                "body": note,
                "target_commitish": target or "",
                "draft": draft,
                "prerelease": prerelease,
            },
            operation="release-create",
        )
        payload = response.payload
        if not isinstance(payload, dict):
            raise AdapterError("invalid_provider_response", "release create response is not an object", operation="release-create")
        return {
            "id": payload.get("id"),
            "tag": payload.get("tag_name") or tag,
            "url": payload.get("html_url") or payload.get("url"),
            "draft": bool(payload.get("draft")),
            "prerelease": bool(payload.get("prerelease")),
            "observed_at": response.observed_at,
            "raw": _redact_provider_value(payload),
        }


class GitHubBackend(ProviderBackend):
    def _command(self, endpoint: str, method: str, include: bool) -> list[str]:
        # Endpoints are already repository-bound (`repos/{owner}/{repo}/...`);
        # `gh api` has no `--repo` flag, unlike higher-level gh commands.
        argv = ["gh", "api", endpoint, "--method", method]
        if include:
            argv.append("--include")
        return argv

    def get_ci_facts(self, branch: str, sha: str) -> dict[str, Any]:
        sha = _require_sha(sha, "sha")
        protection_response = self._request(
            f"repos/{self.binding.full_name}/branches/{quote(branch, safe='')}/protection/required_status_checks",
            operation="ci-protection",
            include=True,
            check=False,
        )
        if protection_response.status == 404:
            contexts: list[str] = []
            protection = None
        elif protection_response.status != 200:
            plan_limited = (
                protection_response.status == 403
                and isinstance(protection_response.payload, dict)
                and protection_response.payload.get("message") == GITHUB_PLAN_LIMITED_PROTECTION_MESSAGE
            )
            if not plan_limited:
                code = "ci_policy_unavailable" if protection_response.status is not None else "ci_policy_unknown"
                raise AdapterError(
                    code,
                    "GitHub required-check protection policy is unavailable",
                    operation="ci-protection",
                    details={"status": protection_response.status},
                )
            branch_response = self._request(
                f"repos/{self.binding.full_name}/branches/{quote(branch, safe='')}",
                operation="ci-branch-policy",
                include=True,
                check=False,
            )
            branch_payload = branch_response.payload
            if branch_response.status != 200:
                raise AdapterError(
                    "ci_policy_unavailable" if branch_response.status is not None else "ci_policy_unknown",
                    "GitHub branch policy fallback is unavailable",
                    operation="ci-branch-policy",
                    details={"status": branch_response.status, "protection_status": protection_response.status},
                )
            if not isinstance(branch_payload, dict) or branch_payload.get("name") != branch or branch_payload.get("protected") is not False:
                raise AdapterError(
                    "ci_policy_unknown",
                    "GitHub branch policy fallback did not confirm an unprotected branch",
                    operation="ci-branch-policy",
                    details={"status": branch_response.status, "protection_status": protection_response.status},
                )
            contexts = []
            protection = {
                "policy_source": "branch_metadata",
                "protected": False,
                "required_status_checks": None,
                "branch": branch_payload,
            }
        elif not isinstance(protection_response.payload, dict):
            raise AdapterError(
                "ci_policy_unknown",
                "GitHub required-check protection policy response is invalid",
                operation="ci-protection",
                details={"status": protection_response.status},
            )
        else:
            raw_contexts = protection_response.payload.get("contexts")
            if not isinstance(raw_contexts, list) or not all(isinstance(context, str) for context in raw_contexts):
                raise AdapterError(
                    "ci_policy_unknown",
                    "GitHub required-check protection policy has no readable contexts",
                    operation="ci-protection",
                    details={"status": protection_response.status},
                )
            contexts = raw_contexts
            protection = protection_response.payload
        status_response = self._request(f"repos/{self.binding.full_name}/commits/{sha}/status", operation="ci-status")
        checks_response = self._request(f"repos/{self.binding.full_name}/commits/{sha}/check-runs", operation="ci-checks")
        self._normalize_statuses(status_response.payload, sha, status_response.observed_at)
        self._normalize_checks(checks_response.payload, sha, checks_response.observed_at)
        runs_response = self._request(f"repos/{self.binding.full_name}/actions/runs?head_sha={sha}&per_page=100", operation="ci-runs")
        return self._ci_result(
            branch=branch,
            sha=sha,
            required_contexts=contexts if isinstance(contexts, list) else [],
            protection=protection,
            status_response=status_response,
            checks_response=checks_response,
            runs_response=runs_response,
        )

    def rerun_ci(self, run_id: int, expected_sha: str) -> dict[str, Any]:
        return self._rerun_ci(run_id, expected_sha)

    def delete_branch(self, branch: str) -> dict[str, Any]:
        branch = branch.strip()
        if not branch or branch in {".", ".."} or "\x00" in branch:
            raise AdapterError("invalid_branch", "branch name is invalid", operation="branch-delete")
        endpoint = f"repos/{self.binding.full_name}/git/refs/heads/{quote(branch, safe='')}"
        deleted = self._request(endpoint, method="DELETE", include=True, check=False, operation="branch-delete")
        if deleted.status not in {200, 204, 404, 422}:
            raise AdapterError("branch_delete_failed", "provider did not accept branch deletion", operation="branch-delete", details={"status": deleted.status})
        verified = self._request(endpoint, method="GET", include=True, check=False, operation="branch-verify")
        return self._branch_delete_result(branch, deleted, verified)


class GiteaBackend(ProviderBackend):
    @property
    def _merge_http_method(self) -> str:
        return "POST"

    def _command(self, endpoint: str, method: str, include: bool) -> list[str]:
        argv = ["tea", "api", "--remote", self.binding.remote, "--method", method]
        if include:
            argv.append("--include")
        argv.append(endpoint)
        return argv

    def _body_args(self, body: str) -> list[str]:
        return ["--data", "@-"]

    def _markdown_payload(self, text: str, context: str | None) -> dict[str, Any]:
        return {"Text": text, "Mode": "gfm", "Context": context or self.binding.full_name}

    def _merge_payload(self, expected_head: str, method: str) -> dict[str, Any]:
        return {"head_commit_id": expected_head, "do": method}

    def get_ci_facts(self, branch: str, sha: str) -> dict[str, Any]:
        sha = _require_sha(sha, "sha")
        protection_response = self._request(
            f"repos/{self.binding.full_name}/branches/{quote(branch, safe='')}",
            operation="ci-protection",
            check=False,
        )
        branch_payload = protection_response.payload
        contexts = branch_payload.get("status_check_contexts", []) if isinstance(branch_payload, dict) else []
        status_response = self._request(f"repos/{self.binding.full_name}/commits/{sha}/status", operation="ci-status")
        self._normalize_statuses(status_response.payload, sha, status_response.observed_at)
        runs_response = self._request(
            f"repos/{self.binding.full_name}/actions/tasks?head_sha={sha}&limit=100",
            operation="ci-runs",
            check=False,
        )
        runs_payload = runs_response.payload
        if runs_response.status in {404, 405, 501} or not isinstance(runs_payload, (dict, list)) or (
            isinstance(runs_payload, dict)
            and not any(key in runs_payload for key in ("tasks", "workflow_tasks", "workflow_runs"))
        ):
            runs_response = self._request(
                f"repos/{self.binding.full_name}/actions/runs?head_sha={sha}&limit=100",
                operation="ci-runs",
            )
        return self._ci_result(
            branch=branch,
            sha=sha,
            required_contexts=contexts if isinstance(contexts, list) else [],
            protection=branch_payload,
            status_response=status_response,
            checks_response=None,
            runs_response=runs_response,
        )

    def rerun_ci(self, run_id: int, expected_sha: str) -> dict[str, Any]:
        return self._rerun_ci(run_id, expected_sha)


def backend_for(binding: RepositoryBinding, *, runner: Runner = _run_command, cwd: str | None = None) -> ProviderBackend:
    if binding.provider == "github":
        return GitHubBackend(binding, runner=runner, cwd=cwd)
    if binding.provider == "gitea":
        return GiteaBackend(binding, runner=runner, cwd=cwd)
    raise AdapterError("unsupported_provider", f"provider is not supported: {binding.provider}")


def _read_file(path: str | None) -> str:
    if path is None:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise AdapterError("input_unavailable", "input file could not be read") from error


def _envelope(operation: str, binding: RepositoryBinding, result: Any) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "operation": operation,
        "outcome": "ok",
        "binding": binding.as_dict(),
        "result": _redact_provider_value(result),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=os.getcwd())
    parser.add_argument("--remote", required=True)
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("resolve")
    sub.add_parser("identity")
    facts = sub.add_parser("pr-facts")
    facts.add_argument("--number", type=int, required=True)
    create = sub.add_parser("pr-create")
    create.add_argument("--title", required=True)
    create.add_argument("--body-file", required=True)
    create.add_argument("--head", required=True)
    create.add_argument("--base", required=True)
    create.add_argument("--draft", action="store_true")
    edit = sub.add_parser("pr-edit")
    edit.add_argument("--number", type=int, required=True)
    edit.add_argument("--body-file", required=True)
    merge = sub.add_parser("pr-merge")
    merge.add_argument("--number", type=int, required=True)
    merge.add_argument("--expected-head", required=True)
    merge.add_argument("--method", choices=("merge", "squash", "rebase"), required=True)
    branch = sub.add_parser("branch-delete")
    branch.add_argument("--branch", required=True)
    ci = sub.add_parser("ci-facts")
    ci.add_argument("--branch", required=True)
    ci.add_argument("--sha", required=True)
    rerun = sub.add_parser("ci-rerun")
    rerun.add_argument("--run-id", type=int, required=True)
    rerun.add_argument("--expected-sha", required=True)
    tree = sub.add_parser("tree-has")
    tree.add_argument("--sha", required=True)
    tree.add_argument("--path", required=True)
    asset = sub.add_parser("asset-url")
    asset.add_argument("--sha", required=True)
    asset.add_argument("--path", required=True)
    markdown = sub.add_parser("render-markdown")
    markdown.add_argument("--text-file", required=True)
    markdown.add_argument("--context")
    issue = sub.add_parser("issue-get")
    issue.add_argument("--number", type=int, required=True)
    issue_create = sub.add_parser("issue-create")
    issue_create.add_argument("--title", required=True)
    issue_create.add_argument("--body-file", required=True)
    review = sub.add_parser("review-submit")
    review.add_argument("--number", type=int, required=True)
    review.add_argument("--event", required=True)
    review.add_argument("--body-file")
    sub.add_parser("release-list")
    release_create = sub.add_parser("release-create")
    release_create.add_argument("--tag", required=True)
    release_create.add_argument("--title", required=True)
    release_create.add_argument("--note-file", required=True)
    release_create.add_argument("--target")
    release_create.add_argument("--draft", action="store_true")
    release_create.add_argument("--prerelease", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    operation = str(args.operation)
    try:
        binding = resolve_repository(args.repo_root, args.remote)
        backend = backend_for(binding, cwd=str(Path(args.repo_root).resolve()))
        if operation == "resolve":
            result = binding.as_dict()
        elif operation == "identity":
            result = backend.get_identity_fact()
        elif operation == "pr-facts":
            result = backend.get_pr_facts(args.number)
        elif operation == "pr-create":
            result = backend.create_pr(title=args.title, body=_read_file(args.body_file), head=args.head, base=args.base, draft=args.draft)
        elif operation == "pr-edit":
            result = backend.edit_pr_body(args.number, _read_file(args.body_file))
        elif operation == "pr-merge":
            result = backend.merge_pr(args.number, args.expected_head, args.method)
        elif operation == "branch-delete":
            result = backend.delete_branch(args.branch)
        elif operation == "ci-facts":
            result = backend.get_ci_facts(args.branch, args.sha)
        elif operation == "ci-rerun":
            result = backend.rerun_ci(args.run_id, args.expected_sha)
        elif operation == "tree-has":
            result = backend.tree_facts(args.sha, args.path)
        elif operation == "asset-url":
            result = {"url": asset_url(binding, args.sha, args.path), "sha": _require_sha(args.sha, "sha"), "path": args.path}
        elif operation == "render-markdown":
            result = backend.render_markdown_fact(_read_file(args.text_file), context=args.context)
        elif operation == "issue-get":
            result = backend.get_issue(args.number)
        elif operation == "issue-create":
            result = backend.create_issue(args.title, _read_file(args.body_file))
        elif operation == "review-submit":
            result = backend.submit_review(args.number, args.event, _read_file(args.body_file) if args.body_file else "")
        elif operation == "release-list":
            result = backend.list_releases()
        elif operation == "release-create":
            result = backend.create_release(
                tag=args.tag,
                title=args.title,
                note=_read_file(args.note_file),
                target=args.target,
                draft=args.draft,
                prerelease=args.prerelease,
            )
        else:
            raise AdapterError("unsupported_operation", f"operation is not supported: {operation}", operation=operation)
    except AdapterError as error:
        error.operation = operation
        print(json.dumps(error.envelope(), ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(_envelope(operation, binding, result), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
