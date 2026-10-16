# Agent Toolkit

Agent Toolkit is a public collection of reusable Skills, focused command-line helpers, and narrowly scoped operational contracts for coding and automation agents. The repository is the single source for the standalone Skills listed in `PUBLIC_SKILLS.txt`; consumers load those Skill directories directly from a checkout or symlink and do not need a generated copy or runtime adapter.

## Install

Clone this repository, then point a standalone consumer's Skill root at its `skills/` directory. A direct symlink is sufficient when the consumer has no private Skills:

```bash
git clone https://github.com/IvanLi-CN/agent-toolkit.git /path/to/agent-toolkit
ln -sfn /path/to/agent-toolkit/skills /path/to/consumer/skills
```

The consumer owns the final root path. Agent Toolkit does not require Codex, a Codex runtime home, or a particular host layout. Skills that integrate with an external service document the required CLI, environment variables, and configuration explicitly. A consumer that also has private Skills may link the allowlisted public directories individually beside its private source; that is a direct source link, not a generated adapter.

### Optional skills-switch management

This repository does not ship a `skills-switch` manager, but an external manager may maintain direct links to the public Skill directories. `PUBLIC_SKILLS.txt` is the allowlist for enablement and reconciliation; the checkout remains the source of truth.

- Enable: create links only for selected allowlisted directories under the consumer root, and record enough ownership metadata to distinguish managed links from private or third-party content.
- Disable: remove only links owned by the manager after verifying that their resolved targets still point inside this checkout; never remove an unrelated directory or private Skill.
- Update: update the checkout, re-read the allowlist, and refresh managed links without replacing the consumer root or generating a second copy of the Skills.
- Upstream deletion reconciliation: remove managed links whose allowlisted source directory was deleted or is no longer public, while leaving unrelated consumer paths untouched.
- Uninstall: remove managed links and manager metadata only; leave the checkout and private source paths in place unless the consumer explicitly requests their removal.
- Collision handling: refuse an existing non-managed path or a managed link pointing elsewhere, report the collision, and never overwrite it implicitly.

## Repository layout

```text
skills/                 reusable Skills, scripts, references, assets, and tests
docs/specs/agent-vm/    public lifecycle and CLI contracts for Agent VM
docs/adr/               public architecture decisions supporting Agent VM
bin/                    repository-local index and safety checks
.github/workflows/      repository checks
```

`PUBLIC_SKILLS.txt` is the public boundary and `skills/README.md` is the discoverability index; both must contain the same public Skill set exactly once. `~/.agents/skills` and other installed third-party Skill roots are external dependencies, not content maintained here. Consumer-specific workflow and runtime integration Skills are outside this public source.

## Validation

Run the checks from the repository root with the installed Bun runtime:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run check
bun run test:repo
python3 -m pip install -r requirements-dev.txt
ruby -e 'require "yaml"'
bun run test:skills
```

The test runner discovers maintained TypeScript, Python, and Shell test files automatically, so a new Skill can add a focused test without editing a root test list. It rejects empty or non-declarative Bun/Python test files before execution; Shell tests must execute at least one `test` builtin, which the runner counts and reports as `TESTS_RUN=<count>`. Skill tests that exercise the XP policy require Ruby with its standard YAML library; Python-facing tests use `requirements-dev.txt`. The runner fails when a requested scope has no selected tests instead of reporting a false pass.

During a source migration, compare the public allowlist with the source snapshot and verify that private consumer Skills remain in the private source tree. The inventory check rejects duplicate or invalid public manifest names before comparing the source snapshot and target checkout:

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
