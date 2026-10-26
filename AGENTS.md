# Agent Toolkit

Agent Toolkit is the public source for the reusable Skills listed in `PUBLIC_SKILLS.txt`, together with the small repository checks that keep that source standalone and auditable. A consumer loads Skill directories directly from this checkout or a source link; the repository does not generate a copied consumer tree, install a runtime adapter, or store deployment configuration.

## Repository responsibilities

- `skills/` contains the maintained public Skills and their self-contained scripts, references, assets, and tests.
- `PUBLIC_SKILLS.txt` is the public membership allowlist; `skills/README.md` is the human-readable catalog and must contain the same local Skills exactly once.
- `bin/` contains only public repository checks and their Bun tests. Domain and application-specific Skill implementations remain under their owning Skill directory.
- `docs/specs/`, `docs/adr/`, `GLOSSARY.md`, `README.md`, and `CONTRIBUTING.md` describe public contracts and maintenance boundaries.
- `.github/workflows/` validates the public source on Linux and macOS. A workflow passing is not a production deployment or a publication approval.

The repository owns reusable source and validation contracts. Operators own credentials, real inventory, deployment addresses, host configuration, and consumer-specific integrations. Keep those values outside this repository.

## Local validation

Use the Bun installed on the host; this repository does not select or download an exact Bun or Node.js version.

```bash
bun install --frozen-lockfile
bun --version
bun run typecheck
bun run check
bun run test:repo
python3 -m pip install -r requirements-dev.txt
ruby -e 'require "yaml"'
bun run test:skills
```

`test:repo` discovers repository-owned Bun, Python, and Shell test files outside `skills/`. `test:skills` discovers those same test families below `skills/`. The runner rejects empty or non-declarative Bun/Python test files before execution; Shell tests must execute at least one counted `test` builtin in the suite shell or a sourced helper and report `TESTS_RUN=<count>`. Assertions confined to a separate helper process do not contribute to the count; assert that helper's result in the suite shell. See [validation prerequisites](README.md#validation) for supported runner platforms, native commands, and Bun FFI requirements. Python dependencies needed by application-facing or domain tests are declared separately in `requirements-dev.txt`; the XP policy test also requires Ruby with its standard YAML library; text-only Skills need no programming runtime.

The source-target inventory check is an opt-in migration check because it compares a synthetic or explicitly supplied Git source snapshot:

```bash
bun run bin/source_target_inventory_check.ts --source-root /path/to/source --source-revision HEAD
```

It is not required for ordinary standalone checkout validation.

## Public boundaries

`bun run check` includes the foundation consistency gate: membership, catalog, language allocation, Spec/implementation coverage, requirement/scenario identities, and local/CI validation wiring must agree. Record migration targets separately from completed behavior evidence; root validation does not prove domain migration, deployment, or remote required-check enforcement.

Use direct repository-relative links and neutral placeholders in public content. Do not add credentials, real hostnames, personal filesystem paths, private runtime/task integration, copied consumer Skills, or resident synchronization services. Python, C, and POSIX Shell remain allowed only where the public language matrix records a concrete application, native-rendering, or remote-observation boundary.

Changes to a CLI, protocol, lifecycle rule, durable state, or configuration schema must update its public contract and behavior tests in the same change. Keep one active implementation per executable responsibility and remove a replaced public check rather than leaving two entrypoints active.

## Contract anchors

- The CVM image fallback keeps its Python module-integration boundary in [`skills/cvm-imagegen/SKILL.md`](skills/cvm-imagegen/SKILL.md), [`skills/cvm-imagegen/references/cli.md`](skills/cvm-imagegen/references/cli.md), and [`skills/cvm-imagegen/scripts/test_image_gen.py`](skills/cvm-imagegen/scripts/test_image_gen.py). The configured module and endpoint are explicit prerequisites; the public wrapper does not create a second API client.
- XP policy and read-only audit behavior are defined by [`skills/xp-infra/SKILL.md`](skills/xp-infra/SKILL.md), [`skills/xp-infra/references/runbook.md`](skills/xp-infra/references/runbook.md), and [`skills/xp-infra/tests/test-xp-infra.sh`](skills/xp-infra/tests/test-xp-infra.sh). Live aliases, addresses, credentials, and exception records remain operator-owned.
