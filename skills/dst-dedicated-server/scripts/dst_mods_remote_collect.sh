#!/usr/bin/env bash
set -euo pipefail

cluster="${1:?missing cluster}"
shard="${2:?missing shard}"
cluster_dir="$HOME/.klei/DoNotStarveTogether/$cluster"

if [[ ! -d "$cluster_dir" ]]; then
  printf 'CLUSTER_MISSING\n'
  exit 1
fi

file="$cluster_dir/$shard/modoverrides.lua"
if [[ ! -f "$file" ]]; then
  printf 'MISSING %s\n' "$file"
  exit 0
fi

size="$(wc -c < "$file")"
size="${size//[[:space:]]/}"
max_bytes=$((1024 * 1024))
if (( size > max_bytes )); then
  printf 'modoverrides.lua exceeds %s bytes\n' "$max_bytes" >&2
  exit 1
fi
printf 'PRESENT %s\n' "$size"
cat "$file"
