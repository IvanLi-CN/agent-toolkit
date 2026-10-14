# Environment configuration

The operator supplies deployment-specific values outside this repository:

| Variable | Meaning |
| --- | --- |
| `DST_HOST` | SSH alias or hostname. |
| `DST_USER` | Non-secret remote operator account. |
| `DST_LOCAL_DIR` | Optional local client data root. |
| `DST_CLUSTER` | Remote cluster name. |
| `DST_REMOTE_ROOT` | Optional remote installation root for local runbooks. |

Do not commit resolved hostnames, IP addresses, ports, home directories, tokens or passwords. Check the operator's SSH configuration and the remote deployment card at runtime, then redact paths and credentials before sharing output.
