# Image API quick reference

The wrapper delegates request construction to a configured OpenAI-compatible Images API endpoint selected by `CVM_BASE_URL`.

## Endpoints

- Text-only generation uses `POST /images/generations` through `client.images.generate`.
- Reference-guided generation and editing use `POST /images/edits` through `client.images.edit`.

## Parameters

Core fields include `prompt`, `model`, `n`, `size`, `quality`, `background`, `output_format`, `output_compression` and `moderation`. Edits additionally accept `image`, `mask` and `input_fidelity`.

The fallback owns model-specific validation. The wrapper preserves transparent-output checks and labels HTTP 4xx/5xx responses as backend rejections. `--dry-run` validates the local request and prints its payload without contacting the endpoint.
