#!/usr/bin/env python3
"""Regression coverage for the CVM image generation wrapper."""

from __future__ import annotations

import asyncio
from contextlib import redirect_stderr
from io import BytesIO, StringIO
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from openai import OpenAI


SCRIPT = Path(__file__).with_name("image_gen.py")
SYSTEM_SCRIPT = Path(__file__).parents[1] / "tests/fixtures/system_image_gen.py"
SYSTEM_IMAGE = Path(__file__).parents[1] / "tests/fixtures/imagegen-fixture.png"
SPEC = importlib.util.spec_from_file_location("cvm_image_gen", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class _DeclaredEditImages:
    def __init__(self) -> None:
        self.request = None

    def edit(
        self,
        *,
        quality: str,
        output_format: str,
        moderation: str,
        extra_body: dict[str, str] | None = None,
    ) -> None:
        self.request = {
            "quality": quality,
            "output_format": output_format,
            "moderation": moderation,
            "extra_body": extra_body,
        }


class _DeclaredEditClient:
    def __init__(self) -> None:
        self.images = _DeclaredEditImages()


class _BackendRejectedRequest(RuntimeError):
    status_code = 400


class _RejectedImages:
    def generate(self, **request: object) -> None:
        raise _BackendRejectedRequest("Transparent background is not supported")

    def edit(self, **request: object) -> None:
        raise _BackendRejectedRequest("Transparent background is not supported")


class _RejectedClient:
    def __init__(self) -> None:
        self.images = _RejectedImages()


class _RejectedAsyncImages:
    async def generate(self, **request: object) -> None:
        raise _BackendRejectedRequest("Transparent background is not supported")


class _RejectedAsyncClient:
    def __init__(self) -> None:
        self.images = _RejectedAsyncImages()


class CvmImageEditCompatibilityTests(unittest.TestCase):
    def test_declared_edit_fields_stay_top_level(self) -> None:
        client = _DeclaredEditClient()
        adapted = MODULE._CVMClientCompatibility(client)

        adapted.images.edit(
            quality="high",
            output_format="png",
            input_fidelity="high",
            moderation="low",
        )

        self.assertEqual(
            client.images.request,
            {
                "quality": "high",
                "output_format": "png",
                "moderation": "low",
                "extra_body": {"input_fidelity": "high"},
            },
        )

    def test_legacy_sdk_edit_uses_extra_body_multipart_without_moderation(self) -> None:
        expected_fields = {
            b"output_format": b"png",
            b"output_compression": b"75",
            b"input_fidelity": b"high",
        }
        seen = {"method": None, "path": None, "fields": set()}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            seen["path"] = request.url.path
            body = request.content
            for name, value in expected_fields.items():
                marker = b'name="' + name + b'"\r\n\r\n' + value + b"\r\n"
                if marker in body:
                    seen["fields"].add(name.decode("ascii"))
            if b'name="moderation"\r\n' in body:
                seen["fields"].add("moderation")
            return httpx.Response(200, json={"created": 0, "data": [{"b64_json": ""}]})

        transport = httpx.MockTransport(handler)
        http_client = httpx.Client(transport=transport)
        client = OpenAI(
            api_key="test",
            base_url="https://mock.invalid/v1",
            http_client=http_client,
        )
        try:
            adapted = MODULE._CVMClientCompatibility(client)
            moderation_is_declared = "moderation" in MODULE._edit_parameter_names(
                client.images.edit
            )
            adapted.images.edit(
                image=BytesIO(b"offline image fixture"),
                prompt="offline compatibility fixture",
                model="gpt-image-1",
                output_format="png",
                output_compression=75,
                input_fidelity="high",
                moderation="auto",
            )
        finally:
            client.close()

        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["path"], "/v1/images/edits")
        expected_multipart_fields = {
            "output_format",
            "output_compression",
            "input_fidelity",
        }
        if moderation_is_declared:
            expected_multipart_fields.add("moderation")
        self.assertEqual(seen["fields"], expected_multipart_fields)


class CvmTransparentBackgroundTests(unittest.TestCase):
    def test_transparent_background_bypasses_only_the_system_capability_guard(self) -> None:
        calls: list[dict[str, object]] = []

        def system_validation(**request: object) -> None:
            calls.append(request)
            if request["background"] == "transparent":
                raise AssertionError("stale local capability guard invoked")

        system_module = SimpleNamespace(
            _validate_model_specific_options=system_validation,
            _validate_size=lambda size, model: None,
            _add_shared_args=lambda parser: None,
            _generate=lambda args: None,
        )
        MODULE._patch_module(system_module)

        system_module._validate_model_specific_options(
            model="gpt-image-2",
            background="transparent",
            input_fidelity=None,
        )

        self.assertEqual(
            calls,
            [
                {
                    "model": "gpt-image-2",
                    "background": None,
                    "input_fidelity": None,
                }
            ],
        )

    def test_sync_http_rejection_is_labeled_as_a_cvm_backend_error(self) -> None:
        adapted = MODULE._CVMClientCompatibility(_RejectedClient())

        with self.assertRaises(MODULE._CVMBackendRequestError) as captured:
            adapted.images.generate(model="gpt-image-2", prompt="probe")

        self.assertIn("CVM backend rejected the Images API request (HTTP 400)", str(captured.exception))

    def test_async_http_rejection_is_labeled_as_a_cvm_backend_error(self) -> None:
        adapted = MODULE._CVMAsyncClientCompatibility(_RejectedAsyncClient())

        async def run() -> None:
            await adapted.images.generate(model="gpt-image-2", prompt="probe")

        with self.assertRaises(MODULE._CVMBackendRequestError):
            asyncio.run(run())

    def test_main_renders_backend_rejection_without_a_traceback(self) -> None:
        def raise_backend_rejection() -> None:
            raise MODULE._CVMBackendRequestError("CVM backend rejected the Images API request")

        system_module = SimpleNamespace(
            _validate_model_specific_options=lambda **request: None,
            _validate_size=lambda size, model: None,
            _add_shared_args=lambda parser: None,
            _generate=lambda args: None,
            main=raise_backend_rejection,
        )

        with patch.object(MODULE, "_load_system_module", return_value=system_module):
            with redirect_stderr(stderr_text := StringIO()):
                self.assertEqual(MODULE.main(), 1)

        self.assertIn("Error: CVM backend rejected the Images API request", stderr_text.getvalue())


class CvmReferenceGenerationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.system_path = patch.dict(
            os.environ,
            {"AGENT_IMAGEGEN_SYSTEM_PATH": str(SYSTEM_SCRIPT.resolve())},
            clear=False,
        )
        self.system_path.start()
        self.addCleanup(self.system_path.stop)

    def run_cli(self, *args: str) -> dict[str, object]:
        env = os.environ.copy()
        env.pop("CVM_API_KEY", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "generate", *args, "--dry-run"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_reference_images_use_edit_endpoint(self) -> None:
        payload = self.run_cli(
            "--prompt", "Use the reference composition",
            "--image", str(SYSTEM_IMAGE),
            "--image", str(SYSTEM_IMAGE),
        )

        self.assertEqual(payload["endpoint"], "/v1/images/edits")
        self.assertEqual(payload["image"], [str(SYSTEM_IMAGE)] * 2)
        self.assertNotIn("input_fidelity", payload)

    def test_reference_images_accept_explicit_input_fidelity(self) -> None:
        payload = self.run_cli(
            "--model", "gpt-image-1.5",
            "--prompt", "Use the reference colors",
            "--image", str(SYSTEM_IMAGE),
            "--input-fidelity", "high",
        )

        self.assertEqual(payload["endpoint"], "/v1/images/edits")
        self.assertEqual(payload["input_fidelity"], "high")

    def test_live_reference_path_passes_images_to_system_edit(self) -> None:
        module = MODULE._load_system_module()
        MODULE._patch_module(module)
        requests: list[dict[str, object]] = []

        def edit(**request: object) -> SimpleNamespace:
            images = request["image"]
            self.assertIsInstance(images, list)
            self.assertEqual(len(images), 2)
            self.assertTrue(all(image.read(1) for image in images))
            requests.append(request)
            return SimpleNamespace(data=[SimpleNamespace(b64_json="")])

        client = SimpleNamespace(images=SimpleNamespace(edit=edit))
        argv = [
            str(SCRIPT), "generate", "--prompt", "Use both references",
            "--image", str(SYSTEM_IMAGE), "--image", str(SYSTEM_IMAGE),
        ]
        with patch.dict(os.environ, {"CVM_API_KEY": "offline-test"}):
            with patch.object(sys, "argv", argv):
                with patch.object(module, "_create_client", return_value=client):
                    with patch.object(module, "_decode_write_and_downscale"):
                        self.assertEqual(module.main(), 0)

        self.assertEqual(len(requests), 1)
        self.assertNotIn("input_fidelity", requests[0])

    def test_text_generate_keeps_generation_endpoint(self) -> None:
        payload = self.run_cli("--prompt", "A plain text request")

        self.assertEqual(payload["endpoint"], "/v1/images/generations")

    def test_image_2_5_variant_accepts_flexible_size(self) -> None:
        payload = self.run_cli(
            "--model", "gpt-image-2.5-sunburst",
            "--size", "2048x1152",
            "--prompt", "A wide scene",
        )

        self.assertEqual(payload["size"], "2048x1152")


if __name__ == "__main__":
    unittest.main()
