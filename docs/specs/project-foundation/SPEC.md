# Independent project foundation and public documentation

## Context and Scope

Agent Toolkit provides reusable Skills for multiple agent consumers. This contract owns the public source boundary, independent maintenance, language allocation, discoverability, and documentation presentation. The existing Agent VM lifecycle and CLI contracts remain authoritative for their business behavior.

The public source owns shared instructions and executable resources. Operators own actual inventory, credentials, deployment configuration, and consumer-specific integrations. A website renders public source as static presentation; it does not install, adapt, or duplicate consumer Skill files. Production deployment, external publication, third-party Skill ownership, and a new standalone image API client are outside this contract.

## Terms and Interfaces

- Domain terms are defined in [GLOSSARY.md](../../../GLOSSARY.md).
- Public membership is declared by PUBLIC_SKILLS.txt and Skill metadata; consumer discovery uses a direct checkout or source links.
- [The script language matrix](SCRIPT-LANGUAGE-MATRIX.md) allocates the executable responsibilities of all 16 public Skills.
- General tools use installed Bun with explicit type checking; application-host Python, native C rendering, and bounded remote Shell retain their concrete interface roles.
- The documentation presentation uses Bun/Rspress and the /agent-toolkit/ repository subpath. A successful build does not establish external publication.

## Requirements

### REQ-FOUNDATION-GOV-01

The project MUST add a public, consumer-neutral `AGENTS.md` describing repository responsibilities, paths, commands, tests, and operational boundaries. Exclude personal identity, private machines, mandated models, and proprietary task APIs.

### REQ-FOUNDATION-GOV-02

The project MUST assign every retained repository tool a current public purpose. Remove private workflow remnants from the public tree after an exact dependency audit; keep private originals in their existing private source.

### REQ-FOUNDATION-GOV-03

The project MUST extend executable coupling/dependency checks beyond `skills/` to public tools. Permit truthful consumer examples and documented Python/domain interfaces without allowing runtime dependence on a particular agent home.

### REQ-FOUNDATION-GOV-04

The project MUST document the public source, consumer installation, private deployment configuration, client/control boundary, contract ownership, and contribution responsibilities.

### REQ-FOUNDATION-GOV-05

The project MUST review private legacy design documents for transferable requirements. Rewrite public contracts against current code/tests, and restore traceable requirements and verification for Agent VM, imagegen integration, and XP policy/audit.

### REQ-FOUNDATION-LANG-01

The project MUST record a responsibility-based Python/TS/Node/Bun comparison and a runtime ADR without relying on historical language or rewrite cost.

### REQ-FOUNDATION-LANG-02

The project MUST standardize repository checks on TS/Bun, permit useful Bun-native APIs, and keep type checking explicit. Convert the checks, their behavioral tests, and invocation sites together.

### REQ-FOUNDATION-LANG-03

The project MUST specify prerequisites per Skill and split developer/test dependencies from domain/application/runtime dependencies. Audit indirect fallback dependencies before removing packages.

### REQ-FOUNDATION-LANG-04

The project MUST use system-installed Bun locally and latest stable Bun in CI, record observed versions, and test portable checks on Linux/macOS. Do not enforce an exact runtime version or Node LTS selection. Declare actual API/platform/application prerequisites and lock package dependencies independently.

### REQ-FOUNDATION-LANG-05

The project MUST compare Bun, Node.js, and Python against actual responsibilities under the owner's runtime policy. Classify generic CLIs under the Bun default and justify Python exceptions by concrete interfaces. State what has not been measured.

### REQ-FOUNDATION-LANG-06

The project MUST record a target language for every public Skill's owned scripts, tests, native resources, and embedded guest/remote actions. Evaluate state/protocol/policy complexity rather than line count, and declare changed execution prerequisites at each boundary.

### REQ-FOUNDATION-MIG-01

The project MUST convert buzzer and framebuffer helpers, DST local tooling, and the owned Git contract test to TS/Bun. Retain native C rendering and remote Shell collection.

### REQ-FOUNDATION-MIG-02

The project MUST convert XP local policy, orchestration, interpretation, and audit decisions to TS/Bun. Retain remote native collection and identity revalidation in POSIX Shell.

### REQ-FOUNDATION-MIG-03

The project MUST convert the one-shot VM controller and guest disk growth to Bun with equivalent native locking, process handling, durable state, and lifecycle contracts. Wire systemd/image prerequisites and the then-current client's control invocation.

### REQ-FOUNDATION-MIG-04

The project MUST convert the VM client, local sync, and guest source transaction to Bun. Complete the cross-component prerequisite and invocation update.

### REQ-FOUNDATION-MIG-05

The project MUST preserve the accepted Python module/CAD, C rendering, remote Shell, small Tavily helper, and text-only exceptions. Retire only replaced implementations and align affected tests/docs/CI.

### REQ-FOUNDATION-DOC-01

The project MUST put project purpose, five capability groups, 16 clickable Skill entries, prerequisites, outputs, and representative scenarios within easy reach of the root README.

### REQ-FOUNDATION-DOC-02

The project MUST document universal HTTPS checkout/direct source linking and optional skills-switch management, including enable/disable, update, upstream deletion reconciliation, uninstall, and collision handling.

### REQ-FOUNDATION-DOC-03

The project MUST for every Skill, explain when to use it, prerequisites/platforms, required configuration, the smallest useful example, outputs, and read/write boundaries.

### REQ-FOUNDATION-DOC-04

The project MUST explain protected configuration for XP, Agent VM, imagegen, and other operational Skills using neutral examples. Move one-off migration instructions out of the newcomer path.

### REQ-FOUNDATION-SITE-01

The project MUST use Rspress with Bun to build a static introduction/documentation site from the same public Markdown and catalog sources. Include overview, catalog, installation/update, configuration, and architecture/contracts.

### REQ-FOUNDATION-SITE-02

The project MUST provide responsive navigation, built-in local search, readable code examples, edit/source links, and stable Skill routes. Keep canonical Skill files in plain Markdown; site-specific React/MDX components belong only to the presentation surface. Verify existing frontmatter, code blocks, and literal command placeholders render correctly.

### REQ-FOUNDATION-SITE-03

The project MUST enforce an explicit public-content allowlist, link/build checks, and a Bun-executed build with locked package dependencies and the observed runtime recorded. Verify the framework and child commands actually run under Bun. Build static artifacts only; private operator config and local artifacts are excluded.

### REQ-FOUNDATION-SITE-04

The project MUST prepare GitHub Pages publication with the repository base path and default-branch publication conditions. PR validation builds the site without a production publish step.

### REQ-FOUNDATION-COMMON-01

The project MUST maintain one public Skill source and the same 16 public Skills unless a separate membership change is approved. Consumers use direct source links. No adapter, runtime wrapper, copied consumer Skill tree, synchronization service, or second source repository is introduced.

### REQ-FOUNDATION-COMMON-02

The project MUST use installed Bun locally and latest stable Bun in CI; record the observed version. Lock package dependencies independently. Text-only Skills need no programming runtime; Python, C, and Shell exceptions match the accepted matrix.

### REQ-FOUNDATION-COMMON-03

The project MUST keep real inventory, credentials, deployment addresses, personal paths, and private task/runtime integrations outside public source and site artifacts. Synthetic test fixtures and neutral examples carry no real deployment information.

### REQ-FOUNDATION-COMMON-04

The project MUST preserve the defined CLI, outputs, error behavior, authorization boundaries, configuration semantics, protocol, and durable-state behavior. Intentional contract changes require an explicit decision before implementation.

For the migrated helper CLIs, successful Buzzer and framebuffer runs MUST print each generated output path as `[OK] Wrote: <path>`; diagnostic failures MUST retain the underlying error message after the `error:` prefix; DST snapshot runs MUST print the actual report path after a successful atomic publish, while publish-failure paths remain represented as `<configured-output>` and their diagnostic detail remains redacted. Snapshot file contents remain subject to the public redaction boundary.

Helper artifacts MUST use the accepted atomic publication contract in [ADR 0029](../../adr/0029-helper-output-publication.md): publish through owner-private temporary files, use mode `0600` for newly published files, replace existing regular outputs atomically, and replace a pre-existing output symlink without following or modifying its target.

### REQ-FOUNDATION-COMMON-05

The project MUST change implementation, tests, invocation sites, links, CI discovery, and prerequisite documentation together. Retire replaced production implementations rather than maintaining both as active code. Keep unrelated user/private-source content intact.

### REQ-FOUNDATION-COMMON-06

The project MUST pass affected type/structure/safety checks and meaningful behavior tests at the candidate head. Required scenarios cannot be silently skipped or weakened. Public governance docs name the maintained validation commands; remote required-check enforcement is not assumed merely because a workflow exists.

### REQ-FOUNDATION-COMMON-07

The project MUST distinguish mocked behavior, real operating-system behavior in isolation, and actual deployment observations. Evidence records environment and runtime without containing secrets. Source inspection or a green unit suite cannot stand in for required native behavior evidence.

## Verification

Verification requirements describe evidence that must be produced, rather than claiming that it already exists. Validation status and commands belong in [IMPLEMENTATION.md](IMPLEMENTATION.md).

### VER-FOUNDATION-REQUIREMENT-GOV-01

- covers: `REQ-FOUNDATION-GOV-01`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: A new maintainer can locate and run the documented local checks from a standalone checkout.

### VER-FOUNDATION-REQUIREMENT-GOV-02

- covers: `REQ-FOUNDATION-GOV-02`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Retained entrypoints have no missing repository modules or required private Skill files.

### VER-FOUNDATION-REQUIREMENT-GOV-03

- covers: `REQ-FOUNDATION-GOV-03`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Regression cases reject actual runtime coupling and broken file references without rejecting ordinary consumer documentation.

### VER-FOUNDATION-REQUIREMENT-GOV-04

- covers: `REQ-FOUNDATION-GOV-04`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Architecture and contributing guides agree with public code and current boundary policy.

### VER-FOUNDATION-REQUIREMENT-GOV-05

- covers: `REQ-FOUNDATION-GOV-05`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Every published guarantee has a current contract and validation reference; private deployment observations are not inherited as public guarantees.

### VER-FOUNDATION-REQUIREMENT-LANG-01

- covers: `REQ-FOUNDATION-LANG-01`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: The ADR names selection criteria, trade-offs, concrete exceptions, and the supported runtime.

### VER-FOUNDATION-REQUIREMENT-LANG-02

- covers: `REQ-FOUNDATION-LANG-02`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Index, safety, coupling, and migration-inventory behavior remain covered; there is one active implementation per check and no required Node execution path.

### VER-FOUNDATION-REQUIREMENT-LANG-03

- covers: `REQ-FOUNDATION-LANG-03`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Text-only Skills need no programming runtime; selected scripted Skills document only their actual dependencies.

### VER-FOUNDATION-REQUIREMENT-LANG-04

- covers: `REQ-FOUNDATION-LANG-04`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Local commands do not replace or select a pinned runtime; CI reports its actual runtime; meaningful missing-capability errors and domain-test separation are documented.

### VER-FOUNDATION-REQUIREMENT-LANG-05

- covers: `REQ-FOUNDATION-LANG-05`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: The ADR cites primary documentation; SQLite/subprocess use or Linux deployment alone cannot justify a Python exception; runtime speed is not asserted without project measurements.

### VER-FOUNDATION-REQUIREMENT-LANG-06

- covers: `REQ-FOUNDATION-LANG-06`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: All 16 Skills appear exactly once in the matrix; text-only Skills acquire no runtime requirement; VM Bun prerequisites and Python/Shell/C exceptions have concrete reasons; targets are distinguished from completed changes.

### VER-FOUNDATION-REQUIREMENT-MIG-01

- covers: `REQ-FOUNDATION-MIG-01`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: PR 3's format, parsing, report, transport, Git recoverability, and consumer-source scenarios pass.

### VER-FOUNDATION-REQUIREMENT-MIG-02

- covers: `REQ-FOUNDATION-MIG-02`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: PR 4's strict-input, policy, identity, network/output-boundary, and read-only scenarios pass without local Ruby.

### VER-FOUNDATION-REQUIREMENT-MIG-03

- covers: `REQ-FOUNDATION-MIG-03`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: PR 5's protocol/digest, prior-state, native multi-process, precision, recovery, and current-client interoperability scenarios pass.

### VER-FOUNDATION-REQUIREMENT-MIG-04

- covers: `REQ-FOUNDATION-MIG-04`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: PR 6's session precedence, transport/state, byte-path/ownership, atomicity, concurrency, and lost-ack scenarios pass.

### VER-FOUNDATION-REQUIREMENT-MIG-05

- covers: `REQ-FOUNDATION-MIG-05`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Integrated source/runtime inventory matches the accepted matrix and has no duplicate active implementation or unassigned executable.

### VER-FOUNDATION-REQUIREMENT-DOC-01

- covers: `REQ-FOUNDATION-DOC-01`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Every public Skill appears exactly once in the canonical catalog; all public links resolve.

### VER-FOUNDATION-REQUIREMENT-DOC-02

- covers: `REQ-FOUNDATION-DOC-02`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: A temporary consumer root can discover the selected sources without copied Skill files or overwritten third-party/private entries.

### VER-FOUNDATION-REQUIREMENT-DOC-03

- covers: `REQ-FOUNDATION-DOC-03`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Examples either run in an isolated/offline fixture or identify the real external prerequisite and authorization.

### VER-FOUNDATION-REQUIREMENT-DOC-04

- covers: `REQ-FOUNDATION-DOC-04`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: No actual inventory, credentials, personal paths, or production observations appear in public examples.

### VER-FOUNDATION-REQUIREMENT-SITE-01

- covers: `REQ-FOUNDATION-SITE-01`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: The website adds a rendering view; raw `SKILL.md` remains directly usable and no second behavior specification is maintained.

### VER-FOUNDATION-REQUIREMENT-SITE-02

- covers: `REQ-FOUNDATION-SITE-02`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: All 16 Skill routes and public contract links work; keyboard and mobile navigation are usable; consumers need no Rspress/React syntax to read a Skill.

### VER-FOUNDATION-REQUIREMENT-SITE-03

- covers: `REQ-FOUNDATION-SITE-03`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Removing a Skill removes its site entry on the next build; excluded files cannot silently become pages; the validated build path does not require Node installation or a pinned Bun version.

### VER-FOUNDATION-REQUIREMENT-SITE-04

- covers: `REQ-FOUNDATION-SITE-04`
- Method: inspect the maintained implementation and exercise its applicable consumer or test scenario.
- Pass condition: Base paths and deep links are tested; an authorized production publication is verified independently of a passing build.

### VER-FOUNDATION-COMMON-01

- covers: `REQ-FOUNDATION-COMMON-01`
- Method and required evidence: Public inventory, link/entrypoint inspection, and affected consumer-source scenarios.
- Pass condition: Maintain one public Skill source and the same 16 public Skills unless a separate membership change is approved. Consumers use direct source links. No adapter, runtime wrapper, copied consumer Skill tree, synchronization service, or second source repository is introduced.

### VER-FOUNDATION-COMMON-02

- covers: `REQ-FOUNDATION-COMMON-02`
- Method and required evidence: Clean-environment commands and dependency/entrypoint inspection; no exact runtime pin or mandatory Node installation.
- Pass condition: Use installed Bun locally and latest stable Bun in CI; record the observed version. Lock package dependencies independently. Text-only Skills need no programming runtime; Python, C, and Shell exceptions match the accepted matrix.

### VER-FOUNDATION-COMMON-03

- covers: `REQ-FOUNDATION-COMMON-03`
- Method and required evidence: Public safety/coupling checks and changed-source inspection; site artifacts are additionally checked in PR 8.
- Pass condition: Keep real inventory, credentials, deployment addresses, personal paths, and private task/runtime integrations outside public source and site artifacts. Synthetic test fixtures and neutral examples carry no real deployment information.

### VER-FOUNDATION-COMMON-04

- covers: `REQ-FOUNDATION-COMMON-04`
- Method and required evidence: Existing behavior scenarios carried forward, fixed input/output fixtures, affected contract references, and compatible durable-state scenarios where applicable.
- Pass condition: Preserve the defined CLI, outputs, error behavior, authorization boundaries, configuration semantics, protocol, and durable-state behavior. Intentional contract changes require an explicit decision before implementation.

### VER-FOUNDATION-COMMON-05

- covers: `REQ-FOUNDATION-COMMON-05`
- Method and required evidence: No broken owned references, no omitted affected tests, and one active implementation per executable responsibility at the PR head.
- Pass condition: Change implementation, tests, invocation sites, links, CI discovery, and prerequisite documentation together. Retire replaced production implementations rather than maintaining both as active code. Keep unrelated user/private-source content intact.

### VER-FOUNDATION-COMMON-06

- covers: `REQ-FOUNDATION-COMMON-06`
- Method and required evidence: Local results and current-head CI results during delivery, plus review of any changed checks or test selection.
- Pass condition: Pass affected type/structure/safety checks and meaningful behavior tests at the candidate head. Required scenarios cannot be silently skipped or weakened. Public governance docs name the maintained validation commands; remote required-check enforcement is not assumed merely because a workflow exists.

### VER-FOUNDATION-COMMON-07

- covers: `REQ-FOUNDATION-COMMON-07`
- Method and required evidence: A PR validation record mapping every acceptance item to its scenario and result, with unavailable required evidence treated as incomplete.
- Pass condition: Distinguish mocked behavior, real operating-system behavior in isolation, and actual deployment observations. Evidence records environment and runtime without containing secrets. Source inspection or a green unit suite cannot stand in for required native behavior evidence.

### VER-FOUNDATION-GOVERNANCE-01

- covers: `REQ-FOUNDATION-GOV-01`, `REQ-FOUNDATION-GOV-04`
- Method and required evidence: Fresh-checkout documentation/entrypoint smoke; load affected retained tools through their documented non-mutating entrypoints.
- Pass condition: A fresh standalone checkout explains its responsibilities and can run the documented current checks without dot-codex, private workflow modules, or a consumer runtime home.

### VER-FOUNDATION-GOVERNANCE-02

- covers: `REQ-FOUNDATION-GOV-02`
- Method and required evidence: Exact retained/removed inventory and call/reference audit; relevant reference gate.
- Pass condition: Every retained root executable has a public purpose and all owned imports/file references resolve; removed files have no active public callers.

### VER-FOUNDATION-GOVERNANCE-03

- covers: `REQ-FOUNDATION-GOV-03`
- Method and required evidence: Positive/negative boundary fixtures and public scan.
- Pass condition: Real runtime coupling in root tools or Skills fails the gate, while ordinary consumer examples and legitimate application/Python interfaces remain allowed.

### VER-FOUNDATION-GOVERNANCE-04

- covers: `REQ-FOUNDATION-GOV-05`
- Method and required evidence: Requirement-to-verification mapping and public-content inspection.
- Pass condition: Public guarantees for VM, CVM fallback, and XP point to current contracts/scenarios, and published design text contains no real private deployment material.

### VER-FOUNDATION-GOVERNANCE-05

- covers: `REQ-FOUNDATION-COMMON-01`, `REQ-FOUNDATION-COMMON-05`
- Method and required evidence: Public inventory comparison and exact changed-path review.
- Pass condition: All 16 public Skill directories remain intact and the private source receives no unrelated edits.

### VER-FOUNDATION-TOOLING-01

- covers: `REQ-FOUNDATION-LANG-02`
- Method and required evidence: Repository-check fixtures on Linux/macOS.
- Pass condition: Missing, duplicate, extra, and stale Skill index entries are detected; the valid 16-Skill tree passes.

### VER-FOUNDATION-TOOLING-02

- covers: `REQ-FOUNDATION-LANG-02`, `REQ-FOUNDATION-GOV-03`
- Method and required evidence: Fixed valid/invalid fixtures, synthetic Git source snapshots, and standalone-checkout smoke.
- Pass condition: Safety/coupling failures and source-target migration findings preserve their defined result/exit behavior. Routine checks work without any private source checkout.

### VER-FOUNDATION-TOOLING-03

- covers: `REQ-FOUNDATION-LANG-02`, `REQ-FOUNDATION-LANG-04`
- Method and required evidence: Isolated execution environment and invocation inspection; observed Bun logged.
- Pass condition: Repository checks execute under installed Bun with no Node process or required Python check implementation, and no forced runtime pin/download.

### VER-FOUNDATION-TOOLING-04

- covers: `REQ-FOUNDATION-LANG-02`, `REQ-FOUNDATION-LANG-03`, `REQ-FOUNDATION-LANG-04`
- Method and required evidence: CI matrix, deliberate test-selection failure fixture, and validation-command inventory.
- Pass condition: Type checking runs explicitly, frozen dependency installation succeeds, and all maintained TS/Python/Shell suites are included at the PR head.

### VER-FOUNDATION-TOOLING-05

- covers: `REQ-FOUNDATION-LANG-03`, `REQ-FOUNDATION-LANG-06`, `REQ-FOUNDATION-COMMON-05`
- Method and required evidence: Source/dependency/reference audit and documentation parity.
- Pass condition: Replaced production check files are retired; declared dependencies correspond to retained responsibilities.

### VER-FOUNDATION-HELPERS-01

- covers: `REQ-FOUNDATION-MIG-01`
- Method and required evidence: Independently decoded MIDI/WAV fixtures and invalid-score scenarios; any numeric tolerance is stated and justified.
- Pass condition: Supported score inputs produce correct MIDI events/timing and WAV format, duration, sample bounds, and tone behavior; malformed inputs fail with defined diagnostics.

### VER-FOUNDATION-HELPERS-02

- covers: `REQ-FOUNDATION-MIG-01`
- Method and required evidence: Tiny known pixel fixtures, independent PNG decode/chunk validation, and native-resource inspection.
- Pass condition: Every supported framebuffer format, stride/orientation rule, dimensions, and pixel interpretation produce valid PNG output. Native rendering remains C.

### VER-FOUNDATION-HELPERS-03

- covers: `REQ-FOUNDATION-MIG-01`
- Method and required evidence: Temporary local filesystem plus fake SSH/server-data scenarios; no real server operations.
- Pass condition: DST local/remote selection, missing resources, failed SSH, shard summaries/differences, and bounded report collection preserve their contract; secret fixtures are not emitted.

### VER-FOUNDATION-HELPERS-04

- covers: `REQ-FOUNDATION-MIG-01`
- Method and required evidence: Nested configuration and malformed/unsupported input fixtures.
- Pass condition: Mod parsing preserves enabled/disabled/unknown meaning and its supported syntax, and does not execute Lua configuration.

### VER-FOUNDATION-HELPERS-05

- covers: `REQ-FOUNDATION-MIG-01`
- Method and required evidence: Temporary Git repository scenarios that inspect actual refs, HEAD, reflog, and remote settings.
- Pass condition: Detached Git alignment preserves recoverability, branch/remote configuration, and blocked-action behavior.

### VER-FOUNDATION-HELPERS-06

- covers: `REQ-FOUNDATION-MIG-01`
- Method and required evidence: Consumer-link smoke, CI suite selection, and reference scan.
- Pass condition: All new entrypoints work from Skill source links on Linux/macOS, replaced helper/test references are gone, and C/Shell prerequisites remain accurate.

### VER-FOUNDATION-XP-01

- covers: `REQ-FOUNDATION-MIG-02`
- Method and required evidence: Neutral policy/inventory fixtures and fake-command records proving no disallowed continuation.
- Pass condition: Missing/unconfirmed/incomplete policies, unsupported schema/fields, ambiguous inventory, and invalid values block the relevant operation.

### VER-FOUNDATION-XP-02

- covers: `REQ-FOUNDATION-MIG-02`
- Method and required evidence: Explicit parser and normalization fixtures; do not rely on ordinary `JSON.parse` alone.
- Pass condition: Duplicate record/JSON members, malformed values, invalid booleans/timestamps/ports, and stale or contradictory observations are rejected. YAML parsing does not silently broaden previously prohibited constructs.

### VER-FOUNDATION-XP-03

- covers: `REQ-FOUNDATION-MIG-02`
- Method and required evidence: Fake remote runtime scenarios and retained remote-probe tests in isolated Linux.
- Pass condition: Host/container/process identity changes between observation and revalidation fail closed; direct/sudo Docker and native-service access follow the declared policy.

### VER-FOUNDATION-XP-04

- covers: `REQ-FOUNDATION-MIG-02`
- Method and required evidence: Local fixture endpoints and synthetic target/data tests with bounded outputs; no production network validation.
- Pass condition: Public probe validation preserves target/redirect/network restrictions, output limits, timeouts, and error reporting. Missing/failed evidence cannot become an audit success.

### VER-FOUNDATION-XP-05

- covers: `REQ-FOUNDATION-MIG-02`
- Method and required evidence: End-to-end fake SSH/native-command audit cases, secret canaries, and result comparisons.
- Pass condition: Reports agree with expected policy/audit outcomes and do not read or print administrator tokens. No alternate node or port is chosen automatically.

### VER-FOUNDATION-XP-06

- covers: `REQ-FOUNDATION-MIG-02`
- Method and required evidence: Fresh operator-environment smoke and remote dependency inspection.
- Pass condition: Local entrypoints need Bun and native transport tools, not Ruby or Python; remote probes remain POSIX and require no Bun installation.

### VER-FOUNDATION-VM-CONTROL-01

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Protocol/configuration fixtures and fake-native invocation records.
- Pass condition: Valid requests retain their envelope/results/error behavior; missing identity, invalid configuration/protocol/action/generation fail before disallowed native writes.

### VER-FOUNDATION-VM-CONTROL-02

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Fixtures created from the accepted baseline, current/new request scenarios, and lost-response/restart tests. Canonical digest serialization is compared explicitly.
- Pass condition: Prior database/operation fixtures are usable without changing identity or reapplying a completed operation. Same-ID retries, payload conflicts, pending outcomes, and deadline updates preserve idempotence.

### VER-FOUNDATION-VM-CONTROL-03

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Isolated Linux multi-process lock/admission/expiry scenarios, not only mocked lock objects.
- Pass condition: Two real control processes serialize conflicting operations while unrelated work proceeds as allowed. Expiration closes access despite contended work; long native waits do not hold the global admission transaction.

### VER-FOUNDATION-VM-CONTROL-04

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Boundary-number/digest/transaction fixtures and concurrent admission tests.
- Pass condition: SQLite transactions and all supported integer/ratio calculations preserve precision, rounding, reservation and capacity results. There is no silent JS-number truncation or newly restricted valid input range.

### VER-FOUNDATION-VM-CONTROL-05

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Carried-forward lifecycle, reclamation, resource-overcommit, and live-memory scenarios with injected partial failures.
- Pass condition: Release/reclaim/drain/reconcile/live-memory failures preserve protected leases, conservative accounting, bounded retries, generation fences, and the existing no-implicit-restart behavior.

### VER-FOUNDATION-VM-CONTROL-06

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Real isolated process trees, noisy pipe fixtures, and timeout/cleanup failures on Linux.
- Pass condition: Streams are drained while retained output stays bounded; timeout cleanup handles descendants and leader reaping with accurate diagnostics.

### VER-FOUNDATION-VM-CONTROL-07

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Fake guest/native filesystem scenarios and prerequisite failure records; no real production disk resizing.
- Pass condition: Guest growth preserves direct ext4/xfs constraints, ambiguous-root refusal, native-command checks, and verified size reporting. Missing guest Bun blocks before writes.

### VER-FOUNDATION-VM-CONTROL-08

- covers: `REQ-FOUNDATION-MIG-03`
- Method and required evidence: Client/control transport smoke, systemd unit validation, and exact source-reference audit.
- Pass condition: The then-current client reaches the new controller through its updated transport, all systemd/assets/config references resolve, and only one active controller remains.

### VER-FOUNDATION-VM-CLIENT-01

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Offline CLI scenarios and fake SSH invocation records; no Codex identity reads.
- Pass condition: Explicit session identity overrides the environment; missing identity fails before remote mutation; requests, journals, and state use the same generic identity.

### VER-FOUNDATION-VM-CLIENT-02

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Client/controller contract scenarios and fixed local-state/journal fixtures.
- Pass condition: Acquire/retry/status/renew/release/resize/admin behavior preserves current generation and operation identity; observation does not renew a lease. Old connection material is rejected.

### VER-FOUNDATION-VM-CLIENT-03

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Temporary transport/key/state fixtures, fake SSH/rsync, and output/permission assertions.
- Pass condition: SSH/keys/state/config permissions, argv handling, upload/download, port operations, diagnostics, and transport exit codes remain correct. Credentials are absent from ordinary logs.

### VER-FOUNDATION-VM-CLIENT-04

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Real temporary Git/filesystem scenarios, including spaces/newlines/Unicode and byte-path boundaries. Unsupported preservation is reported as a blocker rather than silent path substitution.
- Pass condition: Sync handles deletions, symlinks/modes, special byte paths, and changed manifests without damaging adjacent results or unowned paths; submodules are rejected before writes.

### VER-FOUNDATION-VM-CLIENT-05

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Isolated Linux guest-action tests with actual locks/rename/fsync behavior and injected failures.
- Pass condition: Concurrent baseline conflicts reject stale commits; atomic exchange failure preserves the old source; lost commit acknowledgement returns the defined uncertain outcome and retains recovery material.

### VER-FOUNDATION-VM-CLIENT-06

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Fresh linked-consumer smoke, prerequisite-failure scenarios, and exact runtime/source scan.
- Pass condition: Missing Bun/native atomic capability fails before unsafe writes; source linking is sufficient to discover and run the new client. No VM-specific Python runtime action remains.

### VER-FOUNDATION-VM-CLIENT-07

- covers: `REQ-FOUNDATION-MIG-04`
- Method and required evidence: Cross-component scenario and configuration/reference review.
- Pass condition: New client, controller, guest actions, systemd assets, and deployment instructions agree on prerequisites, protocol, and canonical source; no production rollout is claimed from offline evidence.

### VER-FOUNDATION-GUIDES-01

- covers: `REQ-FOUNDATION-DOC-01`, `REQ-FOUNDATION-DOC-03`
- Method and required evidence: Catalog/metadata completeness and source-link validation.
- Pass condition: All 16 Skills appear exactly once in the detailed catalog and every entry has purpose, prerequisites, configuration, a useful example, outputs, and usage boundaries.

### VER-FOUNDATION-GUIDES-02

- covers: `REQ-FOUNDATION-DOC-02`
- Method and required evidence: Consumer discovery smoke and realpath/source-identity checks using documented installation choices.
- Pass condition: A clean temporary consumer root discovers selected Skills through direct source links without copied Skill files or private repositories. Third-party/private entries and collisions are preserved.

### VER-FOUNDATION-GUIDES-03

- covers: `REQ-FOUNDATION-DOC-02`
- Method and required evidence: Disposable upstream Git/catalog scenarios using the selected tool/link workflow; do not modify the owner's live installation.
- Pass condition: Update, upstream deletion, disable, and uninstall follow the documented procedure without removing unrelated entries or the source checkout. Automatic and manual reconciliation are labeled truthfully.

### VER-FOUNDATION-GUIDES-04

- covers: `REQ-FOUNDATION-DOC-03`
- Method and required evidence: Example smoke/contract review and prerequisite table compared with scripts.
- Pass condition: Examples use actual post-conversion entrypoints. Offline/fixture examples run; external application/service examples declare their real prerequisites and required authorization.

### VER-FOUNDATION-GUIDES-05

- covers: `REQ-FOUNDATION-DOC-02`, `REQ-FOUNDATION-DOC-04`
- Method and required evidence: Standalone newcomer-path review, links, and safety/coupling checks.
- Pass condition: No newcomer step requires dot-codex, real private inventory, a Codex-specific variable, or a second source tree. All maintained validation commands match CI.

### VER-FOUNDATION-SITE-01

- covers: `REQ-FOUNDATION-SITE-01`, `REQ-FOUNDATION-SITE-03`
- Method and required evidence: Clean build/preview environment and runtime invocation evidence, including native build dependencies.
- Pass condition: Development, type/structure checks, static build, and production preview execute with installed Bun and locked dependencies, without a required Node process or fixed Bun version.

### VER-FOUNDATION-SITE-02

- covers: `REQ-FOUNDATION-SITE-02`
- Method and required evidence: Catalog-to-route/search assertions and representative browser rendering observations.
- Pass condition: All 16 Skill pages and public guide/contract routes are navigable/searchable; frontmatter, code blocks, literal command placeholders, headings, and links preserve their intended content.

### VER-FOUNDATION-SITE-03

- covers: `REQ-FOUNDATION-SITE-02`, `REQ-FOUNDATION-SITE-04`
- Method and required evidence: Browser checks against the built production output under `/agent-toolkit/`, with controlled visual evidence for the changed site.
- Pass condition: Desktop/mobile navigation, keyboard interaction, search results, source links, subpath assets, deep links, and refreshed pages work.

### VER-FOUNDATION-SITE-04

- covers: `REQ-FOUNDATION-SITE-03`
- Method and required evidence: Disposable build fixtures and output artifact inspection, including synthetic excluded-content markers.
- Pass condition: Removing a Skill from an isolated source fixture removes its route/catalog/search entry on rebuild. Files outside the allowlist never become pages or search content.

### VER-FOUNDATION-SITE-05

- covers: `REQ-FOUNDATION-SITE-04`
- Method and required evidence: Workflow trigger/permission inspection and PR build evidence.
- Pass condition: PR CI validates/builds without publishing or requiring deployment credentials. Only the declared default-branch publication path, including a manual run against that branch, has Pages deployment permissions and conditions.

### VER-FOUNDATION-SITE-06

- covers: `REQ-FOUNDATION-SITE-04`
- Method and required evidence: Build artifact/guide comparison and deployment workflow review.
- Pass condition: Publication is reproducible from the documented checkout/commands, and deployment instructions include base path, artifact directory, and the verification procedure.

## Related ADRs

- [Language and runtime policy](../../adr/0028-language-and-runtime-policy.md)

## References

- [Agent VM lifecycle](../agent-vm/SPEC.md)
- [Agent VM CLI contract](../agent-vm/contracts/cli.md)
- [Implementation coverage](IMPLEMENTATION.md)
- [Topic history](HISTORY.md)
