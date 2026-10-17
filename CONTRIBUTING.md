# Contributing

Keep each public Skill self-contained under `skills/<name>/` with its `SKILL.md`, scripts, references, assets, and focused tests. Add its name to `PUBLIC_SKILLS.txt` and update `skills/README.md` when adding or removing a Skill. A public Skill must run from a standalone checkout and must not require consumer-specific runtime variables, native task APIs, worktrees, or personal service inventory. Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run check`, `bun run test:repo`, and `bun run test:skills` before committing. Install `requirements-dev.txt` first when Skill tests need their declared Python dependencies. XP local policy and audit tests use the installed Bun runtime plus native transport tools where needed; remote observation remains POSIX Shell.

Public files must use placeholders, environment variables, or explicit configuration for machine-specific values. Do not commit credentials, private hostnames, personal filesystem paths, production inventories, generated runtime state, or copied files from another consumer installation.

Use English conventional commit messages with `--signoff`. Changes that alter a CLI, protocol, lifecycle rule, or configuration schema must update the corresponding contract and tests in the same change.
