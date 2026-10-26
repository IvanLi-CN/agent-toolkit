# Agent Toolkit

Agent Toolkit 为 coding 与 automation agents 提供可独立使用的公共 Skills：从 Git 诊断、离线预览，到有明确授权边界的 Linux 与服务操作。消费者直接读取 checkout 中的 Skill 目录或其源链接。

Canonical source 位于 `skills/<name>/`；公共 membership 以 [PUBLIC_SKILLS.txt](PUBLIC_SKILLS.txt) 为准，共 13 个 Skill。[公共目录](skills/README.md)维护 membership 索引，下面的五组入口连接使用指南。指南提供最小示例；完整行为以各 Skill 的 `SKILL.md` 和 contracts 为准。

[安装与更新](docs/guides/installation.md) · [全部指南](docs/guides/README.md) · [Protected configuration](docs/guides/configuration.md) · [Validation](#validation) · [Contracts 与架构](docs/guides/README.md#contracts) · [贡献边界](CONTRIBUTING.md)

## 五个能力组

| 能力组 / Skill | 最小用途与代表场景 | 平台 / 前置条件 | 输出 |
| --- | --- | --- | --- |
| 隔离执行：[agent-vm](docs/guides/isolated-execution.md#agent-vm) | 在会话所属 VM 中执行构建、Docker/Compose 或重型验证 | 本地 Linux/macOS、Bun、OpenSSH、Git；已配置的匹配协议控制环境，sync 另需 rsync | 租约与状态、命令结果、取回文件 |
| 隔离执行：[agent-vm-ops](docs/guides/isolated-execution.md#agent-vm-ops) | 在明确基础设施任务内检查、维护控制环境 | 已配置的 Incus/Linux/systemd、Bun、原生工具；发布另需 Python | 诊断、清理预览、授权维护结果 |
| 服务运维：[xp-infra](docs/guides/service-operations.md#xp-infra) | 校验 XP 部署策略并审计指定节点 | 本地 Bun、OpenSSH、curl；私有 inventory/policy；远端 Linux 原生探针 | policy/preflight/audit 结果 |
| 服务运维：[tavily-hikari-infra](docs/guides/service-operations.md#tavily-hikari-infra) | 只读检查已配置的 primary/standby | Bash、OpenSSH；私有 inventory 与显式只读命令 | inventory、status、受限日志 |
| 服务运维：[dst-dedicated-server](docs/guides/service-operations.md#dst-dedicated-server) | 排查 Master/Caves 状态、比较 mod 配置 | Linux/macOS、Bun；远端观察另需可信 SSH 与 POSIX 工具 | Markdown 快照、mod 摘要 |
| 服务运维：[linux-server-init](docs/guides/service-operations.md#linux-server-init) | 为新 Linux 主机建立已验证的非 root 管理通路 | OpenSSH、目标 Linux 管理权限、sudo/doas 与恢复通路 | 验证过的访问与加固配置 |
| Git 与文档：[git-remote-troubleshoot](docs/guides/git-and-docs.md#git-remote-troubleshoot) | 识别远端、认证、网络失败原因 | Linux/macOS、Git 与既有 SSH/HTTPS 工具；无编程 runtime | 诊断证据与最小修复建议 |
| Git 与文档：[git-sync](docs/guides/git-and-docs.md#git-sync) | 对比已确认基线、按授权同步本地状态 | Linux/macOS、Git 与已配置 remote；无编程 runtime | ahead/behind、HEAD 与恢复信息 |
| Git 与文档：[docs-no-revision-markers](docs/guides/git-and-docs.md#docs-no-revision-markers) | 编写稳定语义路径的 timeless 文档 | 文本编辑环境；无 runtime、账户或部署配置 | 不含文档级修订标记的正文 |
| 媒体与固件预览：[buzzer-audio-preview](docs/guides/media-previews.md#buzzer-audio-preview) | 从 JSON 音符确认蜂鸣器节奏 | Linux/macOS、Bun、合法 score | MIDI 与 WAV，不自动播放 |
| 媒体与固件预览：[firmware-display-preview](docs/guides/media-previews.md#firmware-display-preview) | 将固件 framebuffer 转为 PNG | Linux/macOS、Bun；真实渲染另需 C 编译器、固件入口与资产 | framebuffer、场景源码、PNG |
| 媒体与固件预览：[cvm-imagegen](docs/guides/media-previews.md#cvm-imagegen) | 显式要求 CLI/API fallback 时生成或编辑图片 | Python、已配置 fallback 模块及其依赖；在线需 endpoint/key 与授权 | dry-run 请求或生成图片 |
| CAD：[step-stl-print-repair](docs/guides/cad-repair.md#step-stl-print-repair) | 从 STEP 重新网格化并检查打印 STL | Linux/macOS、匹配 FreeCAD/Gmsh/Blender 的 Python 环境与扩展 | STL、JSON 报告、渲染预览 |

## 安装

先通过 HTTPS 获取源码；目标路径为使用者自选的占位符：

```bash
git clone https://github.com/IvanLi-CN/agent-toolkit.git /path/to/agent-toolkit
```

按[安装指南](docs/guides/installation.md#direct-source-links)把 allowlist 中选定目录直接链接到消费者的 Skill root。先检查同名条目，不使用强制覆盖。消费者也可以原生配置源码目录。仓库不生成复制的 consumer Skill tree，不提供 runtime adapter，也不运行同步服务。可选外部 `skills-switch` 的独立管理流程见[对应章节](docs/guides/installation.md#skills-switch)。

## Validation

使用本机已安装的 Bun；仓库不选择或下载固定 Bun/Node.js。普通 Skill 消费不需要先安装仓库开发依赖，文本型 Skills 不需要编程 runtime。维护者从仓库根目录执行：

```bash
bun --version
go version
bun install --frozen-lockfile
bun run typecheck
bun run check
go -C skills/agent-vm-ops/control vet ./...
bun run test:repo
python3 -m pip install -r requirements-dev.txt
ruby -e 'require "yaml"'
bun run test:skills
```

`check` 包含 typecheck、foundation/spec、索引与公共安全/依赖检查，并执行 Go control module 的 `go vet`；`test:repo` 发现 `skills/` 外仓库自有的 Bun/Python/Shell 测试；`test:skills` 发现 Skill 内测试并按 module 唯一运行 Go 测试。Python 依赖单列在 [requirements-dev.txt](requirements-dev.txt)。XP 当前本地 CLI 使用 Bun，不需要 Ruby/Python；完整 Skill 测试中的策略 fixture 仍检查 Ruby 标准 YAML 库。应用 Python、C 编译器、原生 OS 工具或外部 fallback 的前提由各指南和 canonical source 说明，不能用装好 Bun 替代。

测试 runner 支持 macOS 和 glibc Linux；依赖 Bun FFI 对 POSIX `getsid`/`getpgid` 的访问，分别使用 `libSystem.B.dylib` 或 `libc.so.6`，并需 PATH 中有 `bash`、`ps`、`mktemp`、`mkfifo`、`cat`、`tr`、`sleep`、`wc`、`rm`。原生 Windows 与非 glibc Linux 不在 runner 支持范围内。

Runner 拒绝空或无声明的 Bun/Python 测试文件，并按 Go module 聚合测试入口。Shell suite 必须在自身 shell 或 sourced helper 中执行至少一个计数的 `test` builtin，并报告 `TESTS_RUN=<count>`；单独子进程的断言不贡献计数，需在 suite shell 断言其结果。具体行为由 [test_runner.ts](bin/test_runner.ts) 定义。

Root checks 证明结构与契约一致性；隔离 fixture 测试证明其覆盖的行为。两者都不证明真实 VM、CAD 应用、游戏服务器、远端服务、站点发布或生产部署已运行。验证时分别记录本地离线、隔离原生 OS、远端观察及真实应用证据；完整/重型验证使用隔离环境，不在本机 Docker 或生产系统上试运行。平台 wiring 见 [CI](.github/workflows/ci.yml)，证据边界见 [IMPLEMENTATION.md](docs/specs/project-foundation/IMPLEMENTATION.md)。

## Contracts 与贡献

[指南与 contracts 导航](docs/guides/README.md#contracts)连接项目职责、语言边界和 Agent VM、XP、CVM 的权威契约。[CONTRIBUTING.md](CONTRIBUTING.md)说明源码、测试与文档如何一起维护。真实 inventory、凭据、部署地址和消费者私有集成归 operator 所有，按 [protected configuration](docs/guides/configuration.md) 保存在仓库外。

一次性 source inventory 对照属于维护操作，不属于新人安装路径；按[贡献指南](CONTRIBUTING.md#maintenance)执行。

## License

Agent Toolkit 使用 [MIT License](LICENSE)。
