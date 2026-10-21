#!/usr/bin/env bash
set -euo pipefail

have_cmd() { command -v "$1" >/dev/null 2>&1; }

echo "### Identity"
echo
echo "- hostname: <remote-host>"
echo "- whoami: <remote-user>"
echo "- kernel: $(uname -srm)"
OS_RELEASE_FILE="${AGENT_TOOLKIT_DST_OS_RELEASE_FILE:-/etc/os-release}"
if [[ -f "$OS_RELEASE_FILE" && ! -L "$OS_RELEASE_FILE" ]]; then
  echo "- os-release:"
  while IFS='=' read -r key value; do
    value="${value#\"}"
    value="${value%\"}"
    case "$key" in
      ID)
        case "$value" in
          alpine|amazon|arch|centos|debian|fedora|gentoo|kali|linuxmint|manjaro|nixos|opensuse|opensuse-leap|opensuse-tumbleweed|oracle|raspbian|rhel|rocky|slackware|ubuntu|void)
            printf '  - ID: %s\n' "$value"
            ;;
          *)
            echo '  - ID: <redacted>'
            ;;
        esac
        ;;
      VERSION_ID)
        if [[ "$value" =~ ^[0-9]{1,4}([.][0-9]{1,4}){0,3}$ ]]; then
          printf '  - VERSION_ID: %s\n' "$value"
        else
          echo '  - VERSION_ID: <redacted>'
        fi
        ;;
    esac
  done < "$OS_RELEASE_FILE"
fi
echo

echo "### Resources"
echo
if have_cmd uptime; then echo "- uptime: $(uptime)"; fi
if have_cmd df; then
  if df_line="$(df -h "$HOME" 2>/dev/null | awk 'NR == 2 { print "- home_fs: size=" $2 " used=" $3 " available=" $4 " capacity=" $5; found=1 } END { if (!found) print "> home filesystem metrics unavailable." }')"; then
    printf '%s\n' "$df_line"
  else
    echo "> home filesystem metrics unavailable."
  fi
fi
if have_cmd free; then free -h || true; fi
echo

echo "### systemd (best-effort)"
echo
if have_cmd systemctl; then
  for unit in dst-master dst-caves; do
    printf '%s: %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
  done
else
  echo "> systemctl not found."
fi
echo

echo "### Listening ports (best-effort)"
echo
if have_cmd ss; then
  ss -ltnup 2>/dev/null | awk 'NR > 1 && $0 ~ /:(22|10999|11000|27018|27019|8768|8769)([^0-9]|$)/ { found=1 } END { if (found) print "- configured-listener: present"; else print "> configured listeners not observed." }'
else
  echo "> ss not found."
fi
echo

echo "### Processes (dontstarve/steamcmd/screen/tmux)"
echo
if have_cmd ps; then
  ps -eo pid=,comm= 2>/dev/null | grep -Ei 'dontstarve|steamcmd|screen|tmux' | awk 'NR <= 120 { print "- pid: " $1 " process: <redacted>" }' || true
fi
echo

echo "### Runbooks / helper scripts (paths only)"
echo
for f in \
  "$HOME/DST_DEPLOY.md" \
  "$HOME/steamcmd/dst_update.sh" \
  "$HOME/steamcmd/steamcmd.sh"
do
  if [[ -f "$f" ]]; then
    echo "- $(basename "$f"): present"
  fi
done
echo

echo "### Backups (paths only)"
echo
if [[ -d "$HOME/backups" ]]; then
  echo "- backups: present"
else
  echo "> <remote-home>/backups not found."
fi
echo

echo "### Klei data (paths only; secrets redacted)"
echo
KLEI_DIR="$HOME/.klei/DoNotStarveTogether"
if [[ ! -d "$HOME/.klei" || -L "$HOME/.klei" || ! -d "$KLEI_DIR" || -L "$KLEI_DIR" ]]; then
  echo "> <remote-home>/.klei/DoNotStarveTogether not found."
  exit 0
fi

echo "- klei_dir: <remote-home>/.klei/DoNotStarveTogether"
echo

cluster_count=0
emit_cluster() {
  local cluster="$1"
  [[ -d "$cluster" && ! -L "$cluster" ]] || return 0
  ((cluster_count += 1))
  if (( cluster_count > 128 )); then
    echo "> cluster inventory truncated at 128 entries."
    return 1
  fi
  echo "#### Cluster: <cluster>"
  if [[ -f "$cluster/cluster.ini" && ! -L "$cluster/cluster.ini" ]]; then
    echo "- cluster.ini: present (contains cluster_password; do not paste)"
  fi
  if [[ -f "$cluster/cluster_token.txt" && ! -L "$cluster/cluster_token.txt" ]]; then
    echo "- cluster_token.txt: present (redacted)"
  fi
  for shard in Master Caves; do
    if [[ -d "$cluster/$shard" && ! -L "$cluster/$shard" ]]; then
      echo "- $shard/: present"
      for f in server.ini modoverrides.lua server_log.txt server_chat_log.txt; do
        if [[ -f "$cluster/$shard/$f" && ! -L "$cluster/$shard/$f" ]]; then
          if have_cmd stat; then
            if stat -c '%s bytes %y' "$cluster/$shard/$f" >/dev/null 2>&1; then
              echo "  - $f: $(stat -c '%s bytes %y' "$cluster/$shard/$f")"
            else
              echo "  - $f: $(stat -f '%z bytes %Sm' "$cluster/$shard/$f" 2>/dev/null || echo present)"
            fi
          else
            echo "  - $f: present"
          fi
        fi
      done
    fi
  done
  echo
  return 0
}

if have_cmd find; then
  set +e
  find "$KLEI_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | (
    cluster_count=0
    while IFS= read -r -d '' cluster; do
      if ! emit_cluster "$cluster"; then
        if (( cluster_count > 128 )); then
          exit 125
        fi
        exit 1
      fi
    done
    exit 0
  )
  cluster_scan_status=$?
  set -e
  if (( cluster_scan_status != 0 && cluster_scan_status != 125 && cluster_scan_status != 141 )); then
    echo "> cluster inventory unavailable."
  fi
else
  echo "> find not found; cluster inventory unavailable."
fi

echo "### Server binary (best-effort)"
echo
found="0"
for p in \
  "$HOME/Steam/steamapps/common/dstserver" \
  "$HOME/Steam/steamapps/common/Don't Starve Together Dedicated Server" \
  "$HOME/steamapps/common/Don't Starve Together Dedicated Server" \
  "$HOME/steamapps/common/Dont Starve Together Dedicated Server" \
  "$HOME/steamapps/common/dontstarvetogether_dedicated_server" \
  "$HOME/dst" \
  "$HOME/dst-server" \
  "$HOME/dstserver"
do
  if [[ -d "$p" ]]; then
    echo "- candidate_dir: present"
    if [[ -f "$p/bin64/dontstarve_dedicated_server_nullrenderer_x64" ]]; then
      echo "  - bin64/dontstarve_dedicated_server_nullrenderer_x64: present"
      found="1"
    fi
    if [[ -f "$p/bin64/dontstarve_dedicated_server_nullrenderer" ]]; then
      echo "  - bin64/dontstarve_dedicated_server_nullrenderer: present"
      found="1"
    fi
    if [[ -f "$p/bin/dontstarve_dedicated_server_nullrenderer" ]]; then
      echo "  - bin/dontstarve_dedicated_server_nullrenderer: present"
      found="1"
    fi
    if [[ -f "$p/dontstarve_dedicated_server_nullrenderer_x64" ]]; then
      echo "  - dontstarve_dedicated_server_nullrenderer_x64: present"
      found="1"
    fi
    if [[ -f "$p/dontstarve_dedicated_server_nullrenderer" ]]; then
      echo "  - dontstarve_dedicated_server_nullrenderer: present"
      found="1"
    fi
  fi
done

if [[ "$found" == "0" ]] && have_cmd find; then
  if find "$HOME" -maxdepth 0 -type d -print >/dev/null 2>&1; then
    if have_cmd timeout; then
      binary_path="$(timeout 5s find "$HOME" -maxdepth 6 -type f -name 'dontstarve_dedicated_server_nullrenderer*' -print -quit 2>/dev/null || true)"
      if [[ -n "$binary_path" ]]; then
        echo "- binary: present"
      else
        echo "> recursive binary search found no result within the 5s bound."
      fi
    else
      echo "> timeout not found; skipped recursive binary search."
    fi
  else
    echo "> find does not support -maxdepth; skipped recursive binary search."
  fi
fi
