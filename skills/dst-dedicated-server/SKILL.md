---
name: dst-dedicated-server
description: Operate and troubleshoot a configured Don't Starve Together dedicated server.
---

# DST dedicated server

Use this Skill for a configured server whose SSH alias, user and local client directory are supplied by environment or command arguments. The workflow is snapshot, diagnosis, minimal change and verification. The public Skill contains no deployment inventory.

## Configuration

- `DST_HOST` is the SSH host or alias.
- `DST_USER` is the remote operator account.
- `DST_LOCAL_DIR` is the optional local client data directory.
- `DST_CLUSTER` selects the cluster on the remote host.
- The local CLI uses the Bun installed on the host and requires local Perl and `ps` runtimes for POSIX process supervision; the supervisor fails closed with `supervisor_requires_perl` or `supervisor_requires_ps` when either is unavailable. Remote collection keeps its native Shell boundary and does not require Bun on the game server.
- The remote collection scripts are executed with Bash on the inspected host and require a standard Perl runtime for nonblocking, no-follow file reads; if either prerequisite is unavailable they fail closed instead of opening an unbounded remote stream.

Set these values outside tracked files or pass them to the scripts. Missing host configuration fails closed; do not guess an address or path.

## Safety

Treat cluster tokens, server tokens, passwords and provider credentials as secrets. Prefer read-only investigation. Ask before restarting services, updating the server, rolling back saves or changing mods. Never choose a different host or hardware target because it happens to respond.

## Workflow

1. Run `bun scripts/dst_snapshot.ts --host "$DST_HOST" --user "$DST_USER" --local-dir "$DST_LOCAL_DIR"`.
2. Classify the failure as master, caves, shared configuration, binary/runtime or mod related.
3. Read the remote runbook and log paths discovered by the snapshot; redact before sharing.
4. Make one minimal authorized change and verify that the affected shard stays ready for several minutes.

`bun scripts/dst_mods_from_modoverrides.ts` reads only shard `modoverrides.lua` through the remote Shell collector and prints Workshop IDs plus enabled state; it does not read cluster secrets or execute Lua.

## References

- `references/environment.md`: required external configuration and secret boundary.
- `references/dst-paths.md`: layout checklist with placeholders.
- `scripts/dst_snapshot.ts`: local options, filesystem reads, bounded report composition, and remote SSH orchestration.
- `scripts/dst_snapshot_remote.sh`: native commands executed on the remote host for the redacted baseline.
- `scripts/dst_mods_from_modoverrides.ts`: local safe parser, summaries, and shard comparison.
- `scripts/dst_mods_remote_collect.sh`: remote bounded projection of Workshop IDs and top-level enabled state; it never emits configuration values or arbitrary source text.
