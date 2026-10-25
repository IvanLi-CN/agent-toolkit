# Environment configuration

The operator supplies deployment-specific values outside this repository:

| Variable | Meaning |
| --- | --- |
| `DST_HOST` | SSH alias or hostname. |
| `DST_USER` | Non-secret remote operator account. |
| `DST_LOCAL_DIR` | Optional local client data root. |
| `DST_CLUSTER` | Remote cluster name. |
| `DST_REMOTE_ROOT` | Optional remote installation root for local runbooks. |

The Bun helpers consume the first four variables. `DST_REMOTE_ROOT` belongs to operator runbooks, not a helper path override. `--cluster-dir PATH` explicitly selects local-only mod parsing and requires no SSH configuration. `--no-remote` selects local-only snapshots; `--no-local` omits the client data directory. An SSH user can be omitted for snapshots when the selected SSH alias already supplies it; remote mod collection requires an explicit user.

Local runtime: installed Bun and, for remote mode, OpenSSH. Remote runtime: POSIX `sh`, `dd`, `wc`, `tr`, `head`, `hostname`, `id`, `uname`, and ordinary filesystem utilities; `dd` provides the byte-capped mod transfer and `head -n` provides optional snapshot line caps. Resource/service probes are best effort when their commands exist. Host key enrollment and authentication are manual prerequisites. The helpers use BatchMode and strict host-key checking, never install a runtime, and never change SSH configuration.

Do not commit resolved hostnames, IP addresses, ports, home directories, tokens or passwords. Check the operator's SSH configuration and the remote deployment card at runtime, then redact paths and credentials before sharing output.
