# Project foundation implementation coverage

## Current Status

Public membership: 13 Skills, defined by [PUBLIC_SKILLS.txt](../../../PUBLIC_SKILLS.txt). The root governance guide and maintained repository checks use the standalone public source with directly executed TypeScript under installed Bun. Buzzer/framebuffer conversion, DST local tooling and the owned Git alignment test use Bun with the helper behavior evidence below; remote Shell, native C rendering, Python CAD/application bindings and text-only production workflows retain their declared boundaries. The language matrix records allocation separately from this implementation coverage. Usage-guide expansion and the documentation site remain unimplemented requirements here.

## Skill Migration Coverage

The statuses below describe language migration coverage, not deployment status. `deferred` means the allocated conversion has not been delivered; `migrated` means the owned conversion, entrypoints, prerequisites and tests are present with linked behavior evidence; `retained` means the concrete application/module/remote exception remains; `no-runtime` means the production Skill is text-only, even if maintainers use a programming runtime for repository smoke tests. Source links identify the current contract. A root consistency pass alone cannot establish behavioral equivalence, application execution or rollout.

| Skill | Migration status | Evidence |
| --- | --- | --- |
| `agent-vm` | deferred | [Python client and source sync](../../../skills/agent-vm/SKILL.md) |
| `agent-vm-ops` | deferred | [Python controller and guest growth](../../../skills/agent-vm-ops/SKILL.md) |
| `buzzer-audio-preview` | migrated | [Bun score and MIDI/WAV helper](../../../skills/buzzer-audio-preview/SKILL.md); [Behavior evidence](../../../skills/buzzer-audio-preview/tests/buzzer_preview.test.ts): independent media decoding, timing, tone/sample bounds and invalid inputs. |
| `cvm-imagegen` | retained | [Python module integration](../../../skills/cvm-imagegen/SKILL.md) |
| `docs-no-revision-markers` | no-runtime | [Text guidance](../../../skills/docs-no-revision-markers/SKILL.md) |
| `dst-dedicated-server` | migrated | [Bun local tooling and retained remote Shell](../../../skills/dst-dedicated-server/SKILL.md); [Behavior evidence](../../../skills/dst-dedicated-server/tests/dst_helpers.test.ts): temporary files, fake SSH, isolated native Shell, bounded reports, shard differences and non-executable Lua parsing. |
| `firmware-display-preview` | migrated | [Bun conversion and retained C rendering](../../../skills/firmware-display-preview/SKILL.md); [Behavior evidence](../../../skills/firmware-display-preview/tests/fb_to_png.test.ts): five formats, independent PNG/pixel decoding and a native C stub smoke. |
| `git-remote-troubleshoot` | no-runtime | [Text guidance using existing Git/SSH tools](../../../skills/git-remote-troubleshoot/SKILL.md); [Source-link smoke](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts) is a Bun maintainer test, not a production CLI or live authentication check. |
| `git-sync` | migrated | [Text workflow and Bun contract test](../../../skills/git-sync/SKILL.md); [Behavior evidence](../../../skills/git-sync/tests/detached_alignment_contract.test.ts): isolated native Git refs, HEAD, reflog recovery, configuration invariance and blocked actions; no production Git CLI. |
| `linux-server-init` | no-runtime | [Text guidance](../../../skills/linux-server-init/SKILL.md) |
| `step-stl-print-repair` | retained | [Five Python FreeCAD/Blender/Gmsh application scripts](../../../skills/step-stl-print-repair/SKILL.md); [Binding/source-link inspection](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts) checks retained imports only; CAD application execution is unavailable. |
| `tavily-hikari-infra` | retained | [Bounded Shell helper](../../../skills/tavily-hikari-infra/SKILL.md) |
| `xp-infra` | deferred | [Shell/Ruby local logic and POSIX probes](../../../skills/xp-infra/SKILL.md) |

## Implementation Coverage

- Public membership and direct-source consumption: PUBLIC_SKILLS.txt, skills/README.md, and existing consumer instructions.
- Foundation consistency: `bin/foundation_contract_check.ts` compares manifest membership against catalog, language allocation, and implementation coverage; validates membership counts, preserved requirement/scenario identities, source links, and local/CI validation wiring. Behavioral fixtures exercise drift and fail-closed input handling. Existing public-boundary and tool-dependency checks remain authoritative for private coupling and dependency safety.
- Repository validation: `bin/spec_contract_check.ts`, `bin/skills_index_check.ts`, `bin/public_boundary_check.ts`, `bin/public_skill_boundary_check.ts`, and `bin/source_target_inventory_check.ts` are the maintained Bun entrypoints. `bin/public_tool_boundary_check.ts` recursively checks local TypeScript, JavaScript, Python, and Shell dependencies, rejects unverifiable loader forms and imports of excluded test files, and keeps local references inside the public repository. The source-target inventory also rejects duplicate or invalid public manifest names before comparing source and target. The old private workflow-only root tools are not part of the public source.
- Skill implementations: [SCRIPT-LANGUAGE-MATRIX.md](SCRIPT-LANGUAGE-MATRIX.md) distinguishes source implementations from accepted targets. Buzzer/framebuffer helpers, DST local entrypoints and the owned Git test have one active Bun implementation per replaced responsibility; their former Python/local Shell entrypoints are removed. The C firmware harness, remote Shell collector, five Python CAD/application scripts and text production workflows retain their concrete interfaces. Deferred domains keep their existing implementation/tests until replacement behavior is covered.
- Public design material: Agent VM lifecycle, CLI, retention/reclamation designs and ADRs are already present. This slice anchors the CVM Python module-integration and XP policy/audit guarantees to their current Skill contracts and tests; the broader usage guides and documentation site remain separate work.
- Verification coverage: SPEC.md retains seven cross-cutting evidence requirements and 48 detailed domain scenarios, in addition to the project requirement assertions. No result is inferred from their presence in the document.

### Helper behavior evidence

HELPERS-01 is covered by the [buzzer suite](../../../skills/buzzer-audio-preview/tests/buzzer_preview.test.ts), which independently decodes MIDI/WAV and compares tone timing, rests, sample limits and invalid-score diagnostics. HELPERS-02 is covered by the [framebuffer suite](../../../skills/firmware-display-preview/tests/fb_to_png.test.ts), which independently validates PNG chunks/CRCs and known pixels for all five formats, plus native compilation and the C stub's explicit unimplemented-accessor failure. These fixtures establish portable conversion behavior, not physical acoustics, device display observation or execution of a project's real firmware renderer.

HELPERS-03 and HELPERS-04 are covered by the [DST suite](../../../skills/dst-dedicated-server/tests/dst_helpers.test.ts): temporary client/cluster files, fake SSH, native Shell collection against a temporary home, local/remote selection, absent resources, failed transport, secret omission, output caps, whole-command timeout, shard summaries/differences and the documented non-executable Lua table subset. Fake SSH is transport simulation; executing the Shell collector locally is isolated native OS evidence. No actual dedicated server, deployment or game readiness was observed.

HELPERS-05 is covered by the [Git alignment suite](../../../skills/git-sync/tests/detached_alignment_contract.test.ts), which checks actual Git refs, detached HEAD, reflog recoverability, branch/remote/upstream configuration and blocked actions in temporary repositories with a filesystem bare remote. HELPERS-06 is covered by the [source-link smoke](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts), which runs the new local entrypoints through consumer directory links from another working directory and inspects replaced-entrypoint absence and retained C/Python source boundaries. CAD binding/import inspection does not execute FreeCAD, Blender or Gmsh; application-level geometry/rendering evidence remains unavailable.

Local helper validation is observed on macOS with installed Bun. Linux helper execution and remote CI results require separate observed runs; CI suite selection or configuration alone does not establish either. The repository runner selects all five maintained Bun helper suites through the existing `skills` discovery path; no Python runtime is needed for the replaced helper tests. Runtime versions and current-candidate results belong to the execution report, not the language allocation.

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

Focused helper verification from the repository root uses installed Bun, Git, a native C compiler (`cc`), and POSIX Shell/native utilities. It needs no live SSH endpoint or CAD application installation:

```bash
bun test ./skills/buzzer-audio-preview/tests ./skills/firmware-display-preview/tests ./skills/dst-dedicated-server/tests ./skills/git-sync/tests ./skills/git-remote-troubleshoot/tests
```

The linked [media](../../../skills/buzzer-audio-preview/references/media-contract.md), [framebuffer](../../../skills/firmware-display-preview/references/framebuffer-contract.md), and [DST](../../../skills/dst-dedicated-server/references/helper-contract.md) contracts define supported inputs, limits, prerequisites and evidence boundaries. Production CAD scripts still require the application Python environments declared by [STEP/STL Print Repair](../../../skills/step-stl-print-repair/SKILL.md); repository source inspection is not a substitute for those prerequisites.

## Compatibility and Deployment

CI declares `checks (ubuntu-latest)` and `checks (macos-latest)` on pushes and pull requests, with read-only content permission, latest stable Bun, observed runtime versions, frozen dependencies, explicit type checking, root checks, repository tests, and Skill tests. The foundation gate checks this wiring; actual job results are SHA-bound delivery evidence, not a claim made by this document. Remote branch protection, required-check enforcement, Linux/macOS execution, and production publication cannot be inferred solely from workflow inspection.

Language migration must preserve existing request envelopes, canonical digests, durable state, native locking/atomicity, and recoverability. Test evidence must separate fake infrastructure, native isolated behavior, and actual deployment observations. Control-host and managed-guest runtime prerequisites require explicit deployment validation; documentation does not authorize installing them on a production system.

A linked-consumer experiment must preserve third-party/private entries. A site preview must exercise production static output under the repository subpath. Formal site publication and production Agent VM rollout are separate operational outcomes. Local validation records the observed Bun version; it does not establish production deployment behavior.

## References

- [Requirements and verification](SPEC.md)
- [Topic history](HISTORY.md)
