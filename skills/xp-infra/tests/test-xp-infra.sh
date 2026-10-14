#!/usr/bin/env bash
set -euo pipefail

skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
for required in \
  "$skill_dir/scripts/xp-infra" \
  "$skill_dir/scripts/xp-infra-audit-local" \
  "$skill_dir/scripts/xp-infra-audit-remote" \
  "$skill_dir/references/deployment-policy.yaml.example" \
  "$skill_dir/references/hosts.txt.example" \
  "$skill_dir/references/inventory.md.example" \
  "$skill_dir/references/xp.env.template"; do
  test -e "$required" || { echo "missing required file: $required" >&2; exit 1; }
done

"$skill_dir/scripts/xp-infra" --help >/dev/null

config_dir="$(mktemp -d)"
trap 'rm -rf "$config_dir"' EXIT
printf '%s\n' fixture-node > "$config_dir/hosts.txt"
cat > "$config_dir/deployment-policy.yaml" <<'EOF'
schema_version: 1
owner_confirmed: true
geo:
  enabled: true
  origin: https://api.country.is
  owner_authorized_third_party_lookup: true
public_hostname:
  zone: example.test
defaults:
  cloudflare_tunnel: true
  cloudflare_ddns: true
  ip_geo_enrichment: true
  managed_default_vless: true
  managed_default_ss2022: false
  direct_docker: false
  vless_port: automatic_preflight
node_overrides: {}
EOF
inventory_output="$(XP_HOSTS_FILE="$config_dir/hosts.txt" "$skill_dir/scripts/xp-infra" inventory)"
printf '%s\n' "$inventory_output" | grep -Fx '== fixture-node ==' >/dev/null || {
  echo "xp-infra did not honor XP_HOSTS_FILE" >&2
  exit 1
}

policy_output="$(XP_HOSTS_FILE="$config_dir/hosts.txt" XP_POLICY_FILE="$config_dir/deployment-policy.yaml" "$skill_dir/scripts/xp-infra" policy check)"
printf '%s\n' "$policy_output" | grep -Fx 'policy: OK' >/dev/null || {
  echo "xp-infra did not honor XP_POLICY_FILE" >&2
  exit 1
}

if XP_INFRA_CONFIG_DIR="$config_dir/missing" "$skill_dir/scripts/xp-infra" inventory >/dev/null 2>&1; then
  echo "xp-infra unexpectedly accepted a missing private hosts file" >&2
  exit 1
fi

echo "xp-infra public structure ok"
