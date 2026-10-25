#!/bin/sh
# Native observation only. Local Bun owns parsing, comparison and report policy.
set -eu
mode=${1:?missing mode}
cluster=${2:-}
shard=${3:-both}
root="$HOME/.klei/DoNotStarveTogether"
case "$mode" in
  mods)
    case "$cluster" in ''|.|..|*[!A-Za-z0-9_.\ -]*) exit 2;; esac
    case "$shard" in Master|Caves|both) ;; *) exit 2;; esac
    [ -d "$root/$cluster" ] || exit 3
    printf 'DSTMODS1\n'
    for name in Master Caves; do
      [ "$shard" = both ] || [ "$shard" = "$name" ] || continue
      file="$root/$cluster/$name/modoverrides.lua"
      if [ ! -f "$file" ]; then printf '%s\tmissing\n' "$name"; continue; fi
      size=$(wc -c < "$file" | tr -d '[:space:]')
      [ "$size" -le 1048576 ] || exit 4
      printf '%s\t%s\n' "$name" "$size"
      # Cap transfer if the file changes after stat; the local framing check rejects drift.
      head -c 1048577 "$file"
    done
    ;;
  snapshot)
    printf '### Identity\n\n'
    printf -- '- hostname: '; hostname
    printf -- '- user: '; id -un
    printf -- '- kernel: '; uname -sr
    printf '\n### Resources\n\n'
    if command -v uptime >/dev/null 2>&1; then uptime; fi
    if command -v df >/dev/null 2>&1; then df -h "$HOME" 2>/dev/null | head -n 10; fi
    if command -v free >/dev/null 2>&1; then free -h; fi
    printf '\n### systemd (active state only)\n\n'
    if command -v systemctl >/dev/null 2>&1; then
      for unit in dst-master dst-caves; do
        printf '%s: ' "$unit"
        systemctl is-active "$unit" 2>/dev/null || true
      done
    else printf 'systemctl unavailable\n'; fi
    printf '\n### Listening ports (no process arguments)\n\n'
    if command -v ss >/dev/null 2>&1; then ss -ltnu 2>/dev/null | head -n 120; fi
    printf '\n### Processes (names only)\n\n'
    if command -v ps >/dev/null 2>&1; then ps -eo pid,user,comm | awk 'NR == 1 || /dontstarve|steamcmd|screen|tmux/' | head -n 120; fi
    printf '\n### Runbooks / helper scripts (paths only)\n\n'
    for file in "$HOME/DST_DEPLOY.md" "$HOME/steamcmd/dst_update.sh" "$HOME/steamcmd/steamcmd.sh"; do
      if [ -f "$file" ]; then printf '%s\n' "$file"; fi
    done
    printf '\n### Backups (names only)\n\n'
    if [ -d "$HOME/backups" ]; then ls -1 "$HOME/backups" | head -n 120; fi
    printf '\n### Klei data (metadata only; secrets omitted)\n\n'
    if [ ! -d "$root" ]; then printf 'Klei data directory not found\n'; exit 0; fi
    count=0
    for dir in "$root"/*; do
      [ -d "$dir" ] || continue
      count=$((count + 1)); [ "$count" -le 100 ] || break
      printf 'Cluster: %s\n' "${dir##*/}"
      for file in cluster.ini cluster_token.txt; do
        if [ -f "$dir/$file" ]; then printf '%s: present (redacted)\n' "$file"; fi
      done
      for name in Master Caves; do
        [ -d "$dir/$name" ] || continue
        printf '%s/: present\n' "$name"
        for file in server.ini modoverrides.lua server_log.txt server_chat_log.txt; do
          if [ -f "$dir/$name/$file" ]; then printf '%s: present\n' "$file"; fi
        done
      done
    done
    printf '\n### Server binary candidates (paths only)\n\n'
    for dir in "$HOME/dst" "$HOME/dst-server" "$HOME/dstserver" "$HOME/Steam/steamapps/common/dstserver" "$HOME/Steam/steamapps/common/Don't Starve Together Dedicated Server" "$HOME/steamapps/common/Don't Starve Together Dedicated Server" "$HOME/steamapps/common/Dont Starve Together Dedicated Server" "$HOME/steamapps/common/dontstarvetogether_dedicated_server"; do
      for file in bin64/dontstarve_dedicated_server_nullrenderer_x64 bin64/dontstarve_dedicated_server_nullrenderer bin/dontstarve_dedicated_server_nullrenderer dontstarve_dedicated_server_nullrenderer_x64 dontstarve_dedicated_server_nullrenderer; do
        if [ -f "$dir/$file" ]; then printf '%s\n' "$dir/$file"; fi
      done
    done
    ;;
  *) exit 2;;
esac
