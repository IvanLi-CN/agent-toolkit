import { randomUUID } from "node:crypto";
import { close as closeFileDescriptorCallback, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SUPERVISOR_CLEANUP_TIMEOUT_MS = 60_000;
const SUPERVISOR_CLEANUP_ACK_SETTLE_MS = 15_000;
const SUPERVISOR_CLEANUP_MARKER_SETTLE_MS = 2_000;
const SUPERVISOR_UNEXPECTED_EXIT_SETTLE_MS = 250;
const SUPERVISOR_ORPHAN_CLEANUP_TIMEOUT_MS = 5_000;
const SUPERVISOR_CLEANUP_DEADLINE_SECONDS = Math.ceil(SUPERVISOR_CLEANUP_TIMEOUT_MS / 1_000);
const SUPERVISOR_STATUS_PIPE_TIMEOUT_MS = 2_000;
const SUPERVISOR_TARGET_REFERENCE_TIMEOUT_MS = 5_000;
export const SUPERVISOR_UNKNOWN_TARGET_STATUS = 125;
const MAX_SUPERVISOR_MARKER_BYTES = 256;

function closeFileDescriptor(fd: number): Promise<void> {
  return new Promise((resolve) => closeFileDescriptorCallback(fd, () => resolve()));
}

async function raceWithTimeout<T, U>(promise: Promise<T>, timeoutMs: number, timeoutValue: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T | U>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const SUPERVISOR_SCRIPT = `
set +e
set +m 2>/dev/null || true
status_path="$1"
shift
status_dir="$(dirname -- "$status_path")"
target_marker="\${AGENT_TOOLKIT_TARGET_MARKER:-unbound}"
supervisor_pid="$$"
ready_path="$status_dir/ready"
cleanup_started_path="$status_dir/cleanup-started"
cleanup_complete_path="$status_dir/cleanup-complete"
cleanup_owner_path="$status_dir/cleanup-owner"
cleanup_ack_enabled=1
captured_descendants_read_data=""
captured_group_members_read_data=""
quiesced_groups_read_data=""
cleanup_ack_result=1
cleanup_ack_sent=0
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
descendant_result_path="$status_dir/descendants-result"
parent_dead_path="$status_dir/parent-dead"
supervisor_no_follow=""
if command -v perl >/dev/null 2>&1; then
  supervisor_no_follow="$(perl -MFcntl -e 'print eval { Fcntl::O_NOFOLLOW() } // ""' 2>/dev/null || true)"
fi
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
safe_create_file() {
  marker_path="$1"
  [ -n "$supervisor_no_follow" ] || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL);
    my ($path, $nofollow) = @ARGV;
    exit 1 unless defined $nofollow;
    sysopen(my $fh, $path, O_WRONLY | O_CREAT | O_EXCL | $nofollow, 0600) or exit 1;
    close($fh) or exit 1;
  ' "$marker_path" "$supervisor_no_follow"
}
safe_write_file() {
  marker_path="$1"
  marker_value="$2"
  [ -n "$supervisor_no_follow" ] || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL);
    my ($path, $value, $nofollow) = @ARGV;
    exit 1 unless defined $nofollow;
    sysopen(my $fh, $path, O_WRONLY | O_CREAT | O_EXCL | $nofollow, 0600) or exit 1;
    print {$fh} $value, "\n" or exit 1;
    close($fh) or exit 1;
  ' "$marker_path" "$marker_value" "$supervisor_no_follow"
}
safe_append_line() {
  marker_path="$1"
  marker_value="$2"
  [ -n "$supervisor_no_follow" ] || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_APPEND O_NONBLOCK);
    my ($path, $value, $nofollow) = @ARGV;
    exit 1 unless defined $nofollow;
    my @path_stat = lstat($path);
    if (@path_stat) {
      exit 1 unless (($path_stat[2] & 0170000) == 0100000) && $path_stat[7] <= 1048576;
    }
    my $fh;
    if (!sysopen($fh, $path, O_WRONLY | O_APPEND | O_NONBLOCK | $nofollow)) {
      sysopen(my $created, $path, O_WRONLY | O_CREAT | O_EXCL | $nofollow, 0600) or exit 1;
      close($created) or exit 1;
      sysopen($fh, $path, O_WRONLY | O_APPEND | O_NONBLOCK | $nofollow) or exit 1;
    }
    my @opened = stat($fh);
    exit 1 unless @opened && (($opened[2] & 0170000) == 0100000);
    exit 1 if @path_stat && ($opened[0] != $path_stat[0] || $opened[1] != $path_stat[1]);
    exit 1 if $opened[7] > 1048576;
    print {$fh} $value, "\n" or exit 1;
    my @final = stat($fh);
    exit 1 unless @final && (($final[2] & 0170000) == 0100000) && $final[0] == $opened[0] && $final[1] == $opened[1] && $final[7] <= 1048576;
    close($fh) or exit 1;
  ' "$marker_path" "$marker_value" "$supervisor_no_follow"
}
safe_copy_file() {
  input_path="$1"
  output_path="$2"
  [ -n "$supervisor_no_follow" ] || return 1
  rm -f -- "$output_path" 2>/dev/null || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_NONBLOCK);
    my ($input, $output, $nofollow) = @ARGV;
    exit 1 unless defined $nofollow;
    my @path_stat = lstat($input);
    exit 1 unless @path_stat && (($path_stat[2] & 0170000) == 0100000) && $path_stat[7] <= 1048576;
    sysopen(my $in, $input, O_RDONLY | O_NONBLOCK | $nofollow) or exit 1;
    my @in_stat = stat($in);
    exit 1 unless @in_stat && (($in_stat[2] & 0170000) == 0100000)
      && $in_stat[0] == $path_stat[0] && $in_stat[1] == $path_stat[1]
      && $in_stat[7] == $path_stat[7] && $in_stat[7] <= 1048576;
    sysopen(my $out, $output, O_WRONLY | O_CREAT | O_EXCL | $nofollow, 0600) or exit 1;
    binmode $in;
    binmode $out;
    my $copied = 0;
    while (1) {
      my $read = sysread($in, my $chunk, 65536);
      exit 1 unless defined $read;
      last if $read == 0;
      print {$out} $chunk or exit 1;
      $copied += $read;
      exit 1 if $copied > 1048576;
    }
    my @final_in = stat($in);
    exit 1 unless @final_in && $final_in[0] == $in_stat[0] && $final_in[1] == $in_stat[1]
      && $final_in[7] == $in_stat[7] && $copied == $in_stat[7];
    close($in) or exit 1;
    close($out) or exit 1;
    my @final_out = stat($output);
    exit 1 unless @final_out && (($final_out[2] & 0170000) == 0100000) && $final_out[7] == $copied;
  ' "$input_path" "$output_path" "$supervisor_no_follow"
}
safe_read_snapshot() {
  snapshot_input_path="$1"
  [ -n "$supervisor_no_follow" ] || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_RDONLY O_NONBLOCK);
    my ($path, $nofollow) = @ARGV;
    exit 1 unless defined $nofollow;
    $SIG{ALRM} = sub { exit 124 };
    alarm 2;
    my @path_stat = lstat($path);
    exit 1 unless @path_stat && (($path_stat[2] & 0170000) == 0100000) && $path_stat[7] <= 1048576;
    sysopen(my $fh, $path, O_RDONLY | O_NONBLOCK | $nofollow) or exit 1;
    my @opened = stat($fh);
    exit 1 unless @opened && (($opened[2] & 0170000) == 0100000)
      && $opened[0] == $path_stat[0] && $opened[1] == $path_stat[1]
      && $opened[7] == $path_stat[7] && $opened[7] <= 1048576;
    my $data = "";
    while (1) {
      my $read = sysread($fh, my $chunk, 65536);
      exit 1 unless defined $read;
      last if $read == 0;
      $data .= $chunk;
      exit 1 if length($data) > 1048576;
    }
    my @final = stat($fh);
    exit 1 unless @final && $final[0] == $opened[0] && $final[1] == $opened[1]
      && $final[7] == $opened[7] && length($data) == $opened[7] && length($data) <= 1048576;
    close($fh) or exit 1;
    binmode STDOUT;
    print $data;
  ' "$snapshot_input_path" "$supervisor_no_follow"
}
validate_captured_ledger() {
  [ -n "$supervisor_no_follow" ] || return 1
  if [ ! -e "$captured_descendants_path" ]; then
    [ "$authorized_descendant_count" -eq 0 ] || return 1
    captured_descendants_read_data=""
    return
  fi
  captured_descendants_read_data="$(safe_read_snapshot "$captured_descendants_path" 2>/dev/null)" || return 1
  printf '%s' "$captured_descendants_read_data" | run_snapshot_command perl -e '
    use strict;
    use warnings;
    my ($expected_count, @expected) = @ARGV;
    local $/;
    my $data = <STDIN> // "";
    my @lines = split(/\n/, $data, -1);
    pop @lines if @lines && $lines[-1] eq "";
    my %expected = map { $_ => 1 } @expected;
    my %seen;
    for my $line (@lines) {
      exit 1 unless length($line) > 0;
      $line =~ s/ /%/g;
      exit 1 unless $expected{$line};
      $seen{$line}++;
    }
    exit 1 unless @lines == $expected_count;
    for my $record (@expected) {
      exit 1 unless ($seen{$record} // 0) == 1;
    }
  ' "$authorized_descendant_count" $authorized_descendant_records || return 1
}
safe_capture_command() {
  output_path="$1"
  shift
  [ -n "$supervisor_no_follow" ] || return 1
  rm -f -- "$output_path" 2>/dev/null || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL);
    my ($path, $nofollow) = splice @ARGV, 0, 2;
    exit 1 unless defined $nofollow;
    $SIG{ALRM} = sub { exit 124 };
    alarm 2;
    sysopen(my $fh, $path, O_WRONLY | O_CREAT | O_EXCL | $nofollow, 0600) or exit 1;
    open(STDOUT, ">&", $fh) or exit 1;
    exec @ARGV or exit 127;
  ' "$output_path" "$supervisor_no_follow" "$@"
}
safe_capture_command_with_input() {
  output_path="$1"
  input_path="$2"
  shift 2
  [ -n "$supervisor_no_follow" ] || return 1
  rm -f -- "$output_path" 2>/dev/null || return 1
  if ! command -v perl >/dev/null 2>&1; then return 1; fi
  perl -e '
    use strict;
    use warnings;
    use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_NONBLOCK);
    my ($output, $input, $nofollow) = splice @ARGV, 0, 3;
    exit 1 unless defined $nofollow;
    $SIG{ALRM} = sub { exit 124 };
    alarm 2;
    sysopen(my $in, $input, O_RDONLY | O_NONBLOCK | $nofollow) or exit 1;
    my @stat = stat($in);
    exit 1 unless @stat && (($stat[2] & 0170000) == 0100000);
    sysopen(my $out, $output, O_WRONLY | O_CREAT | O_EXCL | $nofollow, 0600) or exit 1;
    open(STDIN, "<&", $in) or exit 1;
    open(STDOUT, ">&", $out) or exit 1;
    exec @ARGV or exit 127;
  ' "$output_path" "$input_path" "$supervisor_no_follow" "$@"
}
write_marker_exclusive() {
  marker_path="$1"
  marker_value="$2"
  safe_write_file "$marker_path" "$marker_value"
}
create_marker_exclusive() {
  marker_path="$1"
  safe_create_file "$marker_path"
}
ensure_marker() {
  marker_path="$1"
  if [ -e "$marker_path" ]; then
    [ -f "$marker_path" ] && [ ! -L "$marker_path" ]
    return $?
  fi
  create_marker_exclusive "$marker_path"
}
acquire_cleanup_owner() {
  # The signal path and detached cleaner share status_dir; only one may mutate
  # the ledger or publish the cleanup acknowledgement.
  if ! mkdir "$cleanup_owner_path" 2>/dev/null; then return 1; fi
  write_marker_exclusive "$cleanup_owner_path/pid" "$$"
}
cleanup() {
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ] || [ -e "$snapshot_failed_path" ]; then cleanup_ack_enabled=0; fi
  if [ -e "$parent_dead_path" ]; then
    rm -rf -- "$status_dir"
  fi
  if [ "$cleanup_ack_sent" = "1" ]; then return; fi
  cleanup_ack_sent=1
  if [ "$cleanup_ack_enabled" = "1" ] && [ "$cleanup_ack_result" = "1" ] && [ ! -e "$parent_dead_path" ] && write_marker_exclusive "$cleanup_complete_path" complete; then
    printf '1\n' >&4 2>/dev/null || true
  else
    printf '0\n' >&4 2>/dev/null || true
  fi
  exec 4>&-
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
ps_identity_start_token() {
  ps_identity_token_value="\${1#ps:}"
  ps_identity_token_value="\${ps_identity_token_value%%;ppid=*}"
  [ -n "$ps_identity_token_value" ] || return 1
  printf '%s\n' "$ps_identity_token_value"
}
ps_identity_start_epoch() {
  ps_identity_start_value="$(ps_identity_start_token "$1" 2>/dev/null || true)"
  [ -n "$ps_identity_start_value" ] || return 1
  ps_identity_start_epoch_value="$(LC_ALL=C date -j -f '%a %b %e %T %Y' "$ps_identity_start_value" +%s 2>/dev/null || LC_ALL=C date -d "$ps_identity_start_value" +%s 2>/dev/null || true)"
  case "$ps_identity_start_epoch_value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$ps_identity_start_epoch_value"
}
ps_identity_pgid_token() {
  ps_identity_token_value="\${1#*;pgid=}"
  ps_identity_token_value="\${ps_identity_token_value%%;cmd=*}"
  case "$ps_identity_token_value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$ps_identity_token_value"
}
ps_owner_for_pid() {
  ps_owner_pid="$1"
  run_process_probe ps -o uid= -p "$ps_owner_pid" 2>/dev/null | run_process_probe awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }'
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
target_authorized_path="$status_dir/target-authorized"
target_anchor_path="$status_dir/target"
target_pgid_path="$status_dir/target-pgid"
target_identity_path="$status_dir/target-identity"
target_marker_baseline_path="$status_dir/target-marker-baseline"
target_marker_scan_path="$status_dir/target-marker-scan"
target_marker_baseline_read_data=""
target_marker_scan_requested=0
target_pgid=""
target_pid=""
target_group_fast_path=0
wrapper_pgid="$(run_process_probe ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
authorized_descendant_records=""
authorized_descendant_count=0
group_quiescence_required=0
quiesced_groups_path="$status_dir/quiesced-groups"
if command -v setsid >/dev/null 2>&1 && [ "\${AGENT_TOOLKIT_SUPERVISOR_DISABLE_SETSID:-0}" != "1" ]; then
  setsid sh -c '
    anchor_path="$1"
    result_path="$2"
    start_path="$3"
    authorized_path="$4"
    writer_path="$5"
    done_path="$6"
    supervisor_no_follow="$7"
    shift 7
    publication_path="$(dirname -- "$result_path")/status"
    write_target_marker() {
      marker_path="$1"
      marker_value="$2"
      [ -n "$supervisor_no_follow" ] || return 1
      perl -e "use strict; use warnings; use Fcntl qw(O_WRONLY O_CREAT O_EXCL); my (\\$path, \\$value, \\$nofollow) = @ARGV; sysopen(my \\$fh, \\$path, O_WRONLY | O_CREAT | O_EXCL | \\$nofollow, 0600) or exit 1; print {\\$fh} \\$value, chr(10) or exit 1; close(\\$fh) or exit 1;" "$marker_path" "$marker_value" "$supervisor_no_follow"
    }
    trap ':' HUP INT TERM
    if ! write_target_marker "$anchor_path" "$$"; then exit 125; fi
    while [ ! -e "$start_path" ]; do sleep 0.01; done
    while [ ! -e "$authorized_path" ]; do sleep 0.01; done
    "$@" 3>&- 4>&- &
    target_pid=$!
    wait "$target_pid"
    target_status=$?
    if ! write_target_marker "$writer_path" "$$"; then exit 125; fi
    if ! write_target_marker "$result_path" "$target_status"; then exit 125; fi
    if ! write_target_marker "$publication_path" "$target_status"; then exit 125; fi
    if ! printf "%s\\n" "$target_status" >&3; then exit 125; fi
    if ! write_target_marker "$done_path" complete; then exit 125; fi
    exec 3>&-
    while :; do sleep 1; done
  ' "agent-toolkit-target-$target_marker" "$target_anchor_path" "$target_status_path" "$target_start_path" "$target_authorized_path" "$target_status_writer_path" "$completion_path" "$supervisor_no_follow" "$@" &
else
  # The external setsid utility may be absent or deliberately disabled in
  # tests, but Perl is already a supervisor prerequisite. Use POSIX::setsid
  # through Perl so the fallback keeps the same isolated process-group
  # contract instead of relying on non-interactive shell job control.
  perl -MPOSIX -e 'POSIX::setsid() < 0 and exit 125; exec @ARGV or exit 127' -- sh -c '
    anchor_path="$1"
    result_path="$2"
    start_path="$3"
    authorized_path="$4"
    writer_path="$5"
    done_path="$6"
    supervisor_no_follow="$7"
    shift 7
    publication_path="$(dirname -- "$result_path")/status"
    write_target_marker() {
      marker_path="$1"
      marker_value="$2"
      [ -n "$supervisor_no_follow" ] || return 1
      perl -e "use strict; use warnings; use Fcntl qw(O_WRONLY O_CREAT O_EXCL); my (\\$path, \\$value, \\$nofollow) = @ARGV; sysopen(my \\$fh, \\$path, O_WRONLY | O_CREAT | O_EXCL | \\$nofollow, 0600) or exit 1; print {\\$fh} \\$value, chr(10) or exit 1; close(\\$fh) or exit 1;" "$marker_path" "$marker_value" "$supervisor_no_follow"
    }
    trap ':' HUP INT TERM
    if ! write_target_marker "$anchor_path" "$$"; then exit 125; fi
    while [ ! -e "$start_path" ]; do sleep 0.01; done
    while [ ! -e "$authorized_path" ]; do sleep 0.01; done
    "$@" 3>&- 4>&- &
    target_pid=$!
    wait "$target_pid"
    target_status=$?
    if ! write_target_marker "$writer_path" "$$"; then exit 125; fi
    if ! write_target_marker "$result_path" "$target_status"; then exit 125; fi
    if ! write_target_marker "$publication_path" "$target_status"; then exit 125; fi
    if ! printf "%s\\n" "$target_status" >&3; then exit 125; fi
    if ! write_target_marker "$done_path" complete; then exit 125; fi
    exec 3>&-
    while :; do sleep 1; done
  ' "agent-toolkit-target-$target_marker" "$target_anchor_path" "$target_status_path" "$target_start_path" "$target_authorized_path" "$target_status_writer_path" "$completion_path" "$supervisor_no_follow" "$@" &
fi
target_launcher_pid=$!
# The shell owns this PID; the target can discover and mutate marker files but
# cannot change the value used for process-group authorization.
target_pid="$target_launcher_pid"
# The supervisor never reads the status pipe. Only the anchor owns its write
# end, and the target command receives an explicitly closed fd 3.
exec 3>&- || true
wrapper_pgid="$(run_process_probe ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
target_pgid_attempt=0
while [ "$target_pgid_attempt" -lt 100 ]; do
  observed_target_pgid="$(run_process_probe ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  case "$observed_target_pgid" in
    ''|*[!0-9]*) sleep 0.01; target_pgid_attempt=$((target_pgid_attempt + 1)) ;;
    *)
      if [ -n "$wrapper_pgid" ] && [ "$observed_target_pgid" = "$wrapper_pgid" ]; then
        sleep 0.01
        target_pgid_attempt=$((target_pgid_attempt + 1))
      else
        target_pgid="$observed_target_pgid"
        break
      fi
      ;;
  esac
done
capture_target_identity() {
  target_identity_mode="unknown"
  target_starttime=""
  target_ps_start=""
  target_ps_uid=""
  if [ -r "/proc/$target_pid/stat" ]; then
    target_starttime="$(run_process_probe awk '{ sub(/.*\\) /, ""); print $20 }' "/proc/$target_pid/stat" 2>/dev/null || true)"
    if [ -n "$target_starttime" ]; then
      target_identity_mode="proc"
      return 0
    fi
  fi
  target_ps_start="$(ps_identity_for_pid "$target_pid" 2>/dev/null || true)"
  if [ -n "$target_ps_start" ]; then
    target_ps_uid="$(ps_owner_for_pid "$target_pid" 2>/dev/null || true)"
    [ -n "$target_ps_uid" ] || return 1
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
    kill -0 "$target_pid" 2>/dev/null || return 1
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
  # Linux exposes process identity through /proc. Do not fall back to the
  # slower macOS ps identity format after a Linux process has disappeared.
  [ -d /proc ] && return 1
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
  if [ -d /proc ] && [ ! -e "/proc/$process_id" ]; then
    process_liveness_result=dead
    return 0
  fi
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
retry_process_liveness() {
  retry_process_id="$1"
  retry_process_attempt=0
  process_liveness "$retry_process_id"
  while [ "$process_liveness_result" = "unknown" ] && [ "$retry_process_attempt" -lt 3 ]; do
    snapshot_deadline_exceeded && return 0
    sleep 0.025
    process_liveness "$retry_process_id"
    retry_process_attempt=$((retry_process_attempt + 1))
  done
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
              if printf '%s' "$captured_descendants_read_data" | awk -F'|' -v pid="$captured_expected_ppid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' >/dev/null 2>&1; then
                [ "$captured_expected_pgid" = "$captured_ps_pgid" ] && return 0
              fi
              ;;
          esac
          return 1
          ;;
        ''|*[!0-9]*) return 1 ;;
      esac
      if printf '%s' "$captured_descendants_read_data" | awk -F'|' -v pid="$captured_ps_ppid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' >/dev/null 2>&1; then
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
process_parent_id() {
  process_parent_pid="$1"
  if [ -r "/proc/$process_parent_pid/stat" ]; then
    process_parent_value="$(run_snapshot_command awk '{ sub(/.*\\) /, ""); print $2 }' "/proc/$process_parent_pid/stat" 2>/dev/null || true)"
  else
    process_parent_value="$(run_process_probe ps -o ppid= -p "$process_parent_pid" 2>/dev/null | run_process_probe awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
  fi
  case "$process_parent_value" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$process_parent_value" ;;
  esac
}
process_is_target_descendant() {
  candidate_pid="$1"
  ancestry_seen=" "
  ancestry_attempt=0
  while [ "$ancestry_attempt" -lt 32 ]; do
    [ "$candidate_pid" = "$target_pid" ] && return 0
    case "$candidate_pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
    case "$ancestry_seen" in *" $candidate_pid "*) return 1 ;; esac
    ancestry_seen="$ancestry_seen$candidate_pid "
    candidate_parent="$(process_parent_id "$candidate_pid" 2>/dev/null || true)"
    case "$candidate_parent" in ''|0|1|*[!0-9]*) return 1 ;; esac
    candidate_pid="$candidate_parent"
    ancestry_attempt=$((ancestry_attempt + 1))
  done
  return 1
}
authorized_record_exists() {
  authorized_candidate="$(printf '%s\n' "$1" | tr ' ' '%')"
  for authorized_record in $authorized_descendant_records; do
    [ "$authorized_record" = "$authorized_candidate" ] && return 0
  done
  return 1
}
authorize_descendant_record() {
  authorized_new_record="$(printf '%s\n' "$1" | tr ' ' '%')"
  authorized_record_exists "$authorized_new_record" && return 0
  authorized_descendant_records="$authorized_descendant_records $authorized_new_record"
  authorized_descendant_count=$((authorized_descendant_count + 1))
}
validate_authorized_record() {
  authorized_record_exists "$1|$2|$3" || { cleanup_ack_enabled=0; return 1; }
}
authorized_group_record() {
  authorized_group="$1"
  for authorized_record in $authorized_descendant_records; do
    authorized_decoded_record="$(printf '%s\n' "$authorized_record" | tr '%' ' ')"
    authorized_record_group="\${authorized_decoded_record##*|}"
    if [ "$authorized_record_group" = "$authorized_group" ]; then
      printf '%s\n' "$authorized_decoded_record"
      return 0
    fi
  done
  return 1
}
authorized_record_for_pid() {
  authorized_lookup_pid="$1"
  for authorized_record in $authorized_descendant_records; do
    authorized_decoded_record="$(printf '%s\n' "$authorized_record" | tr '%' ' ')"
    authorized_decoded_pid="\${authorized_decoded_record%%|*}"
    if [ "$authorized_decoded_pid" = "$authorized_lookup_pid" ]; then
      printf '%s\n' "$authorized_decoded_record"
      return 0
    fi
  done
  return 1
}
capture_group_members() {
  captured_group="$1"
  case "$captured_group" in ''|0|*[!0-9]*) return 1 ;; esac
  captured_group_probe_path="$status_dir/group-probe-$captured_group"
  captured_group_members_path="$status_dir/group-members-$captured_group"
  captured_group_probe_attempt=0
  captured_group_probe_status=2
  while [ "$captured_group_probe_attempt" -lt 3 ]; do
    safe_capture_command "$captured_group_probe_path" ps -eo pid=,pgid=,state=
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
  if ! safe_capture_command_with_input "$captured_group_members_path" "$captured_group_probe_path" awk -v wanted="$captured_group" '
    $2 != wanted { next }
    NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[[:alpha:]]/ { malformed = 1; next }
    { print $1 "|" $3 }
    END { if (malformed) exit 2 }
  ' "$captured_group_probe_path"; then
    return 2
  fi
  captured_group_members_read_data="$(safe_read_snapshot "$captured_group_members_path" 2>/dev/null)" || return 2
  return 0
}
captured_group_has_live_process() {
  captured_group="$1"
  capture_group_members "$captured_group"
  captured_group_probe_status=$?
  [ "$captured_group_probe_status" -eq 0 ] || return "$captured_group_probe_status"
  printf '%s' "$captured_group_members_read_data" | run_process_probe awk -F'|' '$2 !~ /^Z/ { found = 1; exit } END { exit(found ? 0 : 1) }'
}
retry_captured_group_has_live_process() {
  retry_captured_group="$1"
  retry_captured_group_attempt=0
  captured_group_has_live_process "$retry_captured_group"
  retry_captured_group_status=$?
  while [ "$retry_captured_group_status" -eq 2 ] && [ "$retry_captured_group_attempt" -lt 3 ]; do
    snapshot_deadline_exceeded && return "$retry_captured_group_status"
    sleep 0.025
    captured_group_has_live_process "$retry_captured_group"
    retry_captured_group_status=$?
    retry_captured_group_attempt=$((retry_captured_group_attempt + 1))
  done
  return "$retry_captured_group_status"
}
send_group_signal_or_confirm_empty() {
  signal_group="$1"
  signal_name="$2"
  if kill -"$signal_name" "-$signal_group" 2>/dev/null; then return 0; fi
  captured_group_has_live_process "$signal_group"
  case "$?" in
    1) return 2 ;;
    *) return 1 ;;
  esac
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
  captured_group_owner_uid=""
  captured_group_owner_identity="$(captured_identity_for_pid "$captured_group" 2>/dev/null || true)"
  case "$captured_group_owner_identity" in
    proc:*)
      captured_group_owner_start="\${captured_group_owner_identity#proc:}"
      case "$captured_group_owner_start" in ''|*[!0-9]*) captured_group_owner_start="" ;; esac
      [ "$captured_group_owner_identity" = "$captured_group_identity" ] || captured_group_owner_start=""
      ;;
    ps:*)
      captured_group_owner_start="$(ps_identity_start_token "$captured_group_owner_identity" 2>/dev/null || true)"
      [ "$captured_group_owner_identity" = "$captured_group_identity" ] || captured_group_owner_start=""
      captured_group_owner_epoch="$(ps_identity_start_epoch "$captured_group_owner_identity" 2>/dev/null || true)"
      captured_group_owner_uid="$target_ps_uid"
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
        ps:*:*)
          current_group_member_start="$(ps_identity_start_token "$current_group_member_identity" 2>/dev/null || true)"
          current_group_member_epoch="$(ps_identity_start_epoch "$current_group_member_identity" 2>/dev/null || true)"
          current_group_member_pgid="$(ps_identity_pgid_token "$current_group_member_identity" 2>/dev/null || true)"
          current_group_member_uid="$(ps_owner_for_pid "$group_member_pid" 2>/dev/null || true)"
          [ -n "$captured_group_owner_start" ] || return 1
          case "$captured_group_owner_epoch:$current_group_member_epoch" in
            ''|*[!0-9:]*) return 1 ;;
          esac
          [ "$current_group_member_epoch" -ge "$captured_group_owner_epoch" ] || return 1
          [ "$current_group_member_pgid" = "$captured_group" ] || return 1
          [ "$current_group_member_uid" = "$captured_group_owner_uid" ] || return 1
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
      quiesced_groups_read_data="$(safe_read_snapshot "$quiesced_groups_path" 2>/dev/null || true)"
      if printf '%s' "$quiesced_groups_read_data" | awk -F'|' -v group="$captured_group" -v identity="$expected_group_member_identity" '$1 == group && $2 == identity { found = 1; exit } END { exit(found ? 0 : 1) }' 2>/dev/null; then
        captured_group_anchor_count=$((captured_group_anchor_count + 1))
      fi
    fi
    captured_group_live_count=$((captured_group_live_count + 1))
  done <<EOF
$captured_group_members_read_data
EOF
  [ "$?" -eq 0 ] || return 2
  if [ "$group_quiescence_required" = "1" ] && [ "$captured_group_anchor_count" -eq 0 ]; then return 1; fi
  if [ "$captured_group_missing_member" = "1" ]; then
    if [ -z "$captured_group_owner_start" ]; then return 1; fi
    return 0
  fi
  [ "$captured_group_live_count" -gt 0 ]
}
retry_captured_group_can_be_signaled() {
  retry_captured_group_identity="$1"
  retry_captured_group="$2"
  retry_captured_group_attempt=0
  captured_group_can_be_signaled "$retry_captured_group_identity" "$retry_captured_group"
  retry_captured_group_status=$?
  while [ "$retry_captured_group_status" -eq 2 ] && [ "$retry_captured_group_attempt" -lt 3 ]; do
    snapshot_deadline_exceeded && return "$retry_captured_group_status"
    sleep 0.025
    captured_group_can_be_signaled "$retry_captured_group_identity" "$retry_captured_group"
    retry_captured_group_status=$?
    retry_captured_group_attempt=$((retry_captured_group_attempt + 1))
  done
  return "$retry_captured_group_status"
}
scan_target_marker_processes() {
  marker_output_path="$1"
  if [ ! -d /proc ] || [ -z "$target_marker" ] || [ "$target_marker" = "unbound" ]; then
    rm -f "$marker_output_path" 2>/dev/null || return 1
    create_marker_exclusive "$marker_output_path"
    return 0
  fi
  safe_capture_command "$marker_output_path" perl -e '
    use strict;
    use warnings;
    my ($expected) = @ARGV;
    opendir(my $proc, "/proc") or exit 1;
    for my $entry (readdir($proc)) {
      next unless $entry =~ /^[0-9]+$/;
      open(my $env, "<:raw", "/proc/$entry/environ") or next;
      local $/;
      my $data = <$env> // "";
      if ($data =~ /(?:^|\\0)AGENT_TOOLKIT_TARGET_MARKER=\Q$expected\E(?:\\0|$)/) {
        print $entry, "\\n";
      }
    }
    closedir($proc);
  ' "$target_marker"
}

marker_process_is_baseline() {
  marker_pid="$1"
  printf '%s' "$target_marker_baseline_read_data" | awk -v pid="$marker_pid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' >/dev/null 2>&1
}

append_marker_roots() {
  marker_roots=""
  target_marker_scan_read_data="$(safe_read_snapshot "$target_marker_scan_path" 2>/dev/null || true)"
  while read -r marker_pid; do
    case "$marker_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; continue ;; esac
    [ "$marker_pid" = "$$" ] && continue
    marker_process_is_baseline "$marker_pid" && continue
    marker_roots="$marker_roots $marker_pid"
  done <<EOF
$target_marker_scan_read_data
EOF
  descendant_roots="$descendant_roots$marker_roots"
}

descendants_for_roots() {
  descendant_roots="$1"
  descendant_groups="$2"
  descendant_result_path="\${3:-$descendant_result_path}"
  if ! rm -f "$descendant_result_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  if ! rm -f "$descendant_scan_status_path" "$descendant_scan_truncated_path" 2>/dev/null; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  if snapshot_deadline_exceeded; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  if ! safe_capture_command "$descendant_scan_input_path" ps -eo pid=,ppid=,pgid=; then
    cleanup_ack_enabled=0
    create_marker_exclusive "$descendant_scan_failed_path" || true
    return 1
  fi
  if [ "$target_marker_scan_requested" = "1" ]; then
    if ! scan_target_marker_processes "$target_marker_scan_path"; then
      cleanup_ack_enabled=0
      create_marker_exclusive "$descendant_scan_failed_path" || true
      return 1
    fi
    append_marker_roots
  fi
  descendant_scan_output_path="$status_dir/descendant-scan-output"
  safe_capture_command_with_input "$descendant_scan_output_path" "$descendant_scan_input_path" awk -v roots="$descendant_roots" -v groups="$descendant_groups" -v max_rows=65536 '
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
      if (truncated) exit 3
      exit 0
    }
  '
  descendant_scan_status_code=$?
  case "$descendant_scan_status_code" in
    0)
      if ! write_marker_exclusive "$descendant_scan_status_path" ok || ! safe_copy_file "$descendant_scan_output_path" "$descendant_result_path"; then
        cleanup_ack_enabled=0
        create_marker_exclusive "$descendant_scan_failed_path" || true
        return 1
      fi
      ;;
    3)
      if ! create_marker_exclusive "$descendant_scan_truncated_path" || ! write_marker_exclusive "$descendant_scan_status_path" truncated || ! safe_copy_file "$descendant_scan_output_path" "$descendant_result_path"; then
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
  descendant_result_path="\${1:-$descendant_result_path}"
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
  target_roots=""
  target_groups=""
  if target_identity_matches; then
    target_roots="$target_pid"
    # While the target is alive, ancestry is the authorization source. A
    # process that merely joins the target's group must not become killable.
  else
    process_liveness "$target_pid"
    case "$process_liveness_result" in
      dead)
        # Once the target is gone, only already captured and authorized
        # descendants may be reconciled. Do not re-authorize a reused PGID.
        target_roots=""
        target_groups=""
        ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
  fi
  descendants_for_roots "$target_roots" "$target_groups" "$descendant_result_path"
}
owned_descendants() {
  descendant_result_path="\${1:-$descendant_result_path}"
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
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
      dead)
        # A dead target's PGID may already have been reused. Existing
        # authorized records below are the only safe roots in this state.
        owned_groups=""
        ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
  fi
  if [ "$authorized_descendant_count" -gt 0 ]; then
    while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
      [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
      case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
      [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
      identity_is_valid "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
      case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
      validate_authorized_record "$captured_pid" "$captured_identity" "$captured_pgid" || return 1
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
    done <<EOF
$captured_descendants_read_data
EOF
    [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
  fi
  descendants_for_roots "$owned_roots" "$owned_groups" "$descendant_result_path"
}
snapshot_descendants() {
  if ! create_marker_exclusive "$snapshot_started_path"; then cleanup_ack_enabled=0; fi
  if ! descendants "$pending_descendants_path" 2>/dev/null || [ "$cleanup_ack_enabled" != "1" ]; then
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
  snapshot_descendants >/dev/null 2>/dev/null || cleanup_ack_enabled=0
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
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
  captured_count="$authorized_descendant_count"
  [ -f "$record_pending_path" ] || { cleanup_ack_enabled=0; return 1; }
  record_pending_read_data="$(safe_read_snapshot "$record_pending_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return 1; }
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
    if target_identity_matches; then
      if authorized_record_exists "$captured_record"; then
        :
      elif ! process_is_target_descendant "$captured_pid"; then
        # A short-lived child may exit between the process snapshot and the
        # ancestry check. Treat a confirmed exit as absent from the ledger;
        # keep live or uncertain processes fail-closed below.
        process_liveness "$captured_pid"
        case "$process_liveness_result" in
          dead) continue ;;
          live) ;;
          *) cleanup_ack_enabled=0; return 1 ;;
        esac
        authorized_group_source="$(authorized_group_record "$captured_pgid" 2>/dev/null || true)"
        if [ -n "$authorized_group_source" ]; then
          IFS='|' read -r authorized_group_pid authorized_group_identity authorized_group_pgid <<EOF
$authorized_group_source
EOF
          if ! captured_group_can_be_signaled "$authorized_group_identity" "$captured_pgid"; then
            cleanup_ack_enabled=0
            return 1
          fi
        else
          cleanup_ack_enabled=0
          return 1
        fi
      fi
    elif ! authorized_record_exists "$captured_record"; then
      authorized_group_source="$(authorized_group_record "$captured_pgid" 2>/dev/null || true)"
      if [ -n "$authorized_group_source" ]; then
        IFS='|' read -r authorized_group_pid authorized_group_identity authorized_group_pgid <<EOF
$authorized_group_source
EOF
        if ! captured_group_can_be_signaled "$authorized_group_identity" "$captured_pgid"; then
          cleanup_ack_enabled=0
          return 1
        fi
      elif [ "$captured_pgid" = "$target_pgid" ] && [ "$target_pgid" != "$wrapper_pgid" ]; then
        if ! target_group_can_be_signaled_after_anchor_loss; then
          cleanup_ack_enabled=0
          return 1
        fi
      else
        cleanup_ack_enabled=0
        return 1
      fi
    fi
    existing_captured_record="$(authorized_record_for_pid "$captured_pid" 2>/dev/null || true)"
    if [ -n "$existing_captured_record" ]; then
      if ! authorized_record_exists "$existing_captured_record"; then
        cleanup_ack_enabled=0
        return 1
      fi
      existing_captured_identity="\${existing_captured_record#*|}"
      existing_captured_identity="\${existing_captured_identity%%|*}"
      if captured_identity_matches "$existing_captured_identity" "$captured_identity"; then
        continue
      fi
      cleanup_ack_enabled=0
      return 1
    fi
    if ! safe_append_line "$captured_descendants_path" "$captured_record"; then
      cleanup_ack_enabled=0
      return 1
    fi
    authorize_descendant_record "$captured_record"
    captured_count=$((captured_count + 1))
  done <<EOF
$record_pending_read_data
EOF
  [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
  captured_descendants_read_data="$(safe_read_snapshot "$captured_descendants_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return 1; }
}
capture_owned_descendants() {
  if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
  owned_pending_path="$status_dir/owned-descendant-pids-$snapshot_generation-$ownership_round"
  if ! owned_descendants "$owned_pending_path" 2>/dev/null || [ "$cleanup_ack_enabled" != "1" ]; then
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
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
  [ "$authorized_descendant_count" -gt 0 ] || return 0
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
    case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
    identity_is_valid "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    validate_authorized_record "$captured_pid" "$captured_identity" "$captured_pgid" || return 1
    retry_process_liveness "$captured_pid"
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
    if ! safe_append_line "$quiesced_groups_path" "$current_captured_pgid|$captured_identity"; then cleanup_ack_enabled=0; return 1; fi
  done <<EOF
$captured_descendants_read_data
EOF
  [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
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
  if printf '%s' "$captured_descendants_read_data" | awk -F'|' '$2 ~ /^ps:/ { found = 1; exit } END { exit(found ? 0 : 1) }' 2>/dev/null; then
    group_quiescence_required=1
  fi
  ownership_previous_count="$authorized_descendant_count"
  ownership_round=0
  while [ "$ownership_round" -lt 4 ]; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    if ! capture_owned_descendants; then return 1; fi
    if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
    ownership_current_count="$authorized_descendant_count"
    if [ "$ownership_current_count" = "$ownership_previous_count" ]; then return 0; fi
    ownership_previous_count="$ownership_current_count"
    ownership_round=$((ownership_round + 1))
    if ! quiesce_captured_descendants; then return 1; fi
  done
  cleanup_ack_enabled=0
  return 1
}
reconcile_captured_descendants() {
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
  [ "$authorized_descendant_count" -eq 0 ] && return 0
  [ "$authorized_descendant_count" -gt 0 ] || return 0
  if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
  reconcile_pending_path="$status_dir/reconcile-target-descendants"
  reconcile_next_path="$status_dir/descendants-reconciled"
  reconcile_target_pgid="$target_pgid"
  if target_identity_matches; then
    observed_reconcile_target_pgid="$(process_group_id "$target_pid" 2>/dev/null || true)"
    [ -n "$observed_reconcile_target_pgid" ] && reconcile_target_pgid="$observed_reconcile_target_pgid"
  fi
  if ! descendants "$reconcile_pending_path" 2>/dev/null || [ "$cleanup_ack_enabled" != "1" ]; then
    cleanup_ack_enabled=0
    return 1
  fi
  reconcile_pending_read_data="$(safe_read_snapshot "$reconcile_pending_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return 1; }
  if ! create_marker_exclusive "$reconcile_next_path"; then cleanup_ack_enabled=0; return 1; fi
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
    case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
    identity_is_valid "$captured_identity" || { cleanup_ack_enabled=0; return 1; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    validate_authorized_record "$captured_pid" "$captured_identity" "$captured_pgid" || { cleanup_ack_enabled=0; return 1; }
    retry_process_liveness "$captured_pid"
    case "$process_liveness_result" in
      dead)
        if [ "$captured_pgid" = "$reconcile_target_pgid" ]; then
          safe_append_line "$reconcile_next_path" "$captured_pid|$captured_identity|$captured_pgid" || { cleanup_ack_enabled=0; return 1; }
          continue
        fi
        retry_captured_group_has_live_process "$captured_pgid"
        captured_group_live_status=$?
        case "$captured_group_live_status" in
          0)
            retry_captured_group_can_be_signaled "$captured_identity" "$captured_pgid"
            captured_group_signal_status=$?
            if [ "$captured_group_signal_status" -ne 0 ]; then cleanup_ack_enabled=0; return 1; fi
            ;;
          1) ;;
          *) cleanup_ack_enabled=0; return 1 ;;
        esac
        safe_append_line "$reconcile_next_path" "$captured_pid|$captured_identity|$captured_pgid" || { cleanup_ack_enabled=0; return 1; }
        continue
        ;;
      live) ;;
      *) cleanup_ack_enabled=0; return 1 ;;
    esac
    current_captured_identity="$(process_identity "$captured_pid" 2>/dev/null || true)"
    current_captured_identity="$(normalize_process_identity "$current_captured_identity" 2>/dev/null || true)"
    if captured_identity_matches "$captured_identity" "$current_captured_identity"; then
      safe_append_line "$reconcile_next_path" "$captured_pid|$captured_identity|$captured_pgid" || { cleanup_ack_enabled=0; return 1; }
      continue
    fi
    if ! printf '%s' "$reconcile_pending_read_data" | awk -v pid="$captured_pid" '$1 == pid { found = 1; exit } END { exit(found ? 0 : 1) }' >/dev/null 2>&1; then
      cleanup_ack_enabled=0
      return 1
    fi
  done <<EOF
$captured_descendants_read_data
EOF
  [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
  if ! mv -f -- "$reconcile_next_path" "$captured_descendants_path" 2>/dev/null; then cleanup_ack_enabled=0; return 1; fi
}
signal_captured_descendants() {
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
  [ "$authorized_descendant_count" -eq 0 ] && return 0
  [ "$authorized_descendant_count" -gt 0 ] || return 0
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    case "$captured_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; continue; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; continue ;; esac
    validate_authorized_record "$captured_pid" "$captured_identity" "$captured_pgid" || continue
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
  done <<EOF
$captured_descendants_read_data
EOF
  [ "$?" -eq 0 ] || cleanup_ack_enabled=0
}
captured_descendants_confined_to_target_group() {
  case "$target_pgid:$wrapper_pgid" in
    ''|*:|:*) return 1 ;;
  esac
  validate_captured_ledger || return 1
  while IFS='|' read -r confined_pid confined_identity confined_pgid confined_extra; do
    [ -n "$confined_pid$confined_identity$confined_pgid$confined_extra" ] || continue
    [ -z "$confined_extra" ] || return 1
    case "$confined_pgid" in
      "$target_pgid"|"$wrapper_pgid") ;;
      *) return 1 ;;
    esac
    process_liveness "$confined_pid"
    case "$process_liveness_result" in
      dead) continue ;;
      live) ;;
      *) return 1 ;;
    esac
    confined_current_identity="$(process_identity "$confined_pid" 2>/dev/null || true)"
    confined_current_identity="$(normalize_process_identity "$confined_current_identity" 2>/dev/null || true)"
    captured_identity_matches "$confined_identity" "$confined_current_identity" || return 1
    confined_current_pgid="$(process_group_id "$confined_pid" 2>/dev/null || true)"
    [ "$confined_current_pgid" = "$confined_pgid" ] || return 1
  done <<EOF
$captured_descendants_read_data
EOF
  [ "$?" -eq 0 ]
}
signal_tree() {
  signal="$1"
  if [ -d /proc ]; then target_marker_scan_requested=1; fi
  set_snapshot_deadline
  target_group_fast_path=0
  if [ "$target_identity_mode" = "proc" ] && [ -e "$completion_path" ] && target_identity_matches; then
    # Completion can race with a child leaving the target tree. Refresh the
    # authenticated ledger before accepting the process-group fast path.
    start_snapshot || true
    if [ "$snapshot_ready_observed" = "1" ] && [ ! -e "$snapshot_failed_path" ] && captured_descendants_confined_to_target_group; then
      target_group_fast_path=1
    fi
  fi
  group_quiescence_required=0
  rm -f "$quiesced_groups_path" 2>/dev/null || cleanup_ack_enabled=0
  if [ "$signal" = "KILL" ] && [ "$target_group_fast_path" != "1" ]; then
    reconcile_captured_descendants || cleanup_ack_enabled=0
  fi
  if [ "$target_group_fast_path" = "1" ]; then
    snapshot_ready_observed=1
  else
    start_snapshot
  fi
  snapshot_ready_before_signal="$snapshot_ready_observed"
  if [ -z "$wrapper_pgid" ]; then
    wrapper_pgid="$(run_process_probe ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
  fi
  current_target_pgid=""
  group_signal_succeeded=0
  if target_identity_matches; then
    current_target_pgid="$(run_process_probe ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ' || true)"
  fi
  if [ "$signal" = "KILL" ] && [ "$target_group_fast_path" != "1" ] && [ "$snapshot_ready_before_signal" = "1" ] && [ ! -e "$snapshot_failed_path" ]; then
    prepare_kill_ownership || cleanup_ack_enabled=0
  fi
  case "$current_target_pgid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$current_target_pgid" = "$target_pgid" ] && [ "$current_target_pgid" != "$wrapper_pgid" ]; then
        send_group_signal_or_confirm_empty "$current_target_pgid" "$signal"
        case "$?" in
          0|2) group_signal_succeeded=1 ;;
          *) cleanup_ack_enabled=0 ;;
        esac
      fi
      ;;
  esac
  if [ "$group_signal_succeeded" = "0" ] && [ -z "$current_target_pgid" ]; then
    if target_group_can_be_signaled_after_anchor_loss; then
      send_group_signal_or_confirm_empty "$target_pgid" "$signal"
      case "$?" in
        0|2) group_signal_succeeded=1 ;;
        *) cleanup_ack_enabled=0 ;;
      esac
    fi
  fi
  wait_for_snapshot
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ] || [ -e "$snapshot_failed_path" ] || [ "$snapshot_ready_before_signal" != "1" ]; then cleanup_ack_enabled=0; fi
  if [ "$signal" = "KILL" ]; then
    # A fresh scan can fail after an earlier authenticated ledger was
    # captured. Keep the acknowledgement failed closed, but still reap the
    # already-authorized records through identity-checked signaling.
    signal_captured_descendants
  fi
  # If the anchor died before the group signal, retain the captured target
  # group and descendant snapshot as the cleanup roots. Returning here would
  # leave descendants alive precisely when the identity probe is unavailable.
  if [ "$group_signal_succeeded" = "1" ]; then return; fi
  signal_descendants_path="$status_dir/signal-descendants"
  if ! descendants "$signal_descendants_path"; then cleanup_ack_enabled=0; return; fi
  signal_descendants_read_data="$(safe_read_snapshot "$signal_descendants_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return; }
  while read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    process_liveness "$pid"
    case "$process_liveness_result" in
      dead) continue ;;
      live) ;;
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
  done <<EOF
$signal_descendants_read_data
EOF
  [ "$?" -eq 0 ] || cleanup_ack_enabled=0
  if [ -e "$descendant_scan_truncated_path" ] || [ -e "$descendant_scan_failed_path" ] || [ -e "$snapshot_failed_path" ]; then cleanup_ack_enabled=0; fi
}
captured_identity_for_pid() {
  captured_lookup_pid="$1"
  [ "$authorized_descendant_count" -gt 0 ] || return 1
  printf '%s' "$captured_descendants_read_data" | awk -F'|' -v pid="$captured_lookup_pid" '$1 == pid { print $2; found = 1; exit } END { if (!found) exit 1 }'
}
captured_group_for_pid() {
  captured_lookup_pid="$1"
  [ "$authorized_descendant_count" -gt 0 ] || return 1
  printf '%s' "$captured_descendants_read_data" | awk -F'|' -v pid="$captured_lookup_pid" '$1 == pid { print $3; found = 1; exit } END { if (!found) exit 1 }'
}
verify_captured_descendants() {
  if ! validate_captured_ledger; then cleanup_ack_enabled=0; return 1; fi
  [ "$authorized_descendant_count" -gt 0 ] || return 0
  while IFS='|' read -r captured_pid captured_identity captured_pgid captured_extra; do
    if snapshot_deadline_exceeded; then cleanup_ack_enabled=0; return 1; fi
    [ -n "$captured_pid$captured_identity$captured_pgid$captured_extra" ] || continue
    case "$captured_pid" in ''|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    [ "$captured_pid" = "$$" ] && continue
    [ "$captured_pid" = "$target_pid" ] && continue
    [ -z "$captured_extra" ] || { cleanup_ack_enabled=0; return 1; }
    case "$captured_pgid" in ''|0|*[!0-9]*) cleanup_ack_enabled=0; return 1 ;; esac
    validate_authorized_record "$captured_pid" "$captured_identity" "$captured_pgid" || return 1
    process_liveness "$captured_pid"
    case "$process_liveness_result" in
      dead)
        # A successful target-group signal already covered this member. The
        # dedicated group verification below is the authoritative remaining
        # process check, so avoid a duplicate probe for every dead member.
        if [ "$captured_pgid" = "$target_pgid" ] && [ "$group_signal_succeeded" = "1" ]; then continue; fi
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
  done <<EOF
$captured_descendants_read_data
EOF
  [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
}
verify_owned_descendants() {
  verify_owned_path="$status_dir/remaining-owned-descendants"
  if ! owned_descendants "$verify_owned_path" 2>/dev/null || [ "$cleanup_ack_enabled" != "1" ]; then
    cleanup_ack_enabled=0
    return 1
  fi
  verify_owned_read_data="$(safe_read_snapshot "$verify_owned_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return 1; }
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
  done <<EOF
$verify_owned_read_data
EOF
  [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
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
    done <<EOF
$captured_group_members_read_data
EOF
    [ "$?" -eq 0 ] || { cleanup_ack_enabled=0; return 1; }
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
  if ! descendants "$verify_descendants_path" 2>/dev/null || [ "$cleanup_ack_enabled" != "1" ]; then
    cleanup_ack_enabled=0
    return 1
  fi
  verify_descendants_read_data="$(safe_read_snapshot "$verify_descendants_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return 1; }
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
  done <<EOF
$verify_descendants_read_data
EOF
  if [ "$remaining_descendants" = "1" ]; then sleep 0.05; fi
  if ! descendants "$verify_descendants_path" 2>/dev/null || [ "$cleanup_ack_enabled" != "1" ]; then
    cleanup_ack_enabled=0
    return 1
  fi
  verify_descendants_read_data="$(safe_read_snapshot "$verify_descendants_path" 2>/dev/null)" || { cleanup_ack_enabled=0; return 1; }
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
  done <<EOF
$verify_descendants_read_data
EOF
  verify_captured_descendants
}
target_group_can_be_signaled_after_anchor_loss() {
  [ "$target_identity_mode" != "unknown" ] || return 1
  [ "$target_pgid" = "$target_pid" ] || return 1
  [ -n "$wrapper_pgid" ] && [ "$target_pgid" != "$wrapper_pgid" ] || return 1
  process_liveness "$target_pid"
  [ "$process_liveness_result" = "dead" ] || return 1
  capture_group_members "$target_pgid"
  [ "$?" -eq 0 ] || return 1
  target_group_live_count=0
  while IFS='|' read -r target_group_member_pid target_group_member_state; do
    [ -n "$target_group_member_pid$target_group_member_state" ] || continue
    case "$target_group_member_pid" in ''|*[!0-9]*) return 1 ;; esac
    case "$target_group_member_state" in Z*) continue ;; esac
    [ "$target_group_member_pid" != "$$" ] || return 1
    process_liveness "$target_group_member_pid"
    case "$process_liveness_result" in
      live)
        target_group_member_identity="$(process_identity "$target_group_member_pid" 2>/dev/null || true)"
        target_group_member_identity="$(normalize_process_identity "$target_group_member_identity" 2>/dev/null || true)"
        target_group_expected_identity="$(captured_identity_for_pid "$target_group_member_pid" 2>/dev/null || true)"
        [ -n "$target_group_expected_identity" ] || return 1
        captured_identity_matches "$target_group_expected_identity" "$target_group_member_identity" || return 1
        target_group_live_count=$((target_group_live_count + 1))
        ;;
      dead) ;;
      *) return 1 ;;
    esac
  done <<EOF
$captured_group_members_read_data
EOF
  [ "$?" -eq 0 ] || return 1
  [ "$target_group_live_count" -gt 0 ]
}
watchdog_pid=""
termination_started=0
termination_requested=0
stop_watchdog() {
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
terminate_supervised_tree() {
  if [ "$termination_started" = "1" ]; then return 0; fi
  if ! acquire_cleanup_owner; then return 0; fi
  termination_started=1
  ensure_marker "$cleanup_started_path" || cleanup_ack_enabled=0
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
# Let an in-flight bounded probe finish before starting cleanup. This prevents
# a signal trap from racing a snapshot writer against the cleanup verifier.
trap 'termination_requested=1; if [ "$termination_started" != "1" ] && [ -n "$hold_pid" ]; then kill "$hold_pid" 2>/dev/null || true; fi' HUP INT TERM
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
  ensure_marker "$parent_dead_path" || true
  kill -TERM "$supervisor_pid" 2>/dev/null || true
  exit 0
}
watch_parent </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
if ! write_marker_exclusive "$ready_path" ready; then
  cleanup_ack_enabled=0
  terminate_supervised_tree
  exit 125
fi
if ! scan_target_marker_processes "$target_marker_baseline_path"; then
  cleanup_ack_enabled=0
fi
target_marker_baseline_read_data="$(safe_read_snapshot "$target_marker_baseline_path" 2>/dev/null || true)"
if ! create_marker_exclusive "$target_start_path"; then
  cleanup_ack_enabled=0
  terminate_supervised_tree
  exit 125
fi
snapshot_probe_count=0
start_snapshot || true
target_status_invalid=0
while [ ! -e "$completion_path" ]; do
  if [ "$termination_requested" = "1" ]; then
    terminate_supervised_tree
    exit 143
  fi
  if ! target_is_alive; then
    target_status_invalid=1
    break
  fi
  if ! parent_is_alive; then
    ensure_marker "$parent_dead_path" || true
    terminate_supervised_tree
    exit 143
  fi
  snapshot_probe_count=$((snapshot_probe_count + 1))
  if [ "$snapshot_probe_count" -ge 5 ]; then
    start_snapshot || true
    snapshot_probe_count=0
  fi
  if [ "$termination_requested" = "1" ]; then
    terminate_supervised_tree
    exit 143
  fi
  sleep 0.01
done
if [ "$target_status_invalid" = "1" ] || [ "$(read_regular_marker "$completion_path" 2>/dev/null || true)" != "complete" ]; then
  cleanup_ack_result=0
  terminate_supervised_tree
  exit 125
fi
if ! parent_is_alive; then
  ensure_marker "$parent_dead_path" || true
  terminate_supervised_tree
  exit 143
fi
exec 0<&- 1>/dev/null 2>/dev/null
# The target exit code is the wrapper's authenticated result. Run the
# potentially slower process-tree verification independently so short-lived
# commands are not reported as timed out while cleanup is still in progress.
(trap ':' HUP INT TERM; exec 3>&-; terminate_supervised_tree) </dev/null >/dev/null 2>/dev/null &
cleanup_pid="$!"
exit 0
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

function decodeSpawnOutput(output: Uint8Array | string | undefined): string {
  if (output === undefined) return "";
  return typeof output === "string" ? output : new TextDecoder().decode(output);
}

async function readNumericMarker(path: string): Promise<number | undefined> {
  const value = (await readRegularMarker(path))?.trim() ?? "";
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}

async function readStatusPipe(fd: number, timeoutMs = SUPERVISOR_STATUS_PIPE_TIMEOUT_MS): Promise<number | undefined> {
  const reader = Bun.file(fd).stream().getReader();
  const decoder = new TextDecoder();
  let value = "";
  const cancelReader = (): void => {
    try { void reader.cancel().catch(() => undefined); } catch { /* The pipe may already be closed. */ }
  };
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      const readPromise = reader.read();
      const result = await raceWithTimeout(
        readPromise.then((read) => ({ kind: "data" as const, read })),
        remainingMs,
        { kind: "timeout" as const },
      );
      if (result.kind === "timeout") {
        cancelReader();
        return undefined;
      }
      if (result.read.done) break;
      value += decoder.decode(result.read.value ?? new Uint8Array(), { stream: true });
      const lineEnd = value.indexOf("\n");
      if (lineEnd >= 0) {
        const normalized = value.slice(0, lineEnd).trim();
        if (!/^[0-9]+$/.test(normalized)) return undefined;
        const status = Number(normalized);
        return Number.isInteger(status) && status >= 0 && status <= 255 ? status : undefined;
      }
    }
    value += decoder.decode();
    const normalized = value.trim();
    if (!/^[0-9]+$/.test(normalized)) return undefined;
    const status = Number(normalized);
    return Number.isInteger(status) && status >= 0 && status <= 255 ? status : undefined;
  } catch {
    return undefined;
  } finally {
    cancelReader();
    try { reader.releaseLock(); } catch { /* The pipe may still be closing. */ }
    await closeFileDescriptor(fd);
  }
}

interface TargetReference {
  pid: number;
  pgid: number;
  identity: string;
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

const POSIX_PS = Bun.which("ps") ?? undefined;

async function boundedCommandOutput(command: string[], timeoutMs = 2_000): Promise<{ exitCode: number; stdout: string } | undefined> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const result = await raceWithTimeout(
    child.exited.then(async (exitCode) => ({
      exitCode,
      stdout: await new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    })),
    timeoutMs,
    undefined,
  );
  if (result !== undefined) return result;
  try { child.kill("SIGKILL"); } catch { /* The probe may already be gone. */ }
  await child.exited.catch(() => undefined);
  return undefined;
}

async function macProcessIdentity(pid: number): Promise<string | undefined> {
  if (POSIX_PS === undefined) return undefined;
  const result = await boundedCommandOutput([
    "sh",
    "-c",
    `
pid="$1"
start="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | awk '
  $1 ~ /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/ &&
  $2 ~ /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/ &&
  $3 ~ /^[0-9][0-9]*$/ &&
  $4 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ &&
  $5 ~ /^[0-9][0-9][0-9][0-9]$/ { print $1, $2, $3, $4, $5; exit }
')"
ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); if ($0 ~ /^[0-9]+$/) print; exit }')"
command_hash="$(ps -o command= -p "$pid" 2>/dev/null | cksum | awk 'NR == 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1 ":" $2; exit }')"
if [ -n "$start" ] && [ -n "$ppid" ] && [ -n "$pgid" ] && [ -n "$command_hash" ]; then
  printf 'ps:%s;ppid=%s;pgid=%s;cmd=%s\\n' "$start" "$ppid" "$pgid" "$command_hash"
fi
`,
    "agent-toolkit-process-identity",
    String(pid),
  ]);
  if (result === undefined || result.exitCode !== 0) return undefined;
  const identity = result.stdout.trim();
  return identity.startsWith("ps:") ? identity : undefined;
}

async function currentProcessIdentity(pid: number): Promise<string | undefined> {
  const start = await processStartTime(pid);
  return start === undefined ? await macProcessIdentity(pid) : `proc:${start}`;
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

async function currentProcessGroup(pid: number): Promise<number | undefined> {
  if (POSIX_PS === undefined) return undefined;
  const result = await boundedCommandOutput([POSIX_PS, "-o", "pgid=", "-p", String(pid)]);
  if (result === undefined || result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}

async function currentProcessParent(pid: number): Promise<number | undefined> {
  if (POSIX_PS === undefined) return undefined;
  const result = await boundedCommandOutput([POSIX_PS, "-o", "ppid=", "-p", String(pid)]);
  if (result === undefined || result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}

async function readTargetReference(statusPath: string, wrapperPid: number): Promise<TargetReference | undefined> {
  const directory = dirname(statusPath);
  const [pid, pgid, identity] = await Promise.all([
    readNumericMarker(join(directory, "target")),
    readNumericMarker(join(directory, "target-pgid")),
    readRegularMarker(join(directory, "target-identity")),
  ]);
  const normalizedIdentity = identity?.trim() ?? "";
  if (pid === undefined || pgid === undefined || normalizedIdentity.length === 0) return undefined;
  if (await currentProcessParent(pid) !== wrapperPid) return undefined;
  const currentPgid = await currentProcessGroup(pid);
  const currentIdentity = await currentProcessIdentity(pid);
  if (currentPgid !== pgid || currentIdentity === undefined || !processIdentityMatches(normalizedIdentity, currentIdentity)) return undefined;
  return { pid, pgid, identity: normalizedIdentity };
}

async function processGroupHasLiveProcess(pgid: number): Promise<boolean | undefined> {
  if (POSIX_PS === undefined) return undefined;
  const child = Bun.spawn([POSIX_PS, "-axo", "pid=,pgid=,state="], { stdout: "pipe", stderr: "ignore" });
  const output = await raceWithTimeout(
    child.exited.then((exitCode) => exitCode === 0 ? new Response(child.stdout).text() : undefined),
    2_000,
    undefined,
  );
  if (output === undefined) {
    try { child.kill("SIGKILL"); } catch { /* The process probe may already be gone. */ }
    await child.exited.catch(() => undefined);
    return undefined;
  }
  for (const line of (await output).split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)/.exec(line);
    if (match === null) return undefined;
    const pid = Number(match[1]);
    const observedPgid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(observedPgid)) return undefined;
    if (observedPgid === pgid && pid !== process.pid && !match[3]!.startsWith("Z")) return true;
  }
  return false;
}

async function waitForProcessGroupGone(pgid: number): Promise<boolean> {
  const deadline = Date.now() + SUPERVISOR_ORPHAN_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = await processGroupHasLiveProcess(pgid);
    if (live === false) return true;
    if (live === undefined) return false;
    await Bun.sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  return (await processGroupHasLiveProcess(pgid)) === false;
}

async function cleanupOrphanedTarget(rememberedReference?: TargetReference): Promise<boolean> {
  if (process.platform === "win32") return false;
  const reference = rememberedReference;
  if (reference === undefined) return false;
  const targetPid = reference.pid;
  const targetPgid = reference.pgid;
  if (targetPid === undefined || targetPgid === undefined || targetPid === process.pid) return false;
  const currentPgid = await currentProcessGroup(process.pid);
  if (currentPgid === undefined || currentPgid === targetPgid) return false;
  const verifyTargetReference = async (): Promise<boolean> => {
    const currentIdentity = await currentProcessIdentity(targetPid);
    if (reference.identity.length === 0 || currentIdentity === undefined || !processIdentityMatches(reference.identity, currentIdentity)) return false;
    return await currentProcessGroup(targetPid) === targetPgid;
  };
  if (!await verifyTargetReference()) return false;
  // Re-read the authenticated identity and group immediately before the
  // negative-PGID signal so a reused PID or group cannot pass a stale check.
  if (!await verifyTargetReference()) return false;
  try {
    process.kill(-targetPgid, "SIGKILL");
  } catch {
    // The target may have exited between validation and the group signal.
  }
  return waitForProcessGroupGone(targetPgid);
}

async function waitForTarget(
  parentDeadPath: string,
  statusFd: number | undefined,
  wrapperExited: Promise<number>,
  rememberedReference?: () => TargetReference | undefined,
): Promise<number> {
  const wrapperCode = await wrapperExited;
  const status = statusFd === undefined ? undefined : await readStatusPipe(statusFd);
  if (wrapperCode === 0 && status !== undefined && await readRegularMarker(parentDeadPath) === undefined) {
    return status;
  }
  await cleanupOrphanedTarget(rememberedReference?.());
  return SUPERVISOR_UNKNOWN_TARGET_STATUS;
}

async function waitForReady(path: string, wrapperExited: Promise<number>): Promise<boolean> {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    if ((await readRegularMarker(path))?.trim() === "ready") return true;
    const wrapperDone = await raceWithTimeout(wrapperExited.then(() => true, () => true), 20, false);
    if (wrapperDone) return false;
  }
  return false;
}

async function waitForTargetReference(
  statusPath: string,
  wrapperPid: number,
  wrapperExited: Promise<number>,
): Promise<TargetReference | undefined> {
  const deadline = Date.now() + SUPERVISOR_TARGET_REFERENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reference = await readTargetReference(statusPath, wrapperPid);
    if (reference !== undefined) return reference;
    const wrapperDone = await raceWithTimeout(wrapperExited.then(() => true, () => true), 20, false);
    if (wrapperDone) return undefined;
  }
  return undefined;
}

async function removeSupervisorDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    await rm(path, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; the explicit SupervisedChild.cleanup remains the
    // final owner of the private directory when the wrapper does not settle.
  }
}

async function settleSupervisorDirectory(path: string, acknowledgement: number | undefined): Promise<void> {
  // The detached cleaner owns the directory until it writes the ACK. Removing
  // it merely because the wrapper exited can interrupt a still-running
  // descendant verification pass.
  if (acknowledgement !== 1) return;
  const deadline = Date.now() + SUPERVISOR_CLEANUP_MARKER_SETTLE_MS;
  while (Date.now() < deadline) {
    if ((await readRegularMarker(join(path, "cleanup-complete")))?.trim() === "complete") {
      await removeSupervisorDirectory(path);
      return;
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function waitForCleanupAck(fd: number, cleanupStartedPath: string, wrapperExited: Promise<number>, statusDirectory: string): Promise<boolean> {
  const wrapperResult = await raceWithTimeout(
    wrapperExited.then((code) => ({ done: true as const, code })),
    20,
    { done: false as const },
  );
  let timeoutMs = SUPERVISOR_CLEANUP_TIMEOUT_MS + SUPERVISOR_CLEANUP_ACK_SETTLE_MS;
  if (wrapperResult.done) {
    const cleanupStarted = await readRegularMarker(cleanupStartedPath);
    timeoutMs = wrapperResult.code === 0
      ? SUPERVISOR_CLEANUP_TIMEOUT_MS
      : cleanupStarted !== undefined
        ? SUPERVISOR_CLEANUP_TIMEOUT_MS
        : SUPERVISOR_UNEXPECTED_EXIT_SETTLE_MS;
  }
  const acknowledgement = await readStatusPipe(fd, timeoutMs);
  await settleSupervisorDirectory(statusDirectory, acknowledgement);
  return acknowledgement === 1;
}

async function createSupervisorMarker(path: string): Promise<boolean> {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return false;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function spawnSupervised(args: string[]): Promise<SupervisedChild> {
  if (process.platform === "win32") throw new Error("supervisor_unsupported_platform");

  if (Bun.which("perl") === null) throw new Error("supervisor_requires_perl");
  if (Bun.which("ps") === null) throw new Error("supervisor_requires_ps");

  const targetMarker = randomUUID();
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), ".agent-toolkit-dst-supervisor-"));
  } catch (error) {
    throw error;
  }
  const statusPath = join(directory, "status");
  const readyPath = join(directory, "ready");
  const targetAuthorizedPath = join(directory, "target-authorized");
  const cleanupStartedPath = join(directory, "cleanup-started");
  const cleanupCompletePath = join(directory, "cleanup-complete");
  let statusFdForCleanup: number | undefined;
  let cleanupFdForParent: number | undefined;
  try {
    const child = Bun.spawn(
      ["sh", "-c", SUPERVISOR_SCRIPT, "agent-toolkit-supervisor", statusPath, ...args],
      {
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          AGENT_TOOLKIT_SUPERVISOR_PARENT_PID: String(process.pid),
          AGENT_TOOLKIT_TARGET_MARKER: targetMarker,
        },
      },
    ) as Bun.Subprocess<"pipe", "pipe", "pipe"> & { stdio: [null, null, null, number | null, number | null] };
    statusFdForCleanup = typeof child.stdio[3] === "number" ? child.stdio[3] : undefined;
    cleanupFdForParent = typeof child.stdio[4] === "number" ? child.stdio[4] : undefined;
    if (statusFdForCleanup === undefined || cleanupFdForParent === undefined) {
      try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      await child.exited.catch(() => undefined);
      throw new Error("supervisor_control_pipe_unavailable");
    }
    const statusFd = statusFdForCleanup;
    const cleanupFd = cleanupFdForParent;
    const wrapperExited = child.exited;
    let rememberedTargetReference: TargetReference | undefined;
    let cleanupAckPromise: Promise<boolean> | undefined;
    const waitForCleanupAcknowledged = (): Promise<boolean> => {
      cleanupAckPromise ??= waitForCleanupAck(cleanupFd, cleanupStartedPath, wrapperExited, directory).finally(() => {
        cleanupFdForParent = undefined;
      });
      return cleanupAckPromise;
    };
    const supervised: SupervisedChild = {
      child,
      exited: waitForTarget(join(directory, "parent-dead"), statusFd, wrapperExited, () => rememberedTargetReference),
      wrapperExited,
      waitForCleanupAcknowledged,
      forceCleanup: async () => {
        const reference = rememberedTargetReference ?? await readTargetReference(statusPath, child.pid);
        const targetCleanup = cleanupOrphanedTarget(reference);
        try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
        await wrapperExited.catch(() => undefined);
        if (cleanupFdForParent !== undefined) {
          await closeFileDescriptor(cleanupFdForParent);
          cleanupFdForParent = undefined;
        }
        if (await targetCleanup) return true;
        return cleanupOrphanedTarget(reference);
      },
      cleanup: async () => {
        await cleanupOrphanedTarget(rememberedTargetReference);
        if ((await readRegularMarker(cleanupCompletePath))?.trim() === "complete") {
          await rm(directory, { recursive: true, force: true });
        }
        if (cleanupFdForParent !== undefined) {
          await closeFileDescriptor(cleanupFdForParent);
          cleanupFdForParent = undefined;
        }
      },
    };
    // The supervisor publishes the target reference before it creates the
    // target-start marker. Begin reading it immediately after spawning so a
    // target that exits during the ready handshake cannot erase the anchor
    // before the parent has authenticated the reference.
    const targetReferencePromise = waitForTargetReference(statusPath, child.pid, wrapperExited);
    const ready = await waitForReady(readyPath, wrapperExited);
    if (!ready) {
      try { child.kill("SIGTERM"); } catch { /* The wrapper may already be gone. */ }
      const cleanupReady = await waitForCleanupAcknowledged();
      if (!cleanupReady) {
        try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      }
      await wrapperExited;
      await supervised.exited.catch(() => undefined);
      await targetReferencePromise;
      throw new Error("supervisor_not_ready");
    }
    const targetReference = await targetReferencePromise;
    if (targetReference === undefined) {
      try { child.kill("SIGTERM"); } catch { /* The wrapper may already be gone. */ }
      const cleanupReady = await waitForCleanupAcknowledged();
      if (!cleanupReady) {
        try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      }
      await wrapperExited.catch(() => undefined);
      await supervised.exited.catch(() => undefined);
      throw new Error("supervisor_target_reference_unavailable");
    }
    if (!await createSupervisorMarker(targetAuthorizedPath)) {
      try { child.kill("SIGTERM"); } catch { /* The wrapper may already be gone. */ }
      const cleanupReady = await waitForCleanupAcknowledged();
      if (!cleanupReady) {
        try { child.kill("SIGKILL"); } catch { /* The wrapper may already be gone. */ }
      }
      await wrapperExited.catch(() => undefined);
      await supervised.exited.catch(() => undefined);
      throw new Error("supervisor_target_authorization_unavailable");
    }
    rememberedTargetReference = targetReference;
    return supervised;
  } catch (error) {
    if (statusFdForCleanup !== undefined) await closeFileDescriptor(statusFdForCleanup);
    if (cleanupFdForParent !== undefined) await closeFileDescriptor(cleanupFdForParent);
    if (statusFdForCleanup === undefined || (await readRegularMarker(cleanupCompletePath))?.trim() === "complete") {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
