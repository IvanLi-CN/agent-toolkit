#!/usr/bin/env bash
set -euo pipefail

HOST="${DST_HOST:-}"
SSH_USER="${DST_USER:-}"
CLUSTER="${DST_CLUSTER:-}"
SHARD="both" # Master | Caves | both

usage() {
  cat <<'EOF'
Extract enabled/disabled Workshop mod IDs from DST shard `modoverrides.lua` via SSH.

Usage:
  dst_mods_from_modoverrides.sh [--host <ip>] [--user <ssh-user>] [--cluster <name>] [--shard Master|Caves|both]

Defaults:
  --host    value from DST_HOST
  --user    value from DST_USER
  --cluster value from DST_CLUSTER
  --shard   both

Notes:
  - Reads only `modoverrides.lua` (does NOT read `cluster.ini`), so it won't expose `cluster_password`.
  - Outputs only Workshop IDs and enabled state; no configuration_options are printed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --user) SSH_USER="${2:-}"; shift 2 ;;
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --shard) SHARD="${2:-}"; shift 2 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$HOST" ]] || { echo "error: --host or DST_HOST is required" >&2; exit 2; }
[[ -n "$SSH_USER" ]] || { echo "error: --user or DST_USER is required" >&2; exit 2; }
[[ -n "$CLUSTER" ]] || { echo "error: --cluster or DST_CLUSTER is required" >&2; exit 2; }

ssh -o BatchMode=yes -o ConnectTimeout=5 "${SSH_USER}@${HOST}" 'bash -s' -- "$CLUSTER" "$SHARD" <<'EOF'
set -euo pipefail

CLUSTER="${1:?missing cluster}"
SHARD="${2:?missing shard}"

KLEI_CLUSTER_DIR="$HOME/.klei/DoNotStarveTogether/$CLUSTER"

if [[ ! -d "$KLEI_CLUSTER_DIR" ]]; then
  echo "Cluster dir not found: $KLEI_CLUSTER_DIR" >&2
  exit 1
fi

extract_tsv() {
  # Output: "<id>\t<true|false|unknown>" per line.
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 0
  fi

  awk '
    BEGIN { current=""; enabled="unknown"; in_config=0; config_depth=0 }
    $0 ~ /\["workshop-[0-9]+"\]/ {
      if (current != "") { print current "\t" enabled }
      line = $0
      sub(/^.*\["workshop-/, "", line)
      sub(/".*$/, "", line)
      current = line
      enabled = "unknown"
      in_config = 0
      config_depth = 0
    }
    current != "" {
      # Track entering/leaving configuration_options = { ... } so we do not confuse
      # a config option named "enabled" with the top-level enabled = true/false.
      if (in_config == 0 && $0 ~ /configuration_options/) {
        tmp = $0
        o = gsub(/{/, "{", tmp)
        c = gsub(/}/, "}", tmp)
        config_depth += (o - c)
        if (config_depth > 0) { in_config = 1 }
      } else if (in_config == 1) {
        tmp = $0
        o = gsub(/{/, "{", tmp)
        c = gsub(/}/, "}", tmp)
        config_depth += (o - c)
        if (config_depth <= 0) { in_config = 0; config_depth = 0 }
      }

      if (enabled == "unknown" && in_config == 0 && $0 ~ /enabled[[:space:]]*=[[:space:]]*true/) { enabled = "true" }
      if (enabled == "unknown" && in_config == 0 && $0 ~ /enabled[[:space:]]*=[[:space:]]*false/) { enabled = "false" }
    }
    END { if (current != "") { print current "\t" enabled } }
  ' "$file" | sort -n
}

summarize() {
  local shard="$1"
  local file="$KLEI_CLUSTER_DIR/$shard/modoverrides.lua"

  echo "## $CLUSTER / $shard"
  if [[ ! -f "$file" ]]; then
    echo "- modoverrides.lua: missing ($file)"
    echo
    return 0
  fi

  local tsv
  tsv="$(extract_tsv "$file" || true)"
  local total
  total="$(printf "%s\n" "$tsv" | awk 'NF{c++} END{print c+0}')"
  echo "- modoverrides.lua: present"
  echo "- mods: $total"

  local enabled_count disabled_count unknown_count
  enabled_count="$(printf "%s\n" "$tsv" | awk '$2=="true"{c++} END{print c+0}')"
  disabled_count="$(printf "%s\n" "$tsv" | awk '$2=="false"{c++} END{print c+0}')"
  unknown_count="$(printf "%s\n" "$tsv" | awk '$2=="unknown"{c++} END{print c+0}')"
  echo "- enabled: $enabled_count"
  echo "- disabled: $disabled_count"
  echo "- unknown: $unknown_count"
  echo

  local enabled_list disabled_list unknown_list
  enabled_list="$(printf "%s\n" "$tsv" | awk '$2=="true"{print $1}' | paste -sd ' ' - || true)"
  disabled_list="$(printf "%s\n" "$tsv" | awk '$2=="false"{print $1}' | paste -sd ' ' - || true)"
  unknown_list="$(printf "%s\n" "$tsv" | awk '$2=="unknown"{print $1}' | paste -sd ' ' - || true)"

  echo "enabled_ids: ${enabled_list:-"(none)"}"
  echo "disabled_ids: ${disabled_list:-"(none)"}"
  if [[ -n "${unknown_list:-}" ]]; then
    echo "unknown_ids: $unknown_list"
  fi
  echo
}

diff_enabled_disabled() {
  local master_file="$KLEI_CLUSTER_DIR/Master/modoverrides.lua"
  local caves_file="$KLEI_CLUSTER_DIR/Caves/modoverrides.lua"
  if [[ ! -f "$master_file" || ! -f "$caves_file" ]]; then
    return 0
  fi

  echo "## Diff (Master vs Caves)"

  local only_master only_caves
  only_master="$(comm -23 <(extract_tsv "$master_file" | awk '$2=="true"{print $1}' | sort -n) <(extract_tsv "$caves_file" | awk '$2=="true"{print $1}' | sort -n) | paste -sd ' ' - || true)"
  only_caves="$(comm -13 <(extract_tsv "$master_file" | awk '$2=="true"{print $1}' | sort -n) <(extract_tsv "$caves_file" | awk '$2=="true"{print $1}' | sort -n) | paste -sd ' ' - || true)"
  echo "enabled_only_in_master: ${only_master:-"(none)"}"
  echo "enabled_only_in_caves: ${only_caves:-"(none)"}"

  only_master="$(comm -23 <(extract_tsv "$master_file" | awk '$2=="false"{print $1}' | sort -n) <(extract_tsv "$caves_file" | awk '$2=="false"{print $1}' | sort -n) | paste -sd ' ' - || true)"
  only_caves="$(comm -13 <(extract_tsv "$master_file" | awk '$2=="false"{print $1}' | sort -n) <(extract_tsv "$caves_file" | awk '$2=="false"{print $1}' | sort -n) | paste -sd ' ' - || true)"
  echo "disabled_only_in_master: ${only_master:-"(none)"}"
  echo "disabled_only_in_caves: ${only_caves:-"(none)"}"
  echo
}

case "$SHARD" in
  Master|master) summarize "Master" ;;
  Caves|caves) summarize "Caves" ;;
  both)
    summarize "Master"
    summarize "Caves"
    diff_enabled_disabled
    ;;
  *)
    echo "Invalid --shard: $SHARD (expected Master|Caves|both)" >&2
    exit 2
    ;;
esac
EOF
