---
name: dst-dedicated-server
description: Operate and troubleshoot a configured Don't Starve Together dedicated server.
---

# DST dedicated server

Use this Skill for a configured server whose SSH alias, user and local client directory are supplied by environment or command arguments. The workflow is snapshot, diagnosis, minimal change and verification. The public Skill contains no deployment inventory.

## Prerequisites and smallest examples

Local entrypoints require installed Bun on Linux/macOS. Remote collection additionally requires OpenSSH locally, an already trusted host key and non-interactive key access, and POSIX `sh` plus standard native utilities on the server. No Bun or Lua interpreter is required remotely. Generation and tests do not install or update server software. The scripts work directly from a checkout or a directory symlink without package installation.

```bash
SKILL_DIR=/path/to/agent-toolkit/skills/dst-dedicated-server
bun "$SKILL_DIR/scripts/dst_snapshot.ts" --no-remote --local-dir ./client-data --out ./snapshot.md
bun "$SKILL_DIR/scripts/dst_mods_from_modoverrides.ts" --cluster-dir ./Cluster_1
```

The snapshot writes one Markdown report and prints its path; choose a fresh output path to preserve an earlier report. Mod summary prints Workshop IDs, state counts and Master/Caves differences to stdout and writes no files. [The helper contract](references/helper-contract.md) defines the supported Lua syntax, collection limits, partial failures, remote invocation and focused tests.

## Configuration

- `DST_HOST` is the SSH host or alias.
- `DST_USER` is the remote operator account.
- `DST_LOCAL_DIR` is the optional local client data directory.
- `DST_CLUSTER` selects the cluster on the remote host.

Set these values outside tracked files or pass them to the scripts. Missing host configuration fails closed; do not guess an address or path.

## Safety

Treat cluster tokens, server tokens, passwords and provider credentials as secrets. Prefer read-only investigation. Ask before restarting services, updating the server, rolling back saves or changing mods. Never choose a different host or hardware target because it happens to respond.

## Workflow

1. Run `bun scripts/dst_snapshot.ts --host "$DST_HOST" --user "$DST_USER" --local-dir "$DST_LOCAL_DIR"` from this Skill.
2. Classify the failure as master, caves, shared configuration, binary/runtime or mod related.
3. Read the remote runbook and log paths discovered by the snapshot; redact before sharing.
4. Make one minimal authorized change and verify that the affected shard stays ready for several minutes.

`bun scripts/dst_mods_from_modoverrides.ts --host "$DST_HOST" --user "$DST_USER" --cluster "$DST_CLUSTER"` reads only shard `modoverrides.lua` and prints Workshop IDs plus enabled state; it does not read cluster secrets or execute configuration. Remote Shell only collects native metadata or framed mod bytes; Bun owns interpretation and reports.

## References

- `references/environment.md`: required external configuration and secret boundary.
- `references/dst-paths.md`: layout checklist with placeholders.
- `scripts/dst_snapshot.ts`: bounded metadata baseline report.
- `scripts/dst_mods_from_modoverrides.ts`: safe mod summary.
- `scripts/dst_collect_remote.sh`: remote native collection, invoked over SSH by the Bun entrypoints.
