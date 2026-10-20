#!/usr/bin/env bash
set -euo pipefail

have_cmd() { command -v "$1" >/dev/null 2>&1; }

echo "### Identity"
echo
echo "- hostname: $(hostname)"
echo "- whoami: $(whoami)"
echo "- kernel: $(uname -a)"
if [[ -f /etc/os-release ]]; then
  echo "- os-release:"
  sed -n '1,10p' /etc/os-release | sed 's/^/  - /'
fi
echo

echo "### Resources"
echo
if have_cmd uptime; then echo "- uptime: $(uptime)"; fi
if have_cmd df; then df -h "$HOME" 2>/dev/null || df -h; fi
if have_cmd free; then free -h || true; fi
echo

echo "### systemd (best-effort)"
echo
if have_cmd systemctl; then
  systemctl status dst-master dst-caves --no-pager 2>/dev/null | sed -n '1,120p' || true
else
  echo "> systemctl not found."
fi
echo

echo "### Listening ports (best-effort)"
echo
if have_cmd ss; then
  ss -ltnup 2>/dev/null | (grep -E ':(22|10999|11000|27018|27019|8768|8769)\\b' || true)
else
  echo "> ss not found."
fi
echo

echo "### Processes (dontstarve/steamcmd/screen/tmux)"
echo
if have_cmd ps; then
  ps -eo pid,user,cmd | grep -Ei 'dontstarve|steamcmd|screen|tmux' | head -n 120 || true
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
    echo "- $f"
  fi
done
echo

echo "### Backups (paths only)"
echo
if [[ -d "$HOME/backups" ]]; then
  ls -la "$HOME/backups" | sed -n '1,120p'
else
  echo "> $HOME/backups not found."
fi
echo

echo "### Klei data (paths only; secrets redacted)"
echo
KLEI_DIR="$HOME/.klei/DoNotStarveTogether"
if [[ ! -d "$HOME/.klei" || -L "$HOME/.klei" || ! -d "$KLEI_DIR" || -L "$KLEI_DIR" ]]; then
  echo "> $KLEI_DIR not found."
  exit 0
fi

echo "- klei_dir: $KLEI_DIR"
echo
ls -la "$KLEI_DIR" | sed -n '1,200p'
echo

for cluster in "$KLEI_DIR"/*; do
  [[ -d "$cluster" && ! -L "$cluster" ]] || continue
  echo "#### Cluster: $(basename "$cluster")"
  if [[ -f "$cluster/cluster.ini" ]]; then
    echo "- cluster.ini: present (contains cluster_password; do not paste)"
  fi
  if [[ -f "$cluster/cluster_token.txt" ]]; then
    echo "- cluster_token.txt: present (redacted)"
  fi
  for shard in Master Caves; do
    if [[ -d "$cluster/$shard" && ! -L "$cluster/$shard" ]]; then
      echo "- $shard/: present"
      for f in server.ini modoverrides.lua server_log.txt server_chat_log.txt; do
        if [[ -f "$cluster/$shard/$f" ]]; then
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
done

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
    echo "- candidate_dir: $p"
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
    echo "- find (maxdepth 6 under ~):"
    find "$HOME" -maxdepth 6 -type f -name 'dontstarve_dedicated_server_nullrenderer*' -print 2>/dev/null | sed -n '1,10p'
  else
    echo "> find does not support -maxdepth; skipped recursive binary search."
  fi
fi
