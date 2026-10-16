# Agent Toolkit

Agent Toolkit is a public collection of reusable Skills, focused command-line helpers, and narrowly scoped operational contracts for coding and automation agents. The repository is the single source for the standalone Skills listed in `PUBLIC_SKILLS.txt`; consumers load those Skill directories directly from a checkout or symlink and do not need a generated copy or runtime adapter.

## Install

Clone this repository, then point a standalone consumer's Skill root at its `skills/` directory. A direct symlink is sufficient when the consumer has no private Skills:

```bash
git clone https://github.com/IvanLi-CN/agent-toolkit.git /path/to/agent-toolkit
ln -sfn /path/to/agent-toolkit/skills /path/to/consumer/skills
```

The consumer owns the final root path. Agent Toolkit does not require Codex, a Codex runtime home, or a particular host layout. Skills that integrate with an external service document the required CLI, environment variables, and configuration explicitly. A consumer that also has private Skills may link the allowlisted public directories individually beside its private source; that is a direct source link, not a generated adapter.

## Repository layout

```text
skills/                 reusable Skills, scripts, references, assets, and tests
docs/specs/agent-vm/    public lifecycle and CLI contracts for Agent VM
docs/adr/               public architecture decisions supporting Agent VM
bin/                    repository-local index and safety checks
.github/workflows/      repository checks
```

`PUBLIC_SKILLS.txt` is the public boundary and `skills/README.md` is the discoverability index; both must contain the same public Skill set exactly once. Installed third-party Skill roots are external dependencies, not content maintained here.

## Validation

Run the checks from the repository root with the installed Bun runtime:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run check
bun run test:repo
bun run test:skills
```

The test runner discovers maintained TypeScript, Python, and Shell test files automatically. It rejects empty or non-declarative test files before execution; Shell tests must execute at least one `test` builtin, which the runner counts and reports as `TESTS_RUN=<count>`. Skill tests that exercise the XP policy require Ruby with its standard YAML library; Python-facing tests use the dependencies declared by the repository.

During a source migration, compare the public allowlist with the source snapshot and verify that private consumer Skills remain in the private source tree:

```bash
bun run bin/source_target_inventory_check.ts \
  --source-root /path/to/dot-codex \
  --source-revision <migration-source-revision>
```

The Agent VM client has an explicit generic session interface. Use `--session-id` for a one-off override or set `AGENT_VM_SESSION_ID` for a session. The public client never requires a Codex thread identifier.

## Contributions

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing a Skill. Keep one source of truth, use repository-relative paths, add focused tests for behavior changes, and keep environment-specific values in ignored local configuration.

## License

Agent Toolkit is released under the [MIT License](LICENSE).
