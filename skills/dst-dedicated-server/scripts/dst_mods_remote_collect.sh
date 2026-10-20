#!/usr/bin/env bash
set -euo pipefail

cluster="${1:?missing cluster}"
shard="${2:?missing shard}"
case "$cluster" in
  ""|.|..|*/*|*\\*)
    printf 'INVALID_CLUSTER\n' >&2
    exit 2
    ;;
esac
case "$shard" in
  Master|Caves) ;;
  *) printf 'INVALID_SHARD\n' >&2; exit 2 ;;
esac

klei_base="$HOME/.klei"
klei_root="$klei_base/DoNotStarveTogether"
cluster_dir="$klei_root/$cluster"
shard_dir="$cluster_dir/$shard"

if [[ ! -d "$klei_base" || -L "$klei_base" || ! -d "$klei_root" || -L "$klei_root" || ! -d "$cluster_dir" || -L "$cluster_dir" ]]; then
  printf 'CLUSTER_MISSING\n'
  exit 1
fi

if [[ ! -d "$shard_dir" || -L "$shard_dir" ]]; then
  printf 'MISSING %s/modoverrides.lua\n' "$shard_dir"
  exit 0
fi

file="$shard_dir/modoverrides.lua"
if [[ ! -f "$file" || -L "$file" ]]; then
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
