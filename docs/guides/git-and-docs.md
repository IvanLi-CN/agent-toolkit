# Git 与文档

[返回指南](README.md) · [安装与更新](installation.md)

## git-remote-troubleshoot

**何时使用：**Git clone/fetch/push 出现远端、认证或网络错误，先收集证据再提议最小修复。[Skill source](../../skills/git-remote-troubleshoot/SKILL.md)定义 SSH/HTTPS 分类和完整排查路径。

**平台与前置条件：**Linux/macOS 已安装 Git，以及既有传输的 SSH 或 HTTPS 工具；文本 Skill 不需要 Bun/Python。

**配置：**使用仓库既有 remotes 与 operator 的 SSH/credential 配置，不新增工具私有变量。需要确切失败命令与错误；共享输出前脱敏 URL userinfo、地址与 verbose logs。

**最小例子：**在待诊断仓库运行，只读取本地事实：

```bash
git remote -v
git status -sb
```

**输出：**目标/协议与工作区信息、错误分类及证据支持的修复建议。联网验证使用 canonical 中的只读 connectivity 命令，凭据挑战由主人完成。

**读写边界：**诊断不更改 remote URL/协议、push URL、upstream、代理或认证设置，不以另一 URL push 绕过错误。任何配置修改或真实 push 都需要对应主人授权；read-only `ls-remote` 成功也不代表已 push。维护者的 Bun source-link smoke 不是 live authentication 验证。

## git-sync

**何时使用：**检查与已确认基线的 ahead/behind，或在明确授权下 fetch、fast-forward、rebase、对齐 detached HEAD。[Skill source](../../skills/git-sync/SKILL.md)定义 action 优先级与恢复约束；它没有 production CLI。

**平台与前置条件：**Linux/macOS、Git、已有 remote；不要求 Bun/Python。Bun 只用于维护者的隔离 Git contract tests。

**配置：**显式选择 `ACTION=check`、`BASE_REF=<confirmed-ref>`、`REMOTE=<configured-remote>`，这些是工作流输入，不是可执行程序或自动读取的 env 配置。不要省略 ACTION 让检查请求变成 canonical 默认 rebase 路径。

**最小例子：**离线对已固定的本地 commit/ref 比较：

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
git rev-list --left-right --count 'HEAD...<confirmed-local-ref>'
```

**输出：**left 为 HEAD-only、right 为 base-only 的提交数及 branch/detached identity。若基线为 remote-tracking ref，canonical 要求先 fetch 再比较；fetch 更新 refs 且需要网络，旧本地 ref 只能表示缓存状态。

**读写边界：**check 不对齐源码；fetch 改 remote-tracking refs；rebase/ff/align 改本地 Git 状态，分别需要所选 action 的授权与前提。Rebase 保留可恢复 backup，detached alignment 必须已证明旧 HEAD 可恢复；保留用户未提交内容。此 Skill 不创建/合并 PR、不清理 worktree、不修改 remote/upstream，不隐式 push。

## docs-no-revision-markers

**何时使用：**创建或整理应长期维护的公共说明，避免文档级修订标记。[Skill source](../../skills/docs-no-revision-markers/SKILL.md)规定稳定路径、正文及允许的 subject-matter 例外。

**平台与前置条件：**任何文本编辑环境，不需要 runtime、外部账户或 native tools。

**配置：**无必需环境变量；确认目标文件、主题语义和项目文档约定。

**最小例子：**请求 agent：「按 docs-no-revision-markers 在 `docs/guides/setup.md` 编写安装说明，使用主题标题并自然换行。」这里的路径是使用者项目中的建议产物名，不是本仓库现有页面入口。

**输出：**语义路径与主题标题，正文不包含 Draft/WIP、文档编号式修订后缀、修订历史或更新时间元数据。实际 API/product 标识若属于主题内容仍可保留；历史由 Git 管理。

**读写边界：**只编辑授权文档，不自动重命名其它文件或修复全仓内容；若改路径，更新受影响链接。文本审阅不等于应用、CLI 或部署验证。
