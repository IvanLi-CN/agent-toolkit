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

file_stat="$(stat -Lc '%d:%i:%s' "$file" 2>/dev/null || stat -f '%d:%i:%z' "$file" 2>/dev/null || true)"
if [[ -z "$file_stat" ]]; then
  printf 'MISSING %s\n' "$file"
  exit 0
fi
exec 9<"$file" || { printf 'MISSING %s\n' "$file"; exit 0; }
fd_stat="$(stat -Lc '%d:%i:%s' /proc/self/fd/9 2>/dev/null || stat -f '%d:%i:%z' /dev/fd/9 2>/dev/null || true)"
if [[ "$fd_stat" != "$file_stat" || -L "$klei_base" || -L "$klei_root" || -L "$cluster_dir" || -L "$shard_dir" || -L "$file" ]]; then
  exec 9<&-
  printf 'MISSING %s\n' "$file"
  exit 0
fi

size="${file_stat##*:}"
max_bytes=$((1024 * 1024))
if (( size > max_bytes )); then
  exec 9<&-
  printf 'modoverrides.lua exceeds %s bytes\n' "$max_bytes" >&2
  exit 1
fi
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
head -c $((max_bytes + 1)) <&9 >"$temporary"
exec 9<&-
actual="$(wc -c < "$temporary")"
actual="${actual//[[:space:]]/}"
if (( actual != size )); then
  printf 'modoverrides.lua changed during collection\n' >&2
  exit 1
fi
printf 'PRESENT %s\n' "$size"
cat "$temporary"
