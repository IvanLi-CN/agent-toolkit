# 安装与更新

所有消费者都可使用 HTTPS checkout 或原生 source directory 配置；只需消费者能发现 `SKILL.md`。普通消费不依赖本仓库的 Bun 开发依赖，也不要求特定 agent 产品。先查看 [13 个公共 Skills](../../PUBLIC_SKILLS.txt) 及[运行前置条件](../../README.md#五个能力组)，按需启用。

## HTTPS checkout

```bash
git clone https://github.com/IvanLi-CN/agent-toolkit.git /path/to/agent-toolkit
```

保留完整 Skill 目录，脚本可能引用 sibling modules、references 或 assets。不要只复制 `SKILL.md`。如果消费者支持配置 source root，直接指定 checkout 的 `skills/`，但先核对它是否会与已有私有/第三方 Skill 同名。

## Direct source links

下面使用 POSIX shell 与目录 symlink，适合 Linux/macOS。消费者决定自己的 root；其他平台可配置原生 source directory 或等价的目录链接能力，不必生成复制树。

在你批准使用的消费者目录内启用一个 allowlisted Skill：

```bash
TOOLKIT_SOURCE=/path/to/agent-toolkit
CONSUMER_SKILLS=/path/to/consumer/skills
SKILL_NAME=docs-no-revision-markers
mkdir -p "$CONSUMER_SKILLS"
if [ -e "$CONSUMER_SKILLS/$SKILL_NAME" ] || [ -L "$CONSUMER_SKILLS/$SKILL_NAME" ]; then
  printf '%s\n' 'Collision: inspect the existing entry; nothing was replaced.'
else
  ln -s "$TOOLKIT_SOURCE/skills/$SKILL_NAME" "$CONSUMER_SKILLS/$SKILL_NAME"
fi
```

将 `TOOLKIT_SOURCE` 设为稳定的绝对 checkout 路径；若路径本身含链接，先在该 checkout 运行 `pwd -P` 确认真实来源。对每个选定 Skill 重复此流程，不链接 allowlist 外内容。验证 `readlink "$CONSUMER_SKILLS/$SKILL_NAME"` 的目标，并从消费者路径读取 `SKILL.md`；源码 identity 应与 checkout 内同一文件一致。不要以强制链接、复制或 adopt 覆盖已有条目。空消费者也可把整个 `skills/` 作为直接 source root，但逐目录链接更便于保留私有 Skills 和处理 membership 变化。

## Update and reconciliation

先检查源码 checkout 的工作区和已确认的跟踪分支；保留本地修改，不自动 stash、reset 或更换 remote：

```bash
git -C /path/to/agent-toolkit status --short --branch
git -C /path/to/agent-toolkit pull --ff-only
```

`pull` 更新源码与 remote-tracking refs，需要网络；不能快进时停止并处理差异。直接链接立即看到更新，不需复制或重新安装。更新后重读 allowlist、所用 Skill 的 prerequisites/contracts，并检查 source link identity。

上游删除或移出 allowlist 的 Skill 不会被手工链接流程自动清理。逐项比较原来启用列表与当前 allowlist，检查消费者中的链接，包括 dangling symlink；只移除你创建且目标仍精确匹配旧来源的条目。遇到同名普通目录、第三方链接或重新指向的条目时保留并报告冲突。不要仅因 `test -e` 为假就认为条目不存在，它可能是 dangling symlink。

## Disable and uninstall

禁用一个 Skill 只 unlink 自己创建的直接链接；保留 checkout：

```bash
if [ -L "$CONSUMER_SKILLS/$SKILL_NAME" ] &&
   [ "$(readlink "$CONSUMER_SKILLS/$SKILL_NAME")" = "$TOOLKIT_SOURCE/skills/$SKILL_NAME" ]; then
  unlink "$CONSUMER_SKILLS/$SKILL_NAME"
else
  printf '%s\n' 'Entry is not the expected owned link; leave it untouched.'
fi
```

这段检查也适用于上游删除后的孤儿链接。只对已确认的 allowlisted 名称使用变量，不使用宽泛 glob。重新启用仍走 collision 检查。

卸载消费关系时，对你启用的条目逐一执行相同的检查与 unlink，再移除消费者自己的 source-root 配置。不要删除整个消费者 root、checkout、私有目录或第三方条目。源码 checkout 若确需删除，应另行确认备份、本地修改和所有消费者引用；这不是禁用或清理孤儿链接的隐含动作。

## skills-switch

`skills-switch` 是可选的外部管理工具，本仓库不提供、安装或依赖它。已有用户可由它管理独立资源 catalog 的 vendor checkout，并向消费者投影 source links；这不应复制 consumer Skill tree、增加 runtime adapter 或同步服务。工具的 `source add` 会在资源仓库创建 vendor Git submodule，因此先按该工具自己的文档准备独立资源仓库与注册的 client，保留其配置于本仓库外。不要对 Agent Toolkit checkout 运行 `init` 或把它改成管理器资源仓库。

先核对安装工具的帮助，以下流程要求它具有这些子命令；不兼容时使用上面的直接链接流程：

```bash
skills-switch --help
skills-switch source add --help
skills-switch skills enable --help
skills-switch skills prune --help
```

使用明确 scope 与中性路径，避免意外修改用户全局安装：

```bash
RESOURCE_ROOT=/path/to/resource-catalog
CONSUMER_PROJECT=/path/to/consumer-project
skills-switch --resources "$RESOURCE_ROOT" --project "$CONSUMER_PROJECT" source add \
  https://github.com/IvanLi-CN/agent-toolkit.git --name '<source-name>' --skill-path skills
skills-switch --resources "$RESOURCE_ROOT" --project "$CONSUMER_PROJECT" source list
skills-switch --resources "$RESOURCE_ROOT" --project "$CONSUMER_PROJECT" skills list --scope project
skills-switch --resources "$RESOURCE_ROOT" --project "$CONSUMER_PROJECT" skills show '<skill-id>'
skills-switch --resources "$RESOURCE_ROOT" --project "$CONSUMER_PROJECT" skills enable '<skill-id>' \
  --client '<registered-client>' --scope project
```

`<source-id>`、`<skill-id>` 从 list/show 的实际结果选择，不假定等于短名称。只启用当前 public allowlist 中的 Skill；先检查目标路径及冲突，不用 `adopt`/`delete` 解决同名条目。若发现非自有文件、不同 source 的同名 Skill 或无法确认投影归属，停止并保留原条目，使用消费者支持的独立发现路径或由主人决定名称/来源。

| 操作 | 在相同 `--resources`、`--project` 上执行的子命令 | 边界 |
| --- | --- | --- |
| Disable / enable | `skills disable '<skill-id>' --client '<registered-client>' --scope project` / 对应 `skills enable` | 只调整指定消费 scope，不删除源文件 |
| Update | `source update '<source-id>' --dry-run`，审阅后 `source update '<source-id>'` | 更新 vendor checkout；检查本地修改和新 prerequisites |
| Upstream deletion reconciliation | `skills prune --scope project` 先列出，核对后 `skills prune --scope project --yes` | 显式清理已从来源消失的投影；不把 source update 等同于已清理所有孤儿 |
| 移出 allowlist 但源目录仍在 | 人工比较 allowlist 并 `skills disable '<skill-id>' ...` | `prune` 不替代 membership 审核 |
| Uninstall | 先 disable 自己的启用项，检查所有 scope，再按工具契约决定是否 `source remove '<source-id>'` | remove 会移除干净的 managed vendor submodule 与 catalog policy；不是禁用，不可用于独立 checkout 或有改动的源 |

上表子命令前仍需完整的 `skills-switch --resources "$RESOURCE_ROOT" --project "$CONSUMER_PROJECT"` 前缀。若曾启用 global scope，单独检查该 scope，不能只清理 project 后声称全局卸载。手动链接不会自动清理；外部管理器的 source update、projection reconciliation 与 source removal 也应分别核验。Disposable source-link 验证不代表管理器在真实用户安装上的执行证据。

下一步阅读 [protected configuration](configuration.md)、[能力组指南](README.md) 与[仓库验证](../../README.md#validation)。
