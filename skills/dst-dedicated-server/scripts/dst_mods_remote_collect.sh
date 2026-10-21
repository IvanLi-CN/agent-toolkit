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
if [[ -L "$file" ]]; then
  printf 'modoverrides.lua is a symlink\n' >&2
  exit 1
fi
if [[ ! -e "$file" ]]; then
  printf 'MISSING\n'
  exit 0
fi
if [[ ! -f "$file" ]]; then
  printf 'modoverrides.lua is not a regular file\n' >&2
  exit 1
fi

file_stat="$(stat_signature "$file" || true)"
if [[ -z "$file_stat" ]]; then
  printf 'UNSUPPORTED_STAT\n' >&2
  exit 1
fi
exec 9<"$file" || { printf 'cannot open modoverrides.lua\n' >&2; exit 1; }
fd_stat="$(stat_signature /proc/self/fd/9 || stat_signature /dev/fd/9 || true)"
if [[ -z "$fd_stat" ]]; then
  exec 9<&-
  printf 'UNSUPPORTED_FD_STAT\n' >&2
  exit 1
fi
if [[ "$fd_stat" != "$file_stat" || -L "$klei_base" || -L "$klei_root" || -L "$cluster_dir" || -L "$shard_dir" || -L "$file" ]]; then
  exec 9<&-
  printf 'modoverrides.lua changed during collection\n' >&2
  exit 1
fi

size="${file_stat##*:}"
max_bytes=$((1024 * 1024))
if (( size > max_bytes )); then
  exec 9<&-
  printf 'modoverrides.lua exceeds %s bytes\n' "$max_bytes" >&2
  exit 1
fi
temporary="$(mktemp)"
verification="$(mktemp)"
projection="$(mktemp)"
trap 'rm -f "$temporary" "$verification" "$projection"' EXIT
head -c $((max_bytes + 1)) <&9 >"$temporary"
actual="$(wc -c < "$temporary")"
actual="${actual//[[:space:]]/}"
file_after_stat="$(stat_signature "$file" || true)"
fd_after_stat="$(stat_signature /proc/self/fd/9 || stat_signature /dev/fd/9 || true)"
exec 9<&-
if [[ -z "$file_after_stat" || -z "$fd_after_stat" ]]; then
  printf 'UNSUPPORTED_FD_STAT\n' >&2
  exit 1
fi
if [[ -L "$file" || ! -f "$file" ]]; then
  printf 'modoverrides.lua changed during collection\n' >&2
  exit 1
fi
exec 8<"$file" || { printf 'modoverrides.lua changed during collection\n' >&2; exit 1; }
verification_fd_stat="$(stat_signature /proc/self/fd/8 || stat_signature /dev/fd/8 || true)"
head -c $((max_bytes + 1)) <&8 >"$verification"
verification_size="$(wc -c < "$verification")"
verification_size="${verification_size//[[:space:]]/}"
exec 8<&-
if [[ -z "$verification_fd_stat" ]]; then
  printf 'UNSUPPORTED_FD_STAT\n' >&2
  exit 1
fi
if (( actual != size || verification_size != size )) || [[ "$file_after_stat" != "$file_stat" || "$fd_after_stat" != "$fd_stat" || "$verification_fd_stat" != "$file_stat" ]] || ! cmp -s "$temporary" "$verification"; then
  printf 'modoverrides.lua changed during collection\n' >&2
  exit 1
fi

# Project the Lua table down to Workshop IDs and top-level enabled booleans.
# The remote boundary never emits configuration values or arbitrary source text.
awk '
function mask_lua(value, output, position, character, next_character, quote, escaped, comment, quote_start, literal) {
  output = ""
  escaped = 0
  quote = ""
  quote_start = 0
  for (position = 1; position <= length(value); position++) {
    character = substr(value, position, 1)
    next_character = substr(value, position + 1, 1)
    if (quote != "") {
      output = output " "
      if (escaped) escaped = 0
      else if (character == "\\") escaped = 1
      else if (character == quote) {
        literal = substr(value, quote_start, position - quote_start + 1)
        if (literal ~ /^"workshop-[0-9]+"$/ && substr(value, quote_start - 1, 1) == "[" && substr(value, position + 1, 1) == "]") output = substr(output, 1, length(output) - length(literal)) literal
        quote = ""
        quote_start = 0
      }
    } else if (character == "-" && next_character == "-") {
      for (comment = position; comment <= length(value); comment++) output = output " "
      break
    } else if (character == "\"" || character == "\047") {
      quote = character
      quote_start = position
      output = output " "
    } else {
      output = output character
    }
  }
  return output
}
function brace_delta(value, masked, position, character, opening, closing) {
  masked = mask_lua(value)
  opening = 0
  closing = 0
  for (position = 1; position <= length(masked); position++) {
    character = substr(masked, position, 1)
    if (character == "{") opening++
    else if (character == "}") closing++
  }
  return opening - closing
}
function close_at_depth(value, depth, position, character, masked) {
  masked = mask_lua(value)
  for (position = 1; position <= length(masked); position++) {
    character = substr(masked, position, 1)
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
  value = mask_lua(value)
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
  masked_line = mask_lua(line)
  if (pending_config) {
    brace = index(masked_line, "{")
    if (brace == 0) next
    config = substr(masked_line, brace)
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
  marker = match(masked_line, /configuration_options[[:space:]]*=/)
  if (marker) {
    marker_start = RSTART
    process_outside(substr(masked_line, 1, marker_start - 1))
    config = substr(masked_line, marker_start)
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
  process_outside(masked_line)
}
END { flush_record() }
' "$temporary" >"$projection"
projected_size="$(wc -c < "$projection")"
projected_size="${projected_size//[[:space:]]/}"
printf 'PRESENT %s\n' "$projected_size"
cat "$projection"
