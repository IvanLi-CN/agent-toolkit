# Script language decisions by Skill

Status: accepted target allocation. This document classifies every public Skill and its owned executable responsibilities; it describes target implementations, not completed conversions or proven Bun equivalence. [SPEC.md](SPEC.md) defines the requirements and verification, and [IMPLEMENTATION.md](IMPLEMENTATION.md) records verified implementation coverage. Recording the allocation does not establish that a conversion or production deployment has happened.

## Decision rules

Complexity means relationships between states, requests, errors, configuration, and modules, not source-file length. Prefer TypeScript with Bun when those relationships dominate the work: discriminated unions, narrowing, explicit module contracts, and exhaustive handling can make invalid combinations and incomplete changes visible during type checking. Python can also model and statically check these relationships; the recommendation is specific to this project's selected Bun toolchain, not a claim that Python cannot support complex software.

An application-host API or an explicit Python module interface can outweigh that preference. A small native mechanism such as `flock` is not sufficient to choose Python for an entire stateful control program. Use direct Bun-native APIs and focused internal native bindings when appropriate; do not place TypeScript wrappers around Python implementations. Type checking does not validate external JSON, preserve numeric precision, serialize concurrent processes, or prove recovery behavior.

Keep Shell for direct native command collection on machines that should not need another runtime. Keep policy decisions, normalization, and complex reporting in TypeScript on the operator side. These are distinct execution responsibilities across an existing SSH boundary, not a runtime adapter layer. Text-only Skills need no implementation language or programming-runtime prerequisite.

Local Bun follows the installed host runtime; CI follows the latest stable Bun and records the actual version. Declaring a Bun prerequisite on a managed control host or VM image does not authorize installing or upgrading it during ordinary Skill execution. Deployment and image changes remain explicitly authorized operational work. No fixed Bun or Node version is imposed.

## Complete public Skill matrix

| Skill | Current owned code | Recommended target | Concrete reason |
| --- | --- | --- | --- |
| `agent-requirements` | Markdown and template only | No script/runtime | Produces an agent brief; there is no executable implementation to migrate. |
| `agent-vm` | Python client and source-sync helper, including an embedded guest transaction action | TypeScript + Bun for the client, local sync, and guest transaction | Request identity, generation, retry journal, manifests, ownership, transaction phases, and recovery dominate the work. Native directory exchange and locks are necessary mechanisms, not a Python-only domain. |
| `agent-vm-ops` | TypeScript/Bun one-shot controller, embedded guest disk-growth action, systemd launch assets | TypeScript + Bun for the controller and guest action | Lease/port state machines, idempotence, admission, conservative accounting, expiration, and reconciliation benefit from explicit typed contracts. Use SQLite and native process/lock mechanisms directly; preserve one-shot execution. |
| `buzzer-audio-preview` | `scripts/buzzer_preview.ts`; the former Python entrypoint is retired | TypeScript + Bun | Score/config/event models and MIDI/WAV encoding require no Python-host API. Typed score variants and byte-level output checks are a suitable fit. |
| `cvm-imagegen` | Python fallback-module integration, Python tests and fixture | Python for the defined module integration | This Skill explicitly loads a configured Python module and replaces its functions/client factories. A TS implementation cannot preserve that in-process interface directly. The HTTP image API itself does not require Python. |
| `docs-no-revision-markers` | Markdown only | No script/runtime | Documentation-writing guidance has no owned executable. |
| `dst-dedicated-server` | `scripts/dst_snapshot.ts` and `scripts/dst_mods_from_modoverrides.ts` for local work; `scripts/dst_snapshot_remote.sh` and `scripts/dst_mods_remote_collect.sh` for remote collection; former combined Bash entrypoints are retired | TypeScript + Bun for local CLI, interpretation, and reports; Bash for remote native collection | Argument/options, local/remote results, partial failures, shard comparisons, and report structure belong in typed local code. Remote collection should not require installing Bun on each game server; the remote Bash prerequisite is explicit. |
| `firmware-display-preview` | `scripts/fb_to_png.ts`; C host-rendering assets; the former Python converter is retired | TypeScript + Bun for conversion; C for native rendering | Pixel formats, stride, PNG chunks, and compression are portable byte-processing tasks. C assets directly reuse the firmware rendering ABI and must not be replaced by reimplemented TS rendering. |
| `git-remote-troubleshoot` | Markdown only | No script/runtime | Uses the user's existing Git/SSH/platform tools; no owned executable needs a language choice. |
| `git-sync` | Markdown workflow and `scripts/test_detached_alignment_contract.test.ts`; the former Python contract test is retired | Keep the text workflow; TypeScript + Bun for the owned test | The test creates Git fixtures and checks observable command behavior. It has no Python-specific domain dependency. Do not introduce a new production Git CLI merely to use TS. |
| `linux-server-init` | Markdown/reference guidance only | No script/runtime | Native administration commands are workflow instructions, not an owned Python or TS application. |
| `mcu-agentd-project-integration` | Markdown/template/configuration resources | No script/runtime | Integrates an external tool through its existing interface; do not rewrite that tool or invent a proxy. |
| `requirements-analysis` | Markdown and template only | No script/runtime | Requirements drafting has no owned executable. |
| `step-stl-print-repair` | Five Python FreeCAD, Blender, and Gmsh scripts | Python for all five domain scripts | FreeCAD/Blender run through their application Python APIs; Gmsh has an official Python binding. TS would require replacing domain interfaces or maintaining native bindings without a corresponding benefit. |
| `tavily-hikari-infra` | A short Bash inventory/status/log helper | Shell | Direct role selection and SSH command forwarding have little domain-model complexity. A TS or Python application would add a runtime prerequisite without a clear functional benefit. |
| `xp-infra` | Bash orchestration, Ruby policy/audit interpretation, POSIX remote probes | TypeScript + Bun for local orchestration, policy, normalization, and decisions; POSIX Shell for remote probes | Policy schema, audit observations, identity revalidation, public target validation, and port-preflight conclusions are complex structured logic. Remote probes retain bounded, authorized native observation without requiring Bun on inspected nodes. |

## Exact script responsibilities

### Agent VM client and source sync

- [`agent_vm.py`](../../../skills/agent-vm/scripts/agent_vm.py): replace the client implementation with direct TS/Bun. Keep session precedence, missing-identity failure, protocol envelope, journal/digest behavior, transport exits, and generation-bound connection material.
- [`sync_worktree.py`](../../../skills/agent-vm/scripts/sync_worktree.py): implement local selection/orchestration and the guest transaction with TS/Bun. Keep Git byte-path handling, symlinks/modes/hashes, submodule refusal, baseline conflict checks, precise owned paths, fsync, exclusive file creation, atomic exchange, and lost-ack recovery. The guest action stays a bounded action, not a resident service.
- Guest Bun availability becomes an explicit managed-image prerequisite. A missing prerequisite fails before a guest write; do not install Bun opportunistically or fall back to a weaker directory-replacement algorithm.

### Agent VM control

- [`agent_vm_control.ts`](../../../skills/agent-vm-ops/scripts/agent_vm_control.ts): TS/Bun owns the complete one-shot control program. Separate typed protocol, state transitions, store, admission, native command execution, and recovery as ordinary internal modules; this does not introduce adapters or extra runtime hops. The Bun test suite covers fake-native lifecycle, persistence, idempotence, growth, expiry and bounded-process behavior; production rollout remains a separate operational outcome.
- Implement cross-process locks and native operations directly in the same control process. Preserve short SQLite transactions, native-operation lock ordering, bounded stream draining, descendant termination, generation fences, decimal allocation rounding, conservative reservations, and idempotent operation responses.
- The embedded guest disk-growth action is implemented in Bun along with the guest runtime prerequisite. Preserve direct ext4/xfs partition constraints and use native `findmnt`, `lsblk`, `blockdev`, `growpart`, and filesystem growth commands.
- Update control-host SSH execution, systemd expiry/reconcile/age-GC launch assets, managed-image checks, and deployment prerequisites together. Bun on the developer's computer does not establish its presence on the control host or guest.
- Existing persisted digests, database records, and request serialization are compatibility contracts. Ordinary JS object serialization or floating-point arithmetic must not silently replace their semantics.

### XP operations

- [`xp-infra`](../../../skills/xp-infra/scripts/xp-infra): replace local CLI routing, policy validation, timeouts, target checks, result interpretation, and reporting with TS/Bun. Move complex local Ruby expressions into typed functions; keep remote-native collection at its existing execution boundary.
- [`xp-infra-audit-local`](../../../skills/xp-infra/scripts/xp-infra-audit-local): replace the Ruby interpretation with TS/Bun. Preserve duplicate-record/member rejection, explicit booleans, schema checks, freshness, identity, public-port and URL rules. `JSON.parse` or a YAML parser alone does not reproduce these validation contracts.
- [`xp-infra-compose-image-check`](../../../skills/xp-infra/scripts/xp-infra-compose-image-check): express its exact-single-image check as a local typed function, rather than keeping an extra parser runtime or wrapper process.
- [`xp-infra-audit-remote`](../../../skills/xp-infra/scripts/xp-infra-audit-remote) and [`xp-infra-audit-vless-remote`](../../../skills/xp-infra/scripts/xp-infra-audit-vless-remote): retain POSIX Shell for bounded native collection and identity revalidation. Keep permission/runtime observation where it actually occurs. Do not require Bun on arbitrary inspected servers or move remote identity checks into an unverifiable local assumption.

### Game-server diagnostics

- [`dst_snapshot.ts`](../../../skills/dst-dedicated-server/scripts/dst_snapshot.ts): use TS/Bun for local options, filesystem reads, bounded result handling, and Markdown report composition. [`dst_snapshot_remote.sh`](../../../skills/dst-dedicated-server/scripts/dst_snapshot_remote.sh) retains remote native collection in Shell.
- [`dst_mods_from_modoverrides.ts`](../../../skills/dst-dedicated-server/scripts/dst_mods_from_modoverrides.ts): use TS/Bun locally to interpret safely collected shard data and produce enabled/disabled/unknown summaries and comparisons. [`dst_mods_remote_collect.sh`](../../../skills/dst-dedicated-server/scripts/dst_mods_remote_collect.sh) emits only a bounded projection of Workshop IDs and top-level enabled state, never the selected raw file. Do not execute an untrusted Lua configuration as a parsing shortcut or claim a broader Lua grammar than the tested contract.

### Media and firmware helpers

- [`buzzer_preview.ts`](../../../skills/buzzer-audio-preview/scripts/buzzer_preview.ts): use TS/Bun for score validation, event scheduling, MIDI, and WAV output. Verify format structure, timings, sample bounds, and malformed scores; language choice is not an audio-quality guarantee.
- [`fb_to_png.ts`](../../../skills/firmware-display-preview/scripts/fb_to_png.ts): use TS/Bun for framebuffer decoding and PNG output. Preserve each supported format, stride and orientation rules, CRC/chunk layout, and small fixture pixel results. The C rendering resources remain native code.

### Python-specific integrations

- [`image_gen.py`](../../../skills/cvm-imagegen/scripts/image_gen.py), its test, and fallback fixture remain Python for the existing module-integration contract. The exception is the Python callable/module interface, not the OpenAI SDK or HTTP endpoint. A standalone TS image API client would be a different product contract requiring its own decision; adding TS in front of the current Python wrapper is not recommended.
- [`freecad_step_to_stl.py`](../../../skills/step-stl-print-repair/scripts/freecad_step_to_stl.py) stays Python for FreeCAD geometry and tessellation APIs.
- [`gmsh_step_to_stl.py`](../../../skills/step-stl-print-repair/scripts/gmsh_step_to_stl.py) stays Python for the official Gmsh API. Other native APIs exist; writing a TS native binding is not justified by this meshing/reporting task.
- [`blender_stl_to_binary.py`](../../../skills/step-stl-print-repair/scripts/blender_stl_to_binary.py), [`blender_stl_check_batch.py`](../../../skills/step-stl-print-repair/scripts/blender_stl_check_batch.py), and [`blender_stl_preview.py`](../../../skills/step-stl-print-repair/scripts/blender_stl_preview.py) stay Python for Blender import/export, validation extension, and scene/render APIs. Keep direct application execution instead of adding a TS launcher layer.

### Repository checks and tests

Retained index, public-boundary/coupling, source-target inventory, and contract checks use TS/Bun with their behavioral tests. Remove unrelated private workflow remnants by public scope rather than converting them. The detached Git alignment test moves to Bun's test tooling; VM/XP/media tests follow their target execution interfaces. Python integration tests stay Python where they verify Python module/application contracts.

Every conversion must update its entrypoints, tests, prerequisite declarations, and contract evidence together. [The project foundation contract](SPEC.md) distinguishes source implementation, required behavior evidence, and later operational rollout. Verified coverage belongs in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Sources and evidence limits

This inventory comes from the public Skill tree and script imports, entrypoints, embedded actions, and existing contracts/tests. Language fit is an accepted design decision. No equivalent Bun VM controller, native binding, or production deployment was run to establish behavioral equivalence.

- [TypeScript discriminated unions and exhaustive handling](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Python type hints and static checking boundary](https://docs.python.org/3/library/typing.html)
- [Bun native-library interface](https://bun.com/docs/runtime/ffi)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Gmsh official API interfaces](https://gmsh.info/doc/texinfo/#Gmsh-API)
