---
name: xp-infra
description: Guide, validate and audit configured XP self-hosted nodes with read-only checks and an explicit deployment policy.
---

# XP infrastructure

Use this Skill for XP node initialization, deployment, cluster joins, upgrades and drift diagnosis. Deployment-specific aliases, addresses, domains, credentials and exception records stay outside this public repository.

## Entrypoints and prerequisites

Run [scripts/xp-infra](scripts/xp-infra) directly with the Bun installed on the operator machine. Local policy, normalization, port selection and audit decisions run in TypeScript/Bun; local commands require neither Ruby nor Python. Native `ssh` provides transport and `curl` provides operator-side HTTPS probes. The inspected Linux node needs no Bun installation: retained POSIX probes use native privilege/service tools, `/proc`, `awk`, GNU-compatible `dd` with `iflag=fullblock`, and `timeout` for port discovery. See [the CLI contract](references/cli.md) for exact input, output, limits and failure behavior, and [the runbook](references/runbook.md) for operating and verification steps.

## Policy and safety

Read the private policy configured by `XP_POLICY_FILE` before any deployment or join. A missing, unconfirmed or incomplete policy blocks mutation. The default policy requires the configured public ingress, DDNS/Geo features and managed endpoint; an exception needs an explicit owner decision and an auditable reason. SS2022 remains disabled unless separately approved.

The helper and audit scripts are read-only. They must fail closed on missing or ambiguous data, never choose another node or port because it is available, and never read administrator tokens. Any future mutating command requires an explicit `--yes` and separate authorization.

## Configuration

Set `XP_INFRA_CONFIG_DIR` to a protected directory containing `hosts.txt` and `deployment-policy.yaml`, or set `XP_HOSTS_FILE` and `XP_POLICY_FILE` individually. By default the helper reads `${XDG_CONFIG_HOME:-$HOME/.config}/xp-infra/`. Keep resolved connection details in the operator's SSH configuration. Copy the public `references/hosts.txt.example` and `references/deployment-policy.yaml.example` templates into the private directory, and use `references/xp.env.template` for key names and placeholders; never commit live values.

## Workflow

1. Validate policy and SSH operator access.
2. Run bounded port preflight and read-only audit for the selected alias.
3. Use the official matching release deployment/join workflow with the preflight result.
4. Run the complete audit again and stop on any nonzero result.
5. Record only sanitized role/runtime facts in the private operator configuration, outside this repository.

The local helpers enforce bounded output and timeout behavior. Host-managed probes require non-interactive privilege checks; container probes require an explicit policy override. Neither path silently downgrades failed evidence.

Treat mock command evidence, isolated Linux native-probe evidence and real deployment observations as separate results. A successful fixture run does not establish deployment health.
