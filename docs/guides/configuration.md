# Protected configuration

[返回指南](README.md) · [安装与更新](installation.md) · [贡献边界](../../CONTRIBUTING.md)

Public source 保存可复用说明、schema 和中性模板；operator 保存真实 inventory、主机名/地址、SSH identity、凭据、部署例外与运行证据。将配置放在 checkout 外、仅预期 operator 可读的位置：私有目录通常 `0700`，含敏感值的普通文件通常 `0600`，控制面 root-owned 文件按其 contract 设置 owner/mode。不要把含真实值的文件、输出或截图提交到本仓库或站点。

以下环境变量都只展示配置形状，路径和 alias 不能直接作为部署使用。环境变量也可能被子进程继承或调试日志记录；凭据由受保护的 secret 注入渠道提供，不在 shell 命令中粘贴真实 key，不使用 `set -x`。仓库不自动加载此页面所示 env 文件，也不提供统一配置 runtime。

## xp

本地 Bun helper 读取 `XP_INFRA_CONFIG_DIR` 下的 `hosts.txt` / `deployment-policy.yaml`，也可逐文件覆盖：

```bash
export XP_INFRA_CONFIG_DIR=/path/to/private/xp
export XP_HOSTS_FILE=/path/to/private/xp/hosts.txt
export XP_POLICY_FILE=/path/to/private/xp/deployment-policy.yaml
```

从公共 [hosts template](../../skills/xp-infra/references/hosts.txt.example)、[policy template](../../skills/xp-infra/references/deployment-policy.yaml.example)与 [env key template](../../skills/xp-infra/references/xp.env.template)在仓库外建立私有文件。Inventory 仅列唯一小写 SSH aliases，真实 HostName/User/IdentityFile 放 operator 的 SSH configuration。Policy 示例的 `owner_confirmed: false` 故意不能通过检查，不应为了通过而机械改成 true；主人须确认所有功能基线、public hostname、geo 与例外理由。

完整 schema 与 restricted YAML 子集以 [CLI contract](../../skills/xp-infra/references/cli.md)为准；不要加入任意 YAML tags/anchors。真实节点 runtime 配置和 tokens 留在 operator/node 环境，helper 不读取 administrator tokens。离线 `policy check` 不能证明 DNS/public ingress、进程身份或远端 service 健康。Public probes 会联网，按授权的 policy 和目标执行，结果必须脱敏。

## imagegen

配置可信的外部 Python fallback；dry-run 不要求 endpoint/key：

```bash
export AGENT_IMAGEGEN_SYSTEM_PATH=/path/to/trusted/image_gen.py
export CVM_BASE_URL=https://api.example.invalid/v1
```

Live 还需由私有 secret 渠道注入 `CVM_API_KEY`，不要在 tracked env、命令行参数、prompt 或普通日志写真实值。`.invalid` 是中性示例，不是运行 endpoint。Fallback 路径指向可执行 Python 模块，必须先确认信任与依赖，不只是存在即可。

[CVM CLI](../../skills/cvm-imagegen/references/cli.md)保留 generate/edit/generate-batch 与 delegated flags；wrapper 不创建第二个 client、不安装修改已有 runtime。Live prompt/reference image 上传和计费需明确授权，private input/output 与批量文件留在操作者项目外部安全位置。Fixture、dry-run 与真实后端调用分别记录。

## tavily

使用独立 private inventory 和经过审阅的固定只读命令：

```bash
export TAVILY_CONFIG_DIR=/path/to/private/tavily
export TAVILY_HOSTS_FILE=/path/to/private/tavily/hosts.txt
export TAVILY_PRIMARY_ALIAS='<configured-primary-alias>'
export TAVILY_STANDBY_ALIAS='<configured-standby-alias>'
export TAVILY_PRIMARY_STATUS_COMMAND='systemctl is-active <configured-unit>'
export TAVILY_STANDBY_STATUS_COMMAND='systemctl is-active <configured-unit>'
export TAVILY_PRIMARY_LOG_COMMAND='journalctl --no-pager -u <configured-unit> -n'
export TAVILY_STANDBY_LOG_COMMAND='journalctl --no-pager -u <configured-unit> -n'
```

替换 unit 后才可执行；log helper 追加 tail 数量，命令需保持只读、有界并脱敏。不要从网页或不可信输入构造这些 shell command。Public [hosts template](../../skills/tavily-hikari-infra/references/hosts.txt.example)、[inventory template](../../skills/tavily-hikari-infra/references/inventory.md.example)与 [standby env template](../../skills/tavily-hikari-infra/references/standby.env.template)只供私有配置参考。

`TAVILY_PRIMARY_COMPOSE`、`TAVILY_STANDBY_SERVICE` 与可选 `TAVILY_STANDBY_URL` 是 runbook 的 operator context；helper 的 status/logs 仍使用上面的 command 变量，不自动从 Compose 文件启动服务或推断命令。Inventory 会解析 SSH 字段；状态、日志与 health response 均可能泄露拓扑，公开前脱敏。不把观察升级成 promote/restart/deploy。

## other-operations

| Skill / 表面 | 中性配置形状 | 保护与授权边界 |
| --- | --- | --- |
| DST | `DST_HOST='<configured-alias>'`、`DST_USER='<operator-user>'`、`DST_LOCAL_DIR=/path/to/client-data`、`DST_CLUSTER='<cluster-name>'` | 主机凭据用 SSH；cluster/server tokens、密码和 saves 留在私有位置。纯本地 `--no-remote` / `--cluster-dir` 不需要真实服务器；restart/update/mod/save 操作另行授权。 |
| Linux bootstrap | `HOST='<configured-alias>'`、`PORT=22`、`BOOTSTRAP_USER='<current-admin>'`、`NEW_USER='<new-admin>'`、`PUBKEY_PATH=/path/to/admin.pub` | 这是 workflow inputs，不是自动加载 schema；同时确认 PRIV_ESC、SUDO_MODE、CONSOLE_ACCESS。Account/sudoers/sshd 变更是权限写入，保留旧会话与 rescue。 |
| Git | 已有 remote / SSH configuration 与明确的 ACTION/BASE_REF/REMOTE | 配置和 verbose 输出可能带私有地址或 credential；不自动更换 URL/协议/认证，不隐式 push。 |
| CAD/native | `CAD_PYTHON=/path/to/gmsh-python`，项目提供 input、output、toolchain/assets | 这是示例 executable 选择，不是新的服务配置；模型/输出留在授权目录，不上传。Blender 以独立 background/factory-startup 进程运行。 |
| Buzzer/framebuffer | 显式 input/output 与 score / format 参数 | 不需要 service secrets；输出可能替换同名文件。离线产物不证明硬件/应用实测。 |

排障报告仅保留完成判断所需的 runtime、角色、结果类别和脱敏路径；不公开原始 SSH、请求/响应、模型、用户数据或配置副本。Public tests 应使用 synthetic fixtures 和 temporary directories，不读取主人真实配置。验证层级见 [README](../../README.md#validation)，各 Skill 的细节回到[使用指南](README.md)。
