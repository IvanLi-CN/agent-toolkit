# Project foundation implementation coverage

## Current Status

Public membership: 13 Skills, defined by [PUBLIC_SKILLS.txt](../../../PUBLIC_SKILLS.txt). The root governance guide and maintained repository checks use the standalone public source with directly executed TypeScript under installed Bun. Buzzer/framebuffer conversion, DST local tooling and the owned Git alignment test use Bun with the helper behavior evidence below; remote Shell, native C rendering, Python CAD/application bindings and text-only production workflows retain their declared boundaries. The language matrix records allocation separately from this implementation coverage. Usage-guide coverage is described under DOC-01..04 below; SITE-01..04 records the Bun/Rspress site implementation and its remaining visual, Linux and publication limits.

## Skill Migration Coverage

The statuses below describe language migration coverage, not deployment status. `deferred` means the allocated conversion has not been delivered; `migrated` means the owned conversion, entrypoints, prerequisites and tests are present with linked behavior evidence; `retained` means the concrete application/module/remote exception remains; `no-runtime` means the production Skill is text-only, even if maintainers use a programming runtime for repository smoke tests. Source links identify the current contract. A root consistency pass alone cannot establish behavioral equivalence, application execution or rollout.

| Skill | Migration status | Evidence |
| --- | --- | --- |
| `agent-vm` | migrated | [Bun client and source transaction](../../../skills/agent-vm/SKILL.md); [Behavior evidence](../../../skills/agent-vm/tests/client.test.ts), [transport](../../../skills/agent-vm/tests/transport.test.ts), [source transaction](../../../skills/agent-vm/tests/source.test.ts) and [controller contract](../../../skills/agent-vm/tests/controller.test.ts). Complete-package release/recovery evidence and Linux/image validation limits are detailed below. |
| `agent-vm-ops` | migrated | [Bun controller and guest growth](../../../skills/agent-vm-ops/SKILL.md); [Behavior evidence](../../../skills/agent-vm-ops/tests/control-process.test.ts): Bun controller lifecycle, structured errors, release fences and guest Bun prerequisites. The client transport regression uses the Bun client and canonical controller. |
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
- Skill implementations: [SCRIPT-LANGUAGE-MATRIX.md](SCRIPT-LANGUAGE-MATRIX.md) distinguishes source implementations from accepted targets. Agent VM client/source transaction, Agent VM ops, buzzer/framebuffer helpers, DST local entrypoints and the owned Git test have one active Bun implementation per replaced responsibility; their replaced Python/local Shell entrypoints are removed. Agent VM complete-package release integration has isolated contract evidence; Linux/image deployment verification remains incomplete. The C firmware harness, remote Shell collector, five Python CAD/application scripts and text production workflows retain their concrete interfaces. Other deferred domains keep their existing implementation/tests until replacement behavior is covered.
- Public design material: Agent VM lifecycle, CLI, retention/reclamation designs and ADRs are already present. This slice anchors the CVM Python module-integration and XP policy/audit guarantees to their current Skill contracts and tests; DOC-01..04 usage-guide and SITE-01..04 presentation evidence are described below.
- Verification coverage: SPEC.md retains seven cross-cutting evidence requirements and 48 detailed domain scenarios, in addition to the project requirement assertions. No result is inferred from their presence in the document.

### DOC-01..04 guide coverage

公共文档以 [README](../../../README.md)、`CONTRIBUTING.md` 和[指南索引](../../guides/README.md)为入口，沿用 13 个 public Skills 的 canonical source。指南不是第二份行为规范；详细 CLI、lifecycle、policy 与 application 行为继续链接所属 Skill/contracts。

| Requirement | 文档入口与实现 | 证据边界 |
| --- | --- | --- |
| DOC-01 | README 首屏的五个能力组、全部 13 个可点击 Skill、用途/场景、前置条件和输出；指南索引提供逐 Skill 的唯一目标。 | 对 allowlist、README、guide headings 和 canonical source 做 completeness 与本地路径/锚点静态核对，不推断站点路由。 |
| DOC-02 | [安装与更新](../../guides/installation.md)：HTTPS checkout、直接 source links、每个 link 的隐藏 ownership record、带唯一 owner token 的 consumer-root lock、collision、enable/disable、update、上游删除 reconciliation、uninstall；skills-switch 明确为可选外部工具。 | Disposable upstream/consumer 验证直接链接流程；record 同时保存 canonical source path、source 与 link 的设备号/inode。可执行 smoke 对 enable/disable 分别注入已有 lock、运行中 lock 目录替换、未知内容和 token 丢失，断言具体诊断及 lock 身份/内容保留；释放阶段失败不回滚已完成的 link/record 操作。Disable 先将 record 移入 ledger 私有 pending directory，再捕获并核对 link，最终只在已进入的私有目录内 unlink；中断和删除失败可重跑恢复，不留下陈旧 active record。异常被捕获对象保留供人工核对；不保证抵御同身份/高权限外部写入、inode 复用或断电持久性。外部管理器命令只核对帮助，不宣称真实用户 catalog 生命周期已运行。 |
| DOC-03 | [隔离执行](../../guides/isolated-execution.md)、[服务运维](../../guides/service-operations.md)、[Git 与文档](../../guides/git-and-docs.md)、[媒体预览](../../guides/media-previews.md)、[CAD](../../guides/cad-repair.md)：逐 Skill 列出何时使用、平台/前提、配置、最小例子、输出与读写边界。 | 离线例子使用 temporary fixtures；remote/service、可信 imagegen 模块和 CAD/native 应用例子明确所需真实前提与授权，不以 source inspection 代替应用执行。 |
| DOC-04 | [Protected configuration](../../guides/configuration.md)覆盖 XP、Agent VM、imagegen、Tavily、DST、Linux、Git 与 CAD/native；维护性 source inventory 对照留在 CONTRIBUTING。 | 中性 env/模板路径及公共安全/coupling 检查；不包含私有 inventory、个人路径、凭据或部署观察。 |

Guides 场景与验证层级如下。当前候选的 OS/runtime、实际运行结果和 blocker 记录在执行报告，不由本表存在推断通过。

| Scenario | 可复查的场景与方法 | 不包含的证据 |
| --- | --- | --- |
| GUIDES-01 | 逐一比较 allowlist 与五组指南的 Skill heading、README/索引入口；检查 purpose、prerequisites、configuration、example、output、boundaries 及所有相对链接/锚点。 | Website render/search/navigation。 |
| GUIDES-02 | Temporary consumer 直接链接选定源码；可执行 smoke 直接提取指南 enable/disable 代码块，分别验证已有空目录、foreign owner 目录、文件、symlink 或 dangling symlink lock 时停止，lock 与消费状态的类型、身份和内容均不变。操作完成、释放 lock 前注入目录替换、隐藏 foreign 内容或 token 丢失，断言诊断、失败退出、无成功消息及 lock 保留；替换时保留新目录/foreign 内容与被移走的原目录/token，未知内容时保留原 token，token 丢失时保留空 lock。另核对隐藏 record 的七行格式与 source/link 文件身份，不维护第二份安装器。 | 修改主人真实 consumer root 或安装外部工具；不把释放失败视为事务回滚，不宣称覆盖所有 token 篡改或系统级并发。 |
| GUIDES-03 | Disposable local bare upstream 与 checkout 的 fast-forward update；source 删除后按同一 disable 流程 reconciliation。可执行 smoke 验证 source 同路径重建拒绝、owned dangling link 清理、五个状态转换后的 TERM 恢复、record unlink 失败后重跑、capture 前同 target 字符串的新 inode 被保留，以及 capture 后公开 target 替换不被删除；missing/foreign/malformed/legacy record 与 foreign link/目录均保留。 | 不把 source update 等同于自动 prune；不证明 Linux、真实管理器执行或系统级对抗并发；SIGKILL 遗留 lock 须人工核对，不自动破锁。 |
| GUIDES-04 | 实际 Bun audio/PNG/local DST、local VM version/XP/Tavily help 与隔离 Git 示例 smoke；CVM 使用 synthetic fallback dry-run，并对 canonical entrypoints 与 prerequisites 做 contract review。 | Live image API、真实 Incus/远端主机、真实 firmware renderer、FreeCAD/Gmsh/Blender 与实物输出。 |
| GUIDES-05 | Standalone newcomer path、protected configuration、链接与 public boundary checks；核对 root/Skill test discovery 和 CI 中实际 commands。 | 私有 runtime/task 集成、复制 consumer tree、生产部署与发布。 |

直接 source-link 的 shell/link/anchor smoke 使用安装好的 Bun 与原生 Bash/macOS/Linux 工具，从仓库根目录执行：

```bash
bun test ./docs/guides/installation.test.ts
```

[可执行 smoke](../../guides/installation.test.ts)检查指南与相关 README/contract 的相对链接、锚点、13 个 membership 入口，并在临时目录执行 enable/disable 原文和故障注入。它证明所运行 OS 上的 fixture 行为，不证明另一 OS 或真实消费者安装；当前候选结果与 VM 阻塞只记入执行报告。

### SITE-01..04 implementation and evidence

The independent [site project](../../../site/README.md) uses Rspress 2.0.23, its own package manifest and Bun lockfile. Canonical repository Markdown remains the behavior source; generated presentation files, build output and fixtures are ignored rather than committed as a second specification or consumer tree. The observed local runtime is Bun 1.4.4 on macOS arm64; no exact runtime version is enforced. Rspack requires native bindings for the build platform. Its server-target log label `(node)` does not identify the running interpreter.

| Requirement | Implementation | Evidence and limits |
| --- | --- | --- |
| SITE-01 | [Content assembly](../../../site/scripts/content.ts) selects overview/catalog, installation/update, configuration, public guides and architecture/contracts from exact canonical paths. | 13 manifest Skills and 50 page/search entries; generation records source hashes and rewrites selected relative Markdown links to stable routes. Other public resources link to canonical source. Existing unavailable references receive an explicit notice pointing to their containing canonical document; no replacement contract is invented. |
| SITE-02 | [Rspress configuration](../../../site/rspress.config.ts) supplies responsive navigation, built-in local search, code highlighting and source/edit links under `/agent-toolkit/skills/<skill>/`. | Output assertions preserve frontmatter descriptions, headings and fenced code/literal values. Desktop search, keyboard selection and representative browser pages work. Mobile layout and hamburger opening were observed; complete mobile menu selection remains unverified after a pointer-interception failure. |
| SITE-03 | [Bun entrypoints](../../../site/scripts/run.ts) invoke the Rspress CLI with the actual Bun executable; [content checks](../../../site/scripts/check.ts) inspect routes, search, links, anchors, assets and concrete private-content signatures. | Frozen install, typecheck, development, production build and Bun static preview were exercised locally. Two isolated production builds disable PATH-resolved Node, inject excluded-content sentinels and remove one manifest member while retaining its source directory. Route/catalog/search/navigation shrink together. Signature checks do not prove arbitrary-secret detection. |
| SITE-04 | [Site workflow](../../../.github/workflows/site.yml) uses latest stable Bun and the site lockfile for PR/manual build/check. Only explicit `workflow_dispatch` with `publish=true` on the actual default branch can package the artifact and enter the separate Pages-permitted job. | Static workflow assertions verify this permission/condition boundary and absence of secret references. Publication instructions identify `site/dist/`, `/agent-toolkit/` and post-deploy route/search/revision checks. No workflow dispatch, real Pages deployment or production verification was performed. |

| Scenario | Observed evidence | Honest remaining scope |
| --- | --- | --- |
| SITE-01 | `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, `bun run check`; development returned HTTP 200; production preview served real static output. Runtime receipts and two fixture builds establish Bun execution with Node disabled for those builds. | Native Linux execution is unavailable. Bun development shutdown emitted native ObjectRef cleanup notices; no browser framework overlay was observed. |
| SITE-02 | All 13 Skill routes and 50 guide/contract/catalog pages have exact search membership. The checker follows every local built link/anchor/asset and compares canonical code values/frontmatter. Browser observations include Agent VM, Buzzer Audio Preview, configuration and the Agent VM CLI contract. | External canonical URLs are checked for intended repository/ref/path, not every remote response or GitHub edit authorization. |
| SITE-03 | Production output at `/agent-toolkit/`: 1440×1000 desktop and 393×852 mobile had the expected heading, nonempty content and no horizontal page overflow or framework overlay. Local `buzzer` search returned the Skill and keyboard ArrowDown/Enter navigated to its quick-start anchor. Configuration deep-link reload retained its target and neutral placeholder. Captured browser error/warning/exception events were empty. Source/edit links identify canonical files; expected routes return 200 and outside-base/unknown routes return 404. | Controlled desktop/mobile candidate screenshots were captured from the login-free local site. No prior visual baseline or owner acceptance exists, so visual comparison remains pending and the images are not canonical accepted assets. A mobile menu click was intercepted; full mobile keyboard/menu navigation is incomplete. Preview was stopped after bounded checks. |
| SITE-04 | Disposable source fixture: 13 → 12 manifest Skills; the removed Skill source remains on disk while its page, catalog row, navigation and search entry disappear after rebuild. Synthetic private config, inventory, unrelated guide and unlisted Skill content are absent from output. | Only the explicit allowlist is published. Credential-pattern scanning is a regression control with negative controls, not a universal content-classification guarantee. |
| SITE-05 | Workflow YAML assertions enforce read-only PR/manual validation and the identical explicit default-branch condition on artifact packaging and Pages deployment. No deployment secret is referenced. | Static inspection is not PR CI execution or production publication. Remote CI results must be assessed against the actual PR head separately. |
| SITE-06 | [Site reproduction/publication instructions](../../../site/README.md#pages-publication-boundary) name the exact checkout, frozen dependencies, Bun commands, artifact directory, repository base and post-deployment checks. | Pages setup, environment approvals and live deployment verification remain operator-owned and unexecuted. |

A session-owned Linux VM acquisition failed closed with `guest_resize_unverified` during root-disk topology verification: `lsblk` returned ambiguous disk/partition type output. No effective lease or task port mapping was exposed. Infrastructure repair, full Linux suites and real publication were not attempted. Local build/content evidence remains valid within the stated macOS scope.

### Helper behavior evidence

HELPERS-01 is covered by the [buzzer suite](../../../skills/buzzer-audio-preview/tests/buzzer_preview.test.ts), which independently decodes MIDI/WAV and compares tone timing, rests, sample limits and invalid-score diagnostics. HELPERS-02 is covered by the [framebuffer suite](../../../skills/firmware-display-preview/tests/fb_to_png.test.ts), which independently validates PNG chunks/CRCs and known pixels for all five formats, plus native compilation and the C stub's explicit unimplemented-accessor failure. These fixtures establish portable conversion behavior, not physical acoustics, device display observation or execution of a project's real firmware renderer.

HELPERS-03 and HELPERS-04 are covered by the [DST suite](../../../skills/dst-dedicated-server/tests/dst_helpers.test.ts): temporary client/cluster files, fake SSH, native Shell collection against a temporary home, local/remote selection, absent resources, failed transport, secret omission, output caps, whole-command timeout, shard summaries/differences and the documented non-executable Lua table subset. Fake SSH is transport simulation; executing the Shell collector locally is isolated native OS evidence. No actual dedicated server, deployment or game readiness was observed.

HELPERS-05 is covered by the [Git alignment suite](../../../skills/git-sync/tests/detached_alignment_contract.test.ts), which checks actual Git refs, detached HEAD, reflog recoverability, branch/remote/upstream configuration and blocked actions in temporary repositories with a filesystem bare remote. HELPERS-06 is covered by the [source-link smoke](../../../skills/git-remote-troubleshoot/tests/helper_sources.test.ts), which runs the new local entrypoints through consumer directory links from another working directory and inspects replaced-entrypoint absence and retained C/Python source boundaries. CAD binding/import inspection does not execute FreeCAD, Blender or Gmsh; application-level geometry/rendering evidence remains unavailable.

Local helper validation is observed on macOS with installed Bun. Linux helper execution and remote CI results require separate observed runs; CI suite selection or configuration alone does not establish either. The repository runner selects all five maintained Bun helper suites through the existing `skills` discovery path; no Python runtime is needed for the replaced helper tests. Runtime versions and current-candidate results belong to the execution report, not the language allocation.

### Agent VM client behavior evidence

MIG-04 and the client/source portion of MIG-05 are implemented by the direct Bun entrypoints and their isolated contract tests. [Client tests](../../../skills/agent-vm/tests/client.test.ts) cover VM-CLIENT-01/02 identity selection, missing identity before side effects, legacy persisted state/journals with exact large integers, exclusive journal creation, protocol and response validation, error/uncertainty classification, capability windows, artifact integrity, transport exits and generation-bound SSH material. [Transport tests](../../../skills/agent-vm/tests/transport.test.ts) retain the canonical Bun-controller SSH regression, execute a directory-linked consumer, and exercise bounded pipes, inherited descriptors, timeouts and nonzero exits. [Controller contract tests](../../../skills/agent-vm/tests/controller.test.ts) pass actual serialized client requests through the canonical controller with substituted native infrastructure; they verify replay, lifecycle state, errors and unchanged lease behavior during observation.

VM-CLIENT-03 is exercised by client/transport tests for permissions, argv, transfers, ports and exits. [Source tests](../../../skills/agent-vm/tests/source.test.ts) exercise VM-CLIENT-04 and the transaction behavior in VM-CLIENT-05 with actual temporary Git repositories and filesystem operations: NUL-separated paths, ignored/deleted files, links, mode/hash fidelity, submodule refusal before remote access, baseline conflicts, exact ownership, exclusive records, native locking, atomic exchange/no-replace, bounded lock contention, independent-process races and process death after rename but before the durable acknowledgement. Marker-based recovery retains the committed source and removes only verified owned material. Local orchestration tests substitute SSH/rsync, verify private temporary configuration and exact file lists, and retain recovery material on ambiguous commit acknowledgement. VM-CLIENT-06 has source-linked consumer and prerequisite-failure evidence: the bundled guest action checks Bun/native prerequisites before staging and runs under a fixed one-shot deadline. VM-CLIENT-05 still requires Linux evidence; VM-CLIENT-07 has the cross-component package evidence below but does not establish managed-image or publication acceptance.

Observed native evidence is macOS filesystem/Git/Bun execution, including `flock` and `renamex_np`; it is not Linux `renameat2` or real Incus execution. The Linux invalid-UTF-8 byte-path case is explicitly skipped on macOS, while the reversible byte codec is tested there. A session-owned VM acquisition failed closed during guest root-resize topology verification (`guest_resize_unverified`, ambiguous `lsblk` type output), leaving no effective lease or open task mapping. Linux/full-suite validation and real managed-image Bun/timeout/rsync prerequisites remain unverified; no infrastructure workaround or deployment was performed.

Complete-package integration is covered by [release manifest tests](../../../skills/agent-vm-ops/tests/test_release_manifest.py), [publisher tests](../../../skills/agent-vm-ops/tests/test_agent_vm_release.py) and [wrapper tests](../../../skills/agent-vm-ops/tests/test_agent_vm_release_wrapper.py). Python and Bun manifest policies require both Bun client entrypoints and all six support modules with fixed modes. Cross-language sidecar tests verify every dependency's bytes, mode and regular-file identity; missing, duplicated, extra or retired Python-only metadata fails closed. Recovery tests interrupt every backup/install boundary, verify full-package restoration, reentrant cleanup, precise owned paths, locks and rejection of foreign recovery material. Wrapper tests verify complete activation snapshots, rollback and exact retirement of replaced Python entrypoints. [Foundation fixtures](../../../bin/foundation_contract_check.test.ts) use migrated Bun source links and reject missing release evidence or invalid links. These isolated contracts implement the [release contract](../agent-vm/contracts/release.md); they are not evidence of successful infrastructure publication.

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

The test runner discovers Bun, Python, and Shell tests by maintained filename conventions, rejects empty or non-declarative Bun/Python test files, counts Shell `test` builtins in the suite shell and sourced helpers through a Bash wrapper, and fails closed on an empty selection or zero counted assertions. Child-helper results require an assertion in the suite shell. Supported runner platforms and native/Bun FFI prerequisites are listed in the root [validation guide](../../../README.md#validation). `bun run test:skills` preserves Python application/domain and Shell remote-observation tests; their Python dependencies remain in `requirements-dev.txt`, and the XP policy test requires Ruby with its standard YAML library. These runtime prerequisites remain separate from root Bun tooling.

Site validation from `site/` uses its independent lockfile:

```bash
bun --version
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run check
```

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
