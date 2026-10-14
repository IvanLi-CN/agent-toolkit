# XP infrastructure references

These files define public contracts, examples and read-only operating guidance. They are safe to publish and contain no live node inventory, addresses, credentials or provider state.

Copy `hosts.txt.example` and `deployment-policy.yaml.example` into a protected local configuration directory before using `xp-infra`. `inventory.md.example` is a sanitized record template for that private directory. The helper reads `${XDG_CONFIG_HOME:-$HOME/.config}/xp-infra/` by default; `XP_INFRA_CONFIG_DIR`, `XP_HOSTS_FILE` and `XP_POLICY_FILE` can select another private location.

The live inventory belongs to the operator's protected configuration. Resolved SSH connection details belong in the operator's SSH configuration, and runtime values remain on each node in `/etc/xp/xp.env`.
