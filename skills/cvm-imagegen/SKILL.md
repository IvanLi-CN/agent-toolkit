---
name: cvm-imagegen
description: "Explicit CLI fallback for GPT Image workflows through a configured OpenAI-compatible endpoint."
---

# CVM Image Generation

This Skill provides an explicit CLI fallback for image generation and editing. It preserves the fallback CLI surface while taking the endpoint and credential names from configuration.

## Runtime contract

- `CVM_API_KEY` supplies the credential for live calls.
- `CVM_BASE_URL` supplies the OpenAI-compatible endpoint.
- `AGENT_IMAGEGEN_SYSTEM_PATH` points to the fallback implementation used by the wrapper.
- `scripts/image_gen.py` is the public entrypoint.

All three values are explicit. Dry-run validation does not require the key or endpoint; live calls fail fast when either is missing. The wrapper does not modify an installed runtime or assume a particular agent home directory.

## Usage

```bash
export AGENT_IMAGEGEN_SYSTEM_PATH=/path/to/image_gen.py
export CVM_BASE_URL=https://api.example.invalid/v1
export CVM_API_KEY=provided-out-of-band
python3 skills/cvm-imagegen/scripts/image_gen.py generate \
  --prompt "A cozy alpine cabin at dawn" \
  --out output/imagegen/cabin.png
```

Use `--dry-run` to inspect a request without network access. The wrapper supports `generate`, `edit` and `generate-batch`, including repeated `--image` reference inputs and the model-specific validation inherited from the configured fallback.

## Guardrails

- Use this Skill only when an explicit CLI/API path is required.
- Keep credentials outside source files, command history and ordinary logs.
- Do not create an additional resident service or endpoint proxy.
- Backend HTTP errors are reported as backend rejections; local request errors stop before a network call.

See [the CLI reference](references/cli.md), [the API reference](references/image-api.md) and [the wrapper](scripts/image_gen.py).
