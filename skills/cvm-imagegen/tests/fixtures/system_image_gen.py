#!/usr/bin/env python3
"""Small offline fallback used by the public CVM wrapper tests."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace


def _dependency_hint(package: str, upgrade: bool = False) -> str:
    return f"install {package}" if not upgrade else f"upgrade {package}"


def _warn(message: str) -> None:
    print(message, file=sys.stderr)


def _die(message: str) -> None:
    raise SystemExit(message)


def _validate_gpt_image_2_size(size: str) -> None:
    if re.fullmatch(r"[1-9][0-9]{2,4}x[1-9][0-9]{2,4}", size) is None:
        _die("invalid image size")


def _validate_model_specific_options(*, model: str, background: str | None,
                                     input_fidelity: str | None = None) -> None:
    del model, background, input_fidelity


def _validate_size(size: str, model: str) -> None:
    del model
    _validate_gpt_image_2_size(size)


def _ensure_api_key(dry_run: bool) -> None:
    del dry_run


def _create_client():
    _die("the offline fixture cannot create a live client")


def _add_shared_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default="gpt-image-1")
    parser.add_argument("--prompt", default="")
    parser.add_argument("--prompt-file")
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--quality", default="auto")
    parser.add_argument("--background", default="auto")
    parser.add_argument("--output-format", default="png")
    parser.add_argument("--out")
    parser.add_argument("--dry-run", action="store_true")
    parser.set_defaults(image=None, input_fidelity=None, mask=None)


def _prompt(args: argparse.Namespace) -> str:
    if args.prompt_file:
        return Path(args.prompt_file).read_text(encoding="utf-8")
    return args.prompt


def _generate(args: argparse.Namespace) -> None:
    print(json.dumps({
        "endpoint": "/v1/images/generations",
        "model": args.model,
        "prompt": _prompt(args),
        "size": args.size,
    }))


def _edit(args: argparse.Namespace) -> None:
    if args.dry_run:
        payload = {
            "endpoint": "/v1/images/edits",
            "model": args.model,
            "prompt": _prompt(args),
            "image": args.image,
        }
        if args.input_fidelity is not None:
            payload["input_fidelity"] = args.input_fidelity
        print(json.dumps(payload))
        return
    client = _create_client()
    images = [Path(image).open("rb") for image in args.image]
    try:
        request = {
            "image": images,
            "prompt": _prompt(args),
            "model": args.model,
        }
        if args.input_fidelity is not None:
            request["input_fidelity"] = args.input_fidelity
        client.images.edit(**request)
    finally:
        for image in images:
            image.close()


def _decode_write_and_downscale(*args, **kwargs):
    del args, kwargs


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate")
    _add_shared_args(generate)
    edit = commands.add_parser("edit")
    _add_shared_args(edit)
    edit.add_argument("--image", action="append", required=True)
    batch = commands.add_parser("generate-batch")
    _add_shared_args(batch)
    batch.add_argument("--input", required=True)
    batch.add_argument("--out-dir", required=True)
    batch.add_argument("--concurrency", type=int, default=1)
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    _validate_size(args.size, args.model)
    _validate_model_specific_options(
        model=args.model,
        background=args.background,
        input_fidelity=args.input_fidelity,
    )
    _ensure_api_key(args.dry_run)
    if args.command == "generate" and args.image:
        _edit(args)
    elif args.command == "edit":
        _edit(args)
    else:
        _generate(args)
    return 0
