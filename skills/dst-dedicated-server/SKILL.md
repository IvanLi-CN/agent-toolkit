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

Set these values outside tracked files or pass them to the scripts. Missing host configuration fails closed; do not guess an address or path.

## Safety

Treat cluster tokens, server tokens, passwords and provider credentials as secrets. Prefer read-only investigation. Ask before restarting services, updating the server, rolling back saves or changing mods. Never choose a different host or hardware target because it happens to respond.

## Workflow

1. Run `scripts/dst_snapshot.sh --host "$DST_HOST" --user "$DST_USER" --local-dir "$DST_LOCAL_DIR"`.
2. Classify the failure as master, caves, shared configuration, binary/runtime or mod related.
3. Read the remote runbook and log paths discovered by the snapshot; redact before sharing.
4. Make one minimal authorized change and verify that the affected shard stays ready for several minutes.

`scripts/dst_mods_from_modoverrides.sh` reads only shard `modoverrides.lua` and prints Workshop IDs plus enabled state; it does not read cluster secrets.

## References

- `references/environment.md`: required external configuration and secret boundary.
- `references/dst-paths.md`: layout checklist with placeholders.
- `scripts/dst_snapshot.sh`: redacted baseline collection.
- `scripts/dst_mods_from_modoverrides.sh`: safe mod summary.
