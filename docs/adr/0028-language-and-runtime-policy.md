---
status: accepted
---

# Language and runtime policy by responsibility

Agent Toolkit needs an explicit language policy for portable helpers, Linux system integration, application-hosted automation, repository tooling, and documentation. The comparison evaluates those responsibilities as a new design; existing implementation language, migration effort, and language percentages are not selection criteria. The owner has accepted the per-Skill allocation and specified that execution should use the system-installed Bun without a fixed project runtime version or Node.js LTS requirement. This is an accepted target policy, not evidence that the implementations have already been converted.

## Criteria

- Fit to the actual API and operating-system requirements.
- Consumer installation and dependency requirements for the selected Skill.
- Cross-platform support and actual API availability under the system-installed runtime.
- Maintainability, type checking, structured contracts, and testing.
- Domain complexity: state/request combinations, protocol changes, policy branches, and recovery relationships matter more than file length.
- Direct execution without a wrapper, resident service, or duplicated implementation.
- Measured end-to-end behavior where performance matters; runtime marketing benchmarks are not evidence for this project.

## Options

| Responsibility | Python | TypeScript with Node.js | TypeScript with Bun |
| --- | --- | --- | --- |
| Portable filesystem, JSON, and process-oriented CLI | Strong standard library; type checking can be added independently | Native execution of erasable TS, strong standard library, and typed CLI/schema tooling | Direct TS execution, native subprocess APIs, Shell, SQLite, YAML, package management, and tests reduce separate tooling requirements |
| Linux one-shot control process | Standard-library Unix locking, SQLite, subprocess, and native-library access fit the requirements directly | Feasible; native lock/filesystem calls, SQLite availability, and platform behavior need explicit verification | Built-in SQLite transactions, subprocess control, and FFI make it a credible direct implementation; Unix locking and atomic native calls still need explicit bindings |
| FreeCAD and Blender in-process automation | Direct fit to the applications' Python interfaces | An external process cannot replace an in-process Python interface | An external process cannot replace an in-process Python interface |
| HTTP/API command-line integration | Suitable; Python SDKs and packaging are available | Suitable; async HTTP and typed request/response tooling fit well | Suitable; direct TS execution and integrated tooling are useful |
| Repository checks and documentation tooling | Can implement the checks; a JS documentation framework adds another development toolchain | Same language ecosystem can own checks, catalog validation, and website build | Same language ecosystem plus integrated package/test tooling; chosen site dependencies must execute with Bun |

TypeScript does not replace runtime input validation. Python also supports static type checking. Choosing a language does not itself prove performance, reliable subprocess handling, or safe concurrent mutation.

## Decision

Use TypeScript with Bun as the default for general-purpose CLI work, repository checks, HTTP/configuration integrations, portable binary-media helpers, and documentation tooling. Permit Bun-native APIs when they simplify the implementation. Execute the code directly with Bun, and make type checking an explicit validation command; successful TS execution alone does not establish type correctness. Node.js compatibility is not a required second execution target.

Use TypeScript/Bun for the Agent VM client, one-shot control program, and guest transaction/growth actions. Their main complexity is protocol identity, lease/generation state, idempotence, admission, and recovery. Focused native lock/filesystem/process mechanisms do not outweigh those responsibilities or justify a Python-only control plane. Bun becomes an explicit prerequisite on the control host and managed guest image as well as the client machine; deployment changes require their own authorization and validation.

Use Python for application-hosted Python APIs such as FreeCAD/Blender, the official Gmsh domain binding, and integrations whose explicit contract is a Python module interface. Python's direct Unix APIs are an advantage for native mechanisms, but a small native mechanism is not an automatic exception for an entire stateful program. Python also supports checked type annotations; the recommendation does not assert that complex Python software is inherently unsuitable.

Keep Shell for direct native-command sequences and bounded remote observation on systems that should not require another runtime. XP and DST policy/interpretation/reporting move to local TS/Bun while remote native collection remains Shell. The short Tavily infrastructure helper stays Shell. A helper tied to an explicitly configured Python fallback belongs to the Python integration category; changing it into an independent HTTP implementation is a separate product contract decision. A format-only PNG/MIDI/WAV helper has no application-host Python requirement and falls under the Bun default.

This is a responsibility boundary, not a Python percentage target. Both implementations must execute directly in their own environment. A TypeScript wrapper around Python would add a process boundary without changing the underlying dependency and is not the recommended design.

The [project foundation contract](../specs/project-foundation/SPEC.md) requires governance, repository checks, portable helpers, XP local logic, VM control/client/guest logic, usage documentation, and the site to follow this policy. Implementation, tests, entrypoints, and prerequisites must change together. A control-plane rewrite must independently demonstrate lock exclusion, transaction/numeric behavior, atomic updates, process-tree termination, recovery, and existing lifecycle contracts before replacing its implementation. Documenting the policy does not establish a completed conversion or authorize production deployment.

The accepted [per-Skill script matrix](../specs/project-foundation/SCRIPT-LANGUAGE-MATRIX.md) records all 13 public Skills, exact script responsibilities, concrete Python/Shell/C exceptions, and deployment implications. It distinguishes target language decisions from completed migrations.

## Complexity and type contracts

Stateful tools should model request/action variants and lifecycle states explicitly, with required fields attached to the applicable variant and exhaustive handling where useful. This is more informative than loose optional fields, unvalidated dictionaries, or broad `any` types. TypeScript's discriminated unions and narrowing suit these contracts; Python can express many of the same constraints with checked type annotations. Under the selected Bun toolchain, TS is the recommended default for this structured application logic.

Static types do not prove that an incoming JSON payload is valid or that concurrent control processes are serialized. Runtime parsing, numeric semantics, cross-process locks, SQLite transactions, native atomicity, and failure/recovery tests remain separate requirements. Complexity strengthens the TS recommendation only where structured logic dominates; it does not replace application-host API or remote-runtime requirements.

## Why Bun rather than Node.js or Python for the default

Node.js natively executes TypeScript containing erasable syntax through stable built-in type stripping. It does not perform type checking, read tsconfig.json, or natively execute TSX and syntax requiring JavaScript generation. Direct TS execution is therefore not unique to Bun. Node.js also provides built-in SQLite and test facilities; the comparison does not attribute every integrated capability exclusively to Bun.

Node.js remains a capable runtime with broad ecosystem compatibility, but its LTS policy does not decide this project's selection. Bun's combined Shell, YAML, SQLite, subprocess APIs, TypeScript execution, package management, and test tooling are relevant to the actual CLI/configuration/documentation responsibilities. A Bun-native implementation need not restrict itself to Node APIs. Node compatibility differences matter when evaluating an actual dependency, not as a blanket argument against Bun.

Python already provides strong standard-library process, filesystem, SQLite, and testing facilities. Bun's advantage over Python is therefore not that Python cannot perform those tasks. For this project, Bun combines the typed CLI/configuration code and the JS documentation ecosystem with integrated tooling; its built-in YAML/Shell APIs also avoid separate parsers or shell utilities for applicable tasks. Python remains more direct for application-host Python APIs and some Unix native interfaces. These are interface and toolchain advantages, not unmeasured claims about startup time, memory, or end-to-end speed.

## Runtime and dependency policy

Local commands use the Bun installed on the host. Do not add a fixed Bun/Node version file, a mandatory Node LTS selector, an exact runtime version gate, or automatic runtime installation/upgrades as a prerequisite for running the toolkit. Document required APIs/platforms and report a clear capability error when an actual prerequisite is absent; do not silently switch runtimes or wrap one runtime in another.

CI uses the latest stable Bun and records `bun --version` with validation results. An observed version is diagnostic evidence, not a project runtime pin or a promise to support every historical Bun release. Optional native/application dependencies retain their own truthful prerequisite declarations.

Commit `bun.lock` for the package dependency graph and use frozen dependency installation in CI. Locking dependencies does not lock the Bun executable. The build is repeatable under the recorded environment; a floating runtime does not imply bit-for-bit identical artifacts across future Bun releases.

Documentation commands must actually execute the framework CLI with Bun, including Node shebang entrypoints where applicable, rather than merely using Bun to install dependencies. Validate the selected framework and its child commands on that execution path before claiming Bun-only build support.

Use Rspress for the documentation site with TypeScript configuration. Its documented Bun runtime support, default documentation theme, Markdown/MDX, static HTML, and built-in search fit the public catalog and guides. Keep canonical Skill files as plain Markdown and site-specific React/MDX in the presentation surface. The website builds from the public source and creates static presentation artifacts; it does not add a runtime layer to Skill consumption. The site PR verifies the actual Bun build and existing Skill rendering.

## Sources

- [Node.js release policy](https://nodejs.org/en/about/previous-releases)
- [Node.js native TypeScript execution](https://nodejs.org/api/typescript.html)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [TypeScript narrowing and exhaustive handling](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Python type hints](https://docs.python.org/3/library/typing.html)
- [Bun TypeScript execution](https://bun.com/docs/runtime/typescript)
- [Bun Shell](https://bun.com/docs/runtime/shell)
- [Bun subprocess APIs](https://bun.com/docs/runtime/child-process)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Bun YAML](https://bun.com/docs/runtime/yaml)
- [Bun FFI](https://bun.com/docs/runtime/ffi)
- [Bun Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun runtime selection for package scripts](https://bun.com/docs/runtime)
- [Bun dependency lockfile](https://bun.com/docs/pm/lockfile)
- [Bun GitHub Actions setup](https://bun.com/guides/runtime/cicd)
- [Rspress supported runtimes and setup](https://rspress.rs/guide/start/getting-started)
- [Rspress features](https://rspress.rs/guide/start/introduction)
- [Rspress deployment](https://rspress.rs/guide/basic/deploy)
- [Python Unix file locking](https://docs.python.org/3/library/fcntl.html)
- [Python SQLite](https://docs.python.org/3/library/sqlite3.html)
- [Python native library interface](https://docs.python.org/3/library/ctypes.html)
