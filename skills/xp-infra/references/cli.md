# XP local CLI and observation contract

## Runtime boundary

`scripts/xp-infra` and `scripts/xp-infra-audit-local` execute directly with the operator-installed Bun. The TypeScript modules beside them own policy, orchestration, strict parsing, normalization, public target validation, interpretation and decisions. The single-image compose check is the exported `composeImageMatches` function in `preflight.ts`; it accepts exactly one nonblank image line equal to the expected image and has no extra wrapper process. Its former path is a nonexecutable source-reference anchor for existing public contract links. Replaced local Shell/Ruby implementations are not fallback paths.

`xp-infra-audit-remote` and `xp-infra-audit-vless-remote` remain POSIX native collection and identity revalidation. `xp-infra-port-remote` is the extracted bounded native preflight collector; it returns observations for the local typed decision function. `xp-infra-inventory-remote` collects native OS/version/service facts. A remote failure is never replaced by a locally assumed identity. The helper does not install runtimes or run deployment, repair, restart, upload or DNS-write commands.

## Commands and exit status

| Command | Output and gates |
| --- | --- |
| `inventory` | Selected aliases and SSH/OS/service/version facts; nonzero if any probe fails. |
| `policy check` | `policy: OK` only for a complete confirmed policy and valid inventory. |
| `port preflight ALIAS` | One numeric port after complete policy validation and bounded sudo-native observation. Reuses an existing managed port only with matching state, process, active service and Xray inbound identity. Bootstrap selection excludes occupied, reserved, ephemeral and unbindable privileged ranges and preserves deterministic alias hashing. No fallback after invalid observations. |
| `audit ALIAS` | `PASS`, `FAIL` and policy-authorized `SKIP` lines, followed by `audit: OK (ALIAS)` only when every required decision passes. Any invalid/missing/failed observation returns nonzero. |
| `status ALIAS` / `version ALIAS` | Bounded native diagnostic output for a registered non-root operator. |
| `logs ALIAS [--tail N]` | Native diagnostic output; N is a decimal integer from 1 through 10000, default 200. |
| `tunnel ALIAS [--ui\|--metrics] [--local-port PORT]` | Foreground loopback SSH forwarding to the chosen service, default UI 62416 or metrics 10085. Local port is 1 through 65535; no automatic alternate. Forwarding permission must be positively observed. |
| `help` / `-h` / `--help` | Usage without configuration or network access. |

Unknown arguments, extra positional fields and duplicate tunnel options are rejected. Exit zero means the requested read-only operation completed with valid required evidence; nonzero means failure. Diagnostic success does not establish deployment success. Remote stderr is consumed within a bound and never echoed, because it can contain sensitive or untrusted content. Local errors identify a category; audit response bodies and unrelated records are not printed.

## Protected configuration and strict inputs

`XP_INFRA_CONFIG_DIR` selects a protected directory; otherwise use `${XDG_CONFIG_HOME:-$HOME/.config}/xp-infra/`. `XP_HOSTS_FILE` and `XP_POLICY_FILE` independently override filenames. Inventory is a nonempty list of unique lowercase SSH aliases matching `[a-z0-9][a-z0-9-]*`, with optional blank lines/comments. Actual addresses, SSH identities, credentials, exception reasons and live inventory remain outside the public source. `XP_CONTAINER_IMAGE_PREFIX` may select an explicit image namespace using safe image-name characters; it never chooses another node.

Policy schema 1 accepts exactly `schema_version`, `owner_confirmed`, `geo`, `public_hostname`, `defaults` and `node_overrides`, with the nested fields demonstrated by the public template. Every default must match the required feature baseline. Geo origin/authorization and owner confirmation must be explicit. Overrides name registered aliases, carry `owner_approved: true` and a nonblank reason, and contain only boolean feature values. Disabling both public endpoints requires an explicit direct-Docker exception. SS2022 remains disabled unless an approved override enables it.

The policy parser accepts a deliberately restricted YAML mapping subset: two-space nesting, lowercase bare keys, booleans spelled `true`/`false`, integers, quoted/plain single-line scalars, comments and empty `{}` maps. Duplicate keys, tags, aliases, merge keys, documents, flow collections, block scalars, tabs and unsupported indentation fail closed. This subset is narrower than general YAML; existing private files using other constructs must be rewritten explicitly rather than silently interpreted with broader semantics.

Remote audit records are newline-delimited `key=value`, with unique lowercase keys, no embedded control characters and all required basic fields present. JSON objects use recursive duplicate-member rejection, including escaped equivalent keys, and bounded nesting; unsafe/nonfinite numeric values are invalid. Booleans must be explicit. Timestamps require an actual RFC3339 date/time with timezone. Unsupported managed-state schema, malformed identifiers, duplicate/out-of-range ports, host/container identity mixtures and invalid process snapshots fail before probes or decisions. Enabled DDNS requires a timestamped snapshot; future or stale synchronization and non-up/error status cannot satisfy health. Invalid data is distinct from an explicit false policy feature.

## Bounds and public probes

Local command stdout and stderr are independently limited to 65536 bytes, with a 60-second default execution deadline, 15 seconds for SSH configuration/forwarding checks and 20 seconds for a curl process. Timeout, excess output, signal, invalid UTF-8, spawn failure and nonzero native status fail the operation and terminate the command process group. The standalone normalizer bounds stdin to 65536 bytes and 15 seconds. Long-lived explicitly requested tunnels run until SSH exits or the operator interrupts them.

Public probes accept only an HTTPS DNS origin with the exact `/api/health` or `/generate_204` path, no userinfo, query, fragment, IP literal, path normalization or uppercase hostname. DNS has a 10-second bound; every answer must be globally reachable under the documented public-address special-range rules. One validated address is pinned with curl `--resolve`, proxies are disabled, TLS verification remains enabled and redirects are rejected. Curl enforces a 15-second request timeout; combined headers/body and diagnostics stay within local output bounds. HTTP failures or missing evidence cannot become audit success. Cloudflare Tunnel proof additionally requires aligned declaration, public healthy JSON, Cloudflare response headers and membership in the bounded official IPv4/IPv6 range response. The public VLESS ingress must return 204 and agree with the identity-revalidated remote loopback result.

Host probes require sudo-native service/PID/start-time observations. Container probes retain full container ID/start time and Xray process token checks before and after requests, use Docker's default context and clear inherited Docker selectors. Direct Docker is permitted only by explicit policy and verified absence of host runtime configuration. Port preflight also rechecks collected runtime/kernel/listener/state evidence and process/container identity before returning records. No failure causes a different alias, image, runtime mode or port to be guessed.
