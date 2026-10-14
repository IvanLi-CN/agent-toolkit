# CLI reference

The wrapper keeps the fallback command names `generate`, `edit` and `generate-batch`.

## Environment

- `CVM_API_KEY`: credential for live calls.
- `CVM_BASE_URL`: OpenAI-compatible base URL, including the API version path when required by the service.
- `AGENT_IMAGEGEN_SYSTEM_PATH`: absolute or relative path to the fallback `image_gen.py` implementation.

Dry-run mode works without the credential or endpoint. Live mode fails fast when either is unset.

## Examples

```bash
python3 skills/cvm-imagegen/scripts/image_gen.py generate \
  --prompt "Test" --out output/imagegen/test.png --dry-run

python3 skills/cvm-imagegen/scripts/image_gen.py edit \
  --image input.png --prompt "Replace the background" \
  --out output/imagegen/edited.png

python3 skills/cvm-imagegen/scripts/image_gen.py generate-batch \
  --input tmp/imagegen/prompts.jsonl --out-dir output/imagegen/batch
```

Reference-guided `generate --image` uses the edit endpoint and accepts repeated input images. Transparent edits require a PNG or WebP output. Existing output paths are protected unless the fallback's explicit force option is supplied.

## Common flags

`--model`, `--prompt`, `--prompt-file`, `--size`, `--quality`, `--background`, `--output-format`, `--out`, `--out-dir`, `--dry-run`, `--image`, `--input-fidelity`, `--mask`, `--input` and `--concurrency` are delegated to the configured fallback implementation.
