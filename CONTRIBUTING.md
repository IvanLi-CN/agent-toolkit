# 贡献指南

先阅读 [README](README.md)、[使用指南](docs/guides/README.md)、[protected configuration](docs/guides/configuration.md) 和 [contracts 导航](docs/guides/README.md#contracts)。公共源码服务于不同 Skill consumers，不能依赖某一产品的 runtime home、原生 task API、个人 worktree 布局或私有 inventory。

## 源码与贡献边界

每个 public Skill 自包含于 `skills/<name>/`，包括 `SKILL.md`、scripts、references、assets 与行为测试。[PUBLIC_SKILLS.txt](PUBLIC_SKILLS.txt) 定义 membership，[skills/README.md](skills/README.md) 中每个本地 Skill 恰好出现一次。增删 Skill 必须同时维护 allowlist、catalog、[语言矩阵](docs/specs/project-foundation/SCRIPT-LANGUAGE-MATRIX.md)、[实现覆盖](docs/specs/project-foundation/IMPLEMENTATION.md)及指南入口；不把第三方或消费者私有 Skills 收入本仓库。

`bin/` 只放公共仓库检查；领域脚本留在所属 Skill。一个 executable responsibility 只有一个 active implementation，替换时移除旧入口。Python/C/远端 Shell 的保留边界以语言矩阵和 canonical source 为准；不要为统一外观添加 TS launcher 或第二套 API client。

变更 CLI、协议、lifecycle、持久状态或配置 schema 时，同步更新权威 contract、调用点和行为测试。指南只维护导航、前置条件、最小例子与安全边界，详细协议仍链接 [canonical contracts](docs/guides/README.md#contracts)，避免复制维护。文档正文以中文为主，代码、命令、路径、Skill 名称保留原样；使用稳定语义文件名，按完整句子自然换行，遵循 [docs-no-revision-markers](skills/docs-no-revision-markers/SKILL.md)。

公共内容使用仓库相对链接和中性占位符。禁止提交真实凭据、私有域名/地址、个人路径、生产 inventory、运行态、消费者副本或私有 task/runtime 集成。Protected configuration 保存在仓库外；`.gitignore` 本身不能保护已跟踪文件或阻止无意上传。公开报告前须脱敏路径、SSH 输出、日志、请求与响应。

## Validation

执行 [README 的完整验证命令](README.md#validation)，使用已安装 Bun，不额外选择固定 runtime。开发依赖通过 `bun install --frozen-lockfile` 安装；完整 Skill 测试还需要 [requirements-dev.txt](requirements-dev.txt)、Ruby 标准 YAML 库及测试要求的原生工具。领域运行另需匹配的应用环境或远端配置，不要为让 root checks 通过而安装或接触生产服务。

`bun run check` 包含 foundation/spec、索引与公共边界检查；`bun run test:repo` 与 `bun run test:skills` 的 discovery scope 不同。改动后至少运行受影响检查、对应行为测试与 `git diff --check`。链接核对包括文件/目录存在、相对路径与锚点；还需确认每个 allowlist Skill 有唯一明确的使用指南入口。记录实际 OS/runtime、通过/失败项及缺失依赖，不把 skipped 或未运行项目计为通过。

[CI](.github/workflows/ci.yml) 在 Linux/macOS 上执行维护命令，但配置存在不代表远端 required-check enforcement，更不等于部署或发布。区分 mock、隔离原生 OS、真实应用执行与生产观察；fixture 不得连接真实主机或收费 API。重型/full-suite、Docker/Compose、E2E 和镜像构建使用授权的隔离 Linux 环境，不在本机 Docker 或生产机器上运行。

## Maintenance

仅当维护任务明确需要比较某个源快照时，运行可选 source-target inventory 检查：

```bash
bun run bin/source_target_inventory_check.ts \
  --source-root /path/to/source \
  --source-revision '<confirmed-source-revision>'
```

这不是普通 checkout 的前置条件，也不复制 consumer tree。一次性迁移、控制环境恢复及历史操作不属于[新人路径](docs/guides/installation.md)；确需执行时另行核对契约、精确目标和主人授权。

## 提交与评审

使用英文 conventional commit，并附 `--signoff`；不要跳过 hooks。保留已有无关修改，不擅自 stash、覆盖或丢弃。PR 说明问题与行为、contract/doc 入口、验证结果及证据局限；文档和 fixture 完成不应写成站点或真实发布完成。远端配置、push、服务变更、权限变更和破坏性动作需要其对应明确授权。
