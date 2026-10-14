#!/usr/bin/env bash
set -euo pipefail

HOST="${DST_HOST:-}"
SSH_USER="${DST_USER:-}"
OUT=""
LOCAL_DIR="${DST_LOCAL_DIR:-}"
NO_LOCAL="0"
NO_REMOTE="0"

usage() {
  cat <<'EOF'
Collect a non-sensitive DST troubleshooting snapshot (local client dir + remote dedicated server).

Usage:
  dst_snapshot.sh [--host <ip>] [--user <ssh-user>] [--out <path>] [--local-dir <path>] [--no-local] [--no-remote]

Defaults:
  --host      value from DST_HOST
  --user      value from DST_USER
  --local-dir value from DST_LOCAL_DIR
  --out       /tmp/dst-snapshot-<timestamp>.md

Notes:
  - Remote collection uses non-interactive SSH (`BatchMode=yes`) to avoid hanging.
  - Secrets are never printed; only existence/path is reported.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --user) SSH_USER="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --local-dir) LOCAL_DIR="${2:-}"; shift 2 ;;
    --no-local) NO_LOCAL="1"; shift ;;
    --no-remote) NO_REMOTE="1"; shift ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$NO_REMOTE" != "1" && -z "$HOST" ]]; then
  echo "error: --host or DST_HOST is required unless --no-remote is used" >&2
  exit 2
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
if [[ -z "$OUT" ]]; then
  OUT="/tmp/dst-snapshot-${timestamp}.md"
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

safe_head() {
  # usage: safe_head <n> <file>
  local n="$1"
  local file="$2"
  if [[ -f "$file" ]]; then
    head -n "$n" "$file"
  fi
}

safe_tail() {
  # usage: safe_tail <n> <file>
  local n="$1"
  local file="$2"
  if [[ -f "$file" ]]; then
    tail -n "$n" "$file"
  fi
}

local_collect() {
  {
    echo "## Local"
    echo
    echo "- Host: $(hostname)"
    echo "- Collected at: $(date -Iseconds)"
    echo "- Client data dir: \`${LOCAL_DIR:-<unset>}\`"
    echo

    if [[ -z "$LOCAL_DIR" || ! -d "$LOCAL_DIR" ]]; then
      echo "> Local dir not found. Skipping local collection."
      echo
      return 0
    fi

    echo "### Directory overview"
    echo
    (ls -la "$LOCAL_DIR" 2>/dev/null || true) | sed -n '1,200p'
    echo

    echo "### Known log files (first 200 lines of listing)"
    echo
    (ls -la "$LOCAL_DIR"/*log*.txt 2>/dev/null || true) | sed -n '1,200p'
    echo

    if [[ -f "$LOCAL_DIR/client_log.txt" ]]; then
      echo "### client_log.txt (tail 80)"
      echo
      safe_tail 80 "$LOCAL_DIR/client_log.txt"
      echo
    fi

    # Avoid printing cluster.ini because it may contain cluster_password.
    shopt -s nullglob
    local clusters=( "$LOCAL_DIR"/*/Cluster_* )
    shopt -u nullglob
    if (( ${#clusters[@]} > 0 )); then
      echo "### Local clusters (paths only; secrets redacted)"
      echo
      for cluster in "${clusters[@]}"; do
        [[ -d "$cluster" ]] || continue
        echo "- $cluster"
        if [[ -f "$cluster/cluster_token.txt" ]]; then
          echo "  - cluster_token.txt: present (redacted)"
        fi
        if [[ -f "$cluster/cluster.ini" ]]; then
          echo "  - cluster.ini: present (contains cluster_password; do not paste)"
        fi
      done
      echo
    fi
  }
}

remote_collect() {
  {
    echo "## Remote"
    echo
    echo "- Target: \`${SSH_USER}@${HOST}\`"
    echo

    if ! have_cmd ssh; then
      echo "> ssh not found on this machine. Skipping remote collection."
      echo
      return 0
    fi

    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "${SSH_USER}@${HOST}" 'echo ok' >/dev/null 2>&1; then
      echo "> Remote SSH failed (host down, wrong IP/port, or missing SSH key)."
      echo "> Next step: verify reachability and run \`ssh ${SSH_USER}@${HOST}\` interactively, then re-run this script."
      echo
      return 0
    fi

    ssh -o BatchMode=yes -o ConnectTimeout=5 "${SSH_USER}@${HOST}" 'bash -s' <<'EOF'
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
  # system-level units are readable without sudo on most distros; ignore failures.
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
  ps -eo pid,user,cmd | (grep -Ei 'dontstarve|steamcmd|screen|tmux' || true)
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
if [[ ! -d "$KLEI_DIR" ]]; then
  echo "> $KLEI_DIR not found."
  exit 0
fi

echo "- klei_dir: $KLEI_DIR"
echo
ls -la "$KLEI_DIR" | sed -n '1,200p'
echo

for cluster in "$KLEI_DIR"/*; do
  [[ -d "$cluster" ]] || continue
  echo "#### Cluster: $(basename "$cluster")"
  if [[ -f "$cluster/cluster.ini" ]]; then
    echo "- cluster.ini: present (contains cluster_password; do not paste)"
  fi
  if [[ -f "$cluster/cluster_token.txt" ]]; then
    echo "- cluster_token.txt: present (redacted)"
  fi
  for shard in Master Caves; do
    if [[ -d "$cluster/$shard" ]]; then
      echo "- $shard/: present"
      for f in server.ini modoverrides.lua server_log.txt server_chat_log.txt; do
        if [[ -f "$cluster/$shard/$f" ]]; then
          # Avoid printing file content; show metadata only.
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

if [[ "$found" == "0" ]]; then
  if have_cmd find; then
    echo "- find (maxdepth 6 under ~):"
    find "$HOME" -maxdepth 6 -type f -name 'dontstarve_dedicated_server_nullrenderer*' -print 2>/dev/null | sed -n '1,10p'
  fi
fi
EOF
    echo
  }
}

{
  echo "# DST snapshot"
  echo
  echo "- Generated: $(date -Iseconds)"
  echo "- Remote: ${SSH_USER}@${HOST}"
  echo "- Local dir: ${LOCAL_DIR:-<unset>}"
  echo

  if [[ "$NO_LOCAL" == "1" ]]; then
    echo "## Local"
    echo
    echo "> Skipped (--no-local)."
    echo
  else
    local_collect
  fi

  if [[ "$NO_REMOTE" == "1" ]]; then
    echo "## Remote"
    echo
    echo "> Skipped (--no-remote)."
    echo
  else
    remote_collect
  fi
} >"$OUT"

echo "$OUT"
