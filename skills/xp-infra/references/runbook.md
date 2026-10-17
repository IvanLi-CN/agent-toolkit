# XP self-hosted runbook

## Read-only gate

Resolve the selected alias through the operator's SSH configuration, then run `xp-infra policy check`, `inventory`, `status` and `audit`. Redact resolved hostnames, addresses, ports and response bodies before sharing.

The local commands require the installed Bun runtime plus native `ssh` and `curl`. Remote observation stays in POSIX Shell and does not require Bun on the inspected node. The checks are read-only and fail closed on missing, malformed or changing evidence.

## Deployment sequence

1. Establish a dedicated key-authenticated operator account and verify non-interactive privilege escalation.
2. Preflight the managed endpoint port from the full bindable range. Reuse a persisted managed endpoint only when runtime identity and ownership match.
3. Run the official release deployment with policy-selected Tunnel, DDNS, Geo and managed endpoint settings. Keep secrets and provider mappings outside this repository.
4. Join the node once, observe cluster role and health, then run the complete audit.
5. Treat any nonzero audit result as deployment failure. Repair only after explicit authorization and rerun all checks.

## Audit invariants

- Missing, malformed or changing runtime snapshots fail closed.
- Host and container probes use one validated runtime identity and recheck it around the request.
- Managed endpoint ownership comes from the active listener and persisted state, never from a guessed default port.
- Public probes run only when enabled by the effective policy; disabling a feature requires an explicit false setting.
- Audit never reads administrator tokens, changes DNS, restarts services or repairs drift.

## Recovery

Fence a returned former primary until synchronization and write ownership are validated. Repair orphan cluster voters only through the signed project CLI preview/apply flow with an unchanged membership fingerprint. Do not use raw consensus edits or broad recovery commands.
