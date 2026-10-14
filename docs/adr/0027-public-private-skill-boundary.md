# Public and Private Skill Boundary

## Context

The first migration treated every repository-local Skill as public. That mixed reusable agent capabilities with Skills whose contract depends on Codex Plan Mode, native task Worktrees, `$CODEX_HOME`, owner-facing chat evidence, or this user's private service layout. Those Skills cannot be honestly presented as standalone public capabilities.

## Decision

`agent-toolkit` owns only the Skills listed in [`PUBLIC_SKILLS.txt`](../../PUBLIC_SKILLS.txt). A listed Skill must be usable from a standalone checkout and must keep consumer-specific values in explicit configuration. The repository checks this boundary in CI.

Codex workflow and runtime integration Skills remain in the existing private consumer configuration. They are not copied into `agent-toolkit`, are not part of the public index, and are not exposed through a compatibility adapter. This is one public repository plus the existing private configuration source, not a second public repository.

## Consumer integration

A consumer that needs only public Skills can mount the whole `agent-toolkit/skills` directory. A consumer that also has private Skills links each allowlisted public Skill directory directly beside its private directories. Both arrangements point at the original source tree; no generated copies or resident synchronization process is used.

## Consequences

- Public changes are reviewed against standalone-agent compatibility.
- Codex-specific workflow changes remain local to the Codex configuration and do not create a public compatibility promise.
- The migration inventory compares the public allowlist with the target and separately verifies that private Skills remain in the private consumer source.
