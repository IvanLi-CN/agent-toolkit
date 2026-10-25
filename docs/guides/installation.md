# 安装与更新

所有消费者都可使用 HTTPS checkout 或原生 source directory 配置；只需消费者能发现 `SKILL.md`。普通消费不依赖本仓库的 Bun 开发依赖，也不要求特定 agent 产品。先查看 [13 个公共 Skills](../../PUBLIC_SKILLS.txt) 及[运行前置条件](../../README.md#五个能力组)，按需启用。

## HTTPS checkout

```bash
git clone https://github.com/IvanLi-CN/agent-toolkit.git /path/to/agent-toolkit
```

保留完整 Skill 目录，脚本可能引用 sibling modules、references 或 assets。不要只复制 `SKILL.md`。如果消费者支持配置 source root，直接指定 checkout 的 `skills/`，但先核对它是否会与已有私有/第三方 Skill 同名。

## Direct source links

下面使用 Bash-compatible shell 与目录 symlink，适合 Linux/macOS。消费者决定自己的 root；其他平台可配置原生 source directory 或等价的目录链接能力，不必生成复制树。直接链接流程在 consumer root 下维护一个隐藏的 metadata ledger；它只记录 ownership，不包含 Skill 文件，也不是 consumer Skill tree。

启用流程创建 `"$CONSUMER_SKILLS/.agent-toolkit-links/<skill>.record"`。记录必须完整匹配下面的五行格式：

```text
format=agent-toolkit-link-ownership/1
skill=<skill-name>
source_target=<absolute-source-target-used-by-the-link>
source_identity=<canonical-source-directory-at-enable-time>
target=<absolute-consumer-target>
```

`source_target` 是 symlink 的精确 target 字符串，`source_identity` 是启用时对 source directory 执行 `cd ... && pwd -P` 得到的 canonical identity；`target` 是 consumer 中 link 的精确路径。启用、禁用和清理都把 Skill 名称、source target、source identity、target 与 record 一起作为 ownership 事实。单独匹配 symlink target 不足以取得 ownership。

enable、disable 和 upstream deletion reconciliation 共享 `"$CONSUMER_SKILLS/.agent-toolkit-links.lock"`。它们用原子 `mkdir` 获取这个 consumer-root lock，并在锁内完成 ownership record、exact symlink target 与 source identity 的最终检查，以及 link/record 的创建或 unlink。已有 lock 路径（包括目录、文件或 symlink）都视为 busy/foreign：停止并报告，不删除未知状态或外部管理器状态。正常退出只用 `rmdir` 移除本次取得且仍为空的 lock；若 lock 已改变或不为空，则保留并报告。

在你批准使用的消费者目录内启用一个 allowlisted Skill。示例先写 ownership record，再创建 link；record 通过同目录 hard link 安装以避免覆盖已有 record。若 record 写入或 link 创建失败，退出清理会移除本次创建的临时状态，绝不会留下没有 ownership record 的新 link：

```bash
set -eu
TOOLKIT_SOURCE=/path/to/agent-toolkit
CONSUMER_SKILLS=/path/to/consumer/skills
SKILL_NAME=docs-no-revision-markers
SOURCE_TARGET="$TOOLKIT_SOURCE/skills/$SKILL_NAME"
TARGET="$CONSUMER_SKILLS/$SKILL_NAME"
LEDGER_DIR="$CONSUMER_SKILLS/.agent-toolkit-links"
RECORD="$LEDGER_DIR/$SKILL_NAME.record"
LOCK_DIR="$CONSUMER_SKILLS/.agent-toolkit-links.lock"
ledger_created=0
marker_tmp=''
lock_held=0

die() { printf 'Not changed: %s\n' "$*" >&2; exit 1; }
case "$TOOLKIT_SOURCE" in /*) ;; *) die 'TOOLKIT_SOURCE must be an absolute path' ;; esac
case "$CONSUMER_SKILLS" in /*) ;; *) die 'CONSUMER_SKILLS must be an absolute path' ;; esac
case "$SKILL_NAME" in ''|*[!a-z0-9-]*) die 'SKILL_NAME is not a safe Skill name' ;; esac
[ -d "$CONSUMER_SKILLS" ] || die 'consumer Skill root is missing'
cleanup() {
  if [ -n "$marker_tmp" ]; then rm -f "$marker_tmp" 2>/dev/null || true; fi
  if [ "$ledger_created" -eq 1 ]; then rmdir "$LEDGER_DIR" 2>/dev/null || true; fi
  if [ "$lock_held" -eq 1 ]; then
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
      printf 'Consumer-root lock changed or is not empty; leaving it untouched: %s\n' "$LOCK_DIR" >&2
    else
      lock_held=0
    fi
  fi
}
stop_on_signal() {
  printf 'Interrupted by %s; link outcome may be ambiguous. No further link/record changes will be attempted; inspect %s and %s.\n' "$1" "$TARGET" "$RECORD" >&2
  exit "$2"
}
trap cleanup EXIT
trap 'stop_on_signal HUP 129' HUP
trap 'stop_on_signal INT 130' INT
trap 'stop_on_signal TERM 143' TERM
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  die 'consumer-root lock is already held or unavailable; no state was changed'
fi
lock_held=1
[ -d "$SOURCE_TARGET" ] || die 'source Skill directory is missing'
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  die 'Collision: inspect the existing consumer entry; nothing was replaced.'
fi

if [ -e "$LEDGER_DIR" ] || [ -L "$LEDGER_DIR" ]; then
  [ -d "$LEDGER_DIR" ] && [ ! -L "$LEDGER_DIR" ] || die 'ownership ledger path is not a regular directory'
else
  mkdir "$LEDGER_DIR" || die 'could not create the ownership ledger'
  ledger_created=1
fi
if [ -e "$RECORD" ] || [ -L "$RECORD" ]; then
  die 'Collision: an ownership record already exists; nothing was replaced.'
fi

SOURCE_IDENTITY="$(cd "$SOURCE_TARGET" && pwd -P)" || die 'could not resolve source identity'
marker_tmp="$(mktemp "$LEDGER_DIR/.$SKILL_NAME.record.XXXXXX")" || die 'could not create a temporary ownership record'
chmod 600 "$marker_tmp" || die 'could not protect the temporary ownership record'
if ! printf '%s\n' \
  'format=agent-toolkit-link-ownership/1' \
  "skill=$SKILL_NAME" \
  "source_target=$SOURCE_TARGET" \
  "source_identity=$SOURCE_IDENTITY" \
  "target=$TARGET" > "$marker_tmp"; then
  die 'ownership record write failed; no link was created'
fi
if ! ln "$marker_tmp" "$RECORD"; then
  die 'ownership record collision; no link was created'
fi
if ! ln -s "$SOURCE_TARGET" "$TARGET"; then
  current_target=''
  if [ -L "$TARGET" ]; then current_target="$(readlink "$TARGET" 2>/dev/null || true)"; fi
  if [ "$current_target" = "$SOURCE_TARGET" ]; then
    die 'link creation outcome is ambiguous; ownership record was retained for review'
  fi
  if cmp -s "$marker_tmp" "$RECORD"; then rm -f "$RECORD"; fi
  die 'link creation failed; no untracked link was left'
fi
if ! rm -f "$marker_tmp"; then
  die 'temporary ownership record cleanup failed; the link remains paired with its record for review'
fi
marker_tmp=''
if ! rmdir "$LOCK_DIR" 2>/dev/null; then
  die 'consumer-root lock could not be released; leaving it untouched for review'
fi
lock_held=0
trap - EXIT HUP INT TERM
printf 'Enabled %s with ownership record %s\n' "$SKILL_NAME" "$RECORD"
```

将 `TOOLKIT_SOURCE` 设为稳定的绝对 checkout 路径；若路径本身含链接，record 会保存 `pwd -P` 得到的 source identity。对每个选定 Skill 重复此流程，不链接 allowlist 外内容。启用后检查 link 的 `readlink`、record 的五行内容和 `SKILL.md` 可读性。不要以强制链接、复制或 adopt 覆盖已有条目。空消费者也可把整个 `skills/` 作为直接 source root，但逐目录链接更便于保留私有 Skills 和处理 membership 变化。

## Update and reconciliation

先检查源码 checkout 的工作区和已确认的跟踪分支；保留本地修改，不自动 stash、reset 或更换 remote：

```bash
git -C /path/to/agent-toolkit status --short --branch
git -C /path/to/agent-toolkit pull --ff-only
```

`pull` 更新源码与 remote-tracking refs，需要网络；不能快进时停止并处理差异。直接链接立即看到更新，不需复制或重新安装。更新后重读 allowlist、所用 Skill 的 prerequisites/contracts，并检查 source link identity 与 ownership record 是否仍相互匹配。不要在 lock 已存在时绕过它，也不要删除未知或外部管理器状态。

上游删除或移出 allowlist 的 Skill 不会被手工链接流程自动清理。逐项比较原来启用列表与当前 allowlist，先用与 enable/disable 相同的 `LOCK_DIR` 原子 `mkdir` 获得 consumer-root lock；已有 lock 时停止并报告，不删除未知或外部管理器状态。持锁期间检查消费者中的链接、隐藏 ledger 和 record，包括 dangling symlink，并在 unlink 前再次完成 record 格式、Skill、source target、source identity、target 及当前 `readlink` 的最终核对。对已删除的 source，仍可使用 record 中保存的 `source_target`/`source_identity` 做人工 reconciliation；只有所有事实匹配时才可清理。record 缺失、foreign、malformed，ledger 路径异常，或 target 已被改指其它 source 时，报告并保留 entry 与 record，不能从 symlink target 单独推断 ownership。信号或失败发生在最终核对与 unlink 之间时，保留 record/entry 供人工复核；共享 lock 只协调遵循本流程的操作，不授权触碰外部管理器状态。

## Disable and uninstall

禁用一个 Skill 只 unlink 自己创建的直接链接；必须同时验证隐藏 record 和当前 link target。下面的检查把 malformed/foreign marker、source identity 变化、target 改指和 dangling target 都当作不安全，任何失败都报告并保持 entry 与 record 不变：

```bash
set -eu
TOOLKIT_SOURCE=/path/to/agent-toolkit
CONSUMER_SKILLS=/path/to/consumer/skills
SKILL_NAME=docs-no-revision-markers
SOURCE_TARGET="$TOOLKIT_SOURCE/skills/$SKILL_NAME"
TARGET="$CONSUMER_SKILLS/$SKILL_NAME"
LEDGER_DIR="$CONSUMER_SKILLS/.agent-toolkit-links"
RECORD="$LEDGER_DIR/$SKILL_NAME.record"
LOCK_DIR="$CONSUMER_SKILLS/.agent-toolkit-links.lock"
lock_held=0

report() { printf 'Not disabling %s: %s; leaving entry and record untouched.\n' "$SKILL_NAME" "$*" >&2; exit 1; }
cleanup_lock() {
  if [ "$lock_held" -eq 1 ]; then
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
      printf 'Consumer-root lock changed or is not empty; leaving it untouched: %s\n' "$LOCK_DIR" >&2
    else
      lock_held=0
    fi
  fi
}
stop_on_signal() {
  printf 'Interrupted by %s; no further unlink will be attempted. Inspect %s and %s.\n' "$1" "$TARGET" "$RECORD" >&2
  exit "$2"
}
trap cleanup_lock EXIT
trap 'stop_on_signal HUP 129' HUP
trap 'stop_on_signal INT 130' INT
trap 'stop_on_signal TERM 143' TERM
[ -d "$CONSUMER_SKILLS" ] || report 'consumer Skill root is missing'
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  report 'consumer-root lock is already held or unavailable; no state was changed'
fi
lock_held=1
[ -d "$LEDGER_DIR" ] && [ ! -L "$LEDGER_DIR" ] || report 'ownership ledger is missing or foreign'
[ -f "$RECORD" ] && [ ! -L "$RECORD" ] || report 'ownership record is missing or foreign'
[ -L "$TARGET" ] || report 'consumer entry is not the owned symlink'
current_target="$(readlink "$TARGET" 2>/dev/null || true)"
[ "$current_target" = "$SOURCE_TARGET" ] || report 'current link target changed'

format_seen=0; skill_seen=0; source_seen=0; identity_seen=0; target_seen=0; recorded_identity=''
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    format=agent-toolkit-link-ownership/1) [ "$format_seen" -eq 0 ] || report 'ownership record is malformed'; format_seen=1 ;;
    skill=*) [ "$skill_seen" -eq 0 ] || report 'ownership record is malformed'; [ "${line#skill=}" = "$SKILL_NAME" ] || report 'ownership record is foreign'; skill_seen=1 ;;
    source_target=*) [ "$source_seen" -eq 0 ] || report 'ownership record is malformed'; [ "${line#source_target=}" = "$SOURCE_TARGET" ] || report 'ownership record is foreign'; source_seen=1 ;;
    source_identity=*) [ "$identity_seen" -eq 0 ] || report 'ownership record is malformed'; recorded_identity="${line#source_identity=}"; case "$recorded_identity" in /*) ;; *) report 'ownership record is malformed' ;; esac; identity_seen=1 ;;
    target=*) [ "$target_seen" -eq 0 ] || report 'ownership record is malformed'; [ "${line#target=}" = "$TARGET" ] || report 'ownership record is foreign'; target_seen=1 ;;
    *) report 'ownership record is malformed' ;;
  esac
done < "$RECORD"
[ "$format_seen" -eq 1 ] && [ "$skill_seen" -eq 1 ] && [ "$source_seen" -eq 1 ] && [ "$identity_seen" -eq 1 ] && [ "$target_seen" -eq 1 ] || report 'ownership record is incomplete'
if [ -e "$SOURCE_TARGET" ] || [ -L "$SOURCE_TARGET" ]; then
  [ -d "$SOURCE_TARGET" ] || report 'source target is no longer a directory'
  current_identity="$(cd "$SOURCE_TARGET" && pwd -P)" || report 'source identity cannot be resolved'
  [ "$recorded_identity" = "$current_identity" ] || report 'source identity changed'
fi
[ -L "$TARGET" ] || report 'consumer entry changed during final verification'
current_target="$(readlink "$TARGET" 2>/dev/null || true)"
[ "$current_target" = "$SOURCE_TARGET" ] || report 'current link target changed during final verification'
unlink "$TARGET" || report 'could not remove the verified link'
if ! unlink "$RECORD"; then
  printf 'Disabled link but could not remove ownership record; manual cleanup required: %s\n' "$RECORD" >&2
  exit 1
fi
rmdir "$LEDGER_DIR" 2>/dev/null || true
if ! rmdir "$LOCK_DIR" 2>/dev/null; then
  report 'consumer-root lock could not be released; leaving it untouched for review'
fi
lock_held=0
trap - EXIT HUP INT TERM
printf 'Disabled %s after ownership verification.\n' "$SKILL_NAME"
```

当 source 目录已被上游删除时，`[ -e "$SOURCE_TARGET" ] || [ -L "$SOURCE_TARGET" ]` 为假，record 中的 canonical identity 仍作为历史 source identity；target 仍必须精确匹配 record。disable 的 lock、record、source identity 与 target 最终检查都完成后才 unlink；若 lock 已存在、信号中断或最终 target 已变为 foreign link，则停止并保留现状。只对已确认的 allowlisted 名称使用变量，不使用宽泛 glob。重新启用仍走 collision 检查，并且不能复用缺失、foreign 或 malformed record。

卸载消费关系时，对你启用的每个条目逐一取得相同 consumer-root lock，执行 marker+exact-target+source-identity 最终检查和 unlink，再移除消费者自己的 source-root 配置。若 lock 已存在，或 marker 缺失、foreign、malformed、source identity changed 或 target changed，停止、报告并保留该 entry、record 与 checkout，等待人工核对；不要仅凭 target 删除，也不要触碰外部管理器状态。所有已验证的 link 清理后，只有空的 `.agent-toolkit-links` ledger 才可移除。不要删除整个消费者 root、checkout、私有目录或第三方条目。源码 checkout 若确需删除，应另行确认备份、本地修改和所有消费者引用；这不是禁用或清理孤儿链接的隐含动作。

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
