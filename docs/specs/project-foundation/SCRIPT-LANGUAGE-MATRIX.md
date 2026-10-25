# Script language decisions by Skill

Status: accepted responsibility allocation. This document records current owned source and the accepted target for every public Skill. [SPEC.md](SPEC.md) defines the requirements and verification, and [IMPLEMENTATION.md](IMPLEMENTATION.md) distinguishes completed migrations with behavior evidence from deferred conversions and retained exceptions. An allocation or source link alone does not prove behavioral equivalence or production deployment.

Public membership: 13 Skills, defined by [PUBLIC_SKILLS.txt](../../../PUBLIC_SKILLS.txt). Only manifest-listed Skills receive allocations here; application and remote prerequisites describe their own execution boundaries.

## Decision rules

Complexity means relationships between states, requests, errors, configuration, and modules, not source-file length. Prefer TypeScript with Bun when those relationships dominate the work: discriminated unions, narrowing, explicit module contracts, and exhaustive handling can make invalid combinations and incomplete changes visible during type checking. Python can also model and statically check these relationships; the recommendation is specific to this project's selected Bun toolchain, not a claim that Python cannot support complex software.

An application-host API or an explicit Python module interface can outweigh that preference. A small native mechanism such as `flock` is not sufficient to choose Python for an entire stateful control program. Use direct Bun-native APIs and focused internal native bindings when appropriate; do not place TypeScript wrappers around Python implementations. Type checking does not validate external JSON, preserve numeric precision, serialize concurrent processes, or prove recovery behavior.

Keep Shell for direct native command collection on machines that should not need another runtime. Keep policy decisions, normalization, and complex reporting in TypeScript on the operator side. These are distinct execution responsibilities across an existing SSH boundary, not a runtime adapter layer. Text-only Skills need no implementation language or programming-runtime prerequisite.

Local Bun follows the installed host runtime; CI follows the latest stable Bun and records the actual version. Declaring a Bun prerequisite on a managed control host or VM image does not authorize installing or upgrading it during ordinary Skill execution. Deployment and image changes remain explicitly authorized operational work. No fixed Bun or Node version is imposed.

## Complete public Skill matrix

| Skill | Current owned code | Recommended target | Concrete reason |
| --- | --- | --- | --- |
| `agent-vm` | Python client and source-sync helper, including an embedded guest transaction action | TypeScript + Bun for the client, local sync, and guest transaction | Request identity, generation, retry journal, manifests, ownership, transaction phases, and recovery dominate the work. Native directory exchange and locks are necessary mechanisms, not a Python-only domain. |
| `agent-vm-ops` | Python one-shot controller, embedded guest disk-growth action, systemd launch assets | TypeScript + Bun for the controller and guest action | Lease/port state machines, idempotence, admission, conservative accounting, expiration, and reconciliation benefit from explicit typed contracts. Use SQLite and native process/lock mechanisms directly; preserve one-shot execution. |
| `buzzer-audio-preview` | [Bun score/MIDI/WAV helper](../../../skills/buzzer-audio-preview/scripts/buzzer_preview.ts) and [Bun behavior tests](../../../skills/buzzer-audio-preview/tests/buzzer_preview.test.ts) | TypeScript + Bun | Score/config/event models and MIDI/WAV encoding require no Python-host API. Typed score variants and independently decoded byte-level outputs cover the portable local responsibility. |
| `cvm-imagegen` | Python fallback-module integration, Python tests and fixture | Python for the defined module integration | This Skill explicitly loads a configured Python module and replaces its functions/client factories. A TS implementation cannot preserve that in-process interface directly. The HTTP image API itself does not require Python. |
| `docs-no-revision-markers` | Markdown only | No script/runtime | Documentation-writing guidance has no owned executable. |
| `dst-dedicated-server` | Bun [snapshot CLI](../../../skills/dst-dedicated-server/scripts/dst_snapshot.ts), [mod CLI](../../../skills/dst-dedicated-server/scripts/dst_mods_from_modoverrides.ts), [local collection/transport](../../../skills/dst-dedicated-server/scripts/dst_common.ts), [non-executable Lua subset parser](../../../skills/dst-dedicated-server/scripts/mod_parser.ts), [behavior tests](../../../skills/dst-dedicated-server/tests/dst_helpers.test.ts), and [remote Shell collector](../../../skills/dst-dedicated-server/scripts/dst_collect_remote.sh) | TypeScript + Bun for local CLI, interpretation, and reports; Shell for remote native collection | Argument/options, local/remote results, partial failures, shard comparisons, and report structure belong in typed local code. Remote collection uses native Shell without installing Bun or executing Lua configuration on the server. |
| `firmware-display-preview` | [Bun framebuffer converter](../../../skills/firmware-display-preview/scripts/fb_to_png.ts), [Bun behavior tests](../../../skills/firmware-display-preview/tests/fb_to_png.test.ts), and C [host harness](../../../skills/firmware-display-preview/assets/host_c/preview_main.c)/[scene](../../../skills/firmware-display-preview/assets/host_c/scene.c) | TypeScript + Bun for conversion; C for native rendering | Pixel formats, stride, PNG chunks, and compression are portable byte-processing tasks. C assets directly reuse the firmware rendering ABI; Bun only converts framebuffer bytes. |
| `git-remote-troubleshoot` | [Text workflow](../../../skills/git-remote-troubleshoot/SKILL.md); [repository-only Bun source-link smoke](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts) | No script/runtime | Diagnosis uses the user's existing Git/SSH/platform tools and has no owned production executable. Bun is a maintainer test prerequisite only. |
| `git-sync` | [Text workflow](../../../skills/git-sync/SKILL.md) and [Bun detached-alignment contract test](../../../skills/git-sync/tests/detached_alignment_contract.test.ts) | Keep the text workflow; TypeScript + Bun for the owned test | The test creates isolated Git fixtures and checks observable command behavior. It adds no production Git CLI or programming-runtime requirement to the text workflow. |
| `linux-server-init` | Markdown/reference guidance only | No script/runtime | Native administration commands are workflow instructions, not an owned Python or TS application. |
| `step-stl-print-repair` | Five Python FreeCAD, Blender, and Gmsh scripts listed under Python-specific integrations; [binding/source-link inspection](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts) in the repository smoke | Python for all five domain scripts | FreeCAD/Blender run through their application Python APIs; Gmsh has an official Python binding. The inspection does not execute CAD applications or justify a TS launcher or native binding replacement. |
| `tavily-hikari-infra` | A short Bash inventory/status/log helper | Shell | Direct role selection and SSH command forwarding have little domain-model complexity. A TS or Python application would add a runtime prerequisite without a clear functional benefit. |
| `xp-infra` | Bash orchestration, Ruby policy/audit interpretation, POSIX remote probes | TypeScript + Bun for local orchestration, policy, normalization, and decisions; POSIX Shell for remote probes | Policy schema, audit observations, identity revalidation, public target validation, and port-preflight conclusions are complex structured logic. Remote probes retain bounded, authorized native observation without requiring Bun on inspected nodes. |

## Exact script responsibilities

### Agent VM client and source sync

- [`agent_vm.py`](../../../skills/agent-vm/scripts/agent_vm.py): replace the client implementation with direct TS/Bun. Keep session precedence, missing-identity failure, protocol envelope, journal/digest behavior, transport exits, and generation-bound connection material.
- [`sync_worktree.py`](../../../skills/agent-vm/scripts/sync_worktree.py): implement local selection/orchestration and the guest transaction with TS/Bun. Keep Git byte-path handling, symlinks/modes/hashes, submodule refusal, baseline conflict checks, precise owned paths, fsync, exclusive file creation, atomic exchange, and lost-ack recovery. The guest action stays a bounded action, not a resident service.
- Guest Bun availability becomes an explicit managed-image prerequisite. A missing prerequisite fails before a guest write; do not install Bun opportunistically or fall back to a weaker directory-replacement algorithm.

### Agent VM control

- [`agent_vm_control.py`](../../../skills/agent-vm-ops/scripts/agent_vm_control.py): recommend TS/Bun for the complete one-shot control program. Separate typed protocol, state transitions, store, admission, native command execution, and recovery as ordinary internal modules; this does not introduce adapters or extra runtime hops.
- Implement cross-process locks and native operations directly in the same control process. Preserve short SQLite transactions, native-operation lock ordering, bounded stream draining, descendant termination, generation fences, decimal allocation rounding, conservative reservations, and idempotent operation responses.
- Convert the embedded guest disk-growth action along with the guest runtime prerequisite. Preserve direct ext4/xfs partition constraints and use native `findmnt`, `lsblk`, `blockdev`, `growpart`, and filesystem growth commands.
- Update control-host SSH execution, systemd expiry/reconcile/age-GC launch assets, managed-image checks, and deployment prerequisites together. Bun on the developer's computer does not establish its presence on the control host or guest.
- Existing persisted digests, database records, and request serialization are compatibility contracts. Ordinary JS object serialization or floating-point arithmetic must not silently replace their semantics.

### XP operations

- [`xp-infra`](../../../skills/xp-infra/scripts/xp-infra): replace local CLI routing, policy validation, timeouts, target checks, result interpretation, and reporting with TS/Bun. Move complex local Ruby expressions into typed functions; keep remote-native collection at its existing execution boundary.
- [`xp-infra-audit-local`](../../../skills/xp-infra/scripts/xp-infra-audit-local): replace the Ruby interpretation with TS/Bun. Preserve duplicate-record/member rejection, explicit booleans, schema checks, freshness, identity, public-port and URL rules. `JSON.parse` or a YAML parser alone does not reproduce these validation contracts.
- [`xp-infra-compose-image-check`](../../../skills/xp-infra/scripts/xp-infra-compose-image-check): express its exact-single-image check as a local typed function, rather than keeping an extra parser runtime or wrapper process.
- [`xp-infra-audit-remote`](../../../skills/xp-infra/scripts/xp-infra-audit-remote) and [`xp-infra-audit-vless-remote`](../../../skills/xp-infra/scripts/xp-infra-audit-vless-remote): retain POSIX Shell for bounded native collection and identity revalidation. Keep permission/runtime observation where it actually occurs. Do not require Bun on arbitrary inspected servers or move remote identity checks into an unverifiable local assumption.

### Game-server diagnostics

- [`dst_snapshot.ts`](../../../skills/dst-dedicated-server/scripts/dst_snapshot.ts): Bun owns local options, metadata-only filesystem reads, bounded result handling, partial-failure warnings and Markdown report composition. It omits log/configuration contents rather than relying on redaction after collection.
- [`dst_mods_from_modoverrides.ts`](../../../skills/dst-dedicated-server/scripts/dst_mods_from_modoverrides.ts) and [`mod_parser.ts`](../../../skills/dst-dedicated-server/scripts/mod_parser.ts): Bun interprets local or safely collected shard files and produces enabled/disabled/unknown summaries and comparisons. The parser never executes configuration; [the helper contract](../../../skills/dst-dedicated-server/references/helper-contract.md) defines its supported Lua table subset and fail-closed behavior.
- [`dst_common.ts`](../../../skills/dst-dedicated-server/scripts/dst_common.ts): Bun owns option validation, bounded local reads, non-interactive SSH, concurrent stdout/stderr draining, output caps, timeout termination and transport diagnostics. [`dst_collect_remote.sh`](../../../skills/dst-dedicated-server/scripts/dst_collect_remote.sh) retains native metadata observation and bounded shard-file collection through POSIX `sh`; parsing, comparison and report policy stay local. Remote prerequisites are Shell/native utilities and existing trusted SSH access, not Bun or a Lua runtime.

### Media and firmware helpers

- [`buzzer_preview.ts`](../../../skills/buzzer-audio-preview/scripts/buzzer_preview.ts): Bun validates scores, schedules events and encodes MIDI/WAV. [The media contract](../../../skills/buzzer-audio-preview/references/media-contract.md) defines numeric limits, timing/rounding, waveform behavior and diagnostics; independent MIDI/WAV decoding tests cover the local byte-processing boundary, not physical buzzer acoustics.
- [`fb_to_png.ts`](../../../skills/firmware-display-preview/scripts/fb_to_png.ts): Bun decodes all five supported framebuffer formats and emits PNG chunks/compression. [The framebuffer contract](../../../skills/firmware-display-preview/references/framebuffer-contract.md) defines stride, bit order, endianness, inversion, orientation and dimension limits. The C [harness](../../../skills/firmware-display-preview/assets/host_c/preview_main.c) and [scene](../../../skills/firmware-display-preview/assets/host_c/scene.c) retain native rendering; a C compiler and the project's firmware implementation/assets are prerequisites for an actual render. The shipped stub fails closed until its framebuffer accessor is supplied.

### Python-specific integrations

- [`image_gen.py`](../../../skills/cvm-imagegen/scripts/image_gen.py), its test, and fallback fixture remain Python for the existing module-integration contract. The exception is the Python callable/module interface, not the OpenAI SDK or HTTP endpoint. A standalone TS image API client would be a different product contract requiring its own decision; adding TS in front of the current Python wrapper is not recommended.
- [`freecad_step_to_stl.py`](../../../skills/step-stl-print-repair/scripts/freecad_step_to_stl.py) stays Python for FreeCAD geometry and tessellation APIs.
- [`gmsh_step_to_stl.py`](../../../skills/step-stl-print-repair/scripts/gmsh_step_to_stl.py) stays Python for the official Gmsh API. Other native APIs exist; writing a TS native binding is not justified by this meshing/reporting task.
- [`blender_stl_to_binary.py`](../../../skills/step-stl-print-repair/scripts/blender_stl_to_binary.py), [`blender_stl_check_batch.py`](../../../skills/step-stl-print-repair/scripts/blender_stl_check_batch.py), and [`blender_stl_preview.py`](../../../skills/step-stl-print-repair/scripts/blender_stl_preview.py) stay Python for Blender import/export, validation extension, and scene/render APIs. Keep direct application execution instead of adding a TS launcher layer.

### Repository checks and tests

Retained index, public-boundary/coupling, source-target inventory, and contract checks use TS/Bun with their behavioral tests. Remove unrelated private workflow remnants by public scope rather than converting them. The [detached Git alignment test](../../../skills/git-sync/tests/detached_alignment_contract.test.ts) uses Bun to exercise the documented commands against temporary repositories and a filesystem bare remote, checking refs, HEAD, reflog recoverability and configuration invariance; it is test-only. The [helper source smoke](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts) exercises consumer directory links, entrypoints, retired implementation absence and retained native/application source boundaries. VM/XP tests follow their allocated execution interfaces; Python integration tests stay Python where they verify Python module/application contracts.

Every conversion must update its entrypoints, tests, prerequisite declarations, and contract evidence together. [The project foundation contract](SPEC.md) distinguishes source implementation, required behavior evidence, and later operational rollout. Verified coverage belongs in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Sources and evidence limits

This inventory comes from the public Skill tree and script imports, entrypoints, embedded actions, and existing contracts/tests. Language fit is an accepted design decision. Helper execution evidence distinguishes independently decoded media fixtures, fake SSH, isolated native Shell/C/Git, and source-only CAD binding inspection; [implementation coverage](IMPLEMENTATION.md#helper-behavior-evidence) records their limits. It does not establish a real server deployment, physical display/buzzer behavior, or application-level CAD execution. Deferred VM/XP allocations likewise do not claim Bun equivalence or operational rollout.

- [TypeScript discriminated unions and exhaustive handling](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Python type hints and static checking boundary](https://docs.python.org/3/library/typing.html)
- [Bun native-library interface](https://bun.com/docs/runtime/ffi)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Gmsh official API interfaces](https://gmsh.info/doc/texinfo/#Gmsh-API)
