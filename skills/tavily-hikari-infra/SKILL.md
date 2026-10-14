---
name: tavily-hikari-infra
description: Inspect a configured Tavily Hikari primary/standby deployment through read-only checks.
---

# Tavily Hikari infrastructure

This Skill contains a configuration-driven read-only inventory and HA runbook. It deliberately stores no host inventory, resolved address, private domain, credential or owner-only deployment record.

## Configuration

- `TAVILY_PRIMARY_ALIAS` and `TAVILY_STANDBY_ALIAS` select SSH aliases.
- `TAVILY_PRIMARY_COMPOSE` selects the primary Compose file when applicable.
- `TAVILY_STANDBY_SERVICE` selects the standby service unit.
- `TAVILY_STANDBY_URL` is an optional public health origin configured out of band.
- `TAVILY_CONFIG_DIR` or `TAVILY_HOSTS_FILE` selects the protected local inventory; it defaults to `${XDG_CONFIG_HOME:-$HOME/.config}/tavily-hikari-infra/hosts.txt`.

Copy `references/hosts.txt.example` into that protected directory when setting up a deployment. Keep any local inventory based on `references/inventory.md.example` outside the checkout. The helper never reads inventory from the checkout. Connection details belong in the operator's SSH configuration. Missing or ambiguous values fail closed.

## Guardrails

Use only read-only inventory, status and log commands. Any future mutating action must require an explicit `--yes` and a separate authorization. Keep tokens and release credentials outside the repository. Redact resolved hostnames, addresses and response bodies before sharing.

## Commands

```sh
scripts/tavily-hikari-infra inventory
scripts/tavily-hikari-infra status <primary|standby>
scripts/tavily-hikari-infra logs <primary|standby> --tail 200
```

See [the generic runbook](references/runbook.md) and [the standby environment template](references/standby.env.template).
