# Project foundation implementation coverage

## Current Status

The foundation implementation is delivered in bounded slices. This slice keeps the 16 public Skills unchanged, establishes a public root governance guide, and replaces the maintained repository checks with directly executed TypeScript under the installed Bun runtime. The broader Skill migrations and documentation site remain separate contracts.

## Implementation Coverage

- Public membership and direct-source consumption: PUBLIC_SKILLS.txt, skills/README.md, and existing consumer instructions.
- Repository validation: `bin/spec_contract_check.ts`, `bin/skills_index_check.ts`, `bin/public_boundary_check.ts`, `bin/public_skill_boundary_check.ts`, and `bin/source_target_inventory_check.ts` are the maintained Bun entrypoints. `bin/public_tool_boundary_check.ts` checks root-tool coupling and local references. The old private workflow-only root tools are not part of the public source.
- Skill implementations: [SCRIPT-LANGUAGE-MATRIX.md](SCRIPT-LANGUAGE-MATRIX.md) distinguishes source implementations from accepted targets. Existing Python/Shell tests remain authoritative until their replacements preserve the covered behavior.
- Public design material: Agent VM lifecycle, CLI, retention/reclamation designs and ADRs are already present. This slice anchors the CVM Python module-integration and XP policy/audit guarantees to their current Skill contracts and tests; the broader usage guides and documentation site remain separate work.
- Verification coverage: SPEC.md retains seven cross-cutting evidence requirements and 48 detailed domain scenarios, in addition to the project requirement assertions. No result is inferred from their presence in the document.

## Verification Commands

The maintained structural and test checks are:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run check
bun run test:repo
python3 -m pip install -r requirements-dev.txt
ruby -e 'require "yaml"'
bun run test:skills
```

The test runner discovers Bun, Python, and Shell tests by maintained filename conventions, rejects empty or non-declarative Bun/Python test files, and fails closed on an empty selection. `bun run test:skills` preserves Python application/domain and Shell remote-observation tests; their Python dependencies remain in `requirements-dev.txt`, and the XP policy test requires Ruby with its standard YAML library. These runtime prerequisites remain separate from root Bun tooling. Documentation build commands belong here when the Bun/Rspress implementation exists.

## Compatibility and Deployment

Language migration must preserve existing request envelopes, canonical digests, durable state, native locking/atomicity, and recoverability. Test evidence must separate fake infrastructure, native isolated behavior, and actual deployment observations. Control-host and managed-guest runtime prerequisites require explicit deployment validation; documentation does not authorize installing them on a production system.

A linked-consumer experiment must preserve third-party/private entries. A site preview must exercise production static output under the repository subpath. Formal site publication and production Agent VM rollout are separate operational outcomes. Local validation records the observed Bun version; it does not establish production deployment behavior.

## References

- [Requirements and verification](SPEC.md)
- [Topic history](HISTORY.md)
