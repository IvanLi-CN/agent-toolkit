#!/usr/bin/env python3
"""CVM-backed wrapper around a configured image generation fallback CLI.

The wrapper preserves the fallback interface while reading authentication and
endpoint settings from explicit environment variables.
"""

from __future__ import annotations

import importlib.util
import inspect
import os
from pathlib import Path
import sys
from types import ModuleType
from typing import Any


CVM_ENV_KEY = "CVM_API_KEY"
CVM_BASE_URL_ENV = "CVM_BASE_URL"
SYSTEM_IMAGEGEN_PATH_ENV = "AGENT_IMAGEGEN_SYSTEM_PATH"
_EDIT_EXTRA_BODY_FIELDS = frozenset(
    ("output_format", "output_compression", "input_fidelity")
)


class _CVMBackendRequestError(RuntimeError):
    """An Images API request reached CVM and was rejected by its backend."""


def _edit_parameter_names(edit: Any) -> frozenset[str]:
    try:
        return frozenset(inspect.signature(edit).parameters)
    except (TypeError, ValueError):
        return frozenset()


def _raise_cvm_backend_rejection(error: Exception) -> None:
    status_code = getattr(error, "status_code", None)
    if not isinstance(status_code, int):
        response = getattr(error, "response", None)
        status_code = getattr(response, "status_code", None)

    if isinstance(status_code, int) and 400 <= status_code <= 599:
        raise _CVMBackendRequestError(
            "CVM backend rejected the Images API request "
            f"(HTTP {status_code}): {error}"
        ) from error

    raise error


class _ImageEditCompatibility:
    """Bridge edit fields that older OpenAI SDKs do not yet declare."""

    def __init__(self, images: Any) -> None:
        self._images = images
        self._edit_parameters = _edit_parameter_names(images.edit)

    def edit(self, **request: Any) -> Any:
        request = dict(request)
        extra_body: dict[str, Any] = {}

        for field in _EDIT_EXTRA_BODY_FIELDS:
            if field in request and field not in self._edit_parameters:
                extra_body[field] = request.pop(field)

        if "moderation" in request and "moderation" not in self._edit_parameters:
            request.pop("moderation")

        if extra_body:
            existing_extra_body = request.get("extra_body")
            request["extra_body"] = {
                **(dict(existing_extra_body) if existing_extra_body is not None else {}),
                **extra_body,
            }

        try:
            return self._images.edit(**request)
        except Exception as error:
            _raise_cvm_backend_rejection(error)

    def generate(self, **request: Any) -> Any:
        try:
            return self._images.generate(**request)
        except Exception as error:
            _raise_cvm_backend_rejection(error)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._images, name)


class _CVMClientCompatibility:
    def __init__(self, client: Any) -> None:
        self._client = client
        self.images = _ImageEditCompatibility(client.images)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


class _AsyncImageCompatibility:
    def __init__(self, images: Any) -> None:
        self._images = images

    async def generate(self, **request: Any) -> Any:
        try:
            return await self._images.generate(**request)
        except Exception as error:
            _raise_cvm_backend_rejection(error)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._images, name)


class _CVMAsyncClientCompatibility:
    def __init__(self, client: Any) -> None:
        self._client = client
        self.images = _AsyncImageCompatibility(client.images)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def _system_imagegen_path() -> Path:
    value = os.environ.get(SYSTEM_IMAGEGEN_PATH_ENV)
    return Path(value).expanduser() if value else Path()


def _load_system_module() -> ModuleType:
    path = _system_imagegen_path()
    if not path.is_file():
        print(
            "Error: imagegen fallback script not found. Set "
            f"{SYSTEM_IMAGEGEN_PATH_ENV} to a valid script path.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    spec = importlib.util.spec_from_file_location("_cvm_system_imagegen", path)
    if spec is None or spec.loader is None:
        print(f"Error: failed to load system imagegen script from {path}", file=sys.stderr)
        raise SystemExit(1)

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _patch_module(module: ModuleType) -> None:
    original_validate_model_specific_options = module._validate_model_specific_options
    original_validate_size = module._validate_size
    original_add_shared_args = module._add_shared_args
    original_generate = module._generate

    def validate_model_specific_options(
        *,
        model: str,
        background: str | None,
        input_fidelity: str | None = None,
    ) -> None:
        # CVM, not this wrapper, owns model-specific support for a valid
        # transparent Images API request. Keep every other system validation.
        original_validate_model_specific_options(
            model=model,
            background=None if background == "transparent" else background,
            input_fidelity=input_fidelity,
        )

    def validate_size(size: str, model: str) -> None:
        if model.startswith("gpt-image-2"):
            module._validate_gpt_image_2_size(size)
            return
        original_validate_size(size, model)

    def ensure_api_key(dry_run: bool) -> None:
        if os.getenv(CVM_ENV_KEY):
            print(f"{CVM_ENV_KEY} is set.", file=sys.stderr)
            return
        if dry_run:
            module._warn(f"{CVM_ENV_KEY} is not set; dry-run only.")
            return
        module._die(f"{CVM_ENV_KEY} is not set. Export it before running.")

    def create_client():
        try:
            from openai import OpenAI
        except ImportError:
            module._die(
                "openai SDK not installed in the active environment. "
                f"{module._dependency_hint('openai')}"
            )

        api_key = os.getenv(CVM_ENV_KEY)
        if not api_key:
            module._die(f"{CVM_ENV_KEY} is not set. Export it before running.")
        base_url = os.getenv(CVM_BASE_URL_ENV)
        if not base_url:
            module._die(f"{CVM_BASE_URL_ENV} is not set. Export it before running.")
        return _CVMClientCompatibility(OpenAI(api_key=api_key, base_url=base_url))

    def create_async_client():
        try:
            from openai import AsyncOpenAI
        except ImportError:
            try:
                import openai as _openai  # noqa: F401
            except ImportError:
                module._die(
                    "openai SDK not installed in the active environment. "
                    f"{module._dependency_hint('openai')}"
                )
            module._die(
                "AsyncOpenAI not available in this openai SDK version. "
                f"{module._dependency_hint('openai', upgrade=True)}"
            )

        api_key = os.getenv(CVM_ENV_KEY)
        if not api_key:
            module._die(f"{CVM_ENV_KEY} is not set. Export it before running.")
        base_url = os.getenv(CVM_BASE_URL_ENV)
        if not base_url:
            module._die(f"{CVM_BASE_URL_ENV} is not set. Export it before running.")
        return _CVMAsyncClientCompatibility(
            AsyncOpenAI(api_key=api_key, base_url=base_url)
        )

    def add_shared_args(parser: Any) -> None:
        original_add_shared_args(parser)
        if parser.prog.endswith(" generate"):
            parser.add_argument(
                "--image",
                action="append",
                help="Reference image for generation through the edit endpoint; repeat for multiple inputs.",
            )
            parser.add_argument("--input-fidelity")
            parser.set_defaults(mask=None)

    def generate(args: Any) -> None:
        if getattr(args, "image", None):
            module._edit(args)
            return
        if args.input_fidelity is not None:
            module._die("--input-fidelity requires --image")
        original_generate(args)

    module._validate_model_specific_options = validate_model_specific_options
    module._validate_size = validate_size
    module._ensure_api_key = ensure_api_key
    module._create_client = create_client
    module._create_async_client = create_async_client
    module._add_shared_args = add_shared_args
    module._generate = generate


def main() -> int:
    module = _load_system_module()
    _patch_module(module)
    try:
        return int(module.main())
    except _CVMBackendRequestError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
