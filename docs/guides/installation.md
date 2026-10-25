# 安装与更新

所有消费者都可使用 HTTPS checkout 或原生 source directory 配置；只需消费者能发现 `SKILL.md`。普通消费不依赖本仓库的 Bun 开发依赖，也不要求特定 agent 产品。先查看 [13 个公共 Skills](../../PUBLIC_SKILLS.txt) 及[运行前置条件](../../README.md#五个能力组)，按需启用。

## HTTPS checkout

```bash
git clone https://github.com/IvanLi-CN/agent-toolkit.git /path/to/agent-toolkit
```

保留完整 Skill 目录，脚本可能引用 sibling modules、references 或 assets。不要只复制 `SKILL.md`。如果消费者支持配置 source root，直接指定 checkout 的 `skills/`，但先核对它是否会与已有私有/第三方 Skill 同名。

## Direct source links

下面使用 Bash-compatible shell 与目录 symlink，适合 Linux/macOS。消费者决定自己的 root；其他平台可配置原生 source directory 或等价的目录链接能力，不必生成复制树。直接链接流程在 consumer root 下维护一个隐藏的 metadata ledger；它只记录 ownership，不包含 Skill 文件，也不是 consumer Skill tree。

启用流程创建 `"$CONSUMER_SKILLS/.agent-toolkit-links/<skill>.record"`。记录必须完整匹配下面的七行格式：

```text
format=agent-toolkit-link-ownership/2
skill=<skill-name>
source_target=<absolute-source-target-used-by-the-link>
source_identity=<canonical-source-directory-at-enable-time>
source_file_id=<source-device-number>:<source-inode-number>
link_file_id=<symlink-device-number>:<symlink-inode-number>
target=<absolute-consumer-target>
```

`source_target` 是 symlink 的精确 target 字符串，`source_identity` 是启用时对 source directory 执行 `cd ... && pwd -P` 得到的 canonical path；`source_file_id` 是该目录的设备号/inode，`link_file_id` 是 link 自身而非其 referent 的设备号/inode；`target` 是 consumer 中 link 的精确路径。启用、禁用和清理必须一起核对这些 ownership 事实，同路径重建的 source 或同字符串替换的 link 都不能仅凭路径取得 ownership。旧版五行 record 不自动升级，须人工核对并重新启用。

enable、disable 和 upstream deletion reconciliation 共享 `"$CONSUMER_SKILLS/.agent-toolkit-links.lock"`。它们用原子 `mkdir` 获取这个 consumer-root lock，成功后立即在 lock 内创建唯一的 `.owner.*` token，并记录 lock 目录与 token 的 identity。只有 token 路径、token 内容、目录 identity、token identity 和预期目录内容仍与本次实例一致时，cleanup/release 才会先删除自己的 token，再尝试 `rmdir`；token 缺失、路径或目录被替换、目录含有未知内容或 `rmdir` 失败都会保留 lock 并报告。已有 lock 路径（包括目录、文件或 symlink）都视为 busy/foreign：停止并报告，不删除未知状态或外部管理器状态。

在你批准使用的消费者目录内启用一个 allowlisted Skill。示例先在 ledger 私有临时目录创建 symlink、记录其 identity，再安装 ownership record，最后用 `ln -P` 将同一个 symlink inode 链接到消费者；record 也通过同目录 hard link 安装以避免覆盖。若 record 写入或 link 安装失败，退出清理会移除临时状态，不留下没有 ownership record 的新 link：

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
link_tmp=''
lock_held=0
lock_token=''
lock_owner=''
lock_dir_identity=''
lock_token_identity=''
lock_release_started=0
lock_token_removed=0

die() { printf 'Not changed: %s\n' "$*" >&2; exit 1; }
case "$TOOLKIT_SOURCE" in /*) ;; *) die 'TOOLKIT_SOURCE must be an absolute path' ;; esac
case "$CONSUMER_SKILLS" in /*) ;; *) die 'CONSUMER_SKILLS must be an absolute path' ;; esac
case "$SKILL_NAME" in ''|*[!a-z0-9-]*) die 'SKILL_NAME is not a safe Skill name' ;; esac
[ -d "$CONSUMER_SKILLS" ] || die 'consumer Skill root is missing'
path_identity() {
  case "$(uname -s)" in
    Darwin) stat -f '%d:%i' "$1" ;;
    Linux) stat -c '%d:%i' "$1" ;;
    *) return 1 ;;
  esac
}
preserve_lock() {
  printf 'Consumer-root lock ownership could not be proven; leaving it untouched: %s\n' "$*" >&2
  lock_held=0
  return 1
}
release_empty_lock_dir() {
  if [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
    preserve_lock 'lock path changed or is not a regular directory'
    return 1
  fi
  current_lock_identity="$(path_identity "$LOCK_DIR" 2>/dev/null || true)"
  if [ -z "$current_lock_identity" ] || [ "$current_lock_identity" != "$lock_dir_identity" ]; then
    preserve_lock 'lock directory identity changed'
    return 1
  fi
  lock_entry_count=0
  lock_entry=''
  for candidate in "$LOCK_DIR"/.[!.]* "$LOCK_DIR"/..?* "$LOCK_DIR"/*; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      lock_entry_count=$((lock_entry_count + 1))
      lock_entry="$candidate"
    fi
  done
  if [ "$lock_entry_count" -ne 0 ]; then
    preserve_lock 'lock directory is not empty after token removal'
    return 1
  fi
  if ! rmdir "$LOCK_DIR" 2>/dev/null; then
    preserve_lock 'lock directory could not be removed'
    return 1
  fi
  lock_held=0
}
release_lock() {
  [ "$lock_held" -eq 1 ] || return 0
  if [ "$lock_release_started" -eq 1 ]; then
    if [ "$lock_token_removed" -ne 1 ]; then
      preserve_lock 'lock release was interrupted before token removal'
      return 1
    fi
    release_empty_lock_dir
    return $?
  fi
  lock_release_started=1
  if [ -z "$lock_token" ]; then preserve_lock 'ownership token is missing'; return 1; fi
  if [ -z "$lock_owner" ]; then preserve_lock 'ownership token identity is missing'; return 1; fi
  if [ -z "$lock_dir_identity" ]; then preserve_lock 'lock directory identity is missing'; return 1; fi
  if [ -z "$lock_token_identity" ]; then preserve_lock 'lock token identity is missing'; return 1; fi
  if [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
    preserve_lock 'lock path changed or is not a regular directory'
    return 1
  fi
  current_lock_identity="$(path_identity "$LOCK_DIR" 2>/dev/null || true)"
  if [ -z "$current_lock_identity" ] || [ "$current_lock_identity" != "$lock_dir_identity" ]; then
    preserve_lock 'lock directory identity changed'
    return 1
  fi
  case "$lock_token" in
    "$LOCK_DIR"/.owner.*) ;;
    *) preserve_lock 'lock token path changed'; return 1 ;;
  esac
  if [ ! -f "$lock_token" ] || [ -L "$lock_token" ]; then
    preserve_lock 'ownership token is missing or foreign'
    return 1
  fi
  current_token_identity="$(path_identity "$lock_token" 2>/dev/null || true)"
  if [ -z "$current_token_identity" ] || [ "$current_token_identity" != "$lock_token_identity" ]; then
    preserve_lock 'lock token identity changed'
    return 1
  fi
  token_contents="$(cat "$lock_token" 2>/dev/null || true)"
  if [ "$token_contents" != "$lock_owner" ]; then
    preserve_lock 'ownership token content changed'
    return 1
  fi
  lock_entry_count=0
  lock_entry=''
  for candidate in "$LOCK_DIR"/.[!.]* "$LOCK_DIR"/..?* "$LOCK_DIR"/*; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      lock_entry_count=$((lock_entry_count + 1))
      lock_entry="$candidate"
    fi
  done
  if [ "$lock_entry_count" -ne 1 ] || [ "$lock_entry" != "$lock_token" ]; then
    preserve_lock 'lock directory contains unexpected state'
    return 1
  fi
  if ! unlink "$lock_token"; then
    preserve_lock 'ownership token could not be removed'
    return 1
  fi
  lock_token_removed=1
  lock_token=''
  release_empty_lock_dir
}
acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die 'consumer-root lock is already held or unavailable; no state was changed'
  fi
  lock_held=1
  lock_dir_identity="$(path_identity "$LOCK_DIR" 2>/dev/null || true)"
  [ -n "$lock_dir_identity" ] || die 'could not record lock directory identity; lock retained for review'
  lock_token="$(mktemp "$LOCK_DIR/.owner.XXXXXX")" || die 'could not create lock ownership token; lock retained for review'
  lock_owner="pid=$$ token=$lock_token"
  if ! printf '%s\n' "$lock_owner" > "$lock_token"; then
    die 'could not write lock ownership token; lock retained for review'
  fi
  chmod 600 "$lock_token" || die 'could not protect lock ownership token; lock retained for review'
  lock_token_identity="$(path_identity "$lock_token" 2>/dev/null || true)"
  [ -n "$lock_token_identity" ] || die 'could not record lock token identity; lock retained for review'
}
cleanup() {
  if [ -n "$link_tmp" ]; then
    unlink "$link_tmp/$SKILL_NAME" 2>/dev/null || true
    rmdir "$link_tmp" 2>/dev/null || true
  fi
  if [ -n "$marker_tmp" ]; then rm -f "$marker_tmp" 2>/dev/null || true; fi
  if [ "$ledger_created" -eq 1 ]; then rmdir "$LEDGER_DIR" 2>/dev/null || true; fi
  if [ "$lock_held" -eq 1 ]; then
    release_lock || true
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
acquire_lock
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
if [ -e "$LEDGER_DIR/.$SKILL_NAME.disable" ] || [ -L "$LEDGER_DIR/.$SKILL_NAME.disable" ]; then
  die 'Pending disable: rerun disable to recover before enabling.'
fi

SOURCE_IDENTITY="$(cd "$SOURCE_TARGET" && pwd -P)" || die 'could not resolve source identity'
SOURCE_FILE_ID="$(cd "$SOURCE_TARGET" && path_identity .)" || die 'could not identify source directory'
link_tmp="$(mktemp -d "$LEDGER_DIR/.$SKILL_NAME.enable.XXXXXX")" || die 'could not create private link staging directory'
ln -s "$SOURCE_TARGET" "$link_tmp/$SKILL_NAME" || die 'could not stage source link'
LINK_FILE_ID="$(path_identity "$link_tmp/$SKILL_NAME")" || die 'could not identify staged link'
marker_tmp="$(mktemp "$LEDGER_DIR/.$SKILL_NAME.record.XXXXXX")" || die 'could not create a temporary ownership record'
chmod 600 "$marker_tmp" || die 'could not protect the temporary ownership record'
if ! printf '%s\n' \
  'format=agent-toolkit-link-ownership/2' \
  "skill=$SKILL_NAME" \
  "source_target=$SOURCE_TARGET" \
  "source_identity=$SOURCE_IDENTITY" \
  "source_file_id=$SOURCE_FILE_ID" \
  "link_file_id=$LINK_FILE_ID" \
  "target=$TARGET" > "$marker_tmp"; then
  die 'ownership record write failed; no link was created'
fi
if ! ln "$marker_tmp" "$RECORD"; then
  die 'ownership record collision; no link was created'
fi
if ! ln -P "$link_tmp/$SKILL_NAME" "$CONSUMER_SKILLS/"; then
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
unlink "$link_tmp/$SKILL_NAME" || die 'could not remove staged link alias; owned consumer link and record retained'
rmdir "$link_tmp" || die 'could not remove link staging directory'
link_tmp=''
if ! release_lock; then
  die 'consumer-root lock could not be released safely; leaving it untouched for review'
fi
trap - EXIT HUP INT TERM
printf 'Enabled %s with ownership record %s\n' "$SKILL_NAME" "$RECORD"
```

将 `TOOLKIT_SOURCE` 设为稳定的绝对 checkout 路径；若路径本身含链接，record 会保存 canonical path 与实际目录的文件身份。对每个选定 Skill 重复此流程，不链接 allowlist 外内容。启用后检查 link 的 `readlink`、record 的七行内容和 `SKILL.md` 可读性。不要以强制链接、复制或 adopt 覆盖已有条目。空消费者也可把整个 `skills/` 作为直接 source root，但逐目录链接更便于保留私有 Skills 和处理 membership 变化。

## Update and reconciliation

先检查源码 checkout 的工作区和已确认的跟踪分支；保留本地修改，不自动 stash、reset 或更换 remote：

```bash
git -C /path/to/agent-toolkit status --short --branch
git -C /path/to/agent-toolkit pull --ff-only
```

`pull` 更新源码与 remote-tracking refs，需要网络；不能快进时停止并处理差异。直接链接立即看到更新，不需复制或重新安装。更新后重读 allowlist、所用 Skill 的 prerequisites/contracts，并检查 source link identity 与 ownership record 是否仍相互匹配。不要在 lock 已存在时绕过它，也不要删除未知或外部管理器状态。

上游删除或移出 allowlist 的 Skill 不会被手工链接流程自动清理。逐项比较原来启用列表与当前 allowlist，对已确认项运行下面的 disable 流程；reconciliation 使用相同的 lock、record 校验、私有暂存和恢复路径，不另写 pathname unlink。source 存在时，canonical path 与设备号/inode 必须都匹配；同路径重建也拒绝清理。source 已不存在时，record 中的 source identity 只作为历史事实，仍须匹配 link 自身的设备号/inode 和精确 `readlink`。record 缺失、foreign、malformed，ledger 路径异常或 link 已替换时，停止并报告，不能从 symlink target 单独推断 ownership。

## Disable and uninstall

禁用一个 Skill 先验证 record、source 与 link identity，再将 record 原子移入同一 ledger 下 mode 0700 的 `.<skill>.disable` 暂存目录，将 consumer entry rename 到其中并重新核对 inode 与 `readlink`。只在该私有目录内 unlink 已捕获的 link，最后移除暂存 record。中断后重跑同一 disable 即可继续；暂存状态存在时 enable 拒绝启用。校验失败不删除任何 link；rename 后发现替换则保留被捕获的 entry 与 record 供人工复核：

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
PENDING="$LEDGER_DIR/.$SKILL_NAME.disable"
lock_held=0
lock_token=''
lock_owner=''
lock_dir_identity=''
lock_token_identity=''
lock_release_started=0
lock_token_removed=0

report() { printf 'Not completing disable of %s: %s; preserving remaining entry/record or pending state for recovery.\n' "$SKILL_NAME" "$*" >&2; exit 1; }
path_identity() {
  case "$(uname -s)" in
    Darwin) stat -f '%d:%i' "$1" ;;
    Linux) stat -c '%d:%i' "$1" ;;
    *) return 1 ;;
  esac
}
preserve_lock() {
  printf 'Consumer-root lock ownership could not be proven; leaving it untouched: %s\n' "$*" >&2
  lock_held=0
  return 1
}
release_empty_lock_dir() {
  if [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
    preserve_lock 'lock path changed or is not a regular directory'
    return 1
  fi
  current_lock_identity="$(path_identity "$LOCK_DIR" 2>/dev/null || true)"
  if [ -z "$current_lock_identity" ] || [ "$current_lock_identity" != "$lock_dir_identity" ]; then
    preserve_lock 'lock directory identity changed'
    return 1
  fi
  lock_entry_count=0
  lock_entry=''
  for candidate in "$LOCK_DIR"/.[!.]* "$LOCK_DIR"/..?* "$LOCK_DIR"/*; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      lock_entry_count=$((lock_entry_count + 1))
      lock_entry="$candidate"
    fi
  done
  if [ "$lock_entry_count" -ne 0 ]; then
    preserve_lock 'lock directory is not empty after token removal'
    return 1
  fi
  if ! rmdir "$LOCK_DIR" 2>/dev/null; then
    preserve_lock 'lock directory could not be removed'
    return 1
  fi
  lock_held=0
}
release_lock() {
  [ "$lock_held" -eq 1 ] || return 0
  if [ "$lock_release_started" -eq 1 ]; then
    if [ "$lock_token_removed" -ne 1 ]; then
      preserve_lock 'lock release was interrupted before token removal'
      return 1
    fi
    release_empty_lock_dir
    return $?
  fi
  lock_release_started=1
  if [ -z "$lock_token" ]; then preserve_lock 'ownership token is missing'; return 1; fi
  if [ -z "$lock_owner" ]; then preserve_lock 'ownership token identity is missing'; return 1; fi
  if [ -z "$lock_dir_identity" ]; then preserve_lock 'lock directory identity is missing'; return 1; fi
  if [ -z "$lock_token_identity" ]; then preserve_lock 'lock token identity is missing'; return 1; fi
  if [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
    preserve_lock 'lock path changed or is not a regular directory'
    return 1
  fi
  current_lock_identity="$(path_identity "$LOCK_DIR" 2>/dev/null || true)"
  if [ -z "$current_lock_identity" ] || [ "$current_lock_identity" != "$lock_dir_identity" ]; then
    preserve_lock 'lock directory identity changed'
    return 1
  fi
  case "$lock_token" in
    "$LOCK_DIR"/.owner.*) ;;
    *) preserve_lock 'lock token path changed'; return 1 ;;
  esac
  if [ ! -f "$lock_token" ] || [ -L "$lock_token" ]; then
    preserve_lock 'ownership token is missing or foreign'
    return 1
  fi
  current_token_identity="$(path_identity "$lock_token" 2>/dev/null || true)"
  if [ -z "$current_token_identity" ] || [ "$current_token_identity" != "$lock_token_identity" ]; then
    preserve_lock 'lock token identity changed'
    return 1
  fi
  token_contents="$(cat "$lock_token" 2>/dev/null || true)"
  if [ "$token_contents" != "$lock_owner" ]; then
    preserve_lock 'ownership token content changed'
    return 1
  fi
  lock_entry_count=0
  lock_entry=''
  for candidate in "$LOCK_DIR"/.[!.]* "$LOCK_DIR"/..?* "$LOCK_DIR"/*; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      lock_entry_count=$((lock_entry_count + 1))
      lock_entry="$candidate"
    fi
  done
  if [ "$lock_entry_count" -ne 1 ] || [ "$lock_entry" != "$lock_token" ]; then
    preserve_lock 'lock directory contains unexpected state'
    return 1
  fi
  if ! unlink "$lock_token"; then
    preserve_lock 'ownership token could not be removed'
    return 1
  fi
  lock_token_removed=1
  lock_token=''
  release_empty_lock_dir
}
acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    report 'consumer-root lock is already held or unavailable; no state was changed'
  fi
  lock_held=1
  lock_dir_identity="$(path_identity "$LOCK_DIR" 2>/dev/null || true)"
  [ -n "$lock_dir_identity" ] || report 'could not record lock directory identity; lock retained for review'
  lock_token="$(mktemp "$LOCK_DIR/.owner.XXXXXX")" || report 'could not create lock ownership token; lock retained for review'
  lock_owner="pid=$$ token=$lock_token"
  if ! printf '%s\n' "$lock_owner" > "$lock_token"; then
    report 'could not write lock ownership token; lock retained for review'
  fi
  chmod 600 "$lock_token" || report 'could not protect lock ownership token; lock retained for review'
  lock_token_identity="$(path_identity "$lock_token" 2>/dev/null || true)"
  [ -n "$lock_token_identity" ] || report 'could not record lock token identity; lock retained for review'
}
cleanup_lock() {
  if [ "$lock_held" -eq 1 ]; then
    release_lock || true
  fi
}
stop_on_signal() {
  printf 'Interrupted by %s; no further link/record changes. Rerun disable to recover %s; inspect lock if retained.\n' "$1" "$PENDING" >&2
  exit "$2"
}
trap cleanup_lock EXIT
trap 'stop_on_signal HUP 129' HUP
trap 'stop_on_signal INT 130' INT
trap 'stop_on_signal TERM 143' TERM
[ -d "$CONSUMER_SKILLS" ] || report 'consumer Skill root is missing'
case "$TOOLKIT_SOURCE" in /*) ;; *) report 'TOOLKIT_SOURCE must be absolute' ;; esac
case "$CONSUMER_SKILLS" in /*) ;; *) report 'CONSUMER_SKILLS must be absolute' ;; esac
case "$SKILL_NAME" in ''|*[!a-z0-9-]*) report 'unsafe Skill name' ;; esac
acquire_lock
[ -d "$LEDGER_DIR" ] && [ ! -L "$LEDGER_DIR" ] || report 'ownership ledger is missing or foreign'
finish_disable() {
  rmdir "$LEDGER_DIR" 2>/dev/null || true
  release_lock || report 'consumer-root lock could not be released safely'
  trap - EXIT HUP INT TERM
  printf 'Disabled %s after ownership verification.\n' "$SKILL_NAME"
  exit 0
}
if [ -e "$PENDING" ] || [ -L "$PENDING" ]; then
  [ -d "$PENDING" ] && [ ! -L "$PENDING" ] || report 'pending path is foreign'
  # Only these two entries belong to this transaction; never sweep unknown state.
  for candidate in "$PENDING"/.[!.]* "$PENDING"/..?* "$PENDING"/*; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      case "$candidate" in "$PENDING/record"|"$PENDING/link") ;; *) report 'unknown pending contents' ;; esac
    fi
  done
  if [ ! -e "$PENDING/record" ] && [ ! -L "$PENDING/record" ]; then
    rmdir "$PENDING" || report 'pending record missing with captured entry still present'
    if [ ! -e "$RECORD" ] && [ ! -L "$RECORD" ]; then finish_disable; fi
  fi
fi
active_record="$RECORD"
if [ -e "$PENDING/record" ] || [ -L "$PENDING/record" ]; then
  [ ! -e "$RECORD" ] && [ ! -L "$RECORD" ] || report 'both active and pending records exist'
  active_record="$PENDING/record"
fi
[ -f "$active_record" ] && [ ! -L "$active_record" ] || report 'ownership record is missing or foreign'
record_file_id="$(path_identity "$active_record")" || report 'cannot identify ownership record'
format_seen=0; skill_seen=0; source_seen=0; identity_seen=0; target_seen=0
source_id_seen=0; link_id_seen=0; recorded_identity=''; source_file_id=''; link_file_id=''
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    format=agent-toolkit-link-ownership/2) [ "$format_seen" -eq 0 ] || report 'ownership record is malformed'; format_seen=1 ;;
    skill=*) [ "$skill_seen" -eq 0 ] || report 'ownership record is malformed'; [ "${line#skill=}" = "$SKILL_NAME" ] || report 'ownership record is foreign'; skill_seen=1 ;;
    source_target=*) [ "$source_seen" -eq 0 ] || report 'ownership record is malformed'; [ "${line#source_target=}" = "$SOURCE_TARGET" ] || report 'ownership record is foreign'; source_seen=1 ;;
    source_identity=*) [ "$identity_seen" -eq 0 ] || report 'ownership record is malformed'; recorded_identity="${line#source_identity=}"; case "$recorded_identity" in /*) ;; *) report 'ownership record is malformed' ;; esac; identity_seen=1 ;;
    source_file_id=*) [ "$source_id_seen" -eq 0 ] || report 'ownership record is malformed'; source_file_id="${line#source_file_id=}"; [[ "$source_file_id" =~ ^[0-9]+:[0-9]+$ ]] || report 'invalid source file identity'; source_id_seen=1 ;;
    link_file_id=*) [ "$link_id_seen" -eq 0 ] || report 'ownership record is malformed'; link_file_id="${line#link_file_id=}"; [[ "$link_file_id" =~ ^[0-9]+:[0-9]+$ ]] || report 'invalid link file identity'; link_id_seen=1 ;;
    target=*) [ "$target_seen" -eq 0 ] || report 'ownership record is malformed'; [ "${line#target=}" = "$TARGET" ] || report 'ownership record is foreign'; target_seen=1 ;;
    *) report 'ownership record is malformed' ;;
  esac
done < "$active_record"
[ "$format_seen$skill_seen$source_seen$identity_seen$source_id_seen$link_id_seen$target_seen" = 1111111 ] || report 'ownership record is incomplete'
verify_source() {
  if [ -e "$SOURCE_TARGET" ] || [ -L "$SOURCE_TARGET" ]; then
    [ -d "$SOURCE_TARGET" ] || report 'source target is no longer a directory'
    current_identity="$(cd "$SOURCE_TARGET" && pwd -P)" || report 'source identity cannot be resolved'
    current_file_id="$(cd "$SOURCE_TARGET" && path_identity .)" || report 'source file identity cannot be resolved'
    [ "$recorded_identity" = "$current_identity" ] && [ "$source_file_id" = "$current_file_id" ] || report 'source identity changed'
  fi
}
verify_link() {
  [ -L "$1" ] || report 'entry is not the owned symlink'
  [ "$(path_identity "$1")" = "$link_file_id" ] || report 'link file identity changed'
  [ "$(readlink "$1")" = "$SOURCE_TARGET" ] || report 'link target changed'
}
verify_source
if [ "$active_record" = "$RECORD" ]; then
  verify_link "$TARGET"
  (umask 077; mkdir "$PENDING") || report 'could not create private pending directory'
  mv "$RECORD" "$PENDING/record" || report 'could not stage ownership record'
fi
# Pin the private directory for all final removals, even if its pathname is renamed.
cd -P "$PENDING" || report 'could not enter pending directory'
[ -f ./record ] && [ ! -L ./record ] && [ "$(path_identity ./record)" = "$record_file_id" ] || report 'staged record identity changed'
if [ ! -e ./link ] && [ ! -L ./link ]; then
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    verify_link "$TARGET"
    # Same-filesystem rename captures the entry; it does not delete a replacement.
    mv "$TARGET" ./link || report 'could not capture consumer entry'
  fi
fi
if [ -e ./link ] || [ -L ./link ]; then
  verify_link ./link
  verify_source
  unlink ./link || report 'could not remove captured owned link; rerun disable'
fi
unlink ./record || report 'link removed; pending record retained; rerun disable'
cd -P "$LEDGER_DIR" || report 'could not return to ledger'
rmdir "$PENDING" || report 'pending cleanup incomplete; rerun disable'
finish_disable
```

当 source 目录已被上游删除时，`[ -e "$SOURCE_TARGET" ] || [ -L "$SOURCE_TARGET" ]` 为假，record 中的 canonical path 与文件身份作为历史事实保留，仍须验证 link identity。只有 source 缺失允许 dangling link；source 为失效 symlink、非目录或同路径的新目录均 fail closed。设备号/inode 标识文件对象在其生命周期内的身份，不是永久 UUID；文件系统可能在删除后复用 inode，纯 Bash/stat 无法证明历史上从未发生删除重建。

状态依次为「active record + consumer link」→「pending record + consumer link」→「pending record + captured link」→「pending record」→「空 pending directory」→「完成」。信号、rename/unlink 失败均保留当前阶段，不回滚覆盖 target；下一次 disable 在同一 lock 下继续，清理完成后可再次 enable。record 删除失败只留下可重入的 pending record，不会留下阻塞 enable 的陈旧 active record。若捕获后 identity 不匹配，保留 captured entry 和 pending record，报告人工检查；不要自动还原到已可能被外部占用的 target。SIGKILL/断电可能遗留 lock；须先人工确认原进程已结束、核对 token/目录与 pending 内容，再授权精确清理该 lock 后重跑，绝不自动破锁。

消费者、ledger 及其父目录必须由使用者控制，禁止不可信写入；pending 目录由 `umask 077` 创建。最终 unlink 使用已进入的私有目录内的 `./link`，公开 target 在最终核对后被替换时，rename 捕获的是替换对象，后续 inode 校验会拒绝删除；rename 后新放入 target 的对象也不会被最终 unlink 触及。共享 lock 仅协调遵循本流程的操作者。Bash/macOS/Linux 的 pathname 工具没有按预期 inode 条件执行 rename/unlink 的跨平台原子 API；外部替换可能被暂时移入 pending，需要人工处理。同一身份或高权限进程仍能修改私有目录、record、source 或父路径，跨文件系统替换还会破坏 rename 前提；本例不承诺抵御这些系统级并发，也不提供断电后的 fsync 持久性保证。发现异常即保留状态，不升级为强制删除。

卸载消费关系时，对你启用的每个条目逐一执行上面的 disable 与 pending recovery 流程，再移除消费者自己的 source-root 配置。若 lock、record、source 或 link identity 异常，停止、报告并保留剩余 entry、record/pending 与 checkout，等待人工核对；不要仅凭 target 删除，也不要触碰外部管理器状态。所有已验证的 link 清理后，只有空的 `.agent-toolkit-links` ledger 才可移除。不要删除整个消费者 root、checkout、私有目录或第三方条目。源码 checkout 若确需删除，应另行确认备份、本地修改和所有消费者引用；这不是禁用或清理孤儿链接的隐含动作。

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
