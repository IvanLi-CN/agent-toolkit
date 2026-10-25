# Project foundation implementation coverage

## Current Status

Public membership: 13 Skills, defined by [PUBLIC_SKILLS.txt](../../../PUBLIC_SKILLS.txt). The root governance guide and maintained repository checks use the standalone public source with directly executed TypeScript under installed Bun. The language matrix records target allocation; it is not evidence of completed domain migrations. Usage-guide expansion and the documentation site remain unimplemented requirements here.

## Skill Migration Coverage

The statuses below describe language migration coverage, not a fresh execution result for existing code. `deferred` means the allocated conversion has not been delivered; `retained` means the concrete application/module/remote exception remains; `no-runtime` means there is no executable implementation to convert. Source links identify the current contract. A completed conversion must replace `deferred` with `migrated` and link its behavior evidence; a root consistency pass cannot establish equivalence or rollout.

| Skill | Migration status | Evidence |
| --- | --- | --- |
| `agent-vm` | deferred | [Python client and source sync](../../../skills/agent-vm/SKILL.md) |
| `agent-vm-ops` | deferred | [Python controller and guest growth](../../../skills/agent-vm-ops/SKILL.md) |
| `buzzer-audio-preview` | deferred | [Python score and media helper](../../../skills/buzzer-audio-preview/SKILL.md) |
| `cvm-imagegen` | retained | [Python module integration](../../../skills/cvm-imagegen/SKILL.md) |
| `docs-no-revision-markers` | no-runtime | [Text guidance](../../../skills/docs-no-revision-markers/SKILL.md) |
| `dst-dedicated-server` | deferred | [Bash local tooling and remote collection](../../../skills/dst-dedicated-server/SKILL.md) |
| `firmware-display-preview` | deferred | [Python conversion and native C rendering](../../../skills/firmware-display-preview/SKILL.md) |
| `git-remote-troubleshoot` | no-runtime | [Text guidance](../../../skills/git-remote-troubleshoot/SKILL.md) |
| `git-sync` | deferred | [Text workflow and Python contract test](../../../skills/git-sync/SKILL.md) |
| `linux-server-init` | no-runtime | [Text guidance](../../../skills/linux-server-init/SKILL.md) |
| `step-stl-print-repair` | retained | [Python application APIs](../../../skills/step-stl-print-repair/SKILL.md) |
| `tavily-hikari-infra` | retained | [Bounded Shell helper](../../../skills/tavily-hikari-infra/SKILL.md) |
| `xp-infra` | deferred | [Shell/Ruby local logic and POSIX probes](../../../skills/xp-infra/SKILL.md) |

## Implementation Coverage

- Public membership and direct-source consumption: PUBLIC_SKILLS.txt, skills/README.md, and existing consumer instructions.
- Foundation consistency: `bin/foundation_contract_check.ts` compares manifest membership against catalog, language allocation, and implementation coverage; validates membership counts, preserved requirement/scenario identities, source links, and local/CI validation wiring. Behavioral fixtures exercise drift and fail-closed input handling. Existing public-boundary and tool-dependency checks remain authoritative for private coupling and dependency safety.
- Repository validation: `bin/spec_contract_check.ts`, `bin/skills_index_check.ts`, `bin/public_boundary_check.ts`, `bin/public_skill_boundary_check.ts`, and `bin/source_target_inventory_check.ts` are the maintained Bun entrypoints. `bin/public_tool_boundary_check.ts` recursively checks local TypeScript, JavaScript, Python, and Shell dependencies, rejects unverifiable loader forms and imports of excluded test files, and keeps local references inside the public repository. The source-target inventory also rejects duplicate or invalid public manifest names before comparing source and target. The old private workflow-only root tools are not part of the public source.
- Skill implementations: [SCRIPT-LANGUAGE-MATRIX.md](SCRIPT-LANGUAGE-MATRIX.md) distinguishes source implementations from accepted targets. Existing Python/Shell tests remain authoritative until their replacements preserve the covered behavior.
- Public design material: Agent VM lifecycle, CLI, retention/reclamation designs and ADRs are already present. This slice anchors the CVM Python module-integration and XP policy/audit guarantees to their current Skill contracts and tests; the broader usage guides and documentation site remain separate work.
- Verification coverage: SPEC.md retains seven cross-cutting evidence requirements and 48 detailed domain scenarios, in addition to the project requirement assertions. No result is inferred from their presence in the document.

## Verification Commands

The maintained structural and test checks are:

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

The test runner discovers Bun, Python, and Shell tests by maintained filename conventions, rejects empty or non-declarative Bun/Python test files, counts Shell `test` builtins in the suite shell and sourced helpers through a Bash wrapper, and fails closed on an empty selection or zero counted assertions. Child-helper results require an assertion in the suite shell. Supported runner platforms and native/Bun FFI prerequisites are listed in the root [validation guide](../../../README.md#validation). `bun run test:skills` preserves Python application/domain and Shell remote-observation tests; their Python dependencies remain in `requirements-dev.txt`, and the XP policy test requires Ruby with its standard YAML library. These runtime prerequisites remain separate from root Bun tooling. Documentation build commands belong here when the Bun/Rspress implementation exists.

## Compatibility and Deployment

CI declares `checks (ubuntu-latest)` and `checks (macos-latest)` on pushes and pull requests, with read-only content permission, latest stable Bun, observed runtime versions, frozen dependencies, explicit type checking, root checks, repository tests, and Skill tests. The foundation gate checks this wiring; actual job results are SHA-bound delivery evidence, not a claim made by this document. Remote branch protection, required-check enforcement, Linux/macOS execution, and production publication cannot be inferred solely from workflow inspection.

Language migration must preserve existing request envelopes, canonical digests, durable state, native locking/atomicity, and recoverability. Test evidence must separate fake infrastructure, native isolated behavior, and actual deployment observations. Control-host and managed-guest runtime prerequisites require explicit deployment validation; documentation does not authorize installing them on a production system.

A linked-consumer experiment must preserve third-party/private entries. A site preview must exercise production static output under the repository subpath. Formal site publication and production Agent VM rollout are separate operational outcomes. Local validation records the observed Bun version; it does not establish production deployment behavior.

## References

- [Requirements and verification](SPEC.md)
- [Topic history](HISTORY.md)
