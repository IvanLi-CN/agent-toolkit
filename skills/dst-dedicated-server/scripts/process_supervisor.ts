import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, rmdir, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SUPERVISOR_CLEANUP_TIMEOUT_MS = 60_000;
const SUPERVISOR_CLEANUP_ACK_SETTLE_MS = 15_000;
const SUPERVISOR_CLEANUP_DEADLINE_SECONDS = Math.ceil(SUPERVISOR_CLEANUP_TIMEOUT_MS / 1_000);
export const SUPERVISOR_UNKNOWN_TARGET_STATUS = 125;
const MAX_SUPERVISOR_MARKER_BYTES = 256;

const SUPERVISOR_SCRIPT = `
set +e
set +m 2>/dev/null || true
status_path="$1"
shift
status_dir="$(dirname -- "$status_path")"
target_marker="\${AGENT_TOOLKIT_TARGET_MARKER:-unbound}"
completion_proof="\${AGENT_TOOLKIT_SUPERVISOR_COMPLETION_TOKEN:-}"
supervisor_pid="$$"
ready_path="$status_dir/ready"
cleanup_ack_path="\${AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH:-$status_dir/cleanup-done}"
cleanup_failure_path="$cleanup_ack_path.failed"
unset AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH
cleanup_ack_enabled=1
captured_descendants_path="$status_dir/descendants"
pending_descendants_path="$status_dir/descendant-pids"
snapshot_started_path="$status_dir/snapshot-started"
snapshot_ready_path="$status_dir/snapshot-ready"
snapshot_finished_path="$status_dir/snapshot-finished"
snapshot_failed_path="$status_dir/snapshot-failed"
snapshot_generation=0
snapshot_ready_observed=0
snapshot_deadline_epoch=0
descendant_scan_truncated_path="$status_dir/descendant-scan-truncated"
descendant_scan_failed_path="$status_dir/descendant-scan-failed"
descendant_scan_input_path="$status_dir/descendant-scan-input"
descendant_scan_status_path="$status_dir/descendant-scan-status"
parent_dead_path="$status_dir/parent-dead"
read_regular_marker() {
  marker_path="$1"
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  run_process_probe perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_RDONLY O_NONBLOCK);
    my ($path, $max) = @ARGV;
    my @path_stat = lstat($path);
    exit 1 unless @path_stat && (($path_stat[2] & 0170000) == 0100000);
    my $nofollow = eval { Fcntl::O_NOFOLLOW() };
    exit 1 unless defined $nofollow;
    sysopen(my $fh, $path, O_RDONLY | O_NONBLOCK | $nofollow) or exit 1;
    my @opened = stat($fh);
    exit 1 unless @opened && (($opened[2] & 0170000) == 0100000);
    exit 1 unless $opened[0] == $path_stat[0] && $opened[1] == $path_stat[1] && $opened[7] <= $max;
    my $data = "";
    while (length($data) <= $max) {
      my $read = sysread($fh, my $chunk, $max + 1 - length($data));
      exit 1 unless defined $read;
      last if $read == 0;
      $data .= $chunk;
    }
    my @final = stat($fh);
    exit 1 unless @final && $final[0] == $opened[0] && $final[1] == $opened[1] && $final[7] == $opened[7] && length($data) == $opened[7] && length($data) <= $max;
    binmode STDOUT;
    print $data;
  ' "$marker_path" 256
}
write_marker_exclusive() {
  marker_path="$1"
  marker_value="$2"
  (set -C; umask 077; printf '%s\\n' "$marker_value" > "$marker_path") 2>/dev/null
}
create_marker_exclusive() {
  marker_path="$1"
  (set -C; umask 077; : > "$marker_path") 2>/dev/null
}
ensure_marker() {
  marker_path="$1"
  if [ -e "$marker_path" ]; then
    [ -f "$marker_path" ] && [ ! -L "$marker_path" ]
    return $?
  fi
  create_marker_exclusive "$marker_path"
}
cleanup() {
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ] || [ -e "$snapshot_failed_path" ]; then cleanup_ack_enabled=0; fi
  cleanup_ack_created=0
  cleanup_failure_created=0
  if [ "$cleanup_ack_enabled" = "1" ] && [ ! -e "$parent_dead_path" ]; then
    if mkdir "$cleanup_ack_path" 2>/dev/null; then
      cleanup_ack_created=1
    elif mkdir "$cleanup_failure_path" 2>/dev/null; then
      cleanup_failure_created=1
    fi
  else
    if [ ! -e "$parent_dead_path" ] && mkdir "$cleanup_failure_path" 2>/dev/null; then
      cleanup_failure_created=1
    else
      rmdir "$(dirname -- "$cleanup_ack_path")" 2>/dev/null || true
    fi
  fi
  if [ "$cleanup_ack_created" = "1" ] || [ "$cleanup_failure_created" = "1" ]; then
    cleanup_marker_path="$cleanup_ack_path"
    [ "$cleanup_failure_created" = "1" ] && cleanup_marker_path="$cleanup_failure_path"
    if command -v parent_is_alive >/dev/null 2>&1; then
      cleanup_wait=0
      while [ -d "$cleanup_marker_path" ] && [ "$cleanup_wait" -lt 1500 ]; do
        if [ -e "$parent_dead_path" ] || ! parent_is_alive; then
          ensure_marker "$parent_dead_path" || true
          break
        fi
        sleep 0.05
        cleanup_wait=$((cleanup_wait + 1))
      done
    fi
  fi
  if [ -e "$parent_dead_path" ]; then
    rm -rf -- "$status_dir"
    rmdir "$(dirname -- "$cleanup_ack_path")" 2>/dev/null || true
  fi
}
run_bounded() {
  bounded_seconds="$1"
  shift
  if command -v perl >/dev/null 2>&1; then
    perl -e 'my $seconds = shift @ARGV; alarm $seconds; exec @ARGV or exit 127' "$bounded_seconds" "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$bounded_seconds" "$@"
    return $?
  fi
  return 125
}
run_process_probe() {
  # Keep ordinary probes cheap; cleanup activates the bounded path explicitly.
  if [ "\${snapshot_deadline_epoch:-0}" -gt 0 ]; then
    run_bounded 2 "$@"
  else
    "$@"
  fi
}
run_watchdog_probe() {
  run_bounded 1 "$@"
}
run_snapshot_command() {
  run_process_probe "$@"
}
ps_identity_for_pid() {
  ps_identity_pid="$1"
  ps_identity_runner=run_process_probe
  [ "\${2:-}" = "watchdog" ] && ps_identity_runner=run_watchdog_probe
  ps_identity_start="$(LC_ALL=C $ps_identity_runner ps -o lstart= -p "$ps_identity_pid" 2>/dev/null | $ps_identity_runner awk '
    $1 ~ /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/ &&
    $2 ~ /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/ &&
    $3 ~ /^[0-9][0-9]*$/ &&
    $4 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ &&
    $5 ~ /^[0-9][0-9][0-9][0-9]$/ { print $1, $2, $3, $4, $5; exit }
  ')"
  ps_identity_pgid="$($ps_identity_runner ps -o pgid= -p "$ps_identity_pid" 2>/dev/null | $ps_identity_runner awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
  ps_identity_ppid="$($ps_identity_runner ps -o ppid= -p "$ps_identity_pid" 2>/dev/null | $ps_identity_runner awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
  ps_identity_command_hash="$($ps_identity_runner ps -o command= -p "$ps_identity_pid" 2>/dev/null | $ps_identity_runner cksum | $ps_identity_runner awk 'NR == 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1 ":" $2; exit }')"
  # macOS does not expose /proc start ticks. Bind the second-resolution start
  # time to the original parent, group, and command. Captured descendants may
  # later be reparented to launchd, which is handled by captured_identity_matches.
  if [ -n "$ps_identity_start" ] && [ -n "$ps_identity_pgid" ] && [ -n "$ps_identity_ppid" ] && [ -n "$ps_identity_command_hash" ]; then
    printf 'ps:%s;ppid=%s;pgid=%s;cmd=%s\n' "$ps_identity_start" "$ps_identity_ppid" "$ps_identity_pgid" "$ps_identity_command_hash"
    return 0
  fi
  return 1
}
parent_pid="\${AGENT_TOOLKIT_SUPERVISOR_PARENT_PID:-\$PPID}"
parent_starttime=""
parent_identity_mode="unknown"
parent_ps_start=""
if [ -r "/proc/$parent_pid/stat" ]; then
  parent_starttime="$(run_process_probe awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$parent_pid/stat" 2>/dev/null || true)"
  if [ -n "$parent_starttime" ]; then parent_identity_mode="proc"; fi
fi
if [ "$parent_identity_mode" != "proc" ]; then
  parent_ps_start="$(ps_identity_for_pid "$parent_pid" 2>/dev/null || true)"
  if [ -n "$parent_ps_start" ]; then parent_identity_mode="ps"; fi
fi
target_status_path="$status_dir/target-status"
target_status_writer_path="$status_dir/target-status-writer"
completion_path="$status_dir/completed"
target_start_path="$status_dir/target-start"
target_anchor_path="$status_dir/target"
target_pgid_path="$status_dir/target-pgid"
target_identity_path="$status_dir/target-identity"
target_pgid=""
target_pid=""
group_quiescence_required=0
quiesced_groups_path="$status_dir/quiesced-groups"
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c '
    anchor_path="$1"
    result_path="$2"
    start_path="$3"
    writer_path="$4"
    shift 4
    completion_proof="\${AGENT_TOOLKIT_SUPERVISOR_COMPLETION_TOKEN:-}"
    unset AGENT_TOOLKIT_SUPERVISOR_COMPLETION_TOKEN
    trap ':' HUP INT TERM
    if ! (set -C; umask 077; printf "%s\\n" "$$" > "$anchor_path") 2>/dev/null; then exit 125; fi
    while [ ! -e "$start_path" ]; do sleep 0.01; done
    "$@" &
    target_pid=$!
    wait "$target_pid"
    target_status=$?
    if ! (set -C; umask 077; printf "%s\\n" "$$" > "$writer_path") 2>/dev/null; then exit 125; fi
    if ! (set -C; umask 077; printf "%s\\n" "$target_status" > "$result_path") 2>/dev/null; then exit 125; fi
    exec 0<&- 1>&- 2>&-
    while :; do sleep 1; done
  ' "agent-toolkit-target-$target_marker" "$target_anchor_path" "$target_status_path" "$target_start_path" "$target_status_writer_path" "$@" &
else
  set -m 2>/dev/null || true
  sh -c '
    anchor_path="$1"
    result_path="$2"
    start_path="$3"
    writer_path="$4"
    shift 4
    completion_proof="\${AGENT_TOOLKIT_SUPERVISOR_COMPLETION_TOKEN:-}"
    unset AGENT_TOOLKIT_SUPERVISOR_COMPLETION_TOKEN
    trap ':' HUP INT TERM
    if ! (set -C; umask 077; printf "%s\\n" "$$" > "$anchor_path") 2>/dev/null; then exit 125; fi
    while [ ! -e "$start_path" ]; do sleep 0.01; done
    "$@" &
    target_pid=$!
    wait "$target_pid"
    target_status=$?
    if ! (set -C; umask 077; printf "%s\\n" "$$" > "$writer_path") 2>/dev/null; then exit 125; fi
    if ! (set -C; umask 077; printf "%s\\n" "$target_status" > "$result_path") 2>/dev/null; then exit 125; fi
    exec 0<&- 1>&- 2>&-
    while :; do sleep 1; done
  ' "agent-toolkit-target-$target_marker" "$target_anchor_path" "$target_status_path" "$target_start_path" "$target_status_writer_path" "$@" &
fi
unset AGENT_TOOLKIT_SUPERVISOR_COMPLETION_TOKEN
target_launcher_pid=$!
target_pid="$target_launcher_pid"
target_anchor_attempt=0
while [ "$target_anchor_attempt" -lt 500 ]; do
  candidate_target_pid="$(read_regular_marker "$target_anchor_path" 2>/dev/null || true)"
  case "$candidate_target_pid" in
    ''|*[!0-9]*) sleep 0.01; target_anchor_attempt=$((target_anchor_attempt + 1)) ;;
    *) target_pid="$candidate_target_pid"; break ;;
  esac
done
if [ -z "$target_pid" ]; then target_pid="$target_launcher_pid"; fi
target_pgid_attempt=0
while [ "$target_pgid_attempt" -lt 100 ]; do
  observed_target_pgid="$(run_process_probe ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  case "$observed_target_pgid" in
    ''|*[!0-9]*) sleep 0.01; target_pgid_attempt=$((target_pgid_attempt + 1)) ;;
    *) target_pgid="$observed_target_pgid"; break ;;
  esac
done
capture_target_identity() {
  target_identity_mode="unknown"
  target_starttime=""
  target_ps_start=""
  if [ -r "/proc/$target_pid/stat" ]; then
    target_starttime="$(run_process_probe awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    if [ -n "$target_starttime" ]; then
      target_identity_mode="proc"
      return 0
    fi
  fi
  target_ps_start="$(ps_identity_for_pid "$target_pid" 2>/dev/null || true)"
  if [ -n "$target_ps_start" ]; then
    target_identity_mode="ps"
    return 0
  fi
  return 1
}
capture_target_identity || true
if [ "$target_identity_mode" = "unknown" ]; then
  cleanup_ack_enabled=0
  case "$target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$target_pgid" = "$target_launcher_pid" ]; then
        kill -TERM "-$target_pgid" 2>/dev/null || true
        sleep 0.25
        kill -KILL "-$target_pgid" 2>/dev/null || true
      fi
      ;;
  esac
  kill -TERM "$target_launcher_pid" 2>/dev/null || true
  sleep 0.25
  kill -KILL "$target_launcher_pid" 2>/dev/null || true
  cleanup
  exit 143
fi
case "$target_pgid" in
  ''|*[!0-9]*)
    cleanup_ack_enabled=0
    kill -TERM "$target_launcher_pid" 2>/dev/null || true
    sleep 0.25
    kill -KILL "$target_launcher_pid" 2>/dev/null || true
    cleanup
    exit 143
    ;;
esac
record_target_reference() {
  write_marker_exclusive "$target_pgid_path" "$target_pgid" || return 1
  case "$target_identity_mode" in
    proc) write_marker_exclusive "$target_identity_path" "proc:$target_starttime" ;;
    ps) write_marker_exclusive "$target_identity_path" "$target_ps_start" ;;
    *) return 1 ;;
  esac
}
if ! record_target_reference; then
  cleanup_ack_enabled=0
  cleanup
  exit 143
fi
target_identity_matches() {
  if [ "$target_identity_mode" = "proc" ] && [ -r "/proc/$target_pid/stat" ]; then
    current_target_start="$(run_process_probe awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    [ -n "$current_target_start" ] && [ "$current_target_start" = "$target_starttime" ]
    return
  fi
  if [ "$target_identity_mode" = "ps" ]; then
    current_target_ps_start="$(ps_identity_for_pid "$target_pid" 2>/dev/null || true)"
    [ -n "$current_target_ps_start" ] && captured_identity_matches "$target_ps_start" "$current_target_ps_start"
    return
  fi
  return 1
}
target_is_alive() {
  if ! target_identity_matches; then return 1; fi
  if [ -r "/proc/$target_pid/stat" ]; then
    target_state="$(run_process_probe awk '{ sub(/.*\) /, ""); print $1 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    [ -n "$target_state" ] && [ "$target_state" != "Z" ] && kill -0 "$target_pid" 2>/dev/null
    return
  fi
  kill -0 "$target_pid" 2>/dev/null
}
stop_anchor() {
  if target_identity_matches; then
    anchor_pgid="$(run_process_probe ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
    wrapper_pgid="$(run_process_probe ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
    case "$anchor_pgid" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$anchor_pgid" != "$wrapper_pgid" ]; then
          kill -TERM "-$anchor_pgid" 2>/dev/null || true
          if target_identity_matches; then kill -KILL "-$anchor_pgid" 2>/dev/null || true; fi
        fi
        ;;
    esac
    if target_identity_matches; then
      kill -TERM "$target_pid" 2>/dev/null || true
      if target_identity_matches; then kill -KILL "$target_pid" 2>/dev/null || true; fi
    fi
    if ! wait_for_process_dead "$target_pid"; then cleanup_ack_enabled=0; fi
  fi
}
snapshot_deadline_exceeded() {
  [ "\${snapshot_deadline_epoch:-0}" -gt 0 ] || return 1
  snapshot_now="$(date +%s 2>/dev/null || true)"
  case "$snapshot_now" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$snapshot_now" -ge "$snapshot_deadline_epoch" ]
}
set_snapshot_deadline() {
  [ "\${snapshot_deadline_epoch:-0}" -gt 0 ] && return 0
  snapshot_now="$(date +%s 2>/dev/null || true)"
  case "$snapshot_now" in
    ''|*[!0-9]*) snapshot_deadline_epoch=1 ;;
    *) snapshot_deadline_epoch=$((snapshot_now + ${SUPERVISOR_CLEANUP_DEADLINE_SECONDS})) ;;
  esac
}
process_identity() {
  process_id="$1"
  if [ -r "/proc/$process_id/stat" ]; then
    process_starttime="$(run_snapshot_command awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$process_id/stat" 2>/dev/null || true)"
    if [ -n "$process_starttime" ]; then
      printf 'proc:%s\n' "$process_starttime"
      return 0
    fi
  fi
  process_ps_identity="$(ps_identity_for_pid "$process_id" 2>/dev/null || true)"
  if [ -n "$process_ps_identity" ]; then
    printf '%s\n' "$process_ps_identity"
    return 0
  fi
  return 1
}
process_liveness_result=""
process_state_for_pid() {
  process_state_pid="$1"
  run_snapshot_command ps -o state= -p "$process_state_pid" 2>/dev/null | run_snapshot_command awk '{
    gsub(/[[:space:]]/, "")
    if ($0 ~ /^[[:alpha:]]/) { print substr($0, 1, 1); exit }
    if ($0 ~ /^\?/) { print "?"; exit }
  }'
}
process_liveness() {
  process_id="$1"
  process_state=""
  if [ -r "/proc/$process_id/stat" ]; then
    process_state="$(run_snapshot_command awk '{ sub(/.*\) /, ""); print $1 }' "/proc/$process_id/stat" 2>/dev/null || true)"
  else
    process_state="$(process_state_for_pid "$process_id")"
  fi
  case "$process_state" in
    Z*) process_liveness_result=dead; return 0 ;;
    '')
      if kill -0 "$process_id" 2>/dev/null; then
        process_liveness_result=unknown
      else
        process_probe="$(run_snapshot_command ps -p "$process_id" -o pid= 2>/dev/null | run_snapshot_command awk 'NR == 1 { gsub(/[[:space:]]/, ""); print; exit }')"
        if [ -n "$process_probe" ] || [ -e "/proc/$process_id" ]; then
          process_liveness_result=unknown
        else
          process_liveness_result=dead
        fi
      fi
      return 0
      ;;
  esac
  if ! kill -0 "$process_id" 2>/dev/null; then
    if [ -r "/proc/$process_id/stat" ]; then
      process_state_after="$(run_snapshot_command awk '{ sub(/.*\) /, ""); print $1 }' "/proc/$process_id/stat" 2>/dev/null || true)"
    else
      process_state_after="$(process_state_for_pid "$process_id")"
    fi
    case "$process_state_after" in
      Z*) process_liveness_result=dead ;;
      \?*)
        process_probe="$(run_snapshot_command ps -p "$process_id" -o pid= 2>/dev/null | run_snapshot_command awk 'NR == 1 { gsub(/[[:space:]]/, ""); print; exit }')"
        if [ -n "$process_probe" ] || [ -e "/proc/$process_id" ]; then process_liveness_result=unknown; else process_liveness_result=dead; fi
        ;;
      '')
        process_probe="$(run_snapshot_command ps -p "$process_id" -o pid= 2>/dev/null | run_snapshot_command awk 'NR == 1 { gsub(/[[:space:]]/, ""); print; exit }')"
        if [ -n "$process_probe" ] || [ -e "/proc/$process_id" ]; then process_liveness_result=unknown; else process_liveness_result=dead; fi
        ;;
      *) process_liveness_result=unknown ;;
    esac
    return 0
  fi
  if process_identity "$process_id" >/dev/null 2>&1; then process_liveness_result=live; else process_liveness_result=unknown; fi
}
wait_for_process_dead() {
  process_wait_pid="$1"
  process_wait_attempt=0
  while [ "$process_wait_attempt" -lt 20 ]; do
    if snapshot_deadline_exceeded; then return 1; fi
    process_liveness "$process_wait_pid"
    case "$process_liveness_result" in
      dead) return 0 ;;
      live|unknown) sleep 0.025 ;;
      *) sleep 0.025 ;;
    esac
    process_wait_attempt=$((process_wait_attempt + 1))
  done
  if snapshot_deadline_exceeded; then return 1; fi
  process_liveness "$process_wait_pid"
  [ "$process_liveness_result" = "dead" ]
}
identity_is_valid() {
  case "$1" in
    proc:*|ps:*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *"|"*|*"
"*) return 1 ;;
  esac
}
captured_process_can_be_signaled() {
  case "$1" in
    proc:*) return 0 ;;
    ps:*';ppid='*';pgid='*';cmd='*)
      # Darwin has only second-resolution start times. Permit a ps identity
      # only when its original parent was the fixed target or a captured child.
      [ "$1" = "$target_ps_start" ] && return 0
      captured_ps_identity="\${1#ps:}"
      captured_ps_ppid="\${captured_ps_identity#*;ppid=}"
      captured_ps_ppid="\${captured_ps_ppid%%;pgid=*}"
      captured_ps_pgid="\${captured_ps_identity#*;pgid=}"
      captured_ps_pgid="\${captured_ps_pgid%%;cmd=*}"
      captured_ps_command_hash="\${captured_ps_identity#*;cmd=}"
      case "$captured_ps_ppid" in ''|*[!0-9]*) return 1 ;; esac
      case "$captured_ps_pgid" in ''|*[!0-9]*) return 1 ;; esac
      case "$captured_ps_command_hash" in ''|*[!0-9:]*) return 1 ;; esac
      case "$captured_ps_ppid" in
        "$target_pid") return 0 ;;
        0|1)
          # A Darwin child can be reparented to launchd before cleanup. Use
          # the immutable capture record to prove that it originally belonged
          # to the fixed target or another captured descendant, and require
          # the current PGID to remain the captured PGID.
          captured_expected_identity="$(captured_identity_for_pid "$captured_pid" 2>/dev/null || true)"
          captured_expected_parts="\${captured_expected_identity#ps:}"
          captured_expected_ppid="\${captured_expected_parts#*;ppid=}"
          captured_expected_ppid="\${captured_expected_ppid%%;pgid=*}"
          captured_expected_pgid="\${captured_expected_parts#*;pgid=}"
          captured_expected_pgid="\${captured_expected_pgid%%;cmd=*}"
          case "$captured_expected_ppid" in
            "$target_pid") [ "$captured_expected_pgid" = "$captured_ps_pgid" ] && return 0 ;;
            0|1|''|*[!0-9]*) return 1 ;;
            *)
              if [ -f "$captured_descendants_path" ] && awk -F'|' -v pid="$captured_expected_ppid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' "$captured_descendants_path" >/dev/null 2>&1; then
                [ "$captured_expected_pgid" = "$captured_ps_pgid" ] && return 0
              fi
              ;;
          esac
          return 1
          ;;
        ''|*[!0-9]*) return 1 ;;
      esac
      if [ -f "$captured_descendants_path" ] && awk -F'|' -v pid="$captured_ps_ppid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' "$captured_descendants_path" >/dev/null 2>&1; then
        return 0
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}
captured_identity_matches() {
  captured_expected_identity="$1"
  captured_current_identity="$2"
  [ "$captured_expected_identity" = "$captured_current_identity" ] && return 0
  case "$captured_expected_identity" in
    ps:*';ppid='*';pgid='*';cmd='*) ;;
    *) return 1 ;;
  esac
  case "$captured_current_identity" in
    ps:*';ppid='*';pgid='*';cmd='*) ;;
    *) return 1 ;;
  esac
  captured_expected_parts="\${captured_expected_identity#ps:}"
  captured_current_parts="\${captured_current_identity#ps:}"
  captured_expected_start="\${captured_expected_parts%%;ppid=*}"
  captured_current_start="\${captured_current_parts%%;ppid=*}"
  [ "$captured_expected_start" = "$captured_current_start" ] || return 1
  captured_expected_ppid="\${captured_expected_parts#*;ppid=}"
  captured_expected_ppid="\${captured_expected_ppid%%;pgid=*}"
  captured_current_ppid="\${captured_current_parts#*;ppid=}"
  captured_current_ppid="\${captured_current_ppid%%;pgid=*}"
  captured_expected_pgid="\${captured_expected_parts#*;pgid=}"
  captured_expected_pgid="\${captured_expected_pgid%%;cmd=*}"
  captured_current_pgid="\${captured_current_parts#*;pgid=}"
  captured_current_pgid="\${captured_current_pgid%%;cmd=*}"
  captured_expected_command_hash="\${captured_expected_parts#*;cmd=}"
  captured_current_command_hash="\${captured_current_parts#*;cmd=}"
  [ "$captured_expected_pgid" = "$captured_current_pgid" ] || return 1
  [ "$captured_expected_command_hash" = "$captured_current_command_hash" ] || return 1
  case "$captured_current_ppid" in
    0|1) return 0 ;;
    *) return 1 ;;
  esac
}
normalize_process_identity() {
  normalized_identity="$(printf '%s\n' "$1" | run_process_probe awk '/^(proc|ps):/ { print; exit }')"
  if identity_is_valid "$normalized_identity"; then
    printf '%s\n' "$normalized_identity"
  else
    return 1
  fi
}
process_group_id() {
  process_group="$(run_process_probe ps -o pgid= -p "$1" 2>/dev/null | run_process_probe awk '{ gsub(/[[:space:]]/, ""); if ($0 ~ /^[1-9][0-9]*$/) { print; exit } }')"
  case "$process_group" in
    ''|0|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$process_group" ;;
  esac
}
capture_group_members() {
  captured_group="$1"
  case "$captured_group" in ''|0|*[!0-9]*) return 1 ;; esac
  captured_group_probe_path="$status_dir/group-probe-$captured_group"
  captured_group_members_path="$status_dir/group-members-$captured_group"
  captured_group_probe_attempt=0
  captured_group_probe_status=2
  while [ "$captured_group_probe_attempt" -lt 3 ]; do
    run_process_probe ps -eo pid=,pgid=,state= > "$captured_group_probe_path" 2>/dev/null
    captured_group_probe_status=$?
    if [ "$captured_group_probe_status" -eq 0 ]; then
      captured_group_probe_status=0
      break
    fi
    captured_group_probe_attempt=$((captured_group_probe_attempt + 1))
    if snapshot_deadline_exceeded; then break; fi
    sleep 0.01
  done
  [ "$captured_group_probe_status" -eq 0 ] || return 2
  if ! run_process_probe awk -v wanted="$captured_group" '
    $2 != wanted { next }
    NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[[:alpha:]]/ { malformed = 1; next }
    { print $1 "|" $3 }
    END { if (malformed) exit 2 }
  ' "$captured_group_probe_path" > "$captured_group_members_path"; then
    return 2
  fi
  return 0
}
captured_group_has_live_process() {
  captured_group="$1"
  capture_group_members "$captured_group"
  captured_group_probe_status=$?
  [ "$captured_group_probe_status" -eq 0 ] || return "$captured_group_probe_status"
  run_process_probe awk -F'|' '$2 !~ /^Z/ { found = 1; exit } END { exit(found ? 0 : 1) }' "$captured_group_members_path"
}
captured_group_can_be_signaled() {
  captured_group_identity="$1"
  captured_group="$2"
  captured_group_allow_target="\${3:-}"
  captured_process_can_be_signaled "$captured_group_identity" || return 1
  capture_group_members "$captured_group"
  captured_group_probe_status=$?
  [ "$captured_group_probe_status" -eq 0 ] || return "$captured_group_probe_status"
  captured_group_live_count=0
  captured_group_anchor_count=0
  captured_group_missing_member=0
  captured_group_owner_start=""
  captured_group_owner_identity="$(captured_identity_for_pid "$captured_group" 2>/dev/null || true)"
  case "$captured_group_owner_identity" in
    proc:*)
      captured_group_owner_start="\${captured_group_owner_identity#proc:}"
      case "$captured_group_owner_start" in ''|*[!0-9]*) captured_group_owner_start="" ;; esac
      [ "$captured_group_owner_identity" = "$captured_group_identity" ] || captured_group_owner_start=""
      ;;
  esac
  while IFS='|' read -r group_member_pid group_member_state; do
    if snapshot_deadline_exceeded; then return 2; fi
    [ -n "$group_member_pid$group_member_state" ] || continue
    case "$group_member_pid" in ''|*[!0-9]*) return 2 ;; esac
    case "$group_member_state" in Z*) continue ;; esac
    if [ "$group_member_pid" = "$target_pid" ] && [ "$captured_group_allow_target" = "allow-target" ]; then
      target_identity_matches || return 1
      captured_group_live_count=$((captured_group_live_count + 1))
      continue
    fi
    process_liveness "$group_member_pid"
    case "$process_liveness_result" in
      dead) continue ;;
      live) ;;
      *) return 2 ;;
    esac
    expected_group_member_identity="$(captured_identity_for_pid "$group_member_pid" 2>/dev/null || true)"
    current_group_member_identity="$(process_identity "$group_member_pid" 2>/dev/null || true)"
    current_group_member_identity="$(normalize_process_identity "$current_group_member_identity" 2>/dev/null || true)"
    if ! identity_is_valid "$current_group_member_identity"; then
      process_liveness "$group_member_pid"
      case "$process_liveness_result" in
        dead) continue ;;
        *) return 2 ;;
      esac
    fi
    current_group_member_pgid="$(process_group_id "$group_member_pid" 2>/dev/null || true)"
    if [ -z "$current_group_member_pgid" ]; then
      process_liveness "$group_member_pid"
      case "$process_liveness_result" in
        dead) continue ;;
        *) return 2 ;;
      esac
    fi
    if [ "$current_group_member_pgid" != "$captured_group" ]; then
      return 1
    fi
    if ! identity_is_valid "$expected_group_member_identity"; then
      case "$current_group_member_identity:$captured_group_owner_start" in
        proc:*:*)
          current_group_member_start="\${current_group_member_identity#proc:}"
          case "$current_group_member_start" in
            ''|*[!0-9]*) return 1 ;;
            *) [ "$current_group_member_start" -gt "$captured_group_owner_start" ] || return 1 ;;
          esac
          captured_group_missing_member=1
          captured_group_live_count=$((captured_group_live_count + 1))
          continue
          ;;
        *) return 1 ;;
      esac
    fi
    if ! captured_identity_matches "$expected_group_member_identity" "$current_group_member_identity"; then
      return 1
    fi
    if [ "$group_quiescence_required" = "1" ]; then
      case "$group_member_state" in
        T*|t*) ;;
        *) return 1 ;;
      esac
      if awk -F'|' -v group="$captured_group" -v identity="$expected_group_member_identity" '$1 == group && $2 == identity { found = 1; exit } END { exit(found ? 0 : 1) }' "$quiesced_groups_path" 2>/dev/null; then
        captured_group_anchor_count=$((captured_group_anchor_count + 1))
      fi
    fi
    captured_group_live_count=$((captured_group_live_count + 1))
  done < "$captured_group_members_path" || return 2
  if [ "$group_quiescence_required" = "1" ] && [ "$captured_group_anchor_count" -eq 0 ]; then return 1; fi
  if [ "$captured_group_missing_member" = "1" ]; then
    if [ -z "$captured_group_owner_start" ]; then return 1; fi
    return 0
  fi
  [ "$captured_group_live_count" -gt 0 ]
}
descendants_for_roots() {
  descendant_roots="$1"
  descendant_groups="$2"
  if snapshot_deadline_exceeded; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  if ! run_snapshot_command ps -eo pid=,ppid=,pgid= > "$descendant_scan_input_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  if ! run_snapshot_command awk -v roots="$descendant_roots" -v groups="$descendant_groups" -v truncated_path="$descendant_scan_truncated_path" -v status_path="$descendant_scan_status_path" -v max_rows=65536 '
    BEGIN {
      root_count = split(roots, root_values, " ")
      for (root_index = 1; root_index <= root_count; root_index++) {
        if (root_values[root_index] != "") owned_root[root_values[root_index]] = 1
      }
      group_count = split(groups, group_values, " ")
      for (group_index = 1; group_index <= group_count; group_index++) {
        if (group_values[group_index] != "") owned_group[group_values[group_index]] = 1
      }
    }
    {
      total++
      if (total > max_rows) { overflow = 1; exit 2 }
      if ($1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/) { malformed = 1; next }
      parent[$1] = $2
      process_group[$1] = $3
    }
    function is_descendant(pid, current) {
      if (owned_group[process_group[pid]]) return 1
      current = parent[pid]
      delete seen
      while (current != "") {
        if (owned_root[current] || owned_group[process_group[current]]) return 1
        if (seen[current]++) return 0
        current = parent[current]
      }
      return 0
    }
    malformed { next }
    owned_root[$1] || owned_group[process_group[$1]] || is_descendant($1) {
      if (count < 1024) { print $1; count++ }
      else { truncated = 1 }
    }
    END {
      if (overflow || malformed) exit 2
      if (truncated) { print "1" > truncated_path; close(truncated_path) }
      print (truncated ? "truncated" : "ok") > status_path
      close(status_path)
    }
  ' < "$descendant_scan_input_path"; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  scan_status="$(read_regular_marker "$descendant_scan_status_path" 2>/dev/null || true)"
  case "$scan_status" in
    ok) return 0 ;;
    truncated)
      if [ ! -e "$descendant_scan_truncated_path" ]; then
        cleanup_ack_enabled=0
        create_marker_exclusive "$descendant_scan_failed_path" || true
        return 1
      fi
      cleanup_ack_enabled=0
      return 0
      ;;
    *)
      cleanup_ack_enabled=0
      create_marker_exclusive "$descendant_scan_failed_path" || true
      return 1
      ;;
  esac
}
descendants() {
  target_roots=""
  if target_identity_matches; then
    target_roots="$target_pid"
  else
    process_liveness "$target_pid"
    case "$process_liveness_result" in
      dead) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
  fi
  descendants_for_roots "$target_roots" ""
}
owned_descendants() {
  owned_roots=""
  owned_groups=""
  if target_identity_matches; then
    owned_roots="$target_pid"
    if target_is_alive; then
      target_group_for_scan="$(process_group_id "$target_pid" 2>/dev/null || true)"
      case "$target_group_for_scan" in
        ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;;
        *)
          if [ "$target_group_for_scan" = "$wrapper_pgid" ]; then cleanup_ack_enabled=0; return 1; fi
          owned_groups="$target_group_for_scan"
          ;;
      esac
    fi
  else
    process_liveness "$target_pid"
    case "$process_liveness_result" in
      dead) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
  fi
  if [ -f "$captured_descendants_path" ]; then
    while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
      [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
      case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
      [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
      identity_is_valid "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
      case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
      owned_roots="$owned_roots $captured_pid"
      if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
      if [ "$captured_pgid" = "$wrapper_pgid" ] || [ "$captured_pgid" = "$target_pgid" ]; then continue; fi
      process_liveness "$captured_pid"
      case "$process_liveness_result" in
        dead)
          captured_group_has_live_process "$captured_pgid"
          captured_group_live_status=$?
          case "$captured_group_live_status" in
            0)
              captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
              captured_group_signal_status=$?
              if [ "$captured_group_signal_status" -eq 0 ]; then
                owned_groups="$owned_groups $captured_pgid"
              else
                cleanup_ack_enabled=0
                return 1
              fi
              ;;
            1) ;;
            *) cleanup_ack_enabled=0; return 1 ;;
          esac
          continue
          ;;
        live) ;;
        *) cleanup_ack_enabled=0; return 1 ;;
      esac
      current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
      current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
      current_captured_pgid="$(process_group_id "$captured_pid" 2>/dev/null || true)"
      if ! captured_identity_matches "$captured_identity" "$current_captured_identity" || [ "$current_captured_pgid" != "$captured_pgid" ]; then
        cleanup_ack_enabled=0
        return 1
      fi
      if [ "$captured_pgid" != "$wrapper_pgid" ]; then owned_groups="$owned_groups $captured_pgid"; fi
    done < "$captured_descendants_path" || { cleanup_ack_enabled=0; return 1; }
  fi
  descendants_for_roots "$owned_roots" "$owned_groups"
}
snapshot_descendants() {
  if ! create_marker_exclusive "$snapshot_started_path"; then cleanup_ack_enabled=0; fi
  if ! descendants > "$pending_descendants_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
  fi
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ]; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$snapshot_failed_path" || true
  elif ! record_descendants; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$snapshot_failed_path" || true
  fi
  if ! create_marker_exclusive "$snapshot_ready_path"; then cleanup_ack_enabled=0; fi
  if ! create_marker_exclusive "$snapshot_finished_path"; then cleanup_ack_enabled=0; fi
}
start_snapshot() {
  set_snapshot_deadline
  snapshot_generation=$((snapshot_generation + 1))
  snapshot_started_path="$status_dir/snapshot-started-$snapshot_generation"
  snapshot_ready_path="$status_dir/snapshot-ready-$snapshot_generation"
  snapshot_finished_path="$status_dir/snapshot-finished-$snapshot_generation"
  snapshot_failed_path="$status_dir/snapshot-failed-$snapshot_generation"
  snapshot_ready_observed=0
  if ! rm -f "$snapshot_started_path" "$snapshot_ready_path" "$snapshot_finished_path" "$snapshot_failed_path" 2>/dev/null; then cleanup_ack_enabled=0; fi
  snapshot_pid=""
  snapshot_descendants > "$status_dir/snapshot-output-$snapshot_generation" 2> "$status_dir/snapshot-error-$snapshot_generation" || cleanup_ack_enabled=0
  if [ -e "$snapshot_ready_path" ] && [ ! -e "$snapshot_failed_path" ]; then
    snapshot_ready_observed=1
  else
    cleanup_ack_enabled=0
    create_marker_exclusive "$snapshot_failed_path" || true
  fi
}
wait_for_snapshot() {
  snapshot_pid=""
}
record_descendants() {
  record_pending_path="\${1:-$pending_descendants_path}"
  if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
  if [ ! -e "$captured_descendants_path" ] && ! create_marker_exclusive "$captured_descendants_path"; then cleanup_ack_enabled=0; return 1; fi
  captured_count="$(wc -l < "$captured_descendants_path" 2>/dev/null | tr -d '[:space:]' || true)"
  case "$captured_count" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
  [ -f "$record_pending_path" ] || { cleanup_ack_enabled=0; return 1; }
  while read -r captured_pid; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    case "$captured_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ "$captured_count" -ge 1024 ] && { cleanup_ack_enabled=0; return 1; }
    captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    captured_identity="$(normalize_process_identity "$captured_identity" 2>/dev/null || true)"
    if ! identity_is_valid "$captured_identity"; then
      process_liveness "$captured_pid"
      case "$process_liveness_result" in
        dead) continue ;;
        *) cleanup_ack_enabled=0; return 1 ;;
      esac
    fi
    captured_pgid="$(process_group_id "$captured_pid" 2>/dev/null || true)"
    if [ -z "$captured_pgid" ]; then
      process_liveness "$captured_pid"
      case "$process_liveness_result" in
        dead) continue ;;
        *) cleanup_ack_enabled=0; return 1 ;;
      esac
    fi
    captured_record="$captured_pid|$captured_identity|$captured_pgid"
    existing_captured_record="$(awk -F'|' -v pid="$captured_pid" '$1 == pid { print; exit }' "$captured_descendants_path" 2>/dev/null || true)"
    if [ -n "$existing_captured_record" ]; then
      existing_captured_identity="\${existing_captured_record#*|}"
      existing_captured_identity="\${existing_captured_identity%%|*}"
      if captured_identity_matches "$existing_captured_identity" "$captured_identity"; then
        continue
      fi
      cleanup_ack_enabled=0
      return 1
    fi
    if ! printf '%s\n' "$captured_record" >> "$captured_descendants_path"; then cleanup_ack_enabled=0; return 1; fi
    captured_count=$((captured_count + 1))
  done < "$record_pending_path" || { cleanup_ack_enabled=0; return 1; }
}
capture_owned_descendants() {
  if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
  owned_pending_path="$status_dir/owned-descendant-pids-$snapshot_generation-$ownership_round"
  if ! owned_descendants > "$owned_pending_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    return 1
  fi
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ]; then
    cleanup_ack_enabled=0
    return 1
  fi
  if ! record_descendants "$owned_pending_path"; then
    cleanup_ack_enabled=0
    return 1
  fi
  if [ "$group_quiescence_required" = "1" ] && ! quiesce_captured_descendants; then return 1; fi
}
quiesce_captured_descendants() {
  [ -f "$captured_descendants_path" ] || return 0
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
    case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
    identity_is_valid "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    process_liveness "$captured_pid"
    case "$process_liveness_result" in
      dead)
        continue
        ;;
      live) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
    if ! captured_identity_matches "$captured_identity" "$current_captured_identity"; then cleanup_ack_enabled=0; return 1; fi
    current_captured_pgid="$(process_group_id "$captured_pid" 2>/dev/null || true)"
    if [ "$current_captured_pgid" != "$captured_pgid" ]; then cleanup_ack_enabled=0; return 1; fi
    if [ "$current_captured_pgid" = "$wrapper_pgid" ]; then cleanup_ack_enabled=0; return 1; fi
    if [ -n "$target_group_for_quiesce" ] && [ "$current_captured_pgid" = "$target_group_for_quiesce" ]; then continue; fi
    captured_process_can_be_signaled "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
    if ! kill -STOP "-$current_captured_pgid" 2>/dev/null; then cleanup_ack_enabled=0; return 1; fi
    if ! printf '%s|%s\\n' "$current_captured_pgid" "$captured_identity" >> "$quiesced_groups_path"; then cleanup_ack_enabled=0; return 1; fi
  done < "$captured_descendants_path" || { cleanup_ack_enabled=0; return 1; }
}
prepare_kill_ownership() {
  if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
  target_group_for_quiesce=""
  if target_identity_matches; then
    if ! target_is_alive; then
      process_liveness "$target_pid"
      case "$process_liveness_result" in
        dead) ;;
        *) cleanup_ack_enabled=0; return 1 ;;
      esac
    else
      target_group_for_quiesce="$(process_group_id "$target_pid" 2>/dev/null || true)"
      case "$target_group_for_quiesce" in
        ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;;
      esac
      if [ "$target_group_for_quiesce" = "$wrapper_pgid" ] || [ "$target_group_for_quiesce" != "$target_pgid" ]; then
        cleanup_ack_enabled=0
        return 1
      fi
      if ! kill -STOP "-$target_group_for_quiesce" 2>/dev/null; then
        cleanup_ack_enabled=0
        return 1
      fi
    fi
  fi
  if ! quiesce_captured_descendants; then return 1; fi
  group_quiescence_required=0
  if awk -F'|' '$2 ~ /^ps:/ { found = 1; exit } END { exit(found ? 0 : 1) }' "$captured_descendants_path" 2>/dev/null; then
    group_quiescence_required=1
  fi
  ownership_previous_count="$(wc -l < "$captured_descendants_path" 2>/dev/null | tr -d '[:space:]' || true)"
  case "$ownership_previous_count" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
  ownership_round=0
  while [ "$ownership_round" -lt 4 ]; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    if ! capture_owned_descendants; then return 1; fi
    ownership_current_count="$(wc -l < "$captured_descendants_path" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$ownership_current_count" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    if [ "$ownership_current_count" = "$ownership_previous_count" ]; then return 0; fi
    ownership_previous_count="$ownership_current_count"
    ownership_round=$((ownership_round + 1))
    if ! quiesce_captured_descendants; then return 1; fi
  done
  cleanup_ack_enabled=0
  return 1
}
reconcile_captured_descendants() {
  [ -f "$captured_descendants_path" ] || return 0
  if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
  reconcile_pending_path="$status_dir/reconcile-target-descendants"
  reconcile_next_path="$status_dir/descendants-reconciled"
  reconcile_target_pgid="$target_pgid"
  if target_identity_matches; then
    observed_reconcile_target_pgid="$(process_group_id "$target_pid" 2>/dev/null || true)"
    [ -n "$observed_reconcile_target_pgid" ] && reconcile_target_pgid="$observed_reconcile_target_pgid"
  fi
  if ! descendants > "$reconcile_pending_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    return 1
  fi
  if ! create_marker_exclusive "$reconcile_next_path"; then cleanup_ack_enabled=0; return 1; fi
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
    case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
    identity_is_valid "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    process_liveness "$captured_pid"
    case "$process_liveness_result" in
      dead)
        if [ "$captured_pgid" = "$reconcile_target_pgid" ]; then continue; fi
        captured_group_has_live_process "$captured_pgid"
        captured_group_live_status=$?
        case "$captured_group_live_status" in
          0)
            captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
            captured_group_signal_status=$?
            if [ "$captured_group_signal_status" -ne 0 ]; then cleanup_ack_enabled=0; return 1; fi
            ;;
          1) ;;
          *) cleanup_ack_enabled=0; return 1 ;;
        esac
        printf '%s|%s|%s\n' "$captured_pid" "$captured_identity" "$captured_pgid" >> "$reconcile_next_path" || { cleanup_ack_enabled=0; return 1; }
        continue
        ;;
      live) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
    if captured_identity_matches "$captured_identity" "$current_captured_identity"; then
      printf '%s|%s|%s\n' "$captured_pid" "$captured_identity" "$captured_pgid" >> "$reconcile_next_path" || { cleanup_ack_enabled=0; return 1; }
      continue
    fi
    if ! awk -v pid="$captured_pid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' "$reconcile_pending_path" >/dev/null 2>&1; then
      cleanup_ack_enabled=0
      return 1
    fi
  done < "$captured_descendants_path" || { cleanup_ack_enabled=0; return 1; }
  if ! mv -f -- "$reconcile_next_path" "$captured_descendants_path" 2>/dev/null; then cleanup_ack_enabled=0; return 1; fi
}
signal_captured_descendants() {
  [ -f "$captured_descendants_path" ] || return 0
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    case "$captured_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; continue; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; continue ;; esac
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
    if ! identity_is_valid "$current_captured_identity"; then
      process_liveness "$captured_pid"
      case "$process_liveness_result" in
        dead)
          if [ "$captured_pgid" = "$wrapper_pgid" ] || [ "$captured_pgid" = "$target_pgid" ]; then continue; fi
          captured_group_has_live_process "$captured_pgid"
          captured_group_live_status=$?
          case "$captured_group_live_status" in
            0)
              captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
              captured_group_signal_status=$?
              if [ "$captured_group_signal_status" -eq 0 ]; then
                if ! kill -"$signal" "-$captured_pgid" 2>/dev/null; then cleanup_ack_enabled=0; fi
              else
                cleanup_ack_enabled=0
              fi
              ;;
            1) ;;
            *) cleanup_ack_enabled=0 ;;
          esac
          continue
          ;;
        *) ;;
      esac
      cleanup_ack_enabled=0
      continue
    fi
    if ! captured_identity_matches "$captured_identity" "$current_captured_identity"; then cleanup_ack_enabled=0; continue; fi
    current_captured_pgid="$(process_group_id "$captured_pid" 2>/dev/null || true)"
    if [ -z "$current_captured_pgid" ]; then
      cleanup_ack_enabled=0
      case "$captured_identity" in proc:*) kill -"$signal" "$captured_pid" 2>/dev/null || true ;; esac
      continue
    fi
    if [ "$current_captured_pgid" != "$captured_pgid" ]; then
      cleanup_ack_enabled=0
      case "$captured_identity" in proc:*) kill -"$signal" "$captured_pid" 2>/dev/null || true ;; esac
      continue
    fi
    if [ "$captured_pgid" != "$wrapper_pgid" ] && [ "$captured_pgid" != "$target_pgid" ]; then
      captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
      captured_group_signal_status=$?
      if [ "$captured_group_signal_status" -eq 0 ]; then
        if ! kill -"$signal" "-$captured_pgid" 2>/dev/null; then
          cleanup_ack_enabled=0
          case "$captured_identity" in proc:*) kill -"$signal" "$captured_pid" 2>/dev/null || true ;; esac
        fi
      else
        cleanup_ack_enabled=0
        case "$captured_identity" in proc:*) kill -"$signal" "$captured_pid" 2>/dev/null || true ;; esac
      fi
    else
      case "$captured_identity" in proc:*) kill -"$signal" "$captured_pid" 2>/dev/null || true ;; esac
    fi
  done < "$captured_descendants_path" || cleanup_ack_enabled=0
}
signal_tree() {
  signal="$1"
  set_snapshot_deadline
  group_quiescence_required=0
  rm -f "$quiesced_groups_path" 2>/dev/null || cleanup_ack_enabled=0
  if [ "$signal" = "KILL" ]; then
    reconcile_captured_descendants || cleanup_ack_enabled=0
  fi
  start_snapshot
  snapshot_ready_before_signal="$snapshot_ready_observed"
  wrapper_pgid="$(run_process_probe ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
  current_target_pgid=""
  group_signal_succeeded=0
  if target_identity_matches; then
    current_target_pgid="$(run_process_probe ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  fi
  if [ "$signal" = "KILL" ] && [ "$snapshot_ready_before_signal" = "1" ] && [ ! -e "$snapshot_failed_path" ]; then
    prepare_kill_ownership || cleanup_ack_enabled=0
  fi
  case "$current_target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$current_target_pgid" = "$target_pgid" ] && [ "$current_target_pgid" != "$wrapper_pgid" ]; then
        if kill -"$signal" "-$current_target_pgid" 2>/dev/null; then
          group_signal_succeeded=1
        else
          cleanup_ack_enabled=0
        fi
      fi
      ;;
  esac
  wait_for_snapshot
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ] || [ -e "$snapshot_failed_path" ] || [ "$snapshot_ready_before_signal" != "1" ]; then cleanup_ack_enabled=0; fi
  if [ "$signal" = "KILL" ] && [ "$snapshot_ready_before_signal" = "1" ] && [ ! -e "$snapshot_failed_path" ]; then signal_captured_descendants; fi
  if [ "$group_signal_succeeded" = "1" ] || ! target_identity_matches; then return; fi
  for pid in $(descendants); do
    [ "$pid" = "$$" ] && continue
    process_liveness "$pid"
    case "$process_liveness_result" in
      dead) continue ;;
      *) cleanup_ack_enabled=0; continue ;;
    esac
    descendant_identity="$(process_identity "$pid" 2>/dev/null || true)"
    descendant_identity="$(normalize_process_identity "$descendant_identity" 2>/dev/null || true)"
    if ! identity_is_valid "$descendant_identity"; then cleanup_ack_enabled=0; continue; fi
    current_descendant_identity="$(process_identity "$pid" 2>/dev/null || true)"
    current_descendant_identity="$(normalize_process_identity "$current_descendant_identity" 2>/dev/null || true)"
    if target_identity_matches && [ "$current_descendant_identity" = "$descendant_identity" ]; then
      current_descendant_pgid="$(process_group_id "$pid" 2>/dev/null || true)"
      if [ "$current_descendant_pgid" = "$target_pgid" ]; then
        # macOS ps identities have only second-resolution start times. If the
        # target-group signal fails, fail closed instead of re-authorizing a
        # captured ps:* member by PID and PGID.
        captured_pid="$pid"
        if captured_process_can_be_signaled "$descendant_identity"; then
          if ! kill -"$signal" "$pid" 2>/dev/null; then cleanup_ack_enabled=0; fi
        else
          cleanup_ack_enabled=0
        fi
      else
        case "$descendant_identity" in ps:*) cleanup_ack_enabled=0; continue ;; esac
        kill -"$signal" "$pid" 2>/dev/null || true
      fi
    fi
  done
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ] || [ -e "$snapshot_failed_path" ]; then cleanup_ack_enabled=0; fi
}
captured_identity_for_pid() {
  captured_lookup_pid="$1"
  [ -f "$captured_descendants_path" ] || return 1
  awk -F'|' -v pid="$captured_lookup_pid" '$1 == pid { print $2; found = 1; exit } END { if (!found) exit 1 }' "$captured_descendants_path"
}
captured_group_for_pid() {
  captured_lookup_pid="$1"
  [ -f "$captured_descendants_path" ] || return 1
  awk -F'|' -v pid="$captured_lookup_pid" '$1 == pid { print $3; found = 1; exit } END { if (!found) exit 1 }' "$captured_descendants_path"
}
verify_captured_descendants() {
  [ -f "$captured_descendants_path" ] || { cleanup_ack_enabled=0; return 1; }
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
    case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    process_liveness "$captured_pid"
    case "$process_liveness_result" in
      dead)
        captured_group_has_live_process "$captured_pgid"
        captured_group_live_status=$?
        case "$captured_group_live_status" in
          0)
            if [ "$captured_pgid" = "$target_pgid" ] || [ "$captured_pgid" = "$wrapper_pgid" ]; then
              cleanup_ack_enabled=0
              return 1
            elif [ "$captured_pgid" != "$wrapper_pgid" ] && [ "$captured_pgid" != "$target_pgid" ]; then
              captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
              captured_group_signal_status=$?
              if [ "$captured_group_signal_status" -ne 0 ]; then cleanup_ack_enabled=0; return 1; fi
              kill -KILL "-$captured_pgid" 2>/dev/null || true
            else
              cleanup_ack_enabled=0
              return 1
            fi
            captured_group_attempt=0
            while [ "$captured_group_attempt" -lt 5 ] && ! snapshot_deadline_exceeded; do
              sleep 0.05
              captured_group_has_live_process "$captured_pgid"
              captured_group_live_status=$?
              case "$captured_group_live_status" in
                0)
                  if [ "$captured_pgid" = "$target_pgid" ] || [ "$captured_pgid" = "$wrapper_pgid" ]; then
                    cleanup_ack_enabled=0
                    return 1
                  elif [ "$captured_pgid" != "$wrapper_pgid" ] && [ "$captured_pgid" != "$target_pgid" ]; then
                    captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
                    captured_group_signal_status=$?
                    if [ "$captured_group_signal_status" -ne 0 ]; then cleanup_ack_enabled=0; return 1; fi
                    kill -KILL "-$captured_pgid" 2>/dev/null || true
                  else
                    cleanup_ack_enabled=0
                    return 1
                  fi
                  ;;
                1) break ;;
                *) cleanup_ack_enabled=0; return 1 ;;
              esac
              captured_group_attempt=$((captured_group_attempt + 1))
            done
            captured_group_has_live_process "$captured_pgid"
            captured_group_live_status=$?
            case "$captured_group_live_status" in
              1) ;;
              *) cleanup_ack_enabled=0; return 1 ;;
            esac
            ;;
          1) ;;
          *) cleanup_ack_enabled=0; return 1 ;;
        esac
        continue
        ;;
      live) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
    if ! identity_is_valid "$current_captured_identity"; then current_captured_identity=""; fi
    if [ -z "$current_captured_identity" ]; then
      cleanup_ack_enabled=0
      return 1
    fi
    if ! captured_identity_matches "$captured_identity" "$current_captured_identity"; then
      cleanup_ack_enabled=0
      return 1
    fi
    current_captured_pgid="$(process_group_id "$captured_pid" 2>/dev/null || true)"
    if [ -z "$current_captured_pgid" ]; then cleanup_ack_enabled=0; return 1; fi
    if [ "$current_captured_pgid" != "$captured_pgid" ]; then
      cleanup_ack_enabled=0
      case "$captured_identity" in proc:*) kill -KILL "$captured_pid" 2>/dev/null || true ;; esac
      return 1
    fi
    if [ "$captured_pgid" != "$wrapper_pgid" ] && [ "$captured_pgid" != "$target_pgid" ]; then
      captured_group_can_be_signaled "$captured_identity" "$captured_pgid" || { cleanup_ack_enabled=0; return 1; }
      kill -KILL "-$captured_pgid" 2>/dev/null || true
    else
      captured_process_can_be_signaled "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
      kill -KILL "$captured_pid" 2>/dev/null || true
    fi
    if wait_for_process_dead "$captured_pid"; then continue; fi
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
    if ! identity_is_valid "$current_captured_identity" || [ "$current_captured_identity" = "$captured_identity" ]; then cleanup_ack_enabled=0; return 1; fi
    cleanup_ack_enabled=0
    return 1
  done < "$captured_descendants_path" || { cleanup_ack_enabled=0; return 1; }
}
verify_owned_descendants() {
  verify_owned_path="$status_dir/remaining-owned-descendants"
  if ! owned_descendants > "$verify_owned_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    return 1
  fi
  while read -r remaining_owned_pid; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    case "$remaining_owned_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$remaining_owned_pid" = "$$" ] && continue
    [ "$remaining_owned_pid" = "$target_pid" ] && continue
    expected_owned_identity="$(captured_identity_for_pid "$remaining_owned_pid" 2>/dev/null || true)"
    expected_owned_pgid="$(captured_group_for_pid "$remaining_owned_pid" 2>/dev/null || true)"
    if ! identity_is_valid "$expected_owned_identity" || [ -z "$expected_owned_pgid" ]; then
      cleanup_ack_enabled=0
      return 1
    fi
    process_liveness "$remaining_owned_pid"
    case "$process_liveness_result" in
      dead) continue ;;
      live) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
    current_owned_identity="$(process_identity "$remaining_owned_pid" 2>/dev/null || true)"
    current_owned_identity="$(normalize_process_identity "$current_owned_identity" 2>/dev/null || true)"
    current_owned_pgid="$(process_group_id "$remaining_owned_pid" 2>/dev/null || true)"
    if ! captured_identity_matches "$expected_owned_identity" "$current_owned_identity" || [ "$current_owned_pgid" != "$expected_owned_pgid" ]; then
      cleanup_ack_enabled=0
      return 1
    fi
    cleanup_ack_enabled=0
    case "$expected_owned_identity" in
      ps:*) ;;
      *)
        if [ "$expected_owned_pgid" != "$wrapper_pgid" ] && [ "$expected_owned_pgid" != "$target_pgid" ]; then
          kill -KILL "-$expected_owned_pgid" 2>/dev/null || true
        else
          kill -KILL "$remaining_owned_pid" 2>/dev/null || true
        fi
        ;;
    esac
    return 1
  done < "$verify_owned_path" || { cleanup_ack_enabled=0; return 1; }
}
verify_target_group_cleanup() {
  case "$target_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
  target_group_attempt=0
  while [ "$target_group_attempt" -lt 40 ]; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    capture_group_members "$target_pgid"
    target_group_probe_status=$?
    [ "$target_group_probe_status" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
    target_group_remaining=0
    while IFS='|' read -r target_group_member_pid target_group_member_state; do
      if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
      [ -n "$target_group_member_pid$target_group_member_state" ] || continue
      case "$target_group_member_state" in Z*) continue ;; esac
      [ "$target_group_member_pid" = "$$" ] && continue
      target_group_remaining=1
      break
    done < "$captured_group_members_path" || { cleanup_ack_enabled=0; return 1; }
    [ "$target_group_remaining" = "0" ] && return 0
    sleep 0.05
    target_group_attempt=$((target_group_attempt + 1))
  done
  cleanup_ack_enabled=0
  return 1
}
verify_descendant_cleanup() {
  verify_descendants_path="$status_dir/remaining-descendants"
  verify_captured_descendants || return 1
  verify_target_group_cleanup || return 1
  verify_owned_descendants || return 1
  if ! descendants > "$verify_descendants_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    return 1
  fi
  remaining_descendants=0
  while read -r remaining_pid; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    case "$remaining_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$remaining_pid" = "$target_pid" ] && continue
    [ "$remaining_pid" = "$$" ] && continue
    process_liveness "$remaining_pid"
    case "$process_liveness_result" in
      dead) continue ;;
      unknown) cleanup_ack_enabled=0; return 1 ;;
    esac
    if [ "$process_liveness_result" = "live" ]; then
      expected_remaining_identity="$(captured_identity_for_pid "$remaining_pid" 2>/dev/null || true)"
      expected_remaining_pgid="$(captured_group_for_pid "$remaining_pid" 2>/dev/null || true)"
      current_remaining_identity="$(process_identity "$remaining_pid" 2>/dev/null || true)"
      current_remaining_identity="$(normalize_process_identity "$current_remaining_identity" 2>/dev/null || true)"
      if ! identity_is_valid "$current_remaining_identity"; then current_remaining_identity=""; fi
      current_remaining_pgid="$(process_group_id "$remaining_pid" 2>/dev/null || true)"
      if [ -z "$expected_remaining_identity" ] || [ -z "$expected_remaining_pgid" ] || ! captured_identity_matches "$expected_remaining_identity" "$current_remaining_identity" || [ "$current_remaining_pgid" != "$expected_remaining_pgid" ]; then
        cleanup_ack_enabled=0
        return 1
      fi
      captured_pid="$remaining_pid"
      captured_process_can_be_signaled "$expected_remaining_identity" || { cleanup_ack_enabled=0; return 1; }
      remaining_descendants=1
      kill -KILL "$remaining_pid" 2>/dev/null || true
    fi
  done < "$verify_descendants_path"
  if [ "$remaining_descendants" = "1" ]; then sleep 0.05; fi
  if ! descendants > "$verify_descendants_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    return 1
  fi
  while read -r remaining_pid; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    case "$remaining_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$remaining_pid" = "$target_pid" ] && continue
    [ "$remaining_pid" = "$$" ] && continue
    process_liveness "$remaining_pid"
    case "$process_liveness_result" in
      dead) continue ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
  done < "$verify_descendants_path"
  verify_captured_descendants
}
watchdog_pid=""
termination_started=0
stop_watchdog() {
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
terminate_supervised_tree() {
  if [ "$termination_started" = "1" ]; then return 0; fi
  termination_started=1
  signal_tree TERM
  sleep 0.25
  signal_tree KILL
  verify_descendant_cleanup
  stop_anchor
  stop_watchdog
  snapshot_deadline_epoch=0
  cleanup
}
hold_pid=""
trap 'if [ "$termination_started" = "1" ]; then :; else if [ -n "$hold_pid" ]; then kill "$hold_pid" 2>/dev/null || true; fi; terminate_supervised_tree; exit 143; fi' HUP INT TERM
if ! write_marker_exclusive "$ready_path" ready; then
  cleanup_ack_enabled=0
  terminate_supervised_tree
  exit 125
fi
if ! create_marker_exclusive "$target_start_path"; then
  cleanup_ack_enabled=0
  terminate_supervised_tree
  exit 125
fi
parent_is_alive() {
  if [ "$parent_identity_mode" = "proc" ] && [ -r "/proc/$parent_pid/stat" ]; then
    parent_identity="$(run_watchdog_probe awk '{ sub(/.*\\) /, ""); print $1 " " $20 }' "/proc/$parent_pid/stat" 2>/dev/null || true)"
    parent_state="\${parent_identity%% *}"
    current_starttime="\${parent_identity#* }"
    [ "$parent_state" != "Z" ] && [ -n "$parent_state" ] && {
      [ -z "$parent_starttime" ] || [ "$current_starttime" = "$parent_starttime" ]
    }
    return
  fi
  if [ "$parent_identity_mode" = "ps" ]; then
    current_ps_start="$(ps_identity_for_pid "$parent_pid" watchdog 2>/dev/null || true)"
    current_ps_state="$(run_watchdog_probe ps -o state= -p "$parent_pid" 2>/dev/null | run_watchdog_probe awk 'NR == 1 { gsub(/[[:space:]]/, ""); print; exit }')"
    [ -n "$current_ps_start" ] && [ "$current_ps_start" = "$parent_ps_start" ] && [ "$current_ps_state" != "Z" ]
    return
  fi
  return 1
}
watch_parent() {
  watch_sleep_pid=""
  trap 'if [ -n "$watch_sleep_pid" ]; then kill "$watch_sleep_pid" 2>/dev/null || true; fi; exit 0' HUP INT TERM
  while parent_is_alive; do
    sleep 1 &
    watch_sleep_pid="$!"
    wait "$watch_sleep_pid" 2>/dev/null || true
    watch_sleep_pid=""
  done
  cleanup_ack_enabled=0
  ensure_marker "$parent_dead_path" || true
  kill -TERM "$supervisor_pid" 2>/dev/null || true
  exit 0
}
watch_parent </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
target_status=""
target_status_invalid=0
while [ -z "$target_status" ]; do
  candidate_target_status="$(read_regular_marker "$target_status_path" 2>/dev/null || true)"
  case "$candidate_target_status" in
    ''|*[!0-9]*)
      if ! target_is_alive; then
        target_status_invalid=1
        target_status=125
      else
        if ! parent_is_alive; then
          cleanup_ack_enabled=0
          ensure_marker "$parent_dead_path" || true
          terminate_supervised_tree
          exit 143
        fi
        sleep 0.01
      fi
      ;;
    *)
      candidate_target_writer="$(read_regular_marker "$target_status_writer_path" 2>/dev/null || true)"
      if [ "$candidate_target_writer" = "$target_pid" ] && target_identity_matches; then
        target_status="$candidate_target_status"
      elif ! target_is_alive; then
        target_status_invalid=1
        target_status=125
      else
        sleep 0.01
      fi
      ;;
  esac
done
if [ "$target_status_invalid" = "1" ]; then
  cleanup_ack_enabled=0
  terminate_supervised_tree
  exit 125
fi
if ! parent_is_alive; then
  cleanup_ack_enabled=0
  ensure_marker "$parent_dead_path" || true
  terminate_supervised_tree
  exit 143
fi
if ! write_marker_exclusive "$status_path" "$target_status|$completion_proof"; then
  cleanup_ack_enabled=0
  target_status=125
elif ! write_marker_exclusive "$completion_path" complete; then
  cleanup_ack_enabled=0
  target_status=125
fi
exec 0<&- 1>/dev/null 2>/dev/null
# The target exit code is the wrapper's authenticated result. Run the
# potentially slower process-tree verification independently so short-lived
# commands are not reported as timed out while cleanup is still in progress.
(trap ':' HUP INT TERM; terminate_supervised_tree) </dev/null >/dev/null 2>/dev/null &
cleanup_pid="$!"
case "$target_status" in
  ''|*[!0-9]*) exit 125 ;;
  *) exit "$target_status" ;;
esac
`;

export interface SupervisedChild {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  exited: Promise<number>;
  wrapperExited: Promise<number>;
  waitForCleanupAcknowledged: () => Promise<boolean>;
  forceCleanup: () => Promise<boolean>;
  cleanup(): Promise<void>;
}

async function readRegularMarker(path: string, maxBytes = MAX_SUPERVISOR_MARKER_BYTES): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return undefined;
    const flags = constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0);
    handle = await open(path, flags);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size > maxBytes || openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) return undefined;
    const buffer = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (offset > maxBytes || finalMetadata.size !== openedMetadata.size || finalMetadata.dev !== openedMetadata.dev || finalMetadata.ino !== openedMetadata.ino || offset !== openedMetadata.size) return undefined;
    return new TextDecoder().decode(buffer.subarray(0, offset));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStatus(path: string, completionToken: string): Promise<number | undefined> {
  const value = (await readRegularMarker(path))?.trim() ?? "";
  const match = /^(\d+)\|(.+)$/.exec(value);
  if (match !== null && match[2] === completionToken) {
    const status = Number(match[1]);
    if (Number.isInteger(status) && status >= 0 && status <= 255) return status;
  }
  return undefined;
}

function decodeSpawnOutput(output: Uint8Array | string | undefined): string {
  if (output === undefined) return "";
  return typeof output === "string" ? output : new TextDecoder().decode(output);
}

async function readNumericMarker(path: string): Promise<number | undefined> {
  const value = (await readRegularMarker(path))?.trim() ?? "";
  if (/^[1-9][0-9]*$/.test(value)) return Number(value);
  return undefined;
}

interface TargetReference {
  pid: number;
  pgid: number;
  identity: string;
}

async function readTargetReference(statusPath: string): Promise<TargetReference | undefined> {
  const directory = dirname(statusPath);
  const [pid, pgid, identity] = await Promise.all([
    readNumericMarker(join(directory, "target")),
    readNumericMarker(join(directory, "target-pgid")),
    readRegularMarker(join(directory, "target-identity")),
  ]);
  const normalizedIdentity = identity?.trim() ?? "";
  if (pid !== undefined && pgid !== undefined && normalizedIdentity.length > 0) {
    const currentPgid = currentProcessGroup(pid);
    const currentIdentity = await currentProcessIdentity(pid);
    if (currentPgid === pgid && currentIdentity !== undefined && processIdentityMatches(normalizedIdentity, currentIdentity)) {
      return { pid, pgid, identity: normalizedIdentity };
    }
  }
  return undefined;
}

async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const suffix = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const start = suffix[19];
    return start !== undefined && /^[0-9]+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

const POSIX_PS = "/bin/ps";

function macProcessIdentity(pid: number): string | undefined {
  const result = Bun.spawnSync([
    "sh",
    "-c",
    `
pid="$1"
start="$(LC_ALL=C /bin/ps -o lstart= -p "$pid" 2>/dev/null | awk '
  $1 ~ /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/ &&
  $2 ~ /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/ &&
  $3 ~ /^[0-9][0-9]*$/ &&
  $4 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ &&
  $5 ~ /^[0-9][0-9][0-9][0-9]$/ { print $1, $2, $3, $4, $5; exit }
')"
ppid="$(/bin/ps -o ppid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
pgid="$(/bin/ps -o pgid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
command_hash="$(/bin/ps -o command= -p "$pid" 2>/dev/null | cksum | awk 'NR == 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1 ":" $2; exit }')"
if [ -n "$start" ] && [ -n "$ppid" ] && [ -n "$pgid" ] && [ -n "$command_hash" ]; then
  printf 'ps:%s;ppid=%s;pgid=%s;cmd=%s\\n' "$start" "$ppid" "$pgid" "$command_hash"
fi
`,
    "agent-toolkit-process-identity",
    String(pid),
  ]);
  if (result.exitCode !== 0) return undefined;
  const identity = decodeSpawnOutput(result.stdout).trim();
  return identity.startsWith("ps:") ? identity : undefined;
}

async function currentProcessIdentity(pid: number): Promise<string | undefined> {
  const start = await processStartTime(pid);
  if (start !== undefined) return `proc:${start}`;
  return macProcessIdentity(pid);
}

async function discoverTargetReference(targetMarker: string): Promise<TargetReference | undefined> {
  const marker = `agent-toolkit-target-${targetMarker}`;
  const result = Bun.spawnSync([POSIX_PS, "-axo", "pid=,pgid=,command="]);
  if (result.exitCode !== 0) return undefined;
  for (const line of decodeSpawnOutput(result.stdout).split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/.exec(line);
    if (match === null || !match[3]!.includes(marker)) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid) || pid === process.pid || pgid === process.pid) continue;
    const currentPgid = currentProcessGroup(pid);
    const identity = await currentProcessIdentity(pid);
    if (currentPgid === pgid && identity !== undefined) return { pid, pgid, identity };
  }
  return undefined;
}

function psIdentityFields(identity: string): { start: string; ppid: string; pgid: string; commandHash: string } | undefined {
  const match = /^ps:(.*);ppid=([0-9]+);pgid=([0-9]+);cmd=([0-9]+:[0-9]+)$/.exec(identity);
  if (match === null) return undefined;
  return { start: match[1]!, ppid: match[2]!, pgid: match[3]!, commandHash: match[4]! };
}

function processIdentityMatches(expected: string, current: string): boolean {
  if (expected === current) return true;
  const expectedFields = psIdentityFields(expected);
  const currentFields = psIdentityFields(current);
  return expectedFields !== undefined && currentFields !== undefined
    && expectedFields.start === currentFields.start
    && expectedFields.pgid === currentFields.pgid
    && expectedFields.commandHash === currentFields.commandHash
    && (currentFields.ppid === "0" || currentFields.ppid === "1");
}

function currentProcessGroup(pid: number): number | undefined {
  const result = Bun.spawnSync([POSIX_PS, "-o", "pgid=", "-p", String(pid)]);
  if (result.exitCode !== 0) return undefined;
  const value = decodeSpawnOutput(result.stdout).trim();
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}

function processGroupHasLiveProcess(pgid: number): boolean | undefined {
  const result = Bun.spawnSync([POSIX_PS, "-axo", "pid=,pgid=,state="]);
  if (result.exitCode !== 0) return undefined;
  for (const line of decodeSpawnOutput(result.stdout).split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([A-Za-z?]+)/.exec(line);
    if (match === null) return undefined;
    const pid = Number(match[1]);
    const observedPgid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(observedPgid)) return undefined;
    if (observedPgid === pgid && pid !== process.pid && !match[3]!.startsWith("Z")) return true;
  }
  return false;
}

async function waitForProcessGroupGone(pgid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const live = processGroupHasLiveProcess(pgid);
    if (live === false) return true;
    if (live === undefined) return false;
    await Bun.sleep(25);
  }
  return processGroupHasLiveProcess(pgid) === false;
}

async function cleanupOrphanedTarget(rememberedReference?: TargetReference): Promise<boolean> {
  if (process.platform === "win32") return false;
  const reference = rememberedReference;
  const targetPid = reference?.pid;
  const targetPgid = reference?.pgid;
  if (targetPid === undefined || targetPgid === undefined || targetPid === process.pid) {
    return false;
  }
  const currentPgid = currentProcessGroup(process.pid);
  if (currentPgid === undefined || currentPgid === targetPgid) return false;
  const expectedIdentity = reference?.identity ?? "";
  const currentIdentity = await currentProcessIdentity(targetPid);
  if (expectedIdentity.length === 0 || currentIdentity === undefined || !processIdentityMatches(expectedIdentity, currentIdentity)) return false;
  const observedPgid = currentProcessGroup(targetPid);
  if (observedPgid !== targetPgid) return false;
  try {
    process.kill(-targetPgid, "SIGKILL");
  } catch {
    // The target may have exited between validation and the group signal.
  }
  return await waitForProcessGroupGone(targetPgid);
}

async function markCleanupFailure(path: string): Promise<void> {
  await mkdir(path).catch(() => undefined);
}

async function waitForTarget(
  path: string,
  completionPath: string,
  completionToken: string,
  wrapperExited: Promise<number>,
  waitForCleanupAcknowledged?: () => Promise<boolean>,
  cleanupFailurePath?: string,
  rememberedReference?: () => TargetReference | undefined,
): Promise<number> {
  void waitForCleanupAcknowledged?.();
  const wrapperCode = await wrapperExited;
  const status = await readStatus(path, completionToken);
  const completed = (await readRegularMarker(completionPath))?.trim() === "complete";
  if (completed && status !== undefined && status === wrapperCode) return status;
  await cleanupOrphanedTarget(rememberedReference?.());
  if (cleanupFailurePath !== undefined) await markCleanupFailure(cleanupFailurePath);
  return SUPERVISOR_UNKNOWN_TARGET_STATUS;
}

async function waitForReady(path: string, wrapperExited: Promise<number>): Promise<boolean> {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    if ((await readRegularMarker(path))?.trim() === "ready") return true;
    const wrapperDone = await Promise.race([
      wrapperExited.then(() => true, () => true),
      Bun.sleep(20).then(() => false),
    ]);
    if (wrapperDone) return false;
  }
  return false;
}

async function consumeCleanupAck(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return false;
    await rmdir(path);
    try { await rmdir(dirname(path)); } catch { /* The private acknowledgement root may already be gone. */ }
    return true;
  } catch {
    return false;
  }
}

async function consumeCleanupFailure(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return false;
    await rmdir(path);
    return true;
  } catch {
    return false;
  }
}

async function removeCleanupAck(path: string): Promise<void> {
  let removed = false;
  try {
    await rmdir(path);
    removed = true;
  } catch {
    // The marker may be a file or a symlink left by an interrupted run.
  }
  if (!removed) {
    try {
      await rm(path, { force: true });
      removed = true;
    } catch {
      // Never recursively remove an unexpected marker path.
    }
  }
  if (removed) {
    try { await rmdir(dirname(path)); } catch { /* The private acknowledgement root may already be gone. */ }
  }
}

async function removeCleanupAckRoot(path: string): Promise<void> {
  try { await rmdir(path); } catch { /* The marker consumer may already have removed the private root. */ }
}

async function waitForCleanupAck(path: string): Promise<boolean> {
  // The shell keeps the cleanup work bounded to the shared budget. Allow a
  // short, separate window for its success/failure marker to become visible
  // before the caller force-kills a still-running supervisor.
  const deadline = Date.now() + SUPERVISOR_CLEANUP_TIMEOUT_MS + SUPERVISOR_CLEANUP_ACK_SETTLE_MS;
  const failurePath = `${path}.failed`;
  while (Date.now() < deadline) {
    if (await consumeCleanupAck(path)) return true;
    if (await consumeCleanupFailure(failurePath)) return false;
    await Bun.sleep(20);
  }
  if (await consumeCleanupAck(path)) return true;
  await consumeCleanupFailure(failurePath);
  return false;
}

export async function spawnSupervised(args: string[]): Promise<SupervisedChild> {
  if (process.platform === "win32") {
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return {
      child,
      exited: child.exited,
      wrapperExited: child.exited,
      waitForCleanupAcknowledged: () => Promise.resolve(true),
      forceCleanup: () => Promise.resolve(false),
      cleanup: async () => undefined,
    };
  }

  const cleanupAckDirectory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-ack-"));
  const targetMarker = randomUUID();
  const completionToken = randomUUID();
  const completionEnvName = ["AGENT_TOOLKIT_SUPERVISOR_COMPLETION", "TOKEN"].join("_");
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-"));
  } catch (error) {
    await rm(cleanupAckDirectory, { recursive: true, force: true });
    throw error;
  }
  const statusPath = join(directory, "status");
  const completionPath = join(directory, "completed");
  const readyPath = join(directory, "ready");
  const cleanupAckPath = join(cleanupAckDirectory, "done");
  const cleanupFailurePath = `${cleanupAckPath}.failed`;
  try {
    const child = Bun.spawn(
      ["sh", "-c", SUPERVISOR_SCRIPT, "agent-toolkit-supervisor", statusPath, ...args],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          AGENT_TOOLKIT_SUPERVISOR_PARENT_PID: String(process.pid),
          AGENT_TOOLKIT_SUPERVISOR_CLEANUP_ACK_PATH: cleanupAckPath,
          AGENT_TOOLKIT_TARGET_MARKER: targetMarker,
          [completionEnvName]: completionToken,
        },
      },
    ) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    const wrapperExited = child.exited;
    let rememberedTargetReference: TargetReference | undefined;
    let cleanupAckPromise: Promise<boolean> | undefined;
    const waitForCleanupAcknowledged = (): Promise<boolean> => {
      cleanupAckPromise ??= waitForCleanupAck(cleanupAckPath);
      return cleanupAckPromise;
    };
    const supervised: SupervisedChild = {
      child,
      exited: waitForTarget(statusPath, completionPath, completionToken, wrapperExited, waitForCleanupAcknowledged, cleanupFailurePath, () => rememberedTargetReference),
      wrapperExited,
      waitForCleanupAcknowledged,
      forceCleanup: () => cleanupOrphanedTarget(rememberedTargetReference),
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
        await removeCleanupAck(cleanupAckPath);
        await removeCleanupAck(cleanupFailurePath);
        await removeCleanupAckRoot(cleanupAckDirectory);
      },
    };
    const ready = await waitForReady(readyPath, wrapperExited);
    rememberedTargetReference = await readTargetReference(statusPath) ?? await discoverTargetReference(targetMarker);
    if (!ready) {
      await cleanupOrphanedTarget(rememberedTargetReference);
      try { child.kill("SIGTERM"); } catch { /* The wrapper may already be gone. */ }
      const cleanupReady = await waitForCleanupAcknowledged();
      if (!cleanupReady) {
        try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      }
      await wrapperExited;
      await cleanupOrphanedTarget(rememberedTargetReference);
      throw new Error("supervisor_not_ready");
    }
    return supervised;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await rm(cleanupAckDirectory, { recursive: true, force: true });
    throw error;
  }
}
