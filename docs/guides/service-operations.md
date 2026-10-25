# 服务运维

[返回指南](README.md) · [Protected configuration](configuration.md)

这些 Skills 使用 operator 已配置的目标。离线帮助或 policy 检查不证明远端健康；只读诊断不授权 deploy、restart、promote、DNS 写入或权限修改。

## xp-infra

**何时使用：**检查 XP policy、指定节点 preflight/audit、诊断部署漂移；deploy/join/upgrade 仍需另行授权。[Skill source](../../skills/xp-infra/SKILL.md)、[CLI contract](../../skills/xp-infra/references/cli.md) 与 [runbook](../../skills/xp-infra/references/runbook.md)定义行为。

**平台与前置条件：**本地 Bun、OpenSSH、curl，不要求本地 Ruby/Python；远端 Linux 保留 POSIX/native 探针及非交互 privilege/service 工具，端口探针需要 GNU-compatible `dd`、`timeout` 等。远端不需要安装 Bun。

**配置：**`XP_INFRA_CONFIG_DIR` 或独立 `XP_HOSTS_FILE` / `XP_POLICY_FILE`，实际连接放 operator SSH 配置；[公共模板](../../skills/xp-infra/references/deployment-policy.yaml.example)故意未确认，必须由主人决定 policy。见 [XP 配置](configuration.md#xp)；不把 unavailable 证据默认为健康。

**最小例子：**从 checkout 调用实际入口；help 完全离线，policy check 只读取私有配置：

```bash
/path/to/agent-toolkit/skills/xp-infra/scripts/xp-infra --help
/path/to/agent-toolkit/skills/xp-infra/scripts/xp-infra policy check
```

已授权远端观察时再执行 `xp-infra port preflight '<configured-alias>'`、`xp-infra audit '<configured-alias>'`，使用上例完整入口路径。Alias 必须注册且唯一，不选择“恰好能连通”的其他节点。

**输出：**policy 成功/拒绝、经过完整验证的选定端口、audit 的 PASS/FAIL/获准 SKIP 与非零失败。Preflight 不分配真实服务端口，fixture 不建立部署健康证据。

**读写边界：**helpers/audit 只读，不读 administrator tokens、不部署/修复/重启；public HTTPS probes 会访问网络，必须使用明确 policy 和目标，保持 TLS/redirect/output 安全限制。隧道创建本地 listener/SSH forwarding，另需授权与精确端口。真实 policy、例外理由、logs、node runtime secrets 不进入公共源码。

## tavily-hikari-infra

**何时使用：**只读检查已配置的 Tavily Hikari primary/standby 与 HA 状态，不承担广泛网页搜索。[Skill source](../../skills/tavily-hikari-infra/SKILL.md) 与 [runbook](../../skills/tavily-hikari-infra/references/runbook.md)定义操作边界。

**平台与前置条件：**Linux/macOS 的 Bash、OpenSSH、awk/xargs 等原生工具；远端服务已存在，不需要在本机 Docker 启动 Compose。健康 HTTPS 观察另需 curl。

**配置：**`TAVILY_CONFIG_DIR` / `TAVILY_HOSTS_FILE`、两端 alias 与实际 `TAVILY_*_STATUS_COMMAND` / `TAVILY_*_LOG_COMMAND` 均在仓库外。Compose/service/URL 环境变量是 operator 上下文，不能代替 helper 需要的显式命令。见 [Tavily 配置](configuration.md#tavily)。

**最小例子：**help 不联网；配置并获准远端只读观察后运行 status：

```bash
bash /path/to/agent-toolkit/skills/tavily-hikari-infra/scripts/tavily-hikari-infra --help
bash /path/to/agent-toolkit/skills/tavily-hikari-infra/scripts/tavily-hikari-infra status primary
```

**输出：**inventory 解析后的 SSH 连接字段、指定角色的 status 或日志；`logs standby --tail 200` 将 tail 参数交给 operator 配置的命令，operator 必须保证命令只读且输出有界。Inventory 也会暴露解析地址，分享前脱敏。

**读写边界：**helper 不 promote、restart、deploy 或修改 DNS；提供的远端命令本身属于可信配置，不从不可信输入拼接。主备同步/健康必须按 runbook 实际观察，不能从配置文件存在推断。未来写操作仍需单独授权及显式确认，不在本指南例子中执行。

## dst-dedicated-server

**何时使用：**先获取 DST metadata 快照，再区分 Master/Caves、共享配置与 mod 问题。[Skill source](../../skills/dst-dedicated-server/SKILL.md) 与 [helper contract](../../skills/dst-dedicated-server/references/helper-contract.md)定义有界采集和受支持的非执行 Lua 子集。

**平台与前置条件：**本地 Linux/macOS、Bun；远端模式另需 OpenSSH、已信任 host key、非交互 key access，以及 POSIX `sh`、`dd`、`find`、`wc`、`tr`、`head` 等工具。不需要远端 Bun 或 Lua interpreter。

**配置：**`DST_HOST`、`DST_USER`、可选 `DST_LOCAL_DIR`、`DST_CLUSTER` 在仓库外；也可用显式参数。纯本地模式不需要 host，示例路径由使用者提供，输出父目录须存在。

**最小例子：**下面只读本地选定目录，不访问服务器：

```bash
SKILL_DIR=/path/to/agent-toolkit/skills/dst-dedicated-server
bun "$SKILL_DIR/scripts/dst_snapshot.ts" --no-remote \
  --local-dir /path/to/client-data --out /path/to/fresh-output/snapshot.md
bun "$SKILL_DIR/scripts/dst_mods_from_modoverrides.ts" --cluster-dir /path/to/Cluster_1
```

**输出：**一个 Markdown metadata 报告及路径；mod summary 在 stdout 打印 Workshop IDs、状态计数与 shard 差异，不执行 Lua。Snapshot 的 partial warning/exit 0 只表示报告写入成功，不证明远端采集成功。

**读写边界：**snapshot 可能替换同名输出，mod summary 不写文件；远端仅采集 canonical contract 规定的 metadata 或选定 mod bytes，不读 token/config secrets。真实 restart/update、mod/save 变更和回滚要先取得主人授权；只有实际服务器和持续 shard-ready 观察才证明应用可用。

## linux-server-init

**何时使用：**在明确的新服务器初始化任务中建立非 root 公钥管理通路并加固 SSH。[Skill source](../../skills/linux-server-init/SKILL.md)是文本工作流，无独立 executable 或编程 runtime。

**平台与前置条件：**本地 OpenSSH，目标 Linux 的当前 admin access、sudo 或 doas、目标发行版提供的用户管理工具与 console/rescue 兜底。不能把其它服务器现成配置直接套用。

**配置：**由主人提供 `HOST`、`PORT`、`BOOTSTRAP_USER`、`NEW_USER`、`PUBKEY_PATH`、`PRIV_ESC`、`SUDO_MODE`、`CONSOLE_ACCESS`。这些是 workflow inputs，不是仓库自动加载的配置 schema；参见[配置说明](configuration.md#other-operations)。

**最小例子：**先在本地解析已配置 alias；此命令不建立 SSH 连接，但配置含 Match exec 时可能执行 operator 配置的程序：

```bash
ssh -G '<configured-alias>'
```

随后在授权的服务器上按 canonical 顺序 preflight → 创建用户/key → 在第二会话验证 SSH 与 privilege escalation → 校验 `sshd -t` / sudoers → reload → 正反访问验证。

**输出：**经验证的新 admin 通路、明确配置路径与验证结果。仅 `ssh -G` 或语法检查通过不代表远端登录及回滚路径可用。

**读写边界：**preflight 是观察，创建账户、authorized_keys、sudoers、sshd drop-in 与 reload 都是真实权限/服务变更，必须在明确授权目标内。保留现有 admin 会话，在新通路和提权均验证成功前不禁用旧入口。绝不因一条连接失败猜测主机或关闭访问兜底。
