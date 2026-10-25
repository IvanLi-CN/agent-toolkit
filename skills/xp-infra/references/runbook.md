# XP self-hosted runbook

## Prerequisites

Use the operator's installed Bun, OpenSSH client and curl. Run `../scripts/xp-infra --help` from this directory, or invoke the executable by its checkout path. Local helpers have no Ruby/Python dependency, package-install step or runtime-version selector. The protected policy and inventory are operator-owned; the public example deliberately fails owner confirmation until the operator supplies an approved configuration.

Inspected nodes are Linux with a POSIX shell, `/proc`, `awk`, `sed`, `grep`, `tr`, `base64`, `mktemp`, `wc`, `paste` and GNU-compatible `dd` supporting `iflag=fullblock`. Port preflight also needs native `timeout`, `ss` or `netstat`, kernel port-range observations and read-only Xray API access for an existing managed endpoint. Host mode requires a non-root, non-`xp` SSH operator with non-interactive `sudo`, native systemd/OpenRC service observations and curl. Container audit uses Docker in the default local context; direct access requires the explicit approved `direct_docker` exception and verified absence of host runtime configuration. Port preflight continues to require sudo even for containers. No Bun, Ruby or Python is installed or invoked by the remote probes.

## Read-only gate

Resolve the selected alias through the operator's SSH configuration, then run `xp-infra policy check`, `inventory`, `status` and `audit`. Redact resolved hostnames, addresses, ports and response bodies before sharing.

`policy check`, `audit` and `port preflight` reject missing, unconfirmed, incomplete or unknown policy fields. Audit and preflight validate the complete inventory and effective policy before SSH. Diagnostic commands validate inventory and operator access; they do not imply policy approval. Inventory returns nonzero if any selected node lacks valid evidence. Use one explicit registered alias; failure never selects an alternative host or port. Tunnel binds the exact requested local port on `127.0.0.1` and requires positively verified forwarding permission; a bind conflict fails instead of choosing another port.

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

The remote collector selects only required runtime environment keys, retains identity revalidation around requests and avoids an unfiltered process-environment temporary file. Locally, missing or invalid records, duplicate JSON members, unsupported schemas, nonexplicit booleans, invalid timestamps/ports and contradictory identities fail closed. Stale DDNS, expired certificates or failed required observations produce failed audit decisions. Public target checks reject private/special DNS answers, mixed public/private answers, credentials, query/fragment and nonexact paths; HTTPS probes pin the validated address and reject redirects. See [cli.md](cli.md) for bounds and reporting details.

## Focused verification

Run `bun test skills/xp-infra/tests` from the checkout, with native curl and OpenSSL available for a temporary trusted HTTPS fixture. The six scenario groups correspond to `VER-FOUNDATION-XP-01` through `VER-FOUNDATION-XP-06`. Policy/parser/network fixtures and fake SSH/curl/native-command records are mock evidence. The controlled HTTPS endpoint checks actual TLS verification, redirect rejection and output bounds without production traffic. `remote.test.ts` additionally runs the retained VLESS identity/probe and preflight checks in an isolated Linux environment with fake service/Docker/listener inventories and real POSIX shell, process-file fixtures, kernel port observations and native bounded-output tools; these tests are explicitly skipped on non-Linux hosts. Run the same command in an isolated Linux environment to obtain that evidence. Type checking is part of the repository's `bun run typecheck` command.

A fresh environment smoke runs the Bun policy and normalizer entrypoints with no Ruby/Python or transport tools on PATH. Remote syntax/runtime checks confirm that inspected nodes need only the documented native tools. Real deployment observation requires separately authorized private aliases and policy. Without those, record `real deployment observation: unavailable`; do not infer it from fixture or isolated OS results.

## Recovery

Fence a returned former primary until synchronization and write ownership are validated. Repair orphan cluster voters only through the signed project CLI preview/apply flow with an unchanged membership fingerprint. Do not use raw consensus edits or broad recovery commands.
