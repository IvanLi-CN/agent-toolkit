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

stat_signature() {
  local value
  value="$(stat -Lc '%i:%Y:%Z:%s' "$1" 2>/dev/null || stat -f '%i:%m:%c:%z' "$1" 2>/dev/null || true)"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return 0
  fi
  return 1
}

content_digest() {
  local value
  if command -v sha256sum >/dev/null 2>&1; then
    value="$(sha256sum "$1" 2>/dev/null | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    value="$(shasum -a 256 "$1" 2>/dev/null | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    value="$(openssl dgst -sha256 "$1" 2>/dev/null | awk -F'= ' '{print $2}')"
  else
    value="$(cksum "$1" 2>/dev/null | awk '{print $1 ":" $2}')"
  fi
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

klei_base="$HOME/.klei"
klei_root="$klei_base/DoNotStarveTogether"
cluster_dir="$klei_root/$cluster"
shard_dir="$cluster_dir/$shard"

if [[ ! -d "$klei_base" || -L "$klei_base" || ! -d "$klei_root" || -L "$klei_root" || ! -d "$cluster_dir" || -L "$cluster_dir" ]]; then
  printf 'CLUSTER_MISSING\n'
  exit 1
fi

if [[ ! -d "$shard_dir" || -L "$shard_dir" ]]; then
  printf 'MISSING\n'
  exit 0
fi

file="$shard_dir/modoverrides.lua"
if [[ ! -f "$file" || -L "$file" ]]; then
  printf 'MISSING\n'
  exit 0
fi

file_stat="$(stat_signature "$file" || true)"
if [[ -z "$file_stat" ]]; then
  printf 'MISSING\n'
  exit 0
fi
file_digest="$(content_digest "$file" || true)"
if [[ -z "$file_digest" ]]; then
  printf 'modoverrides.lua digest unavailable\n' >&2
  exit 1
fi
exec 9<"$file" || { printf 'MISSING\n'; exit 0; }
fd_stat="$(stat_signature /proc/self/fd/9 || stat_signature /dev/fd/9 || true)"
if [[ "$fd_stat" != "$file_stat" || -L "$klei_base" || -L "$klei_root" || -L "$cluster_dir" || -L "$shard_dir" || -L "$file" ]]; then
  exec 9<&-
  printf 'MISSING\n'
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
projection="$(mktemp)"
trap 'rm -f "$temporary" "$projection"' EXIT
head -c $((max_bytes + 1)) <&9 >"$temporary"
actual="$(wc -c < "$temporary")"
actual="${actual//[[:space:]]/}"
file_after_stat="$(stat_signature "$file" || true)"
fd_after_stat="$(stat_signature /proc/self/fd/9 || stat_signature /dev/fd/9 || true)"
exec 9<&-
file_after_digest="$(content_digest "$file" || true)"
if (( actual != size )) || [[ "$file_after_stat" != "$file_stat" || "$fd_after_stat" != "$fd_stat" || -z "$file_after_digest" || "$file_after_digest" != "$file_digest" ]]; then
  printf 'modoverrides.lua changed during collection\n' >&2
  exit 1
fi

# Project the Lua table down to Workshop IDs and top-level enabled booleans.
# The remote boundary never emits configuration values or arbitrary source text.
awk '
function count_char(value, character, rest, position, count) {
  rest = value
  count = 0
  while ((position = index(rest, character)) > 0) {
    count++
    rest = substr(rest, position + 1)
  }
  return count
}
function brace_delta(value) {
  return count_char(value, "{") - count_char(value, "}")
}
function close_at_depth(value, depth, position, character) {
  for (position = 1; position <= length(value); position++) {
    character = substr(value, position, 1)
    if (character == "{") depth++
    else if (character == "}") {
      depth--
      if (depth == 0) return position
    }
  }
  return 0
}
function flush_record() {
  if (current_id == "") return
  printf "[\"%s\"] = {", current_id
  if (current_enabled != "") printf " enabled = %s,", current_enabled
  print " },"
  current_id = ""
  current_enabled = ""
}
function process_outside(value, enabled) {
  if (match(value, /\["workshop-[0-9]+"\]/)) {
    flush_record()
    current_id = substr(value, RSTART + 2, RLENGTH - 4)
  }
  if (current_id != "" && match(value, /enabled[[:space:]]*=[[:space:]]*(true|false)/)) {
    enabled = substr(value, RSTART, RLENGTH)
    sub(/^.*=[[:space:]]*/, "", enabled)
    current_enabled = enabled
  }
}
{
  line = $0
  if (pending_config) {
    brace = index(line, "{")
    if (brace == 0) next
    config = substr(line, brace)
    pending_config = 0
    config_depth = brace_delta(config)
    if (config_depth > 0) {
      in_config = 1
      next
    }
    closing = close_at_depth(config, 0)
    process_outside(substr(config, closing + 1))
    next
  }
  if (in_config) {
    previous_depth = config_depth
    config_depth += brace_delta(line)
    if (config_depth > 0) next
    closing = close_at_depth(line, previous_depth)
    in_config = 0
    config_depth = 0
    process_outside(substr(line, closing + 1))
    next
  }
  marker = match(line, /configuration_options[[:space:]]*=/)
  if (marker) {
    marker_start = RSTART
    process_outside(substr(line, 1, marker_start - 1))
    config = substr(line, marker_start)
    brace = index(config, "{")
    if (brace == 0) {
      pending_config = 1
      next
    }
    config = substr(config, brace)
    config_depth = brace_delta(config)
    if (config_depth > 0) {
      in_config = 1
      next
    }
    closing = close_at_depth(config, 0)
    process_outside(substr(config, closing + 1))
    next
  }
  process_outside(line)
}
END { flush_record() }
' "$temporary" >"$projection"
projected_size="$(wc -c < "$projection")"
projected_size="${projected_size//[[:space:]]/}"
printf 'PRESENT %s\n' "$projected_size"
cat "$projection"
