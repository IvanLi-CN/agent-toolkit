# 隔离执行

[返回指南](README.md) · [Protected configuration](configuration.md#agent-vm-configuration) · [Agent VM CLI](../specs/agent-vm/contracts/cli.md)

## agent-vm

**何时使用：**需要会话所属的 Linux VM 执行代码、Docker/Compose、重型验证或传输源码时使用；基础设施维护走下一节。Canonical [Skill source](../../skills/agent-vm/SKILL.md) 与 [lifecycle SPEC](../specs/agent-vm/SPEC.md) 定义完整租约与回收行为。

**平台与前置条件：**本地 Linux/macOS、Bun（含 `bun:ffi`、`Bun.build`）、OpenSSH、Git，sync 另需 rsync；远端必须已有匹配协议的 one-shot control 与合格 Linux image。Guest source transaction 另要求 Bun/native locking、atomic rename、GNU `timeout`、Git/rsync。缺失时报告前提，不自行安装基础设施或退回本机 Docker。

**配置：**明确 `AGENT_VM_CONTROL_HOST`、canonical `AGENT_VM_REMOTE_CONTROL` 和稳定的 `AGENT_VM_SESSION_ID`，也可用 `--session-id`。Session ID 是 ownership metadata，不是授权凭据。SSH identity、known-host material 与 state/journals 放私有位置；见[配置说明](configuration.md#agent-vm-configuration)。

**最小例子：**源码 checkout 可直接运行本地 version，无网络或 session 前提：

```bash
bun /path/to/agent-toolkit/skills/agent-vm/scripts/agent_vm.ts version
```

已有安装与配置时，按当前任务授权运行 `agent-vm doctor`、`agent-vm status` 观察控制环境；它们不是离线操作。批准分配、guest 执行及其收尾后，日常路径为：

```bash
agent-vm --session-id '<session-id>' acquire
agent-vm --session-id '<session-id>' exec -- uname -s
agent-vm --session-id '<session-id>' status
```

**输出：**本地协议/client 标识、租约/guest 状态、命令结果及显式 download/export 的文件。必须同时检查 effective lease、guest availability、server deadline 和 structured errors；不能将 `doctor` 的 ready 当任意资源请求均可获批。

**读写边界：**acquire/renew/resize/sync/transfer 会改变会话或 guest 状态。任一执行/传输都不隐式续租；需要继续使用时显式 renew。结束 VM 工作前在线取回所需文件，按 canonical Finish 执行 release 并复查无有效租约、映射关闭与 stopped/cache 状态。缓存无最低保留承诺；destroy 另需明确丢弃授权。Guest root 不授权 Incus、CT、底层 host 或其他会话管理。超时保留原 operation ID/generation 和恢复材料，不盲目制造新意图。

## agent-vm-ops

**何时使用：**只有明确的基础设施任务才使用，包括已配置控制环境、image、timer、admission、reconcile、GC 与发布恢复；日常执行使用 `agent-vm`。[Skill source](../../skills/agent-vm-ops/SKILL.md)、[deployment](../../skills/agent-vm-ops/references/deployment.md)、[control runtime](../../skills/agent-vm-ops/references/control-runtime.md) 与 [release contract](../specs/agent-vm/contracts/release.md) 是权威入口。

**平台与前置条件：**配置好的 Linux/Incus/systemd/OpenSSH 环境、Bun（包括 SQLite/FFI/build）、native locks、网络与存储工具；发布打包使用 Python。Image 能力单独核验，不因已有 Bun 就推断 guest root resize 或 native timers 可用。

**配置：**沿用受保护 control endpoint；所有控制请求和 units 使用 `/etc/agent-vm-native/config.json`，按[模板与保护边界](configuration.md#agent-vm-configuration)设置 project/profile/image/network/pool/state 等。管理访问是共享能力，session 名称不能隔离管理权限。

**最小例子：**已授权的远端观察从以下命令开始，不执行 apply：

```bash
agent-vm doctor
agent-vm admin status
agent-vm admin session list
agent-vm admin reconcile
```

**输出：**组件、维护与会话状态、exact cleanup/reconciliation 预览；只有实际执行并复查的操作才形成维护结果。CLI 本地 help/version、isolated fixtures 和真实 Incus 观察应分别记录。

**读写边界：**admin status/list 与 reconcile 默认预览是观察；drain、release publication、image 变更、`--apply` 与 GC 是独立授权的维护动作。发布必须走完整 canonical package、staging/drain/verify/activation/rollback，不从 guest 上传或部分覆盖 control 文件。恢复保留数据库/WAL/journals/generations 与 VM 数据，按 [OPERATIONS](../specs/agent-vm/OPERATIONS.md)处理缺失证据；control alias 不能证明底层 host 身份，不授权重建、全局 conntrack flush 或影响其他有效租约。离线 release tests 不等于基础设施发布完成。
