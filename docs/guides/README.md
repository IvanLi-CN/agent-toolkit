# 使用指南

从[安装与更新](installation.md)开始，再阅读 [protected configuration](configuration.md) 并选择所需能力。Canonical source 为 `skills/<name>/`，membership 由 [PUBLIC_SKILLS.txt](../../PUBLIC_SKILLS.txt) 定义；[公共 catalog](../../skills/README.md) 是 membership 索引。本页按四组连接全部 11 个 Skill 的唯一使用说明位置。

| 能力组 | 使用说明 |
| --- | --- |
| 服务运维 | [xp-infra](service-operations.md#xp-infra)、[tavily-hikari-infra](service-operations.md#tavily-hikari-infra)、[dst-dedicated-server](service-operations.md#dst-dedicated-server)、[linux-server-init](service-operations.md#linux-server-init) |
| Git 与文档 | [git-remote-troubleshoot](git-and-docs.md#git-remote-troubleshoot)、[git-sync](git-and-docs.md#git-sync)、[docs-no-revision-markers](git-and-docs.md#docs-no-revision-markers) |
| 媒体与固件预览 | [buzzer-audio-preview](media-previews.md#buzzer-audio-preview)、[firmware-display-preview](media-previews.md#firmware-display-preview)、[cvm-imagegen](media-previews.md#cvm-imagegen) |
| CAD | [step-stl-print-repair](cad-repair.md#step-stl-print-repair) |

## 例子与证据

示例中的 `/path/to/...`、`<configured-alias>`、`<skill-id>` 等均需由使用者替换，不可当真实配置执行。Shell 变量只在对应示例中定义，不假定仓库提供全局 wrapper 或安装器。写入产物时选择新的私有输出目录，避免覆盖现有文件。

离线转换、fixture、远端只读诊断和真实应用执行是不同证据。网络、上传、收费生成、VM 分配、服务维护与破坏性操作应先明确目标和主人授权；诊断不自动授权修复。认证、主机信任或身份挑战需要人工完成。Root checks 与 Skill tests 的依赖和范围见 [Validation](../../README.md#validation)。

## Contracts

| 权威内容 | 入口 |
| --- | --- |
| 项目职责与 public source | [AGENTS.md](../../AGENTS.md)、[GLOSSARY.md](../../GLOSSARY.md)、[贡献边界](../../CONTRIBUTING.md) |
| Foundation 要求、实现证据与 runtime 分配 | [SPEC](../specs/project-foundation/SPEC.md)、[IMPLEMENTATION](../specs/project-foundation/IMPLEMENTATION.md)、[语言矩阵](../specs/project-foundation/SCRIPT-LANGUAGE-MATRIX.md)、[架构决定](../adr/0032-project-foundation-rebaseline.md) |
| XP policy 与只读 audit | [Skill](../../skills/xp-infra/SKILL.md)、[CLI](../../skills/xp-infra/references/cli.md)、[runbook](../../skills/xp-infra/references/runbook.md) |
| CVM fallback 模块边界 | [Skill](../../skills/cvm-imagegen/SKILL.md)、[CLI](../../skills/cvm-imagegen/references/cli.md)、[API reference](../../skills/cvm-imagegen/references/image-api.md) |

其他 Skill 的行为细节由各指南直接链接其 source/contracts。本指南不建立新协议、部署配置或第二个 Skill source。
