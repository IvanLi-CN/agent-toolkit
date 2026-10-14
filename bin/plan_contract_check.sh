#!/usr/bin/env bash
set -euo pipefail

PLAN_CONTRACT_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  plan_contract_check.sh [--repo-root <candidate-repo>] <session.jsonl> [more.jsonl...]
  plan_contract_check.sh [--repo-root <candidate-repo>] --cases <CASES.txt>
  plan_contract_check.sh [--repo-root <candidate-repo>] --plan <plan.md|->
  plan_contract_check.sh [--repo-root <candidate-repo>] --wave-manifest <manifest.json>
  plan_contract_check.sh [--repo-root <candidate-repo>] --emit-acceptance-manifest <session.jsonl> <manifest.json>

CASES.txt format (space separated):
  <expect> <path> [required_code] [mode]

Where:
  expect        pass | fail
  path          absolute or relative path to a jsonl file
  required_code optional finding code for fail cases (use "-" to skip)
  mode          optional "raw-plan" for a current Markdown fixture

`--plan` validates the current explicit `$dev-plan` Markdown plan directly.
  Ordinary Plan Mode is routed through JSONL and does not use this raw-plan
  contract entrypoint; direct validation does not reconstruct conversation
  provenance.
EOF
}

initiative_eligibility_proved() {
  local text="$1"
  grep -Eiq '(至少[[:space:]]*(2|两)|两个|two|at least two).{0,60}(ticket|工单)' < <(printf '%s\n' "$text") \
    && grep -Eiq '独立.{0,12}验收|independent.{0,12}accept' < <(printf '%s\n' "$text") \
    && grep -Eiq '独立.{0,12}合并|independent.{0,12}merge' < <(printf '%s\n' "$text") \
    && grep -Eiq 'wave|worktree|integration|aggregate|隔离任务工作区|集成分支' < <(printf '%s\n' "$text")
}

initiative_prerequisites_unavailable() {
  local text="$1"
  grep -Eiq '(github|codex[[:space:]_-]*task|native[[:space:]_-]*task|托管[[:space:]]*worktree).{0,40}(不可用|缺失|unavailable|missing|disabled)' < <(printf '%s\n' "$text")
}

parallel_pr_eligibility_proved() {
  local text="$1"
  grep -Eiq '(独立|互不依赖|纯并行|independent).{0,80}(pr|pull[[:space:]_-]*request|任务|task)' < <(printf '%s\n' "$text") \
    && grep -Eiq '(无依赖|无[[:space:]]*依赖|depends_on[[:space:]]*=[[:space:]]*none|no[[:space:]]+dependenc)' < <(printf '%s\n' "$text") \
    && grep -Eiq '(2[[:space:]]*\.\.[[:space:]]*8|2[[:space:]]*[-~][[:space:]]*8|two[[:space:]]+to[[:space:]]+eight|2..8|并行)' < <(printf '%s\n' "$text") \
    && grep -Eiq '(direct[[:space:]_-]*pr|direct[[:space:]]+pull|直连pr|直接pr|直接[^[:space:]]{0,8}pr|owner-facing[[:space:]_-]*pr)' < <(printf '%s\n' "$text")
}

require_tools() {
  command -v jq >/dev/null 2>&1 || {
    echo "ERROR: jq is required." >&2
    exit 2
  }
}

contains_explicit_flow_lock() {
  local text="$1"
  if [[ -n "$(extract_explicit_flow_type "$text")" ]]; then
    return 0
  fi
  return 1
}

normalize_flow_type() {
  local text="$1"
  local lower normalized
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  normalized="$(printf '%s\n' "$lower" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  case "$normalized" in
    implement-only|implement_only|implementonly|仅实现)
      echo "implement-only"
      return 0
      ;;
    wave-thread|wave_thread|wave-thread-flow|波次线程|波次任务)
      echo "wave-thread"
      return 0
      ;;
    initiative|initiative-flow|initiative_flow|initiativeflow|倡议流|多ticket倡议)
      echo "retired-initiative"
      return 0
      ;;
    parallel-pr|parallel_pr|parallelpr|parallel-pr-flow|并行pr|并行-pr|并行直连pr)
      echo "retired-parallel-pr"
      return 0
      ;;
    normal|普通流程)
      echo "normal"
      return 0
      ;;
    fast-track|fast_track|fastpr|fast-pr|fast-flow|fast-pr-delivery|快车道)
      echo "fast-track"
      return 0
      ;;
    local-merge|local_merge|localmerge|local-merge-flow|本地快车道|本地合主干|本地合主干流程|no-pr-fast|no_pr_fast)
      echo "local-merge"
      return 0
      ;;
  esac
  echo ""
  return 0
}

normalize_flow_lock_token() {
  local text="$1"
  local normalized lower
  normalized="$(normalize_flow_type "$text")"
  if [[ -n "$normalized" ]]; then
    echo "$normalized"
    return 0
  fi
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  case "$lower" in
    \$implement-only-flow|implement-only-flow)
      echo "implement-only"
      return 0
      ;;
    \$wave-thread-flow|wave-thread-flow)
      echo "wave-thread"
      return 0
      ;;
    \$initiative-flow|initiative-flow)
      echo "retired-initiative"
      return 0
      ;;
    \$parallel-pr-flow|parallel-pr-flow)
      echo "retired-parallel-pr"
      return 0
      ;;
    \$normal-flow|normal-flow)
      echo "normal"
      return 0
      ;;
    \$fast-flow|fast-flow)
      echo "fast-track"
      return 0
      ;;
    \$local-merge-flow|local-merge-flow)
      echo "local-merge"
      return 0
      ;;
  esac
  echo ""
  return 0
}

standalone_flow_token_type() {
  local text="$1"
  local trimmed
  trimmed="$(printf '%s\n' "$text" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  trimmed="$(printf '%s\n' "$trimmed" | sed -E 's/[[:space:]]*[.。,，!！?？:：;；]+$//; s/^`([^`]+)`$/\1/; s/^\[([^\]]+)\]\([^)]*\)$/\1/; s/[[:space:]]*[.。,，!！?？:：;；]+$//')"
  normalize_flow_lock_token "$trimmed"
}

collect_explicit_flow_types() {
  local text="$1"
  local found="" standalone

  standalone="$(standalone_flow_token_type "$text")"
  if [[ -n "$standalone" ]]; then
    found+="${standalone}"$'\n'
  fi

  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(implement-only|implement_only|implement[[:space:]_-]*only|仅实现)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*(\$?implement-only|implement[[:space:]_-]*only)([^[:alnum:]_-]|$)|(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*仅实现' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])\$implement-only-flow([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="implement-only"$'\n'
  fi
  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(wave-thread|wave_thread|wave-thread-flow|波次线程|波次任务)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])(\$wave-thread-flow|wave-thread)([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="wave-thread"$'\n'
  fi
  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(initiative|initiative-flow|倡议流|多ticket倡议)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*(\$?initiative|倡议流|多ticket倡议)([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])\$initiative-flow([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="initiative"$'\n'
  fi
  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(parallel-pr|parallel_pr|parallelpr|parallel-pr-flow|并行pr|并行-pr|并行直连pr)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])(\$parallel-pr-flow|parallel-pr)([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="parallel-pr"$'\n'
  fi
  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(normal|普通流程)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*(\$?normal)([^[:alnum:]_-]|$)|(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*普通流程' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])\$normal-flow([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="normal"$'\n'
  fi
  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(fast-track|fast_track|fast-pr|fastpr|fast-flow|fast-pr-delivery|快车道)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*(\$?(fast-track|fast_track|fast-pr|fastpr|fast-flow|fast-pr-delivery))([^[:alnum:]_-]|$)|(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*快车道' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])\$fast-flow([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="fast-track"$'\n'
  fi
  if grep -Eiq 'flow[[:space:]_-]*type[[:space:]]*[:=][[:space:]]*`?(local-merge|local_merge|localmerge|local-merge-flow|本地快车道|本地合主干|本地合主干流程|no-pr[[:space:]_-]*fast)(`|[^[:alnum:]_-]|$)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*(\$?(local-merge|local_merge|local-merge-flow|no-pr[[:space:]_-]*fast))([^[:alnum:]_-]|$)|(走|按|用|采用|选择|锁定|切到|切换到|改为|设为)[[:space:]:：`"'"'"'\[]*(本地快车道|本地合主干|本地合主干流程)' < <(printf '%s\n' "$text") \
    || grep -Eiq '(^|[^[:alnum:]_-])\$local-merge-flow([^[:alnum:]_-]|$)' < <(printf '%s\n' "$text"); then
    found+="local-merge"$'\n'
  fi

  printf '%s' "$found" | awk 'NF' | sort -u
}

has_conflicting_explicit_flow_signals() {
  local text="$1"
  local types count
  types="$(collect_explicit_flow_types "$text")"
  count="$(printf '%s\n' "$types" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [[ "$count" -gt 1 ]]; then
    return 0
  fi
  return 1
}

normalize_flow_type_loose() {
  local text="$1"
  local lower
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq '(^|[^[:alnum:]_-])(implement-only|implement_only|implement[[:space:]_-]*only|仅实现)([^[:alnum:]_-]|$)' < <(printf '%s\n' "$lower"); then
    echo "implement-only"
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]_-])(wave-thread|wave_thread|wave-thread-flow|波次线程|波次任务)([^[:alnum:]_-]|$)' < <(printf '%s\n' "$lower"); then
    echo "wave-thread"
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]])normal([^[:alnum:]]|$)|普通流程' < <(printf '%s\n' "$lower"); then
    echo "normal"
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]_-])(fast-track|fast_track|fast-pr|fastpr|fast-flow|fast-pr-delivery|快车道)([^[:alnum:]_-]|$)' < <(printf '%s\n' "$lower"); then
    echo "fast-track"
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]_-])(local-merge|local_merge|localmerge|local-merge-flow)([^[:alnum:]_-]|$)|本地快车道|本地合主干|本地合主干流程|不建[[:space:]]*pr[[:space:]]*直接本地合主干|no-pr[[:space:]_-]*fast' < <(printf '%s\n' "$lower"); then
    echo "local-merge"
    return 0
  fi
  echo ""
  return 0
}

extract_explicit_flow_type() {
  local text="$1"
  local types count
  types="$(collect_explicit_flow_types "$text")"
  count="$(printf '%s\n' "$types" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [[ "$count" -eq 1 ]]; then
    printf '%s\n' "$types"
    return 0
  fi
  echo ""
  return 0
}

is_generic_continue_only() {
  local text="$1"
  local lower normalized
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  normalized="$(printf '%s\n' "$lower" | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  if grep -Eiq '^(请[[:space:]]*)?(继续|continue|接着|接着做|继续吧|继续一下|接着吧)([[:space:][:punct:]]*)$' < <(printf '%s\n' "$normalized"); then
    return 0
  fi
  return 1
}

contains_strong_new_plan_request_signal() {
  local text="$1"
  local lower
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq '((给我|再给我|再来一份|来一份|新的一份|新的|另一份|重新给我|产出|给出|制定|生成|安排|写一份).{0,24}(可执行计划|执行计划|开发计划|实施计划|规划)|(可执行计划|执行计划|开发计划|实施计划|规划).{0,24}(给我|再给我|再来一份|来一份|新的一份|新的|另一份|重新给我|产出|给出|制定|生成|安排|写一份))' < <(printf '%s\n' "$text"); then
    return 0
  fi
  if contains_bare_plan_request_phrase "$text"; then
    return 0
  fi
  if grep -Eiq '((please|help[[:space:]]+me|use).{0,16}(plan|planning|draft).{0,24}(this|the)[[:space:]]+(task|work))|((give|create|make|draft|produce|write|recreate|redo).{0,24}(plan|planning)|((plan|planning).{0,24}(give|create|make|draft|produce|write|recreate|redo)))' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  if [[ -n "$(extract_explicit_flow_type "$text")" ]] \
    && contains_bare_plan_request_phrase "$text"; then
    return 0
  fi
  if grep -Eiq '((请用|请|请帮我|帮我|麻烦).{0,16}(规划|计划|制定|生成).{0,24}(这项工作|这个任务|当前任务|本次工作))' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

contains_unrelated_flow_wording() {
  local text="$1"
  local lower
  if [[ -n "$(extract_explicit_flow_type "$text")" ]]; then
    return 1
  fi
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq 'flow[[:space:]_-]*(type|lock|route|routing|selection)|流程(类型|锁定|选择)|执行(流|流程)|路由[[:space:]]*flow|flow[[:space:]]*路由|交付[[:space:]]*flow|delivery[[:space:]_-]*flow' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

contains_valid_flow_choice() {
  local text="$1"
  local lower
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq '(^|[^[:alnum:]_-])(wave-thread|wave_thread|wavethread|wave-thread-flow|波次线程|波次任务)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])(implement-only|implement_only|implement[[:space:]_-]*only|仅实现)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])(normal|普通流程)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])(fast-track|fast_track|fast-pr|fastpr|fast-flow|fast-pr-delivery|快车道)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])(local-merge|local_merge|localmerge|local-merge-flow)([^[:alnum:]_-]|$)|本地快车道|本地合主干|本地合主干流程|no-pr[[:space:]_-]*fast' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

contains_merge_ready_stop_condition() {
  local text="$1"
  local relevant_text
  local lower
  relevant_text="$(extract_section "$text" "Summary")"$'\n'"$(extract_section "$text" "Task Orchestration")"$'\n'"$(extract_section "$text" "Acceptance & Validation")"
  lower="$(printf '%s\n' "$relevant_text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq 'merge[[:space:]_-]*ready|step[[:space:]]*5c([[:space:]]*ready)?|latest[[:space:]]+pr.{0,40}(可立即合并|ready[[:space:]]+to[[:space:]]+merge)|(^|[^[:alnum:]_])pr.{0,20}(可立即合并|ready[[:space:]]+to[[:space:]]+merge)|准备好合并|预备合并|完成合并前准备' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

fast_track_non_goals_forbid_pr_delivery() {
  local plan_text="$1"
  local non_goals lower delivery_relevant
  non_goals="$(extract_section "$plan_text" "Non-goals")"
  lower="$(printf '%s\n' "$non_goals" | tr '[:upper:]' '[:lower:]')"
  delivery_relevant="$(printf '%s\n' "$lower" | sed -E \
    -e 's/(不|禁止|不得|勿|不允许)[[:space:]]*创建[[:space:]]*(aggregate|child)[[:space:]_-]*(pr|pull[[:space:]_-]*request)/ /g' \
    -e 's/(do[[:space:]]+not|avoid|skip|exclude)[[:space:]]*(create|reuse|creation|open|opening|opened|submit|submitted|file|filed|raise|raised)?[[:space:]]*(aggregate|child)[[:space:]_-]*(pr|pull[[:space:]_-]*request)/ /g' \
    -e 's/(aggregate|child)[[:space:]_-]*(pr|pull[[:space:]_-]*request)/ /g')"
  grep -Eiq \
    '((不|禁止|不得|勿|不允许|避免|无需|不需要|不必|no|without|avoid|skip|exclude|forbidden|prohibited|not[[:space:]]+(allowed|required|needed)).{0,24}(创建|复用|打开|开|create|reuse|creation|open|opening|opened|submit|submitted|file|filed|raise|raised).{0,32}(a[[:space:]]+)?(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request)|(avoid|skip|exclude|避免).{0,24}(pr|pull[[:space:]_-]*request).{0,24}(创建|复用|打开|开|create|reuse|creation|open|opening|opened|submit|submitted|file|filed|raise|raised)|(no|without)[[:space:]]+(a[[:space:]]+)?(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request)([[:space:]]*[,;；。.]|[[:space:]]*$)|(no|without)[[:space:]]+(a[[:space:]]+)?(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request).{0,16}(创建|复用|打开|开|create|reuse|creation|open|opening|opened|submit|submitted|file|filed|raise|raised)|(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request).{0,24}(创建|复用|打开|开|create|reuse|creation|open|opening|opened|submit|submitted|file|filed|raise|raised).{0,24}(不|禁止|不得|勿|不允许|避免|no|without|avoid|skip|exclude|forbidden|prohibited|not[[:space:]]+allowed)|(无需|不需要|不必|no[[:space:]]+need|not[[:space:]]+(required|needed)).{0,24}(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request)|(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request).{0,24}(out[[:space:]]+of[[:space:]]+scope|local[[:space:]_-]*only|仅本地|只在本地|不在范围|不适用|无需|不需要|不必)|(direct[[:space:]]+)?(pr|pull[[:space:]_-]*request).{0,32}(delivery[[:space:]]+)?(omit|omitted|avoid|skip|exclude|out[[:space:]]+of[[:space:]]+scope|省略|忽略|不适用)|(不|禁止|不得|勿|不允许|避免|no|without|avoid|skip|exclude).{0,16}(git[[:space:]]+push|push[[:space:]]+(current|topic|head|branch|pr|remote)|推送(当前|主题|分支|head|pr|远端)|远端推送|remote[[:space:]_-]*push)|(no|without)[[:space:]]+(remote[[:space:]_-]*delivery|远端交付)|(omit|omitted|avoid|skip|exclude|省略|忽略).{0,24}(remote[[:space:]_-]*delivery|远端交付)|(remote[[:space:]_-]*delivery|远端交付).{0,24}(omit|omitted|avoid|skip|exclude|out[[:space:]]+of[[:space:]]+scope|省略|忽略|不适用)|(不|禁止|不得|勿|不允许|避免|no|without|avoid|skip|exclude).{0,16}(远端写入|remote[[:space:]_-]*(write|mutation)))' \
    < <(printf '%s\n' "$delivery_relevant")
}

fast_track_acceptance_has_complete_pr_evidence() {
  local acceptance="$1"
  local line assertions
  while IFS= read -r line; do
    [[ "$line" == *"assertions="* ]] || continue
    assertions="${line#*assertions=}"
    if fast_track_assertions_has_positive_evidence "$assertions" 'pr状态[[:space:]]*[:=][[:space:]]*存在|(live|open)[[:space:]_-]*(pr|pull[[:space:]_-]*request)|(pr|pull[[:space:]_-]*request)[[:space:]_-]*(exists|is[[:space:]_-]*open)' \
      && fast_track_assertions_has_positive_evidence "$assertions" 'current[[:space:]_-]*head|当前[[:space:]]*head|当前.{0,24}sha|sha.{0,24}当前' \
      && fast_track_assertions_has_positive_evidence "$assertions" 'merge[[:space:]_-]*ready|step[[:space:]]*5c|收敛|convergence|ci.{0,40}review|review.{0,40}ci'; then
      return 0
    fi
  done < <(printf '%s\n' "$acceptance")
  return 1
}

fast_track_assertions_has_positive_evidence() {
  local assertions="$1"
  local evidence_pattern="$2"
  local unit
  while IFS= read -r unit; do
    [[ -z "$unit" ]] && continue
    if grep -Eiq "$evidence_pattern" < <(printf '%s\n' "$unit") \
      && ! grep -Eiq '(no|not|without|forbidden|prohibited|not[[:space:]]+allowed|不|禁止|不得|不允许|无|不存在|不需要|irrelevant)' < <(printf '%s\n' "$unit"); then
      return 0
    fi
  done < <(printf '%s\n' "$assertions" | tr ',;；' '\n')
  return 1
}

check_fast_track_pr_contract() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0
  if fast_track_non_goals_forbid_pr_delivery "$plan_text"; then
    report_finding "$file" "$idx" "FAST_TRACK_PR_FORBIDDEN" "fast-track merge-ready plans must not exclude PR creation/reuse, push, or required remote writes in Non-goals."
    fail_count=$((fail_count + 1))
  fi

  local acceptance lower
  acceptance="$(extract_section "$plan_text" "Acceptance & Validation")"
  lower="$(printf '%s\n' "$acceptance" | tr '[:upper:]' '[:lower:]')"
  if ! fast_track_acceptance_has_complete_pr_evidence "$lower"; then
    report_finding "$file" "$idx" "FAST_TRACK_PR_ACCEPTANCE_MISSING" "one fast-track acceptance assertions field must positively cover live PR, current-head, and PR convergence."
    fail_count=$((fail_count + 1))
  fi

  return "$fail_count"
}

trim_inline_value() {
  local value="$1"
  printf '%s\n' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

trim_owner_baseline_sentence_punctuation() {
  local value="$1"
  printf '%s\n' "$value" | sed -E 's/[。．.：:?？]+$//'
}

trim_owner_baseline_clause_suffix() {
  local value="$1"
  printf '%s\n' "$value" | sed -E 's/[[:space:]]*[,，;；][[:space:]]*(并继续|并|继续|然后|再|后续|follow-?up|continue|then|next).*$//'
}

escape_ere() {
  printf '%s\n' "$1" | sed -E 's/[][(){}.^$*+?|\\]/\\&/g'
}

trim_owner_baseline_followup_separator() {
  local value="$1"
  local full_text="$2"
  local escaped_value
  value="$(trim_inline_value "$value")"
  if ! grep -Eq '[,，;；]$' < <(printf '%s\n' "$value"); then
    printf '%s\n' "$value"
    return 0
  fi
  escaped_value="$(escape_ere "$value")"
  if grep -Eq "${escaped_value}[[:space:]]*(并继续|并|继续|然后|再|后续|follow-?up|continue|then|next)([^[:alnum:]_]|$)" < <(printf '%s\n' "$full_text"); then
    printf '%s\n' "${value%?}"
    return 0
  fi
  printf '%s\n' "$value"
}

trim_owner_baseline_trailing_context() {
  local value="$1"
  printf '%s\n' "$value" | sed -E 's/[[:space:]]+(开发|实现|规划|计划|推进|处理|work|develop(ment)?|implementation|delivery|execution|plan(ning)?).*$/ /' | sed -E 's/[[:space:]]+$//'
}

contains_bare_plan_request_phrase() {
  local text="$1"
  local lower
  local request_text
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  request_text="${text//_/A}"
  if grep -Eiq '((给我|再给我|再来一份|来一份|新的一份|新的|另一份|重新给我|产出|给出|制定|生成|安排|写一份|输出|出|继续出|直接给我).{0,16}计划([[:space:][:punct:]。！？，、；：（）【】《》“”‘’「」『』…]|$))|((再按|请按|按|走|用|采用|选择|切到|切换到|改为|设为).{0,16}((普通)?流程)?计划([[:space:][:punct:]。！？，、；：（）【】《》“”‘’「」『』…]|$))' < <(printf '%s\n' "$request_text"); then
    return 0
  fi
  if grep -Eiq '((give|create|make|draft|produce|write|recreate|redo|output|continue).{0,16}(plan|planning))|((plan|planning).{0,16}(please|again|now|for[[:space:]]+me|output|draft))' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

looks_like_directional_plain_baseline_candidate() {
  local candidate="$1"
  local lower
  candidate="$(trim_inline_value "$candidate")"
  if [[ "$candidate" == *'`'* ]]; then
    return 1
  fi
  if [[ "$candidate" =~ ^(docs|doc|specs|skills|bin|scripts|script|src|test|tests|packages|apps|lib|config|configs|fixtures|assets|images|examples|prompts|notes|adr|workflow|solutions|\.github)/[^[:space:]]+\.(md|markdown|txt|rst|adoc|json|jsonl|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|fish|py|js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|swift|rb|php|css|scss|sass|less|html?|xml|svg|png|jpe?g|gif|webp|pdf|docx?|pptx?|xlsx?|csv)$ ]]; then
    return 1
  fi
  lower="$(printf '%s\n' "$candidate" | tr '[:upper:]' '[:lower:]')"
  if [[ "$candidate" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    return 0
  fi
  if grep -Eiq '^(refs/(heads|tags|remotes)/|remotes/|origin/|upstream/|[^[:space:]]+/[^[:space:]]+|[^[:space:]]+\.[^[:space:]]+/[^[:space:]]+)' < <(printf '%s\n' "$candidate"); then
    return 0
  fi
  if grep -Eiq '^[[:alnum:]_.-]+/[[:alnum:]_.-]+([[:alnum:]_./+-]*)?$' < <(printf '%s\n' "$candidate"); then
    return 0
  fi
  if grep -Eiq '^(head~?[0-9]*|head\^[0-9]*|[[:alnum:]_.-]+@[[:alnum:]_.-]+)$' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

extract_plan_development_baseline() {
  local plan_text="$1"
  local flow_decision
  flow_decision="$(extract_section "$plan_text" "Flow Decision")"
  printf '%s\n' "$flow_decision" \
    | sed -nE 's/.*开发基线[[:space:]]*(：|:)[[:space:]]*`?([^`]+)`?.*/\2/p' \
    | head -n1 \
    | while IFS= read -r line; do
        trim_inline_value "$line"
      done
}

extract_flow_decision_field() {
  local plan_text="$1"
  local field="$2"
  local flow_decision value

  flow_decision="$(extract_section "$plan_text" "Flow Decision")"
  value="$(printf '%s\n' "$flow_decision" | awk -v key="$field" '
    $0 ~ "^[[:space:]]*-[[:space:]]*`?" key "`?[[:space:]]*:" {
      value = $0
      sub("^[[:space:]]*-[[:space:]]*`?" key "`?[[:space:]]*:[[:space:]]*`?", "", value)
      sub("`?[[:space:]]*$", "", value)
      print value
      exit
    }
  ')"
  trim_inline_value "$value"
}

release_arrangement_field_continuation_invalid() {
  local plan_text="$1"
  local flow_decision
  flow_decision="$(extract_section "$plan_text" "Flow Decision")"
  printf '%s\n' "$flow_decision" | awk '
    function is_release_field(line) {
      return line ~ /^[[:space:]]*-[[:space:]]*`?(release_scope|release_reason|release_entrypoint|release_followup)`?[[:space:]]*:/
    }
    function has_unclosed_inline_value(line, rest) {
      rest = line
      return (gsub(/`/, "", rest) % 2) == 1
    }
    {
      if (is_release_field($0)) {
        active = 1
        if (has_unclosed_inline_value($0)) {
          invalid = 1
        }
        next
      }
      if (!active) {
        next
      }
      if ($0 ~ /^[[:space:]]*$/) {
        next
      }
      if ($0 !~ /^[[:space:]]*-[[:space:]]+/) {
        invalid = 1
        exit
      }
      active = 0
    }
    END { exit invalid ? 0 : 1 }
  '
}

count_flow_decision_field() {
  local plan_text="$1"
  local field="$2"
  local flow_decision

  flow_decision="$(extract_section "$plan_text" "Flow Decision")"
  printf '%s\n' "$flow_decision" | awk -v key="$field" '
    $0 ~ "^[[:space:]]*-[[:space:]]*`?" key "`?[[:space:]]*:" { count += 1 }
    END { print count + 0 }
  '
}

is_abstract_development_baseline() {
  local value="$1"
  local lower
  if looks_like_filesystem_or_doc_path "$value"; then
    return 1
  fi
  lower="$(trim_inline_value "$value" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$lower" ]]; then
    return 1
  fi
  if grep -Eiq '^(远程主干|远程主干基线|目标仓库主干|目标仓库主干基线|主干基线|默认主干|默认主干基线|target[[:space:]]+repo[[:space:]]+mainline|target[[:space:]]+repo[[:space:]]+mainline[[:space:]]+baseline|remote[[:space:]]+mainline|remote[[:space:]]+mainline[[:space:]]+baseline|mainline[[:space:]]+baseline|remote[[:space:]]+default[[:space:]]+branch|remote[[:space:]]+default[[:space:]]+branch[[:space:]]+baseline|default[[:space:]]+mainline|default[[:space:]]+mainline[[:space:]]+baseline|default[[:space:]]+branch|default[[:space:]]+branch[[:space:]]+baseline)$' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

looks_like_filesystem_or_doc_path() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  if [[ -z "$value" ]]; then
    return 1
  fi
  if [[ "$value" =~ ^(\./|\.\./|/|~/) ]]; then
    return 0
  fi
  if [[ "$value" == *\\* ]]; then
    return 0
  fi
  if [[ "$value" =~ ^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|go\.mod|go\.sum|tsconfig\.json)$ ]]; then
    return 0
  fi
  if [[ "$value" =~ ^(docs|doc|specs|skills|bin|scripts|script|src|test|tests|packages|apps|lib|config|configs|fixtures|assets|images|examples|prompts|notes|adr|workflow|solutions|\.github)(/|$) ]] \
    && ! git check-ref-format --branch "$value" >/dev/null 2>&1 \
    && [[ "$value" =~ \.(md|markdown|txt|rst|adoc|json|jsonl|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|fish|py|js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|swift|rb|php|css|scss|sass|less|html?|xml|svg|png|jpe?g|gif|webp|pdf|docx?|pptx?|xlsx?|csv)$ ]]; then
    return 0
  fi
  return 1
}

is_placeholder_development_baseline() {
  local value="$1"
  local lower
  local bare_token
  lower="$(trim_inline_value "$value" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$lower" ]]; then
    return 1
  fi
  bare_token="$(printf '%s\n' "$lower" | sed -E 's/^[[:space:][:punct:]]+//; s/[[:space:][:punct:]]+$//')"
  if grep -Eiq '^(tbd|tba|tbc)$|^to be (determined|confirmed|decided|defined)$|^(待补|待定|待确认|待明确|待定义|未确定|占位)$' < <(printf '%s\n' "$bare_token"); then
    return 0
  fi
  return 1
}

is_context_dependent_development_baseline() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  if [[ -z "$value" ]]; then
    return 1
  fi
  if [[ "$value" =~ ^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|REVERT_HEAD|BISECT_HEAD|AUTO_MERGE)$ ]]; then
    return 0
  fi
  if [[ "$value" == "@" ]]; then
    return 0
  fi
  if [[ "$value" == *"@{"* ]]; then
    return 0
  fi
  if [[ "$value" =~ ^(origin|upstream)/HEAD$ ]]; then
    return 0
  fi
  if [[ "$value" =~ ^refs/remotes/[^[:space:]]+/HEAD$ ]]; then
    return 0
  fi
  return 1
}

is_concrete_development_baseline() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  if [[ -z "$value" ]]; then
    return 1
  fi
  if is_abstract_development_baseline "$value"; then
    return 1
  fi
  if looks_like_filesystem_or_doc_path "$value"; then
    return 1
  fi
  if is_context_dependent_development_baseline "$value"; then
    return 1
  fi
  if is_placeholder_development_baseline "$value"; then
    return 1
  fi
  if [[ "$value" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    return 0
  fi
  if git check-ref-format --branch "$value" >/dev/null 2>&1; then
    return 0
  fi
  if git check-ref-format "$value" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

normalize_baseline_compare_value() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  if [[ "$value" =~ ^refs/remotes/(.+)$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^refs/heads/(.+)$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  if [[ "$value" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    printf '%s\n' "$value" | tr '[:upper:]' '[:lower:]'
    return 0
  fi
  printf '%s\n' "$value"
}

extract_owner_explicit_baseline() {
  local text="$1"
  local candidate=""
  local match_kind=""
  local directional_plain_qualifier=""
  local re_replace_backtick='(^|[^[:alnum:]_./-])(开发基线|baseline|base ref|base branch|base commit|基础分支|基础提交)[^`]*`([^`]+)`[^`]*(改为|改成|切到|切换到|改成了|switch[[:space:]]+to|change[[:space:]]+to|update[[:space:]]+to|set[[:space:]]+to|to)[^`]*`([^`]+)`'
  local re_replace_plain='(^|[^[:alnum:]_./-])(开发基线|baseline|base ref|base branch|base commit|基础分支|基础提交).{0,80}(改为|改成|切到|切换到|改成了|switch[[:space:]]+to|change[[:space:]]+to|update[[:space:]]+to|set[[:space:]]+to)[[:space:]]*([[:graph:]]{1,}|[0-9a-fA-F]{7,40})'
  local re_backtick='(^|[^[:alnum:]_./-])(开发基线|baseline|base ref|base branch|base commit|基础分支|基础提交)[^`]*`([^`]+)`'
  local re_plain='(^|[^[:alnum:]_./-])(开发基线|baseline|base ref|base branch|base commit|基础分支|基础提交)[[:space:]]*([:：=]|(使用|用|为|是|use|using|is))[[:space:]]*([[:graph:]]{1,}|[0-9a-fA-F]{7,40})'
  local re_base_equals_backtick='(^|[^[:alnum:]_./-])(base|基础分支|基础提交)[[:space:]]*[:：=][[:space:]]*`([^`]+)`'
  local re_base_equals_plain='(^|[^[:alnum:]_./-])(base|基础分支|基础提交)[[:space:]]*[:：=][[:space:]]*([[:graph:]]{1,}|[0-9a-fA-F]{7,40})'
  local re_base_ref_var_backtick='(^|[^[:alnum:]_./-])(BASE_REF|base_ref|BASE_BRANCH|base_branch|BASE_COMMIT|base_commit)[[:space:]]*[:：=][[:space:]]*`([^`]+)`'
  local re_base_ref_var_plain='(^|[^[:alnum:]_./-])(BASE_REF|base_ref|BASE_BRANCH|base_branch|BASE_COMMIT|base_commit)[[:space:]]*[:：=][[:space:]]*([[:graph:]]{1,}|[0-9a-fA-F]{7,40})'
  local re_directional_backtick='(^|[^[:alnum:]_./-])(基于|从|from|based[[:space:]]+on|based[[:space:]]+off)[^`]*`([^`]+)`[^[:alnum:]_./-]{0,24}(开发|实现|规划实现|处理|work|develop(ment)?|implementation|delivery|execution)'
  local re_directional_plain='(^|[^[:alnum:]_./-])(基于|从|from|based[[:space:]]+on|based[[:space:]]+off)[[:space:]]*((branch|ref|commit|分支|提交)[[:space:]]+)?([[:graph:]]{1,}|[0-9a-fA-F]{7,40})[[:space:]]+(开发|实现|规划|计划|推进|处理|work|develop(ment)?|implementation|delivery|execution|plan(ning)?)'

  if [[ "$text" =~ $re_replace_backtick ]]; then
    candidate="${BASH_REMATCH[5]}"
    match_kind="replace_backtick"
  elif [[ "$text" =~ $re_replace_plain ]]; then
    candidate="${BASH_REMATCH[4]}"
    match_kind="replace_plain"
  elif [[ "$text" =~ $re_backtick ]]; then
    candidate="${BASH_REMATCH[3]}"
    match_kind="backtick"
  elif [[ "$text" =~ $re_plain ]]; then
    candidate="${BASH_REMATCH[5]}"
    match_kind="plain"
  elif [[ "$text" =~ $re_base_equals_backtick ]]; then
    candidate="${BASH_REMATCH[3]}"
    match_kind="base_equals_backtick"
  elif [[ "$text" =~ $re_base_equals_plain ]]; then
    candidate="${BASH_REMATCH[3]}"
    match_kind="base_equals_plain"
  elif [[ "$text" =~ $re_base_ref_var_backtick ]]; then
    candidate="${BASH_REMATCH[3]}"
    match_kind="base_ref_var_backtick"
  elif [[ "$text" =~ $re_base_ref_var_plain ]]; then
    candidate="${BASH_REMATCH[3]}"
    match_kind="base_ref_var_plain"
  elif [[ "$text" =~ $re_directional_backtick ]]; then
    candidate="${BASH_REMATCH[3]}"
    match_kind="directional_backtick"
  elif [[ "$text" =~ $re_directional_plain ]]; then
    candidate="${BASH_REMATCH[5]}"
    directional_plain_qualifier="${BASH_REMATCH[4]}"
    match_kind="directional_plain"
  fi

  candidate="$(trim_inline_value "$candidate")"
  if [[ "$match_kind" == "directional_plain" ]] \
    && [[ -z "$directional_plain_qualifier" ]] \
    && ! looks_like_directional_plain_baseline_candidate "$candidate"; then
    return 1
  fi
  candidate="$(trim_owner_baseline_followup_separator "$candidate" "$text")"
  local trimmed_candidate
  local clause_trimmed_candidate
  local context_trimmed_candidate
  context_trimmed_candidate="$(trim_owner_baseline_trailing_context "$candidate")"
  clause_trimmed_candidate="$(trim_owner_baseline_clause_suffix "$context_trimmed_candidate")"
  trimmed_candidate="$(trim_owner_baseline_sentence_punctuation "$clause_trimmed_candidate")"
  if [[ "$match_kind" =~ ^(plain|base_equals_plain|base_ref_var_plain|directional_plain)$ ]] \
    && [[ "$trimmed_candidate" != "$candidate" ]] \
    && is_concrete_development_baseline "$trimmed_candidate"; then
    printf '%s\n' "$trimmed_candidate"
    return 0
  fi
  if is_concrete_development_baseline "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ "$trimmed_candidate" != "$candidate" ]] && is_concrete_development_baseline "$trimmed_candidate"; then
    printf '%s\n' "$trimmed_candidate"
    return 0
  fi
  return 1
}

is_flow_answer_followup() {
  local text="$1"
  local explicit_flow
  if is_flow_answer_only "$text"; then
    return 0
  fi
  if has_conflicting_explicit_flow_signals "$text"; then
    return 1
  fi
  explicit_flow="$(extract_explicit_flow_type "$text")"
  [[ -n "$explicit_flow" ]]
}

contains_explicit_dev_plan_token() {
  local text="$1"
  local token='$dev-plan'
  local line prefix suffix before after tail
  while IFS= read -r line; do
    while [[ "$line" == *"$token"* ]]; do
      prefix="${line%%"$token"*}"
      suffix="${line#*"$token"}"
      before="${prefix: -1}"
      after="${suffix:0:1}"
      if [[ "$before" =~ [[:alnum:]_-] || "$after" =~ [[:alnum:]_-] ]]; then
        line="$suffix"
        continue
      fi
      tail="${prefix##*\$}"
      if [[ "${#tail}" -gt 64 ]]; then
        tail="${tail: -64}"
      fi
      if grep -Eiq '(不要[[:space:]]*(使用|用|走|采用)|不使用|不用|无需|不走|不采用|without[[:space:]]+|do[[:space:]]+not[[:space:]]+(use|using|apply|invoke)|not[[:space:]]+(use|using|apply|invoke)|avoid)[^$]*$' < <(printf '%s\n' "$tail"); then
        line="$suffix"
        continue
      fi
      return 0
    done
  done <<< "$text"
  return 1
}

contains_explicit_dev_plan_new_request_signal() {
  local text="$1"
  local lower
  if ! contains_explicit_dev_plan_token "$text"; then
    return 1
  fi
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq '(\$dev-plan.{0,48}(给我|再给我|再来一份|来一份|新的一份|新的|另一份|重新给我|产出|给出|制定|生成|安排|写一份|输出|出|直接给我).{0,48}(可执行计划|执行计划|开发计划|实施计划|计划|规划))|((给我|再给我|再来一份|来一份|新的一份|新的|另一份|重新给我|产出|给出|制定|生成|安排|写一份|输出|出|直接给我).{0,48}\$dev-plan.{0,48}(可执行计划|执行计划|开发计划|实施计划|计划|规划))' < <(printf '%s\n' "$text"); then
    return 0
  fi
  if grep -Eiq '(\$dev-plan.{0,48}(plan|planning|draft))|((plan|planning|draft).{0,48}\$dev-plan)' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  if grep -Eiq '(\$dev-plan.{0,48}(这个任务|当前任务|本次工作|这项工作))|((这个任务|当前任务|本次工作|这项工作).{0,24}\$dev-plan)' < <(printf '%s\n' "$text"); then
    return 0
  fi
  return 1
}

contains_explicit_dev_plan_reference_signal() {
  local text="$1"
  grep -Eiq '((参考|阅读|查看|了解|介绍|提到|谈到|关于|什么是|如何|怎么用).{0,48}\$dev-plan)|((\$dev-plan).{0,48}(文档|说明|是什么|如何|怎么用|reference|documentation|docs|mention|about|what[[:space:]]+is|how[[:space:]]+to))' < <(printf '%s\n' "$text")
}

contains_explicit_dev_plan_request_signal() {
  local text="$1"
  local trimmed
  if ! contains_explicit_dev_plan_token "$text"; then
    return 1
  fi
  if grep -Eiq '((使用|用|调用|启用|运行|采用|invoke|use|apply|run|activate).{0,16}\$dev-plan)|((\$dev-plan).{0,16}(使用|用|调用|启用|运行|采用|invoke|use|apply|run|activate))' < <(printf '%s\n' "$text"); then
    return 0
  fi
  if contains_explicit_dev_plan_reference_signal "$text"; then
    return 1
  fi
  if contains_explicit_dev_plan_new_request_signal "$text"; then
    return 0
  fi
  trimmed="$(printf '%s\n' "$text" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [[ "$trimmed" == '$dev-plan' ]]
}

is_same_session_flow_answer_followup() {
  local text="$1"
  if ! is_flow_answer_followup "$text"; then
    return 1
  fi
  if starts_new_explicit_dev_plan_request "$text"; then
    return 1
  fi
  if contains_strong_new_plan_request_signal "$text"; then
    return 1
  fi
  if starts_new_generic_plan_request "$text"; then
    return 1
  fi
  return 0
}

is_continuation_like_dev_plan_request() {
  local text="$1"
  if starts_new_explicit_dev_plan_request "$text"; then
    return 1
  fi
  if contains_strong_new_plan_request_signal "$text"; then
    return 1
  fi
  if starts_new_generic_plan_request "$text"; then
    return 1
  fi
  grep -Eqi '(^|[^[:alnum:]_])(继续|延续|沿用|改为|改成|切到|切换|收尾|follow-?up)([^[:alnum:]_]|$)' < <(printf '%s\n' "$text")
}

starts_new_explicit_dev_plan_request() {
  local text="$1"
  if ! contains_explicit_dev_plan_token "$text"; then
    return 1
  fi
  if contains_explicit_dev_plan_new_request_signal "$text"; then
    return 0
  fi
  if contains_strong_new_plan_request_signal "$text"; then
    return 0
  fi
  starts_new_generic_plan_request "$text"
}

starts_new_generic_plan_request() {
  local text="$1"
  local lower
  lower="$(printf '%s\n' "$text" | tr '[:upper:]' '[:lower:]')"
  if grep -Eiq '((请|麻烦|帮我|给我|再给我|再来一份|重新|重新给我|产出|给出|制定|生成|安排|写一份).{0,24}(可执行计划|执行计划|开发计划|实施计划)|(可执行计划|执行计划|开发计划|实施计划).{0,24}(请|麻烦|帮我|给我|再给我|再来一份|重新|重新给我|产出|给出|制定|生成|安排|写一份|新的|新的一份|另一份))' < <(printf '%s\n' "$text"); then
    return 0
  fi
  if contains_bare_plan_request_phrase "$text"; then
    return 0
  fi
  if grep -Eiq '((请|麻烦|帮我|给我|请帮我).{0,12})?(规划|计划|制定|生成)(这个任务|当前任务|本次工作|这项工作)' < <(printf '%s\n' "$text"); then
    return 0
  fi
  if grep -Eiq '((请|麻烦|帮我|给我).{0,12})?重新规划(.{0,24})?(这个任务|当前任务|本次工作)|re-?(plan|draft).{0,24}(this|the)[[:space:]]+(task|work)' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  if grep -Eiq '((give|create|make|draft|produce|write|recreate|redo).{0,24}(plan|planning)|(plan|planning).{0,24}(give|create|make|draft|produce|write|recreate|redo))' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  if [[ -n "$(extract_explicit_flow_type "$text")" ]] \
    && contains_bare_plan_request_phrase "$text" \
    && grep -Eiq '(再按|请按|按|走|用|采用|选择|切到|切换到|改为|设为)' < <(printf '%s\n' "$text"); then
    return 0
  fi
  return 1
}

starts_new_plan_request_window() {
  local text="$1"
  if starts_new_explicit_dev_plan_request "$text"; then
    return 0
  fi
  if contains_strong_new_plan_request_signal "$text"; then
    return 0
  fi
  if starts_new_generic_plan_request "$text"; then
    return 0
  fi
  if is_continuation_like_dev_plan_request "$text"; then
    return 1
  fi
  return 1
}

is_flow_answer_only() {
  local text="$1"
  [[ -n "$(standalone_flow_token_type "$text")" ]]
}

report_finding() {
  local file="$1"
  local idx="$2"
  local code="$3"
  local message="$4"
  local line="${5:-}"
  local wave="${6:-}"
  local extra=""
  if [[ -n "$line" ]]; then
    extra+=" line=${line}"
  fi
  if [[ -n "$wave" ]]; then
    extra+=" wave=${wave}"
  fi
  echo "FINDING file=${file} idx=${idx} code=${code}${extra} msg=${message}"
}

extract_section() {
  local plan_text="$1"
  local header="$2"
  printf '%s\n' "$plan_text" | awk -v h="$header" '
    $0 ~ "^## " h "$" {flag=1; next}
    /^## / {if (flag) exit}
    /^<\/proposed_plan>/ {if (flag) exit}
    flag {print}
  '
}

extract_section_line_number() {
  local plan_text="$1"
  local header="$2"
  printf '%s\n' "$plan_text" | awk -v h="$header" '
    $0 == "## " h { print NR; exit }
  '
}

check_task_orchestration() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local flow_type="$4"
  local fail_count=0
  local orchestration_plan_kind=""
  if [[ "$flow_type" == "initiative" ]]; then
    orchestration_plan_kind="$(extract_flow_decision_field "$plan_text" "plan_kind")"
  fi
  local re_list='^[[:space:]]*-[[:space:]]+.+$'
  local re_checkbox='^[[:space:]]*-[[:space:]]+\[[[:space:]]*[xX]?[[:space:]]*\]'
  local re_wave='^wave:[[:space:]]*([0-9]+)$'
  local re_bootstrap='^bootstrap:[[:space:]]*$'
  local re_task='^(main-agent|sub-agent:[[:alnum:]_-]+|task:[[:alnum:]_-]+)([[:space:]]+\[([^,]+),[[:space:]]*([^]]+)\])?[[:space:]]*=>[[:space:]]*(.+)$'
  local re_known_executor_prefix='^(main-agent|sub-agent:[[:alnum:]_-]+|task:[[:alnum:]_-]+)[[:space:]].*=>'
  # Keep descriptive forms such as "code implements behavior" out of the
  # imperative write matcher. The dedicated implementation pattern below only
  # accepts the active verb followed by a concrete write target.
  local re_english_write_token='(write|writes|writing|modify|modifies|modifying|push|pushes|pushing|create|creates|creating|delete|deletes|deleting|remove|removes|removing|move|moves|moving|copy|copies|copying|rename|renames|renaming|update|updates|updating|edit|edits|editing|generate|generates|generating|save|saves|saving|store|stores|storing|apply|applies|applying|chmod|chown|touch|mkdir|mkfile|overwrite|overwrites|overwriting|replace|replaces|replacing|append|appends|appending|truncate|truncates|truncating|install|installs|installing|uninstall|uninstalls|uninstalling|rm|mv|cp)'
  local re_english_write_action="(^|[^[:alpha:]])${re_english_write_token}([^[:alpha:]]|$)"
  local re_write_action="(写入|修改|提交|推送|创建|删除|移除|移动|复制|重命名|更新|编辑|生成|保存|存储|覆盖|替换|追加|清空|应用|${re_english_write_action})"
  local re_write_token="(写入|修改|实现|提交|推送|创建|删除|移除|移动|复制|重命名|更新|编辑|生成|保存|存储|覆盖|替换|追加|清空|应用|implement|${re_english_write_token})"
  # Git commands below mutate the index, worktree, refs, or stash even when
  # the surrounding sentence does not use a generic write verb.
  # Git global options may appear between `git` and the mutating subcommand;
  # consume only known option/value forms so the subcommand remains distinct.
  local re_git_global_option='(-[cC]([^[:space:]]+|[[:space:]]+[^[:space:]]+)|--(git-dir|work-tree|namespace|exec-path|config-env)(=|[[:space:]])[^[:space:]]+|--[[:alnum:]-]+(=[^[:space:]]+)?)'
  local re_git_prefix="git[[:space:]]+(${re_git_global_option}[[:space:]]+)*"
  local re_git_command_boundary='([^[:alnum:]_-]|$)'
  local re_git_write_command="(^|[^[:alpha:]])${re_git_prefix}(add|stage|checkout|restore|apply|reset|clean|merge|rebase|cherry-pick|revert|switch|stash|rm|mv|update-index|push|pull|fetch|update-ref|symbolic-ref|config|worktree)${re_git_command_boundary}"
  local re_git_branch_write="(^|[^[:alpha:]])${re_git_prefix}branch[[:space:]]+((-[dDmMcC])|(--(delete|move|copy|force|edit-description|set-upstream-to|unset-upstream|track|no-track))|[^-[:space:]])"
  local re_git_tag_write="(^|[^[:alpha:]])${re_git_prefix}tag[[:space:]]+((-[asufd])|(--(annotate|sign|local-user|force|delete))|[^-[:space:]])"
  local re_git_remote_write="(^|[^[:alpha:]])${re_git_prefix}remote[[:space:]]+(add|remove|rename|set-url|set-branches|set-head|prune)${re_git_command_boundary}"
  local re_git_commit_write="(^|[^[:alpha:]])${re_git_prefix}commit${re_git_command_boundary}"
  local re_shell_inplace_command='(^|[^[:alpha:]])(sed|perl|ruby)[[:space:]]+([^[:space:]]+[[:space:]]+)*(--in-place|-[^[:space:]]*i[^[:space:]]*)([[:space:]]|$)'
  local re_tee_write='(^|[^[:alpha:]])tee[[:space:]]+(-[[:alnum:]-]+[[:space:]]+)*[^[:space:]]+'
  local re_shell_redirect='(^|[[:space:]])([0-9]*>>?|&>)[[:space:]]*[^[:space:]]+'
  # Negation clauses consume the whitespace before a command, so their
  # command subjects intentionally omit the leading boundary used above.
  local re_git_write_subject="${re_git_prefix}(add|stage|checkout|restore|apply|reset|clean|merge|rebase|cherry-pick|revert|switch|stash|rm|mv|update-index|push|pull|fetch|update-ref|symbolic-ref|config|worktree)${re_git_command_boundary}"
  local re_git_branch_subject="${re_git_prefix}branch[[:space:]]+((-[dDmMcC])|(--(delete|move|copy|force|edit-description|set-upstream-to|unset-upstream|track|no-track))|[^-[:space:]])"
  local re_git_tag_subject="${re_git_prefix}tag[[:space:]]+((-[asufd])|(--(annotate|sign|local-user|force|delete))|[^-[:space:]])"
  local re_git_remote_subject="${re_git_prefix}remote[[:space:]]+(add|remove|rename|set-url|set-branches|set-head|prune)${re_git_command_boundary}"
  local re_git_commit_subject="${re_git_prefix}commit${re_git_command_boundary}"
  local re_git_apply_readonly_subject="${re_git_prefix}apply[[:space:]]+--(check|stat|numstat|summary)([[:space:]]+[^-[:space:]][^[:space:]]*)*${re_git_command_boundary}"
  local re_git_config_readonly_subject="${re_git_prefix}config[[:space:]]+(--(get|get-all|get-regexp|get-url|get-color|list|name-only|show-origin|show-scope|null)|-l)([[:space:]]+[^[:space:]]+)*${re_git_command_boundary}"
  local re_git_worktree_readonly_subject="${re_git_prefix}worktree[[:space:]]+list([[:space:]]+--porcelain)?${re_git_command_boundary}"
  local re_git_stash_readonly_subject="${re_git_prefix}stash[[:space:]]+(list|show)([[:space:]]+[^[:space:]]+)*${re_git_command_boundary}"
  local re_readonly_task_suffix='(\(skill:[^)]*\))?[[:space:]]*$'
  local re_shell_inplace_subject='(sed|perl|ruby)[[:space:]]+([^[:space:]]+[[:space:]]+)*(--in-place|-[^[:space:]]*i[^[:space:]]*)([[:space:]]|$)'
  local re_tee_subject='tee[[:space:]]+(-[[:alnum:]-]+[[:space:]]+)*[^[:space:]]+'
  local re_shell_redirect_subject='([0-9]*>>?|&>)[[:space:]]*[^[:space:]]+'
  local re_command_write_subject="(${re_git_write_subject}|${re_git_branch_subject}|${re_git_tag_subject}|${re_git_remote_subject}|${re_git_commit_subject}|${re_shell_inplace_subject}|${re_tee_subject}|${re_shell_redirect_subject})"
  local re_english_implementation_verb='(implement|implements|implemented|implementing)'
  local re_write_target='(((共享|主|当前)[[:space:]]*(工作区|工作树|文件|目录|路径))|((shared|main|current)[[:space:]]*(workspace|worktree|file|files|directory|path|repository|repo|code|branch|source|filesystem|changes?|fix|feature|functionality|solution|implementation|behavior|behaviour))|(task[-[:space:]]*local[[:space:]]*(workspace|worktree|file|directory|path))|(another[[:space:]]+(filesystem|directory|path|worktree|workspace))|(workspace|worktree|file|files|directory|path|repository|repo|code|branch|source|filesystem|changes?|fix|feature|functionality|solution|implementation|behavior|behaviour)|代码|文件|目录|路径|仓库|分支|源文件|文件系统|变更|修复)'
  local re_english_commit_write='(^|[^[:alpha:]])commit(ting|s)?[[:space:]]+(to[[:space:]]+)?(the[[:space:]]+|a[[:space:]]+|an[[:space:]]+)?(changes?|files?|code|fix(es)?|feature|implementation|repository|repo|work|source|branch)'
  local re_implementation_write='(^|[[:space:][:punct:]])实现[[:space:]]*(功能|代码|文件|目录|路径|仓库|分支|源文件|文件系统|变更|修复)'
  local re_english_implementation_target="(${re_write_target}|bug[[:space:]]+fix(es)?|code[[:space:]]+changes?|this[[:space:]]+(feature|fix|task|change|code|implementation|functionality|solution)|current[[:space:]]+(feature|fix|task|code|implementation|changes?))"
  local re_english_implementation_write="(^|[[:space:][:punct:]])${re_english_implementation_verb}[[:space:]]+((the|a|an|this|that|these|those)[[:space:]]+)?${re_english_implementation_target}"
  # `patch` is handled as an imperative verb only; treating every noun phrase
  # such as "review the patch" as a write would reject normal read-only review.
  local re_english_patch_write="(^|[[:space:][:punct:]])(patch|patches|patching)[[:space:]]+(the[[:space:]]+|a[[:space:]]+|an[[:space:]]+)?${re_write_target}"
  local re_sub_agent_write="(${re_write_action}.{0,80}${re_write_target}|${re_write_target}.{0,80}${re_write_action}|${re_english_commit_write}|${re_implementation_write}|${re_english_implementation_write}|${re_english_patch_write}|${re_git_write_command}|${re_git_branch_write}|${re_git_tag_write}|${re_git_remote_write}|${re_git_commit_write}|${re_shell_inplace_command}|${re_tee_write}|${re_shell_redirect})"
  local re_sub_agent_write_negation="(((must|should|shall|may|can|will|do|does|did)[[:space:]]+(not|never)[[:space:]]+${re_write_token})|never[[:space:]]+${re_write_token}|no[[:space:]]+${re_write_token}|(^|[[:space:]])not[[:space:]]+${re_write_token}|not[[:space:]]+(allowed|permitted|authorized|supposed)[[:space:]]+(to[[:space:]]+)?${re_write_token}|(forbidden|prohibited)[[:space:]]+(to[[:space:]]+|from[[:space:]]+)?${re_write_token}|(不得|禁止|不应|不可|不能|不要|不允许|不准)[[:space:]]*${re_write_token})"
  local re_sub_agent_command_negation="(((must|should|shall|may|can|will|do|does|did)[[:space:]]+(not|never)[[:space:]]+(use|using|run|running|execute|executing|perform|performing)[[:space:]]+${re_command_write_subject})|never[[:space:]]+${re_command_write_subject}|no[[:space:]]+${re_command_write_subject}|(^|[[:space:]])not[[:space:]]+${re_command_write_subject}|not[[:space:]]+(allowed|permitted|authorized|supposed)[[:space:]]+(to[[:space:]]+)?(use|using|run|running|execute|executing|perform|performing)?[[:space:]]*${re_command_write_subject}|(forbidden|prohibited)[[:space:]]+(to[[:space:]]+|from[[:space:]]+)?(use|using|run|running|execute|executing|perform|performing)?[[:space:]]*${re_command_write_subject}|(不得|禁止|不应|不可|不能|不要|不允许|不准)[[:space:]]*${re_command_write_subject})"
  local re_legacy_profile_text='(^|[^[:alnum:]_])(model|model_reasoning_effort|reasoning_effort|effort)[[:space:]]*='

  sub_agent_write_forbidden() {
    local text="$1"
    local clause
    while IFS= read -r clause; do
      [[ -z "${clause//[[:space:]]/}" ]] && continue
      # `git apply --check/stat/numstat/summary` only inspects a patch. Keep
      # those validation forms read-only while treating other apply modes as
      # worktree/index mutations.
      if grep -Eiq "^[[:space:]]*${re_git_apply_readonly_subject}${re_readonly_task_suffix}" < <(printf '%s\n' "$clause"); then
        continue
      fi
      if grep -Eiq "^[[:space:]]*${re_git_config_readonly_subject}${re_readonly_task_suffix}" < <(printf '%s\n' "$clause") \
        || grep -Eiq "^[[:space:]]*${re_git_worktree_readonly_subject}${re_readonly_task_suffix}" < <(printf '%s\n' "$clause") \
        || grep -Eiq "^[[:space:]]*${re_git_stash_readonly_subject}${re_readonly_task_suffix}" < <(printf '%s\n' "$clause"); then
        continue
      fi
      if grep -Eiq "$re_sub_agent_write" < <(printf '%s\n' "$clause"); then
        if ! grep -Eiq "$re_sub_agent_write_negation" < <(printf '%s\n' "$clause") \
          && ! grep -Eiq "$re_sub_agent_command_negation" < <(printf '%s\n' "$clause"); then
          return 0
        fi
      fi
    done < <(printf '%s\n' "$text" | awk '{
      gsub(/[;,，；。!！?？]/, "\n")
      gsub(/[&][&]|[|][|]?/, "\n")
      gsub(/[[:space:]]+(or|and|but|then)[[:space:]]+/, "\n")
      gsub(/[[:space:]]+(或|或者|以及|并且|但是|但|然后)[[:space:]]+/, "\n")
      print
    }')
    return 1
  }

  if ! grep -Fq "## Task Orchestration" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_TASK_ORCHESTRATION_SECTION" "Missing required section: ## Task Orchestration"
    return 1
  fi

  local orchestration
  orchestration="$(extract_section "$plan_text" "Task Orchestration")"
  local declared_constraint_ids
  declared_constraint_ids="$(extract_section "$plan_text" "Constraints" | sed -nE 's/^[[:space:]]*-[[:space:]]*(C[1-9][0-9]*):.*/\1/p')"
  local section_line=0
  local line_count=0
  local wave_count=0
  local task_count=0
  local bootstrap_count=0
  local bootstrap_task_count=0
  local current_wave=""
  local current_wave_task=0
  local current_wave_line=""
  local current_wave_tasks=""
  local previous_wave_num=0
  local orchestration_skill_bindings=""
  local re_skill_binding='\(skill:[^)]*\)'
  local re_spec_action_init_word='((^|[^[:alnum:]_])init([^[:alnum:]_]|$))'
  local re_spec_doc_author_action="(创建|生成|迁移|初始化|新建|建立|编写|撰写|新增|添加|补充|更新|修改|编辑|删除|移除|同步|复制|拷贝|移动|重命名|create|generate|migrate|initialize|${re_spec_action_init_word}|add|update|edit|modify|change|revise|delete|remove|drop|sync|synchronize|synchronise|copy|duplicate|clone|move|rename|relocate|write|draft|author)"
  local re_spec_doc_work_action_before="(创建|生成|迁移|初始化|新建|建立|编写|撰写|配置|新增|添加|补充|更新|修改|编辑|删除|移除|同步|复制|拷贝|移动|重命名|create|generate|migrate|initialize|${re_spec_action_init_word}|add|update|edit|modify|change|revise|delete|remove|drop|sync|synchronize|synchronise|copy|duplicate|clone|move|rename|relocate|setup|set[[:space:]]+up|write|draft|author)"
  local re_spec_doc_work_action_after='(创建|生成|迁移|初始化|新建|建立|编写|撰写|配置|新增|添加|补充|更新|修改|编辑|删除|移除|同步|复制|拷贝|移动|重命名|created|generated|migrated|initialized|configured|added|updated|edited|modified|changed|revised|deleted|removed|dropped|synced|synchronized|synchronised|copied|duplicated|cloned|moved|renamed|relocated|setup|set[[:space:]]+up|written|drafted|authored)'
  local re_bare_spec_doc='((write|draft|author|create|generate|add|delete|remove|drop|编写|撰写|创建|生成|新增|添加|补充|删除|移除)([[:space:][:punct:]]+(a|an|the|new|一个|一份|新的|新增)){0,3}[[:space:][:punct:]]*spec(([.]md)|([[:space:]_-]+(doc|document|documentation|文档|specification))|([[:space:][:punct:]]+(before|for|to|gate|用于|以便|供|作为|验收|范围|接口)))([^[:alnum:]_-]|$))'
  local re_bare_specification_doc='((write|draft|author|create|generate|add|delete|remove|drop|编写|撰写|创建|生成|新增|添加|补充|删除|移除)([[:space:][:punct:]]+(a|an|the|new|一个|一份|新的|新增)){0,3}[[:space:][:punct:]]*specifications?([[:space:][:punct:]]+(before|for|to|gate|doc|document|documentation|文档|用于|以便|供|作为|验收|范围|接口))([^[:alnum:]_-]|$))'
  local re_spec_id_generation='((create|generate|init|initialize|创建|生成|初始化)([[:space:][:punct:]]+(a|an|the|new|一个|一份|新的|新增)){0,3}[[:space:][:punct:]]*spec[[:space:]_-]*id([^[:alnum:]_-]|$))'
  local re_spec_doc_token='((^|[^[:alnum:]_/-])spec([-_[:space:]]doc)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_/-])spec[[:space:]]*(document|documentation|文档|specification)([^[:alnum:]_-]|$))'
  local re_cn_spec_doc_token='(规格文档|规范文档|规格说明([[:space:]]*文档)?|需求规格([[:space:]]*说明)?([[:space:]]*文档)?|技术规格([[:space:]]*文档)?|接口规格([[:space:]]*文档)?)'
  local re_spec_doc_runtime_term='(parser|reader|validator|linter|checker|analy(z|s)er|compiler|解析器|校验器|编译器)'
  local re_runtime_impl_context='((^|[^[:alnum:]_])(parser|reader|validator|linter|checker|analy(z|s)er|compiler|engine|runner)([^[:alnum:]_]|$)|解析器|校验器|编译器|运行器)'
  local re_spec_doc_runtime_safe_phrase="((spec([-_[:space:]]doc|[[:space:]]*(document|documentation|文档|specification))[[:space:]_-]*${re_spec_doc_runtime_term})|(${re_spec_doc_runtime_term}[[:space:]_-]*(for[[:space:]]+)?spec([-_[:space:]]doc|[[:space:]]*(document|documentation|文档|specification))))"
  local re_spec_path='(docs/specs|docs/plan)(/|[^[:alnum:]_-]|$)'
  local re_spec_path_doc_work_before="(${re_spec_doc_work_action_before}.{0,120}${re_spec_path})"
  local re_spec_path_doc_work_after="(${re_spec_path}.{0,120}${re_spec_doc_work_action_after})"
  local re_spec_path_forbidden_build_action_before="(创建|生成|迁移|初始化|新建|create|generate|migrate|initialize|${re_spec_action_init_word})"
  local re_spec_path_forbidden_build_action_after='(创建|生成|迁移|初始化|新建|created|generated|migrated|initialized)'
  local re_spec_path_forbidden_build_before="(${re_spec_path_forbidden_build_action_before}.{0,120}${re_spec_path})"
  local re_spec_path_forbidden_build_after="(${re_spec_path}.{0,120}${re_spec_path_forbidden_build_action_after})"
  local re_spec_path_direct_target_create='((create|generate|init|initialize|mkdir|创建|生成|初始化).{0,24}(docs/specs|docs/plan)(/|[^[:alnum:]_-]|$))'
  local re_spec_path_direct_sync_update='((sync|synchronize|synchronise|update|modify|edit|change|revise|migrate|同步|更新|修改|编辑|变更|迁移)[[:space:][:punct:]]+((existing|现有)[[:space:][:punct:]]+)?(docs/specs|docs/plan)(/|[^[:alnum:]_-]|$))'
  local re_spec_path_direct_copy_move_rename='((copy|duplicate|clone|move|rename|relocate|复制|拷贝|移动|重命名|改名|迁移).{0,160}(docs/specs|docs/plan)(/|[^[:alnum:]_-]|$).{0,160}(docs/specs|docs/plan)(/|[^[:alnum:]_-]|$))'
  local re_spec_create_migrate_action='((^|[^[:alnum:]_])(create|generate|init|initialize|migrate)([^[:alnum:]_]|$)|创建|生成|初始化|迁移)'
  local re_spec_path_add_action_before='((^|[^[:alnum:]_])add([^[:alnum:]_]|$)|新增|添加|补充)'
  local re_spec_path_add_action_after='((^|[^[:alnum:]_])added([^[:alnum:]_]|$)|新增|添加|补充)'
  local re_spec_path_add_work_before="(${re_spec_path_add_action_before}.{0,120}${re_spec_path})"
  local re_spec_path_add_work_after="(${re_spec_path}.{0,120}${re_spec_path_add_action_after})"
  local re_spec_path_runtime_read_action_before='((^|[^[:alnum:]_])(read|load|parse|check|validate|inspect|scan|review|analy(z|s)e)([^[:alnum:]_]|$)|读取|加载|解析|检查|校验|审阅|分析)'
  local re_spec_path_runtime_read_action_after='((^|[^[:alnum:]_])(read|loaded|parsed|checked|validated|inspected|scanned|reviewed|analyzed)([^[:alnum:]_]|$)|读取|加载|解析|检查|校验|审阅|分析)'
  local re_spec_path_runtime_read_before="(${re_spec_path_runtime_read_action_before}.{0,120}${re_spec_path})"
  local re_spec_path_runtime_read_after="(${re_spec_path}.{0,120}${re_spec_path_runtime_read_action_after})"
  local re_docs_plan_to_specs_migration='((migrate|迁移).{0,120}docs/plan.{0,120}docs/specs)'
  local re_existing_spec_reference="((using|use|from|according[[:space:]]+to|based[[:space:]]+on|per|follow(ing)?|refer[[:space:]]+to|as[[:space:]]+reference|with|against|via|under|参考|依据|按照|基于|参照|引用|使用)[[:space:][:punct:]]*(existing|现有)?[[:space:][:punct:]]*${re_spec_path}|(existing|现有)[[:space:][:punct:]]*${re_spec_path})"
  local re_existing_spec_reference_runtime="(${re_runtime_impl_context}.{0,60}(using|use|from|according[[:space:]]+to|based[[:space:]]+on|per|against|via|under|参考|依据|按照|基于|参照|引用|使用)[[:space:][:punct:]]*(existing|现有)?[[:space:][:punct:]]*${re_spec_path})"
  local re_existing_spec_reference_for_tests="((write|add|create|run|maintain|update|编写|新增|添加|补充|完善|更新|修改|运行).{0,40}(tests?|test[[:space:]_-]*cases?|integration[[:space:]_-]*tests?|单元测试|集成测试|测试|用例).{0,40}(for|against|according[[:space:]]+to|based[[:space:]]+on|per|using|use|from|via|under|参考|依据|按照|基于|参照|引用|使用|针对|面向)[[:space:][:punct:]]*(existing|现有)?[[:space:][:punct:]]*${re_spec_path})"
  local re_implement_only_spec_work='(spec[[:space:]_-]*(gate|sync)|spec[[:space:]]*(迁移|同步))'
  local re_persisted_plan_artifact_path='(PLAN\.md|PLANS\.md)'
  local re_persisted_plan_artifact_product_anchor='(content|document|documents|payload|api|apis|endpoint|endpoints|product|importer|consumer|processor|parser|reader|handler|integration|integrations|connector|connectors|storage|viewer|exporter|upload|uploads|download|downloads)'
  local re_persisted_plan_artifact_path_product_safe="(((accept|allow|support|handle|process|consume|ingest|import|upload|download|parse|read|open|view|receive|attach|update).{0,80}${re_persisted_plan_artifact_product_anchor}.{0,80}((user|customer)-provided[[:space:]]+)?(PLAN\\.md|PLANS\\.md))|((PLAN\\.md|PLANS\\.md).{0,80}(files?|attachments?|uploads?|content|document|documents|payload|importer|consumer|processor|parser|reader|handler|integration|integrations|connector|connectors).{0,80}(from[[:space:]]+(users?|customers?)|user-provided|customer-provided|upload|import|download|api|endpoint|product)))"
  local re_persisted_plan_artifact_object='(progress[[:space:]_-]*ledger|living[[:space:]_-]*plan|plan[[:space:]_-]*(ledger|log|artifact)|plan[[:space:]_-]*decision[[:space:]_-]*log|persist(ed|ent)?[[:space:]_-]*plan)'
  local re_persisted_plan_artifact_action='((^|[^[:alnum:]_])(write|create|add|update|maintain|keep|sync|persist|save|store|append|draft|author|record|generate|init|initialize|prepare|setup|set[[:space:]_-]*up|read|open|load|view|inspect|move|copy|duplicate|clone|rename|relocate|archive)([^[:alnum:]_]|$)|写入|创建|新增|添加|更新|维护|保留|同步|保存|落盘|追加|撰写|记录|生成|初始化|准备|配置|搭建|读取|打开|加载|查看|检查|移动|复制|拷贝|重命名|迁移|归档)'
  local re_persisted_plan_to_disk='(plan[[:space:]]+to[[:space:]]+disk|落盘[[:space:]]*(计划|plan))'
  local re_persisted_plan_planning_context='(handoff|handoffs|turn|turns|wave|waves|resume|future[[:space:]_-]*(work|works|handoff|handoffs|session|sessions)|next[[:space:]_-]*(work|works|handoff|handoffs|session|sessions)|follow[[:space:]_-]*up|后续|下一步|未来|交接|轮次|波次|续推)'
  local re_progress_log_artifact='(progress[[:space:]_-]*log)'
  local re_decision_log_artifact='(decision[[:space:]_-]*log)'
  local re_product_surface_safe_token='(ui|ux|page|view|viewer|screen|panel|table|list|lists|filter|filters|pagination|component|widget|api|apis|endpoint|endpoints|route|routes|field|fields|schema|schemas|model|models|template|templates|csv|export|exports|exporter|exporters|import|imports|importer|importers|consumer|consumers|processor|processors|parser|parsers|reader|readers|handler|handlers|worker|workers|integration|integrations|connector|connectors|storage|report|reports|download|downloads|entry|entries)'
  local re_product_surface_safe="((^|[^[:alnum:]_])${re_product_surface_safe_token}([^[:alnum:]_]|$))"
  local re_plan_template_surface='(plan[[:space:]_-]*templates?)'
  local re_progress_log_product_safe="((progress[[:space:]_-]*log).{0,40}${re_product_surface_safe}|${re_product_surface_safe}.{0,40}(progress[[:space:]_-]*log))"
  local re_decision_log_product_safe="((decision[[:space:]_-]*log).{0,40}${re_product_surface_safe}|${re_product_surface_safe}.{0,40}(decision[[:space:]_-]*log)|(decision[[:space:]_-]*log).{0,80}${re_plan_template_surface}|${re_plan_template_surface}.{0,80}(decision[[:space:]_-]*log))"
  local re_decision_log_planning_context='(planning|plan|plans|handoff|handoffs|turn|turns|wave|waves|resume|review|workflow|workflows|pipeline|pipelines|job|jobs|future[[:space:]_-]*(work|works|handoff|handoffs|session|sessions)|next[[:space:]_-]*(work|works|handoff|handoffs|session|sessions)|follow[[:space:]_-]*up|后续|下一步|未来|计划|交接|轮次|波次|续推|审查)'
  local re_handoff_log_artifact='(handoff[[:space:]_-]*log|交接[[:space:]_-]*日志?)'
  local re_handoff_log_product_safe="((handoff[[:space:]_-]*log).{0,40}${re_product_surface_safe}|${re_product_surface_safe}.{0,40}(handoff[[:space:]_-]*log)|(handoff[[:space:]_-]*log).{0,80}${re_plan_template_surface}|${re_plan_template_surface}.{0,80}(handoff[[:space:]_-]*log))"
  local re_handoff_log_planning_context='(planning|plan|plans|turn|turns|wave|waves|resume|review|workflow|workflows|pipeline|pipelines|job|jobs|future[[:space:]_-]*(work|works|handoff|handoffs|(agent[[:space:]_-]*)?session|sessions)|next[[:space:]_-]*(work|works|handoff|handoffs|(agent[[:space:]_-]*)?session|sessions)|follow[[:space:]_-]*up|后续|下一步|未来|计划|轮次|波次|续推|审查|下一[[:space:]_-]*个?代理[[:space:]_-]*会话|未来[[:space:]_-]*代理[[:space:]_-]*会话)'

  flush_wave() {
    if [[ -n "$current_wave" && "$current_wave_task" -eq 0 ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_EMPTY_WAVE" "Wave has no task items: wave ${current_wave}" "$current_wave_line" "$current_wave"
      fail_count=$((fail_count + 1))
    fi
  }

  while IFS= read -r line; do
    section_line=$((section_line + 1))
    [[ -z "${line//[[:space:]]/}" ]] && continue
    line_count=$((line_count + 1))

    if [[ "$line" =~ $re_checkbox ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_CHECKBOX_FORBIDDEN" "Task Orchestration list must not use checkbox markers: $line" "$section_line" "$current_wave"
      fail_count=$((fail_count + 1))
      continue
    fi

    if [[ ! "$line" =~ $re_list ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_NON_LIST_CONTENT" "Task Orchestration allows list items only: $line" "$section_line" "$current_wave"
      fail_count=$((fail_count + 1))
      continue
    fi

    local indent item
    indent="$(printf '%s\n' "$line" | sed -E 's/^([[:space:]]*).*/\1/' | awk '{ print length }')"
    item="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*-[[:space:]]+//')"

    if [[ "$indent" -eq 0 ]]; then
      if [[ "$item" =~ $re_bootstrap ]]; then
        if [[ "$flow_type" != "initiative" ]]; then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_FLOW_FORBIDDEN" "only initiative plans may declare a bootstrap block: $line" "$section_line"
          fail_count=$((fail_count + 1))
        fi
        if [[ "$bootstrap_count" -gt 0 ]]; then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_DUPLICATE" "initiative may declare exactly one bootstrap block: $line" "$section_line"
          fail_count=$((fail_count + 1))
        fi
        if [[ "$wave_count" -gt 0 ]]; then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_ORDER_INVALID" "bootstrap must precede Ticket Wave 1: $line" "$section_line"
          fail_count=$((fail_count + 1))
        fi
        flush_wave
        bootstrap_count=$((bootstrap_count + 1))
        current_wave="bootstrap"
        current_wave_task=0
        current_wave_line="$section_line"
        current_wave_tasks=""
        continue
      fi
      if [[ "$item" =~ $re_wave ]]; then
        flush_wave
        wave_count=$((wave_count + 1))
        current_wave="${BASH_REMATCH[1]}"
        current_wave_task=0
        current_wave_line="$section_line"
        current_wave_tasks=""
        if [[ "$previous_wave_num" -eq 0 && "$current_wave" -ne 1 ]]; then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_WAVE_SEQUENCE_INVALID" "wave sequence must start from 1: got wave ${current_wave}" "$section_line" "$current_wave"
          fail_count=$((fail_count + 1))
        elif [[ "$previous_wave_num" -gt 0 && "$current_wave" -ne $((previous_wave_num + 1)) ]]; then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_WAVE_SEQUENCE_INVALID" "wave sequence must be continuous: expected $((previous_wave_num + 1)), got ${current_wave}" "$section_line" "$current_wave"
          fail_count=$((fail_count + 1))
        fi
        previous_wave_num="$current_wave"
        continue
      fi
      if [[ "$item" =~ $re_task ]]; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_TASK_OUTSIDE_WAVE" "task item must be inside a wave block: $line" "$section_line"
        fail_count=$((fail_count + 1))
        continue
      fi
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_INVALID_ITEM" "Top-level item must use wave: <n> format: $line" "$section_line"
      fail_count=$((fail_count + 1))
      continue
    fi

    if [[ "$item" =~ $re_task ]]; then
      if [[ -z "$current_wave" ]]; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_TASK_OUTSIDE_WAVE" "task item must be inside a wave block: $line" "$section_line"
        fail_count=$((fail_count + 1))
        continue
      fi
      local executor task_text normalized_task profile_present profile_model profile_effort
      executor="${BASH_REMATCH[1]}"
      profile_present="${BASH_REMATCH[2]:-}"
      profile_model="$(printf '%s\n' "${BASH_REMATCH[3]:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      profile_effort="$(printf '%s\n' "${BASH_REMATCH[4]:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      task_text="$(printf '%s\n' "${BASH_REMATCH[5]}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      normalized_task="${executor} => ${task_text}"
      # Formal reviewers are a runtime concern. Keep ordinary read-only
      # analysis sidecars valid, but reject task items that schedule a formal
      # lane, reviewer identity, or current-head review in the plan itself.
      local formal_task_text
      formal_task_text="$(printf '%s\n' "$task_text" | sed -E 's/\(skill:[^)]+\)//g')"
      local formal_executor
      formal_executor="$(printf '%s\n' "$executor" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      local formal_scan_text="${formal_executor} => ${formal_task_text}"
      if [[ "$flow_type" == "normal" || "$flow_type" == "fast-track" || "$flow_type" == "local-merge" ]] \
        && grep -Eiq '(\$review-agent|formal[[:space:]_-]+(code[[:space:]_-]+)?review[[:space:]_-]+(lane|wave|reviewer|agent|identity|profile)|formal[[:space:]_-]+evidence|code[[:space:]_-]+review[[:space:]_-]+lane|正式[[:space:]]*(代码)?审查|formal[[:space:]]+lane|review[[:space:]_-]*wave|reviewer([[:space:]_-]*(agent|identity|profile))?|required[[:space:]]+lane|审查[[:space:]]*(lane|批次|波次)|current[[:space:]_-]*head.{0,40}(review|审查|formal[[:space:]_-]*evidence)|冻结[[:space:]]*current[[:space:]]*head.{0,40}(review|审查)|((run|launch|start|schedule|create|execute|perform|运行|启动|创建|执行).{0,40}formal[[:space:]_-]+(code[[:space:]_-]+)?review)|((run|launch|start|schedule|create|execute|perform|运行|启动|创建|执行).{0,40}tier[[:space:]_-]*[34].{0,40}(formal|review|reviewer|lane|evidence|审查)))|(^|:)(reviewer|review-agent|policy-semantics|record-integrity|contract-language|regression-evidence|ui-accessibility|security|database-migration|release-infra)([[:space:]]|$)' < <(printf '%s\n' "$formal_scan_text"); then
        report_finding "$file" "$idx" "FORMAL_REVIEW_PREDECLARATION_FORBIDDEN" "Task Orchestration may not predeclare a formal reviewer, lane, review wave, or reviewer profile; launch formal lanes after Review Readiness at runtime: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      local constraint_id
      while IFS= read -r constraint_id || [[ -n "$constraint_id" ]]; do
        [[ -z "$constraint_id" ]] && continue
        if grep -Eq "(^|[^[:alnum:]_])${constraint_id}([^[:alnum:]_]|$)" < <(printf '%s\n' "$task_text"); then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_CONSTRAINT_REFERENCE_FORBIDDEN" "Constraint ${constraint_id} must limit an existing goal or acceptance, not become a Task Orchestration work item: ${normalized_task}" "$section_line" "$current_wave"
          fail_count=$((fail_count + 1))
        fi
      done <<<"$declared_constraint_ids"
      if [[ "$current_wave" == "bootstrap" && "$executor" != "main-agent" ]]; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_EXECUTOR_INVALID" "bootstrap may only be executed by main-agent: ${executor}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      if [[ "$executor" == "sub-agent:ticket" || "$executor" == task:* ]] \
        && grep -Fq '$dev-plan' < <(printf '%s\n' "$normalized_task"); then
        report_finding "$file" "$idx" "TICKET_REPLAN_FORBIDDEN" "Ticket tasks inherit the approved plan and must not invoke \$dev-plan: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      if [[ "$executor" == "main-agent" && -n "$profile_present" ]]; then
        report_finding "$file" "$idx" "MAIN_AGENT_PROFILE_FORBIDDEN" "main-agent inherits the current session profile and must not declare an inline profile: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      elif [[ "$executor" != "main-agent" && -z "$profile_present" ]]; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_AGENT_PROFILE_MISSING" "sub-agent/task items must declare [model, effort] in new plans: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      elif [[ -n "$profile_present" ]]; then
        case "$profile_model" in
          gpt-5.6-luna)
            if [[ ! "$profile_effort" =~ ^(low|medium|high|xhigh|max)$ ]]; then
              report_finding "$file" "$idx" "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID" "gpt-5.6-luna supports low|medium|high|xhigh|max: ${normalized_task}" "$section_line" "$current_wave"
              fail_count=$((fail_count + 1))
            fi
            ;;
          gpt-5.6-terra|gpt-5.6-sol|gpt-6.1-sol|gpt-6-sol|gpt-6-astra)
            if [[ ! "$profile_effort" =~ ^(low|medium|high|xhigh|max|ultra)$ ]]; then
              report_finding "$file" "$idx" "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID" "${profile_model} supports low|medium|high|xhigh|max|ultra: ${normalized_task}" "$section_line" "$current_wave"
              fail_count=$((fail_count + 1))
            fi
            ;;
          gpt-6-luna)
            if [[ ! "$profile_effort" =~ ^(low|medium|high|xhigh|max)$ ]]; then
              report_finding "$file" "$idx" "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID" "gpt-6-luna supports low|medium|high|xhigh|max: ${normalized_task}" "$section_line" "$current_wave"
              fail_count=$((fail_count + 1))
            fi
            ;;
          *)
            report_finding "$file" "$idx" "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID" "unsupported agent model ${profile_model}: ${normalized_task}" "$section_line" "$current_wave"
            fail_count=$((fail_count + 1))
            ;;
        esac
      fi
      if [[ "$executor" == sub-agent:* ]] && sub_agent_write_forbidden "$task_text"; then
        report_finding "$file" "$idx" "SUB_AGENT_SHARED_WRITE_FORBIDDEN" "sub-agent is read-only and must not write any workspace, worktree, file, or filesystem target: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      if grep -Eiq "$re_legacy_profile_text" < <(printf '%s\n' "$task_text"); then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_LEGACY_PROFILE_FORBIDDEN" "new plans must use [model, effort] instead of free-text model=... profile markers: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      if grep -Fq '$codex-review-loop' < <(printf '%s\n' "$task_text"); then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_LEGACY_SKILL_FORBIDDEN" "plans must leave formal review to the readiness-gated runtime: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      if [[ "$flow_type" == "initiative" && "$executor" == sub-agent:* ]]; then
        report_finding "$file" "$idx" "INITIATIVE_SUB_AGENT_TOP_LEVEL_FORBIDDEN" "initiative Task Orchestration must use task:<name> for independent Codex tasks; sub-agent is internal to a task: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      elif [[ "$flow_type" != "initiative" && "$flow_type" != "parallel-pr" && "$flow_type" != "wave-thread" && "$executor" == task:* ]]; then
        report_finding "$file" "$idx" "TASK_EXECUTOR_FORBIDDEN_FLOW" "task:<name> is only valid at the initiative top level: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      local skill_binding_text=""
      if ! [[ "$task_text" =~ $re_skill_binding ]]; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_MISSING_SKILL_BINDING" "task item must include inline skill binding '(skill: ...)': ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      else
        skill_binding_text="$(grep -Eo '\(skill:[^)]*\)' < <(printf '%s\n' "$task_text") | paste -sd ' ' -)"
        local invalid_skill_ref=0 skill_ref
        while IFS= read -r skill_ref; do
          [[ -z "$skill_ref" ]] && continue
          if ! [[ "$skill_ref" =~ ^\$[[:alnum:]_-]+$ ]]; then
            invalid_skill_ref=1
            break
          fi
        done < <(
          printf '%s\n' "$skill_binding_text" \
            | sed -E 's/\(skill:[[:space:]]*//g; s/\)//g; s/[+,，＋]/ /g' \
            | tr '[:space:]' '\n'
        )
        if [[ "$invalid_skill_ref" -eq 1 ]]; then
          report_finding "$file" "$idx" "TASK_ORCHESTRATION_SKILL_REF_FORMAT_INVALID" "skill binding must use dollar-prefixed skill-name format: ${normalized_task}" "$section_line" "$current_wave"
          fail_count=$((fail_count + 1))
        fi
        orchestration_skill_bindings+="$skill_binding_text"$'\n'
      fi
      local persisted_plan_artifact=0
      if grep -Eiq "$re_persisted_plan_artifact_path" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_persisted_plan_artifact_action" < <(printf '%s\n' "$task_text") && { ! grep -Eiq "$re_persisted_plan_artifact_path_product_safe" < <(printf '%s\n' "$task_text") || grep -Eiq "$re_persisted_plan_planning_context" < <(printf '%s\n' "$task_text"); }; then
        persisted_plan_artifact=1
      elif grep -Eiq "$re_persisted_plan_artifact_object" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_persisted_plan_artifact_action" < <(printf '%s\n' "$task_text"); then
        persisted_plan_artifact=1
      elif grep -Eiq "$re_progress_log_artifact" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_persisted_plan_artifact_action" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_persisted_plan_planning_context" < <(printf '%s\n' "$task_text") && ! grep -Eiq "$re_progress_log_product_safe" < <(printf '%s\n' "$task_text"); then
        persisted_plan_artifact=1
      elif grep -Eiq "$re_decision_log_artifact" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_persisted_plan_artifact_action" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_decision_log_planning_context" < <(printf '%s\n' "$task_text") && ! grep -Eiq "$re_decision_log_product_safe" < <(printf '%s\n' "$task_text"); then
        persisted_plan_artifact=1
      elif grep -Eiq "$re_handoff_log_artifact" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_persisted_plan_artifact_action" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_handoff_log_planning_context" < <(printf '%s\n' "$task_text") && ! grep -Eiq "$re_handoff_log_product_safe" < <(printf '%s\n' "$task_text"); then
        persisted_plan_artifact=1
      elif grep -Eiq "$re_persisted_plan_to_disk" < <(printf '%s\n' "$task_text"); then
        persisted_plan_artifact=1
      fi
      if [[ "$persisted_plan_artifact" -eq 1 ]]; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_PERSISTED_PLAN_ARTIFACT_FORBIDDEN" "Task Orchestration must not create or maintain persisted plan artifacts: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
      fi
      if [[ "$flow_type" =~ ^(implement-only|implement_only)$ ]]; then
        local forbidden_spec_work=0
        if grep -Eiq "$re_implement_only_spec_work" < <(printf '%s\n' "$task_text"); then
          forbidden_spec_work=1
        elif grep -Eiq "$re_bare_spec_doc" < <(printf '%s\n' "$task_text"); then
          if ! grep -Eiq "$re_spec_doc_runtime_safe_phrase" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          fi
        elif grep -Eiq "$re_bare_specification_doc" < <(printf '%s\n' "$task_text"); then
          if ! grep -Eiq "$re_spec_doc_runtime_safe_phrase" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          fi
        elif grep -Eiq "$re_spec_id_generation" < <(printf '%s\n' "$task_text"); then
          forbidden_spec_work=1
        elif grep -Eiq "$re_docs_plan_to_specs_migration" < <(printf '%s\n' "$task_text"); then
          forbidden_spec_work=1
        elif grep -Eiq "$re_spec_doc_token" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_spec_doc_author_action" < <(printf '%s\n' "$task_text"); then
          if ! grep -Eiq "$re_spec_doc_runtime_safe_phrase" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          fi
        elif grep -Eiq "$re_cn_spec_doc_token" < <(printf '%s\n' "$task_text") && grep -Eiq "$re_spec_doc_author_action" < <(printf '%s\n' "$task_text"); then
          if ! grep -Eiq "$re_spec_doc_runtime_safe_phrase" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          fi
        fi
        if [[ "$forbidden_spec_work" -eq 0 ]] && { grep -Eiq "$re_spec_path_doc_work_before" < <(printf '%s\n' "$task_text") || grep -Eiq "$re_spec_path_doc_work_after" < <(printf '%s\n' "$task_text"); }; then
          local is_test_reference=0
          if grep -Eiq "$re_existing_spec_reference_for_tests" < <(printf '%s\n' "$task_text"); then
            is_test_reference=1
          fi
          if grep -Eiq "$re_spec_path_direct_target_create" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          elif grep -Eiq "$re_spec_path_direct_sync_update" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          elif grep -Eiq "$re_spec_path_direct_copy_move_rename" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          elif grep -Eiq "$re_spec_path_forbidden_build_before" < <(printf '%s\n' "$task_text") || grep -Eiq "$re_spec_path_forbidden_build_after" < <(printf '%s\n' "$task_text"); then
            if grep -Eiq "$re_spec_create_migrate_action" < <(printf '%s\n' "$task_text"); then
              if ! grep -Eiq "$re_existing_spec_reference_runtime" < <(printf '%s\n' "$task_text"); then
                forbidden_spec_work=1
              fi
            elif [[ "$is_test_reference" -eq 0 ]] && ! grep -Eiq "$re_existing_spec_reference" < <(printf '%s\n' "$task_text") && ! grep -Eiq "$re_existing_spec_reference_runtime" < <(printf '%s\n' "$task_text"); then
              forbidden_spec_work=1
            fi
          elif grep -Eiq "$re_spec_path_add_work_before" < <(printf '%s\n' "$task_text") || grep -Eiq "$re_spec_path_add_work_after" < <(printf '%s\n' "$task_text"); then
            if [[ "$is_test_reference" -eq 0 ]] && ! grep -Eiq "$re_existing_spec_reference" < <(printf '%s\n' "$task_text") && ! grep -Eiq "$re_existing_spec_reference_runtime" < <(printf '%s\n' "$task_text"); then
              forbidden_spec_work=1
            fi
          elif grep -Eiq "$re_spec_path_runtime_read_before" < <(printf '%s\n' "$task_text") || grep -Eiq "$re_spec_path_runtime_read_after" < <(printf '%s\n' "$task_text"); then
            :
          elif [[ "$is_test_reference" -eq 0 ]] && grep -Eiq "$re_existing_spec_reference_runtime" < <(printf '%s\n' "$task_text"); then
            :
          elif [[ "$is_test_reference" -eq 0 ]] && ! grep -Eiq "$re_existing_spec_reference" < <(printf '%s\n' "$task_text"); then
            forbidden_spec_work=1
          fi
        fi
        if [[ "$forbidden_spec_work" -eq 1 ]]; then
          report_finding "$file" "$idx" "IMPLEMENT_ONLY_FORBIDDEN_TASK_IN_ORCHESTRATION" "implement-only Task Orchestration must not include spec creation/migration/sync tasks: ${normalized_task}" "$section_line" "$current_wave"
          fail_count=$((fail_count + 1))
        fi
      fi
      if [[ -n "$current_wave_tasks" ]] && printf '%s\n' "$current_wave_tasks" | grep -Fqx -- "$normalized_task"; then
        report_finding "$file" "$idx" "TASK_ORCHESTRATION_DUPLICATE_TASK_IN_WAVE" "duplicate task item in same wave: ${normalized_task}" "$section_line" "$current_wave"
        fail_count=$((fail_count + 1))
        continue
      fi
      if [[ -z "$current_wave_tasks" ]]; then
        current_wave_tasks="$normalized_task"
      else
        current_wave_tasks+=$'\n'"$normalized_task"
      fi
      task_count=$((task_count + 1))
      current_wave_task=$((current_wave_task + 1))
      if [[ "$current_wave" == "bootstrap" ]]; then
        bootstrap_task_count=$((bootstrap_task_count + 1))
      fi
      continue
    fi

    if [[ "$item" =~ $re_wave ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_INVALID_ITEM" "wave must be a top-level item and cannot be nested: $line" "$section_line" "$current_wave"
      fail_count=$((fail_count + 1))
      continue
    fi

    if [[ "$item" =~ $re_known_executor_prefix ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID" "agent profile must use [model, effort] before =>: $line" "$section_line" "$current_wave"
    else
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_INVALID_ITEM" "Nested item must use <executor> => <task> format: $line" "$section_line" "$current_wave"
    fi
    fail_count=$((fail_count + 1))
  done < <(printf '%s\n' "$orchestration")

  flush_wave

  if [[ "$line_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "TASK_ORCHESTRATION_LIST_EMPTY" "Task Orchestration must include wave/task list items."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$wave_count" -eq 0 && ! ( "$flow_type" == "initiative" && "$orchestration_plan_kind" == "bootstrap" ) ]]; then
    report_finding "$file" "$idx" "TASK_ORCHESTRATION_MISSING_WAVE_ITEM" "Task Orchestration must include at least one top-level wave item."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$flow_type" == "initiative" && "$orchestration_plan_kind" == "bootstrap" ]]; then
    if [[ "$bootstrap_count" -ne 1 ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_REQUIRED" "Bootstrap plans require exactly one leading bootstrap block."
      fail_count=$((fail_count + 1))
    elif [[ "$bootstrap_task_count" -ne 1 ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_TASK_COUNT" "Bootstrap requires exactly one main-agent item."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$task_count" -ne "$bootstrap_task_count" ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_TASKS_FORBIDDEN" "Bootstrap plans must not declare Ticket task items."
      fail_count=$((fail_count + 1))
    fi
  elif [[ "$flow_type" == "initiative" && "$orchestration_plan_kind" == "delivery" ]]; then
    if [[ "$bootstrap_count" -ne 0 ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_DELIVERY_BOOTSTRAP_FORBIDDEN" "Delivery plans must consume the approved Bootstrap and must not repeat bootstrap orchestration."
      fail_count=$((fail_count + 1))
    fi
  elif [[ "$flow_type" == "initiative" ]]; then
    if [[ "$bootstrap_count" -ne 1 ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_REQUIRED" "initiative requires exactly one leading bootstrap block."
      fail_count=$((fail_count + 1))
    elif [[ "$bootstrap_task_count" -ne 1 ]]; then
      report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_TASK_COUNT" "bootstrap requires exactly one main-agent item."
      fail_count=$((fail_count + 1))
    fi
  elif [[ "$bootstrap_count" -gt 0 && "$flow_type" != "wave-thread" ]]; then
    report_finding "$file" "$idx" "TASK_ORCHESTRATION_BOOTSTRAP_FLOW_FORBIDDEN" "bootstrap is only valid for initiative plans."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$flow_type" != "initiative" && "$flow_type" != "wave-thread" && "$task_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "TASK_ORCHESTRATION_MISSING_TASK_ITEM" "Task Orchestration must include at least one nested task item."
    fail_count=$((fail_count + 1))
  fi

  local orchestration_skill_tokens=""
  orchestration_skill_tokens="$(grep -Eo '\$[[:alnum:]_-]+' < <(printf '%s\n' "$orchestration_skill_bindings") | sort -u || true)"

  case "$flow_type" in
    initiative)
      if ! grep -Fxq '$initiative-flow' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISSING_INITIATIVE" "initiative plan must bind \$initiative-flow in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      ;;
    wave-thread)
      if ! grep -Fxq '$wave-thread-flow' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISSING_WAVE_THREAD" "wave-thread plan must bind \$wave-thread-flow in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      ;;
    parallel-pr)
      if ! grep -Fxq '$parallel-pr-flow' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISSING_PARALLEL_PR" "parallel-pr plan must bind \$parallel-pr-flow in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      ;;
    implement-only|implement_only)
      if ! grep -Fxq '$implement-only-flow' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISMATCH_IMPLEMENT_ONLY" "implement-only plan must bind \$implement-only-flow in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      local forbidden_refs=""
      local forbidden_skill
      for forbidden_skill in '$topic-spec' '$project-engineering-workflow' '$normal-flow' '$fast-flow' '$fast-pr-delivery' '$local-merge-flow'; do
        if grep -Fxq "$forbidden_skill" < <(printf '%s\n' "$orchestration_skill_tokens"); then
          if [[ -z "$forbidden_refs" ]]; then
            forbidden_refs="$forbidden_skill"
          else
            forbidden_refs="${forbidden_refs},${forbidden_skill}"
          fi
        fi
      done
      if [[ -n "$forbidden_refs" ]]; then
        report_finding "$file" "$idx" "IMPLEMENT_ONLY_FORBIDDEN_SKILL" "implement-only plan must not bind spec/delivery flow skills: ${forbidden_refs}."
        fail_count=$((fail_count + 1))
      fi
      ;;
    normal)
      if ! grep -Fxq '$normal-flow' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISSING_NORMAL" "normal plan must bind \$normal-flow in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      ;;
    fast-track|fast_track|fast-pr|fastpr)
      if ! grep -Fxq '$fast-flow' < <(printf '%s\n' "$orchestration_skill_tokens") && ! grep -Fxq '$fast-pr-delivery' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISSING_FAST_PR" "fast-track plan must bind \$fast-flow (legacy \$fast-pr-delivery is also accepted) in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      ;;
    local-merge|local_merge|localmerge|local-merge-flow)
      if ! grep -Fxq '$local-merge-flow' < <(printf '%s\n' "$orchestration_skill_tokens"); then
        report_finding "$file" "$idx" "FLOW_BINDING_MISSING_LOCAL_MERGE" "local-merge plan must bind \$local-merge-flow in Task Orchestration."
        fail_count=$((fail_count + 1))
      fi
      ;;
    *)
      if [[ -n "$flow_type" ]]; then
        report_finding "$file" "$idx" "UNKNOWN_FLOW_TYPE" "Unknown flow_type=${flow_type}."
        fail_count=$((fail_count + 1))
      fi
      ;;
  esac

  local top_level_flow_count=0 top_level_flow_skill
  for top_level_flow_skill in '$wave-thread-flow' '$fast-flow' '$fast-pr-delivery' '$normal-flow' '$local-merge-flow' '$implement-only-flow'; do
    if grep -Fxq "$top_level_flow_skill" < <(printf '%s\n' "$orchestration_skill_tokens"); then
      top_level_flow_count=$((top_level_flow_count + 1))
    fi
  done
  if [[ "$top_level_flow_count" -gt 1 ]]; then
    report_finding "$file" "$idx" "MIXED_TOP_LEVEL_FLOW_BINDING" "Task Orchestration may bind only one top-level flow skill."
    fail_count=$((fail_count + 1))
  fi

  return "$fail_count"
}

check_direct_formal_review_contract() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local flow_type="$4"
  local fail_count=0
  if [[ "$flow_type" != "normal" && "$flow_type" != "fast-track" && "$flow_type" != "local-merge" ]]; then
    return 0
  fi
  # JSONL transcripts are historical compatibility inputs. Their legacy plan
  # shape is checked by the replay-specific rules, not by current raw-plan
  # publication fields.
  if [[ "$idx" != "raw" ]]; then
    return 0
  fi

  local review_tier review_rationale runtime_strategy profile_recommendation
  local runtime_gate_valid profile_pair_valid model_token_count effort_token_count
  local field field_count
  review_tier="$(extract_flow_decision_field "$plan_text" "review_tier")"
  review_rationale="$(extract_flow_decision_field "$plan_text" "review_rationale")"
  runtime_strategy="$(extract_flow_decision_field "$plan_text" "runtime_review_strategy")"
  profile_recommendation="$(extract_flow_decision_field "$plan_text" "review_profile_recommendation")"

  for field in review_tier review_rationale runtime_review_strategy review_profile_recommendation; do
    field_count="$(count_flow_decision_field "$plan_text" "$field")"
    if [[ "$field_count" -gt 1 ]]; then
      report_finding "$file" "$idx" "FORMAL_REVIEW_FIELD_DUPLICATE" "Flow Decision must declare ${field} exactly once."
      fail_count=$((fail_count + 1))
    fi
  done

  if [[ -z "$review_tier" ]] && grep -Eiq 'tier[[:space:]_-]*[34]|正式[[:space:]]*(代码)?审查|formal[[:space:]]+review' < <(printf '%s\n' "$(extract_section "$plan_text" "Flow Decision")"); then
    report_finding "$file" "$idx" "FORMAL_REVIEW_TIER_REQUIRED" "Direct Tier 3/4 plans must define review_tier in Flow Decision."
    fail_count=$((fail_count + 1))
  fi
  if [[ -z "$review_tier" ]]; then
      report_finding "$file" "$idx" "FORMAL_REVIEW_TIER_REQUIRED" "Direct plans must define review_tier=Tier 1|Tier 2|Tier 3|Tier 4 in Flow Decision."
      fail_count=$((fail_count + 1))
  elif [[ ! "$review_tier" =~ ^[Tt]ier[[:space:]_-]*[1-4]$ ]]; then
      report_finding "$file" "$idx" "FORMAL_REVIEW_TIER_INVALID" "Direct plans must use review_tier=Tier 1|Tier 2|Tier 3|Tier 4."
      fail_count=$((fail_count + 1))
  fi
  if [[ -z "$review_rationale" ]]; then
      report_finding "$file" "$idx" "FORMAL_REVIEW_RATIONALE_REQUIRED" "Direct plans must define review_rationale in Flow Decision."
      fail_count=$((fail_count + 1))
  fi
  if [[ -z "$runtime_strategy" ]]; then
      report_finding "$file" "$idx" "FORMAL_REVIEW_RUNTIME_STRATEGY_REQUIRED" "Direct plans must define runtime_review_strategy in Flow Decision."
      fail_count=$((fail_count + 1))
  elif [[ "$review_tier" =~ ^[Tt]ier[[:space:]_-]*[12]$ ]]; then
      if ! grep -Eiq '(no[[:space:]_-]+formal|不启动[[:space:]]*(formal|正式)|advisory|仅.*建议)' <<<"$runtime_strategy"; then
        report_finding "$file" "$idx" "FORMAL_REVIEW_RUNTIME_STRATEGY_INVALID" "Tier 1/2 plans must state that no formal lane launches or that review is advisory only."
        fail_count=$((fail_count + 1))
      fi
  else
      runtime_gate_valid=0
      if grep -Eiq '(launch|start|create|dispatch|instantiate|创建|启动|发起)[^[:cntrl:]]{0,80}(after|once|when)[[:space:]]+(readiness|ready|就绪|准备)' <<<"$runtime_strategy" || \
        grep -Eiq '(readiness|ready|就绪|准备)[^[:cntrl:]]{0,80}(通过后|完成后|就绪后|之后|以后|后)[^[:cntrl:]]{0,80}(launch|start|create|dispatch|instantiate|创建|启动|发起)' <<<"$runtime_strategy" || \
        grep -Eiq '(readiness[[:space:]_-]*gated|readiness[[:space:]_-]*gate|就绪门禁|准备门禁)[^[:cntrl:]]{0,80}(launch|start|create|dispatch|instantiate|创建|启动|发起)' <<<"$runtime_strategy"; then
        runtime_gate_valid=1
      fi
      if grep -Eiq '(before[[:space:]]+(readiness|ready)|unconditionally|without[[:space:]]+(readiness|ready)|not[[:space:]]+required|incomplete|not[[:space:]]+complete|forbidden|禁止|不得|无需|不需要|未(完成|通过|就绪))' <<<"$runtime_strategy"; then
        runtime_gate_valid=0
      fi
      if [[ "$runtime_gate_valid" -eq 0 ]]; then
        report_finding "$file" "$idx" "FORMAL_REVIEW_RUNTIME_STRATEGY_INVALID" "Tier 3/4 plans must require readiness-gated runtime creation or launch of formal lanes."
        fail_count=$((fail_count + 1))
      fi
  fi
  if [[ -z "$profile_recommendation" ]]; then
      report_finding "$file" "$idx" "FORMAL_REVIEW_PROFILE_RECOMMENDATION_REQUIRED" "Direct plans must define review_profile_recommendation in Flow Decision."
      fail_count=$((fail_count + 1))
  elif [[ "$review_tier" =~ ^[Tt]ier[[:space:]_-]*[12]$ ]]; then
      if ! grep -Eiq '(no[[:space:]_-]+formal|不需要[[:space:]]*(formal|正式)|不启动[[:space:]]*(formal|正式)|advisory|可选)' <<<"$profile_recommendation"; then
        report_finding "$file" "$idx" "FORMAL_REVIEW_PROFILE_RECOMMENDATION_INVALID" "Tier 1/2 plans must state that no formal lane profile is required or that review is advisory/optional."
        fail_count=$((fail_count + 1))
      fi
  else
      profile_pair_valid=0
      model_token_count="$(grep -Eio 'gpt-(5\.6-(luna|terra|sol)|6-(luna|sol|astra))' <<<"$profile_recommendation" | wc -l | tr -d ' ')"
      effort_token_count="$(grep -Eio '(^|[^[:alnum:]_])(low|medium|high|xhigh|max|ultra)([^[:alnum:]_]|$)' <<<"$profile_recommendation" | wc -l | tr -d ' ')"
      if grep -Eiq 'gpt-(5\.6|6)-((luna)[[:space:]]*(\+[[:space:]]*|with[[:space:]]+|and[[:space:]]+|at[[:space:]]+|[[:space:]]+)(low|medium|high|xhigh|max)([^[:alnum:]_]|$)|(terra|sol|astra)[[:space:]]*(\+[[:space:]]*|with[[:space:]]+|and[[:space:]]+|at[[:space:]]+|[[:space:]]+)(low|medium|high|xhigh|max|ultra)([^[:alnum:]_]|$))' <<<"$profile_recommendation"; then
        profile_pair_valid=1
      fi
      if [[ "$profile_pair_valid" -eq 0 || "$model_token_count" -ne 1 || "$effort_token_count" -ne 1 ]] || grep -Eiq '(reviewer([[:space:]_-]*(id|identity))?[[:space:]]*[:=][[:space:]]*[[:alnum:]_.:-]+|(named|called|assigned[[:space:]]+to|handled[[:space:]]+by|由)[[:space:]]*[A-Za-z][A-Za-z0-9_.:-]*[[:space:]]+(reviewer|审查)|[A-Za-z][A-Za-z0-9_.:-]*[[:space:]]+reviewer[[:space:]]*([;,]|$)|reviewer[[:space:]]+[A-Za-z][A-Za-z0-9_.:-]*([^[:alnum:]_]|$)|[A-Za-z][A-Za-z0-9_.:-]*[[:space:]]+reviewer[[:space:]]+(uses|handles|执行|使用))' <<<"$profile_recommendation"; then
        report_finding "$file" "$idx" "FORMAL_REVIEW_PROFILE_RECOMMENDATION_INVALID" "Tier 3/4 plans must recommend a supported model/effort pair without fixing reviewer identity."
        fail_count=$((fail_count + 1))
      fi
  fi
  return "$fail_count"
}

check_direct_empirical_acceptance_contract() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local flow_type="$4"

  if [[ "$flow_type" != "normal" && "$flow_type" != "fast-track" && "$flow_type" != "local-merge" ]]; then
    return 0
  fi
  # Historical JSONL sessions remain readable compatibility inputs. New
  # finalized Markdown plans use idx=raw and must carry the current contract.
  if [[ "$idx" != "raw" ]]; then
    return 0
  fi

  local disposition rationale disposition_count rationale_count acceptance lower
  disposition="$(extract_flow_decision_field "$plan_text" "empirical_acceptance")"
  rationale="$(extract_flow_decision_field "$plan_text" "empirical_acceptance_rationale")"
  disposition_count="$(count_flow_decision_field "$plan_text" "empirical_acceptance")"
  rationale_count="$(count_flow_decision_field "$plan_text" "empirical_acceptance_rationale")"
  local fail_count=0

  if [[ "$disposition_count" -ne 1 ]]; then
    report_finding "$file" "$idx" "EMPIRICAL_ACCEPTANCE_DISPOSITION_REQUIRED" "Direct plans must declare empirical_acceptance=required|not_required exactly once in Flow Decision."
    fail_count=$((fail_count + 1))
  elif [[ "$disposition" != "required" && "$disposition" != "not_required" ]]; then
    report_finding "$file" "$idx" "EMPIRICAL_ACCEPTANCE_DISPOSITION_INVALID" "empirical_acceptance must be required or not_required."
    fail_count=$((fail_count + 1))
  fi

  if [[ "$rationale_count" -ne 1 || -z "$rationale" ]]; then
    report_finding "$file" "$idx" "EMPIRICAL_ACCEPTANCE_RATIONALE_REQUIRED" "Direct plans must declare one non-empty empirical_acceptance_rationale."
    fail_count=$((fail_count + 1))
  fi

  if [[ "$disposition" == "required" ]]; then
    acceptance="$(extract_section "$plan_text" "Acceptance & Validation")"
    local empirical_error
    set +e
    empirical_error="$(printf '%s\n' "$plan_text" | python3 "$(dirname "$0")/plan_acceptance_manifest.py" --require-empirical 2>&1 >/dev/null)"
    local empirical_rc=$?
    set -e
    if [[ "$empirical_rc" -ne 0 ]]; then
      report_finding "$file" "$idx" "EMPIRICAL_ACCEPTANCE_ASSERTIONS_INVALID" "$empirical_error"
      fail_count=$((fail_count + 1))
    fi
  fi

  return "$fail_count"
}

check_parallel_pr_contract() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0
  local flow_decision contracts budget cohort
  flow_decision="$(extract_section "$plan_text" "Flow Decision")"
  contracts="$(extract_section "$plan_text" "Parallel PR Contracts")"
  budget="$(extract_flow_decision_field "$plan_text" "parallel_task_budget")"
  cohort="$(extract_flow_decision_field "$plan_text" "parallel_cohort")"

  if [[ ! "$cohort" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_COHORT_INVALID" "parallel-pr requires a lowercase-kebab parallel_cohort."
    fail_count=$((fail_count + 1))
  fi
  if [[ ! "$budget" =~ ^[2-8]$ ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_TASK_BUDGET_INVALID" "parallel-pr requires parallel_task_budget between 2 and 8."
    fail_count=$((fail_count + 1))
  fi
  if [[ -z "$contracts" ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_CONTRACTS_MISSING" "parallel-pr requires a Parallel PR Contracts section."
    return $((fail_count + 1))
  fi

  local orchestration task_names task_names_raw contract_names
  orchestration="$(extract_section "$plan_text" "Task Orchestration")"
  task_names_raw="$(printf '%s\n' "$orchestration" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:(pr-[a-z0-9]+)([[:space:]]+\[[^]]+\])?[[:space:]]*=>.*$/\1/p')"
  task_names="$(printf '%s\n' "$task_names_raw" | sed '/^$/d' | sort -u)"
  local task_count contract_count
  task_count="$(printf '%s\n' "$task_names" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  contract_names="$(printf '%s\n' "$contracts" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:(pr-[a-z0-9]+)[[:space:]]*=>.*$/\1/p')"
  contract_count="$(printf '%s\n' "$contract_names" | sed '/^$/d' | sort -u | wc -l | tr -d '[:space:]')"
  if [[ "$task_count" -lt 2 || "$task_count" -gt 8 ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_TASK_COUNT_INVALID" "parallel-pr requires exactly 2..8 task:pr-<slug> executors."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$budget" =~ ^[0-9]+$ && "$budget" -ne "$task_count" ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_BUDGET_TOPOLOGY_MISMATCH" "parallel_task_budget must equal the task:pr-<slug> topology count."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$contract_count" -ne "$task_count" ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_CONTRACT_TOPOLOGY_MISMATCH" "Parallel PR Contracts must map one-to-one to task:pr-<slug> executors."
    fail_count=$((fail_count + 1))
  fi
  local duplicate_names
  duplicate_names="$(printf '%s\n' "$task_names_raw" | sed '/^$/d' | sort | uniq -d)"
  if [[ -n "$duplicate_names" ]]; then
    report_finding "$file" "$idx" "PARALLEL_PR_TASK_DUPLICATE" "parallel-pr task identities must be unique."
    fail_count=$((fail_count + 1))
  fi

  local line task owned consumed depends merge_mode
  local contract_seen="" surface_owner=""
  local re_contract='^[[:space:]]*-[[:space:]]+task:(pr-[a-z0-9]+)[[:space:]]*=>[[:space:]]*owned_surfaces=([^;]+);[[:space:]]*consumed_contracts=([^;]+);[[:space:]]*depends_on=([^;]+);[[:space:]]*merge_mode=(ready-only|merge-on-green)[[:space:]]*$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if [[ ! "$line" =~ $re_contract ]]; then
      report_finding "$file" "$idx" "PARALLEL_PR_CONTRACT_INVALID" "Each Parallel PR Contracts item must declare owned_surfaces, consumed_contracts, depends_on, and merge_mode."
      fail_count=$((fail_count + 1))
      continue
    fi
    task="${BASH_REMATCH[1]}"; owned="$(trim_inline_value "${BASH_REMATCH[2]}")"; consumed="$(trim_inline_value "${BASH_REMATCH[3]}")"; depends="$(trim_inline_value "${BASH_REMATCH[4]}")"; merge_mode="${BASH_REMATCH[5]}"
    if printf '%s\n' "$contract_seen" | grep -Fqx -- "$task"; then
      report_finding "$file" "$idx" "PARALLEL_PR_CONTRACT_DUPLICATE" "Parallel PR Contracts must not repeat a task identity."
      fail_count=$((fail_count + 1))
    fi
    contract_seen+="$task"$'\n'
    if ! printf '%s\n' "$task_names" | grep -Fqx -- "$task"; then
      report_finding "$file" "$idx" "PARALLEL_PR_CONTRACT_UNKNOWN_TASK" "Parallel PR Contracts may only name frozen task:pr-<slug> identities."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$depends" != "none" ]]; then
      report_finding "$file" "$idx" "PARALLEL_PR_DEPENDENCY_FORBIDDEN" "parallel-pr tasks must declare depends_on=none."
      fail_count=$((fail_count + 1))
    fi
    if [[ -z "$owned" || "$owned" == "none" ]]; then
      report_finding "$file" "$idx" "PARALLEL_PR_OWNERSHIP_REQUIRED" "parallel-pr tasks must declare non-empty owned_surfaces."
      fail_count=$((fail_count + 1))
    fi
    [[ -n "$consumed" ]] || { report_finding "$file" "$idx" "PARALLEL_PR_CONSUMED_CONTRACTS_REQUIRED" "consumed_contracts must be named or none."; fail_count=$((fail_count + 1)); }
    local surface
    IFS=',' read -r -a surfaces <<<"$owned"
    for surface in "${surfaces[@]}"; do
      surface="$(trim_inline_value "$surface")"
      if [[ ! "$surface" =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.@*?{}-]+)*$ ]]; then
        report_finding "$file" "$idx" "PARALLEL_PR_OWNED_SURFACE_INVALID" "owned_surfaces must use repository-relative path/glob entries."
        fail_count=$((fail_count + 1))
      fi
      if [[ -n "$surface" && -n "$(printf '%s\n' "$surface_owner" | awk -F '\t' -v s="$surface" '$1 == s { print $2; exit }')" && "$(printf '%s\n' "$surface_owner" | awk -F '\t' -v s="$surface" '$1 == s { print $2; exit }')" != "$task" ]]; then
        report_finding "$file" "$idx" "PARALLEL_PR_OWNERSHIP_OVERLAP" "owned_surfaces must be disjoint across parallel tasks."
        fail_count=$((fail_count + 1))
      fi
      local prior_surface prior_task owner_record
      while IFS=$'\t' read -r prior_surface prior_task; do
        [[ -z "$prior_surface" ]] && continue
        if [[ -n "$surface" && "$prior_task" != "$task" && ( "$surface" == "$prior_surface" || "$surface" == "$prior_surface"/* || "$prior_surface" == "$surface"/* ) ]]; then
          report_finding "$file" "$idx" "PARALLEL_PR_OWNERSHIP_OVERLAP" "owned_surfaces must be disjoint across parallel tasks."
          fail_count=$((fail_count + 1))
        fi
      done <<EOF
$surface_owner
EOF
      [[ -n "$surface" ]] && surface_owner+="$surface"$'\t'"$task"$'\n'
    done
  done < <(printf '%s\n' "$contracts")

  local contract_task
  while IFS= read -r contract_task; do
    [[ -z "$contract_task" ]] && continue
    if ! printf '%s\n' "$contract_seen" | grep -Fqx -- "$contract_task"; then
      report_finding "$file" "$idx" "PARALLEL_PR_CONTRACT_MISSING" "Every task:pr-<slug> requires exactly one Parallel PR Contracts item."
      fail_count=$((fail_count + 1))
    fi
  done < <(printf '%s\n' "$task_names")
  return "$fail_count"
}

check_wave_thread_contract() {
  local file="$1" idx="$2" plan_text="$3" fail_count=0
  local contracts
  contracts="$(extract_section "$plan_text" "Wave Thread Contracts")"
  if [[ -z "$contracts" ]]; then
    report_finding "$file" "$idx" "WAVE_THREAD_CONTRACTS_MISSING" "wave-thread plans require ## Wave Thread Contracts."
    fail_count=$((fail_count + 1))
  fi
  if ! grep -Eiq 'parent_branch|父分支' < <(printf '%s\n' "$contracts"); then
    report_finding "$file" "$idx" "WAVE_THREAD_PARENT_BRANCH_REQUIRED" "Wave Thread Contracts must declare parent_branch."
    fail_count=$((fail_count + 1))
  fi
  if ! grep -Eiq 'child_pr|子.?PR' < <(printf '%s\n' "$contracts"); then
    report_finding "$file" "$idx" "WAVE_THREAD_CHILD_PR_REQUIRED" "Wave Thread Contracts must declare child_pr."
    fail_count=$((fail_count + 1))
  fi
  if ! grep -Eiq 'sibling|兄弟|同一.*wave' < <(printf '%s\n' "$contracts"); then
    report_finding "$file" "$idx" "WAVE_THREAD_SIBLING_TOPOLOGY_REQUIRED" "Wave Thread Contracts must state sibling PR topology."
    fail_count=$((fail_count + 1))
  fi
  if ! grep -Eiq 'event|事件' < <(printf '%s\n' "$contracts"); then
    report_finding "$file" "$idx" "WAVE_THREAD_EVENT_PROTOCOL_REQUIRED" "Wave Thread Contracts must state active task events."
    fail_count=$((fail_count + 1))
  fi
  if ! grep -Eiq 'branch-preview|trunk-only|非生产|主干' < <(printf '%s\n' "$contracts"); then
    report_finding "$file" "$idx" "WAVE_THREAD_RELEASE_POLICY_REQUIRED" "Wave Thread Contracts must declare release policy."
    fail_count=$((fail_count + 1))
  fi
  if grep -Eiq 'stacked|stacked-pr|aggregate[[:space:]_-]*pr|tracking[[:space:]_-]*issue|独立.*ledger|独立.*账本' < <(printf '%s\n' "$contracts"); then
    report_finding "$file" "$idx" "WAVE_THREAD_RETIRED_TOPOLOGY_FORBIDDEN" "Wave Thread Contracts must not introduce stacked PR, aggregate PR, Tracking Issue, or runtime ledger."
    fail_count=$((fail_count + 1))
  fi
  return "$fail_count"
}

check_required_section_order() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0
  local previous_line=0
  local previous_header=""
  local header line_no
  local -a required_headers=("Summary" "Flow Decision" "Goals")
  if grep -Fq "## Constraints" < <(printf '%s\n' "$plan_text"); then
    required_headers+=("Constraints")
  fi
  required_headers+=("Non-goals" "Task Orchestration")
  if grep -Fq "## Wave Thread Contracts" < <(printf '%s\n' "$plan_text"); then
    required_headers+=("Wave Thread Contracts")
  elif grep -Fq "## Parallel PR Contracts" < <(printf '%s\n' "$plan_text"); then
    required_headers+=("Parallel PR Contracts")
  fi
  required_headers+=("Acceptance & Validation" "Assumptions/Defaults")

  for header in "${required_headers[@]}"; do
    line_no="$(extract_section_line_number "$plan_text" "$header")"
    [[ -z "$line_no" ]] && continue
    if [[ "$previous_line" -gt 0 && "$line_no" -le "$previous_line" ]]; then
      report_finding "$file" "$idx" "SECTION_ORDER_INVALID" "Required sections must appear in goals-first order: Summary -> Flow Decision -> Goals -> Constraints (when present) -> Non-goals -> Task Orchestration -> Parallel PR Contracts (parallel-pr) -> Acceptance & Validation -> Assumptions/Defaults. Found ## ${header} after ## ${previous_header}." "$line_no"
      fail_count=$((fail_count + 1))
      break
    fi
    previous_line="$line_no"
    previous_header="$header"
  done

  return "$fail_count"
}

check_summary() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0

  local summary
  summary="$(extract_section "$plan_text" "Summary")"
  local valid_bullet_count=0
  local line content
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^- ]] || continue
    content="$(printf '%s\n' "$line" | sed -E 's/^-[[:space:]]*//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [[ -n "$content" ]]; then
      valid_bullet_count=$((valid_bullet_count + 1))
    fi
  done < <(printf '%s\n' "$summary")
  if [[ "$valid_bullet_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "SUMMARY_EMPTY" "Summary must contain at least one bullet item."
    fail_count=$((fail_count + 1))
  fi

  return "$fail_count"
}

check_goals() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0

  local goals
  goals="$(extract_section "$plan_text" "Goals")"
  local current_goal=""
  local current_goal_line=""
  local current_has_detail=0
  local section_line=0
  local valid_goal_count=0
  local re_goal_detail_placeholder='^[[:space:]]*(-[[:space:]]*)?((tbd|tba|tbc|todo|pending|later)([[:space:][:punct:]].*)?|to be determined([[:space:][:punct:]].*)?|to be confirmed([[:space:][:punct:]].*)?|to be decided([[:space:][:punct:]].*)?|to be defined([[:space:][:punct:]].*)?|待补([[:space:][:punct:]].*)?|待定([[:space:][:punct:]].*)?|待确认([[:space:][:punct:]].*)?|待明确([[:space:][:punct:]].*)?|待定义([[:space:][:punct:]].*)?|占位([[:space:][:punct:]].*)?)$'

  flush_goal_detail() {
    if [[ -n "$current_goal" && "$current_has_detail" -eq 0 ]]; then
      report_finding "$file" "$idx" "GOAL_DETAIL_MISSING" "Goal item must include follow-up detail text: ${current_goal}" "$current_goal_line"
      fail_count=$((fail_count + 1))
    fi
  }

  while IFS= read -r line || [[ -n "$line" ]]; do
    section_line=$((section_line + 1))
    [[ -z "${line//[[:space:]]/}" ]] && continue

    if [[ "$line" =~ ^- ]]; then
      flush_goal_detail
      current_goal="$(printf '%s\n' "$line" | sed -E 's/^-[[:space:]]*//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
      current_goal_line="$section_line"
      current_has_detail=0
      if [[ -z "$current_goal" ]]; then
        report_finding "$file" "$idx" "GOAL_TITLE_EMPTY" "Goal bullet must include a non-empty title." "$current_goal_line"
        fail_count=$((fail_count + 1))
        continue
      fi
      valid_goal_count=$((valid_goal_count + 1))
      continue
    fi

    if [[ -n "$current_goal" ]]; then
      local detail_text
      detail_text="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^-[[:space:]]*//')"
      if [[ -n "$detail_text" ]] && ! grep -Eiq "$re_goal_detail_placeholder" < <(printf '%s\n' "$detail_text"); then
        current_has_detail=1
      fi
    fi
  done < <(printf '%s\n' "$goals")

  flush_goal_detail
  if [[ "$valid_goal_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "GOALS_EMPTY" "Goals must contain at least one top-level bullet item."
    fail_count=$((fail_count + 1))
  fi
  return "$fail_count"
}

check_non_goals() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0

  local non_goals
  non_goals="$(extract_section "$plan_text" "Non-goals")"
  local re_non_goal_placeholder='^((tbd|tba|tbc|todo|pending|later|none|n/?a|na)([[:space:][:punct:]].*)?|not[[:space:]]+applicable([[:space:][:punct:]].*)?|no[[:space:]]+(explicit[[:space:]]+)?exclusions?([[:space:][:punct:]].*)?|to be determined([[:space:][:punct:]].*)?|to be confirmed([[:space:][:punct:]].*)?|to be decided([[:space:][:punct:]].*)?|to be defined([[:space:][:punct:]].*)?|待补([[:space:][:punct:]].*)?|待定([[:space:][:punct:]].*)?|待确认([[:space:][:punct:]].*)?|待明确([[:space:][:punct:]].*)?|待定义([[:space:][:punct:]].*)?|占位([[:space:][:punct:]].*)?|无[[:space:]]*(非目标|排除项|范围外事项)?([[:space:][:punct:]].*)?)$'
  local line content section_line=0
  local valid_non_goal_count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    section_line=$((section_line + 1))
    [[ "$line" =~ ^- ]] || continue
    content="$(printf '%s\n' "$line" | sed -E 's/^-[[:space:]]*//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [[ -z "$content" ]]; then
      report_finding "$file" "$idx" "NON_GOAL_EMPTY" "Non-goals bullet must name a concrete exclusion." "$section_line"
      fail_count=$((fail_count + 1))
      continue
    fi
    if [[ -n "$content" ]] && grep -Eiq "$re_non_goal_placeholder" < <(printf '%s\n' "$content"); then
      report_finding "$file" "$idx" "NON_GOAL_PLACEHOLDER" "Non-goals bullet must name a concrete exclusion: ${content}" "$section_line"
      fail_count=$((fail_count + 1))
      continue
    fi
    valid_non_goal_count=$((valid_non_goal_count + 1))
  done < <(printf '%s\n' "$non_goals")

  if [[ "$valid_non_goal_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "NON_GOALS_EMPTY" "Non-goals must contain at least one top-level bullet item."
    fail_count=$((fail_count + 1))
  fi

  return "$fail_count"
}

check_constraints() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0
  local constraints acceptance
  constraints="$(extract_section "$plan_text" "Constraints")"
  acceptance="$(extract_section "$plan_text" "Acceptance & Validation")"
  local line content constraint_id applies_to section_line=0 valid_count=0
  local seen_constraints="|"
  local re_constraint='^C([1-9][0-9]*):[[:space:]]+.+[[:space:]]+\|[[:space:]]*applies_to=`?([A][1-9][0-9]*(,[A][1-9][0-9]*)*)`?$'
  local -a constraint_acceptance_ids=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    section_line=$((section_line + 1))
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if [[ ! "$line" =~ ^- ]]; then
      report_finding "$file" "$idx" "PLAN_CONSTRAINT_INVALID" "Constraints accepts C* list items only." "$section_line"
      fail_count=$((fail_count + 1))
      continue
    fi
    content="$(printf '%s\n' "$line" | sed -E 's/^-[[:space:]]*//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [[ ! "$content" =~ $re_constraint ]]; then
      report_finding "$file" "$idx" "PLAN_CONSTRAINT_INVALID" "Constraint must use C*: <condition> | applies_to=A*[,...]." "$section_line"
      fail_count=$((fail_count + 1))
      continue
    fi
    constraint_id="C${BASH_REMATCH[1]}"
    applies_to="${BASH_REMATCH[2]}"
    if [[ "$seen_constraints" == *"|${constraint_id}|"* ]]; then
      report_finding "$file" "$idx" "PLAN_CONSTRAINT_DUPLICATE" "Constraint ${constraint_id} is declared more than once." "$section_line"
      fail_count=$((fail_count + 1))
    fi
    seen_constraints+="${constraint_id}|"
    local acceptance_id
    IFS=',' read -r -a constraint_acceptance_ids <<<"$applies_to"
    for acceptance_id in "${constraint_acceptance_ids[@]}"; do
      if ! grep -Eq "^-[[:space:]]*${acceptance_id}[[:space:]]+\\[" < <(printf '%s\n' "$acceptance"); then
        report_finding "$file" "$idx" "PLAN_CONSTRAINT_ACCEPTANCE_UNKNOWN" "Constraint ${constraint_id} applies to unknown acceptance ${acceptance_id}." "$section_line"
        fail_count=$((fail_count + 1))
      fi
    done
    valid_count=$((valid_count + 1))
  done < <(printf '%s\n' "$constraints")

  if [[ "$valid_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "PLAN_CONSTRAINTS_EMPTY" "Constraints must contain at least one concrete C* item."
    fail_count=$((fail_count + 1))
  fi
  return "$fail_count"
}

check_provenance_leaks() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0

  local re_provenance_heading='^[[:space:]]*#{1,6}[[:space:]]+.*(scope[[:space:]_-]*basis|authori[sz]ation([[:space:]_-]*(source|sources|basis))?|provenance|conversation([[:space:]_-]*(source|sources|basis))?|sources?|来源|依据|授权([[:space:]_-]*(来源|依据))?|主人原话)'
  local re_provenance_item='^[[:space:]]*-[[:space:]]*`?[GNAC][1-9][0-9]*`?([[:space:]]+is)?[[:space:]]+(authorized|authorised|authorization|authorisation|derived|derives|based[[:space:]]+on|sourced|来自|源于|依据|授权)'
  local re_owner_quote='(owner|主人)[^[:cntrl:]]*(message|request|quote|quoted|said|原话|要求|指令)'
  local non_orchestration_text
  non_orchestration_text="$(printf '%s\n' "$plan_text" | awk '
    /^## Task Orchestration$/ { in_orchestration=1; next }
    /^## / { in_orchestration=0 }
    !in_orchestration { print }
  ')"

  if grep -Eiq "$re_provenance_heading" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "PLAN_PROVENANCE_SECTION_FORBIDDEN" "Final plans must not include a Scope Basis or conversation-source section."
    fail_count=$((fail_count + 1))
  fi
  if grep -Eiq '^[[:space:]]*-[[:space:]]*`?[GNAC][1-9][0-9]*`?[[:space:]]*=>[[:space:]]*`?(owner|contract|adr|derives|flow)[[:space:]]*[:：]' < <(printf '%s\n' "$plan_text") \
    || grep -Eiq "$re_provenance_item" < <(printf '%s\n' "$plan_text") \
    || grep -Eiq "$re_owner_quote" < <(printf '%s\n' "$non_orchestration_text") \
    || grep -Eiq '(^|[[:space:]-])(owner|主人)[[:space:]]*[:：][[:space:]]*["“”`]' < <(printf '%s\n' "$non_orchestration_text"); then
    report_finding "$file" "$idx" "PLAN_PROVENANCE_MAPPING_FORBIDDEN" "Final plans must not quote owner messages or expose authorization mappings."
    fail_count=$((fail_count + 1))
  fi
  return "$fail_count"
}

check_acceptance() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0

  local acceptance
  acceptance="$(extract_section "$plan_text" "Acceptance & Validation")"
  if ! grep -Eq '[^[:space:]]' < <(printf '%s\n' "$acceptance"); then
    report_finding "$file" "$idx" "ACCEPTANCE_EMPTY" "Acceptance & Validation must contain at least one non-empty line."
    fail_count=$((fail_count + 1))
    return "$fail_count"
  fi

  local re_acceptance_placeholder='^[[:space:]]*(-[[:space:]]*)?((tbd|tba|tbc|todo)([[:space:][:punct:]].*)?|to be validated([[:space:][:punct:]].*)?|to be determined([[:space:][:punct:]].*)?|to be confirmed([[:space:][:punct:]].*)?|validation later([[:space:][:punct:]].*)?|acceptance later([[:space:][:punct:]].*)?|fill later([[:space:][:punct:]].*)?|pending([[:space:]]+(validation|review|verification|confirmation|details?|acceptance|tests?))?([[:space:][:punct:]]*)|later([[:space:]]+(validation|review|verification|confirmation|details?|acceptance|tests?))?([[:space:][:punct:]]*)|待补([[:space:][:punct:]].*)?|待定([[:space:][:punct:]].*)?|待确认([[:space:][:punct:]].*)?|待验证([[:space:][:punct:]].*)?|后续验证([[:space:][:punct:]].*)?|稍后验证([[:space:][:punct:]].*)?|占位([[:space:][:punct:]].*)?)$'
  local re_acceptance_label_only='^(notes?|note|follow[[:space:]_-]*up([[:space:]_-]*(items?|notes?))?|remarks?|commentary|summary|details?|items?|备注|说明|后续事项|跟进事项|补充说明)[[:space:][:punct:]]*$'
  local nonempty_count=0
  local meaningful_count=0
  local line trimmed content
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [[ -z "$trimmed" ]] && continue
    content="$(printf '%s\n' "$trimmed" | sed -E 's/^-[[:space:]]*//')"
    [[ -z "$content" ]] && continue
    nonempty_count=$((nonempty_count + 1))
    if ! grep -Eiq "$re_acceptance_placeholder" < <(printf '%s\n' "$content") && ! grep -Eiq "$re_acceptance_label_only" < <(printf '%s\n' "$content"); then
      meaningful_count=$((meaningful_count + 1))
    fi
  done < <(printf '%s\n' "$acceptance")

  if [[ "$nonempty_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "ACCEPTANCE_EMPTY" "Acceptance & Validation must contain at least one non-empty line."
    fail_count=$((fail_count + 1))
    return "$fail_count"
  fi
  if [[ "$nonempty_count" -gt 0 && "$meaningful_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "ACCEPTANCE_PLACEHOLDER" "Acceptance & Validation must include at least one concrete validation line, not only placeholders."
    fail_count=$((fail_count + 1))
  fi
  local acceptance_flow_type
  acceptance_flow_type="$(normalize_flow_type "$(extract_flow_decision_field "$plan_text" "flow_type")")"
  if [[ "$idx" == "raw" && "$acceptance_flow_type" != "initiative" && "$acceptance_flow_type" != "parallel-pr" && "$acceptance_flow_type" != "wave-thread" ]]; then
    local manifest_error
    set +e
    manifest_error="$(printf '%s\n' "$plan_text" | python3 "$(dirname "$0")/plan_acceptance_manifest.py" 2>&1 >/dev/null)"
    local manifest_rc=$?
    set -e
    if [[ "$manifest_rc" -ne 0 ]]; then
      report_finding "$file" "$idx" "ACCEPTANCE_MAPPING_INVALID" "$manifest_error"
      fail_count=$((fail_count + 1))
    fi
  fi

  return "$fail_count"
}

check_initiative_acceptance_mappings() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0
  local plan_kind
  plan_kind="$(extract_flow_decision_field "$plan_text" "plan_kind")"
  if [[ "$plan_kind" == "bootstrap" ]]; then
    return 0
  fi
  local orchestration acceptance
  orchestration="$(extract_section "$plan_text" "Task Orchestration")"
  acceptance="$(extract_section "$plan_text" "Acceptance & Validation")"
  local task_names=""
  task_names="$(printf '%s\n' "$orchestration" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:([[:alnum:]_-]+)([[:space:]]+\[[^]]+\])?[[:space:]]*=>.*$/\1/p' | sort -u)"
  local task_names_raw=""
  task_names_raw="$(printf '%s\n' "$orchestration" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:([[:alnum:]_-]+)([[:space:]]+\[[^]]+\])?[[:space:]]*=>.*$/\1/p')"
  local duplicate_task_names=""
  duplicate_task_names="$(printf '%s\n' "$task_names_raw" | sed '/^$/d' | sort | uniq -d)"
  if [[ -n "$duplicate_task_names" ]]; then
    report_finding "$file" "$idx" "INITIATIVE_TASK_EXECUTOR_DUPLICATE" "Initiative task:<name> executors must be globally unique."
    fail_count=$((fail_count + 1))
  fi
  local task_count=0
  task_count="$(printf '%s\n' "$task_names" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  if [[ "$task_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "INITIATIVE_TASK_EXECUTOR_REQUIRED" "Initiative orchestration requires independent task:<name> executors."
    fail_count=$((fail_count + 1))
  elif [[ "$task_count" -lt 2 ]]; then
    report_finding "$file" "$idx" "INITIATIVE_TASK_EXECUTOR_COUNT" "Initiative orchestration requires at least two distinct task:<name> executors."
    fail_count=$((fail_count + 1))
  fi

  local mapping_names=""
  mapping_names="$(printf '%s\n' "$acceptance" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:([[:alnum:]_-]+)[[:space:]]*=>.*$/\1/p')"
  local re_mapping_line='^[[:space:]]*-[[:space:]]+task:([[:alnum:]_-]+)[[:space:]]*=>[[:space:]]*(.*)$'
  local re_mapping_payload_v5='^acceptance_scope=(technical-only|ticket|aggregate);[[:space:]]*evidence=([^;]+);[[:space:]]*owner_gate=(none|ticket-acceptance|aggregate-acceptance);[[:space:]]*completion_gate=(integration|published|observed)(;[[:space:]]*observation_plan=([^|;]+)\|([1-9][0-9]*)\|([^;]+))?$'
  local task_name count line payload acceptance_scope evidence owner_gate completion_gate observation_source observation_window observation_assertions
  while IFS= read -r task_name; do
    [[ -z "$task_name" ]] && continue
    count="$(printf '%s\n' "$mapping_names" | grep -Fxc "$task_name" || true)"
    if [[ "$count" -eq 0 ]]; then
      report_finding "$file" "$idx" "INITIATIVE_ACCEPTANCE_MAPPING_MISSING" "Initiative task:${task_name} requires exactly one acceptance mapping."
      fail_count=$((fail_count + 1))
    elif [[ "$count" -gt 1 ]]; then
      report_finding "$file" "$idx" "INITIATIVE_ACCEPTANCE_MAPPING_DUPLICATE" "Initiative task:${task_name} has duplicate acceptance mappings."
      fail_count=$((fail_count + 1))
    fi
  done < <(printf '%s\n' "$task_names")

  while IFS= read -r line; do
    [[ "$line" =~ $re_mapping_line ]] || continue
    task_name="${BASH_REMATCH[1]}"
    payload="${BASH_REMATCH[2]}"
    if ! grep -Fxq "$task_name" < <(printf '%s\n' "$task_names"); then
      report_finding "$file" "$idx" "INITIATIVE_ACCEPTANCE_MAPPING_UNKNOWN_TASK" "Acceptance mapping references unknown task:${task_name}."
      fail_count=$((fail_count + 1))
      continue
    fi
    completion_gate=""
    observation_source=""
    observation_window=""
    observation_assertions=""
    if [[ ! "$payload" =~ $re_mapping_payload_v5 ]]; then
      report_finding "$file" "$idx" "INITIATIVE_V5_ACCEPTANCE_MAPPING_INVALID" "V5 Acceptance mapping must add completion_gate and conditionally observation_plan after owner_gate."
      fail_count=$((fail_count + 1))
      continue
    fi
    acceptance_scope="${BASH_REMATCH[1]}"
    evidence="${BASH_REMATCH[2]}"
    owner_gate="${BASH_REMATCH[3]}"
    completion_gate="${BASH_REMATCH[4]}"
    observation_source="${BASH_REMATCH[6]:-}"
    observation_window="${BASH_REMATCH[7]:-}"
    observation_assertions="${BASH_REMATCH[8]:-}"
    if [[ "$completion_gate" == "observed" ]]; then
      if [[ ! "$observation_source" =~ ^[^@[:space:]]+@[^[:space:]](.*[^[:space:]])?$ \
        || -z "$observation_window" || -z "$observation_assertions" ]]; then
        report_finding "$file" "$idx" "INITIATIVE_V5_OBSERVATION_PLAN_REQUIRED" "observed completion_gate requires observation_plan=<kind>@<source>|<positive-seconds>|<assertions>."
        fail_count=$((fail_count + 1))
      fi
    elif [[ -n "$observation_source$observation_window$observation_assertions" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_V5_OBSERVATION_PLAN_FORBIDDEN" "observation_plan is valid only for completion_gate=observed."
      fail_count=$((fail_count + 1))
    fi
    if [[ ! "$evidence" =~ ^[^@[:space:]]+@[^[:space:]](.*[^[:space:]])?$ \
      && ! "$evidence" =~ ^not-applicable:[^[:space:]](.*[^[:space:]])?$ ]]; then
      report_finding "$file" "$idx" "INITIATIVE_ACCEPTANCE_EVIDENCE_INVALID" "Acceptance evidence must be <kind>@<source> or not-applicable:<rationale>."
      fail_count=$((fail_count + 1))
    fi
    if [[ ( "$acceptance_scope" == "technical-only" && "$owner_gate" != "none" ) \
      || ( "$acceptance_scope" == "ticket" && "$owner_gate" != "ticket-acceptance" ) \
      || ( "$acceptance_scope" == "aggregate" && "$owner_gate" != "aggregate-acceptance" ) ]]; then
      report_finding "$file" "$idx" "INITIATIVE_ACCEPTANCE_GATE_MISMATCH" "Acceptance scope and owner gate are incompatible for task:${task_name}."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$owner_gate" != "none" && "$evidence" =~ ^not-applicable: ]]; then
      report_finding "$file" "$idx" "INITIATIVE_OWNER_GATE_REQUIRES_EVIDENCE" "Owner-gated task:${task_name} requires actionable evidence."
      fail_count=$((fail_count + 1))
    fi
  done < <(printf '%s\n' "$acceptance")

  return "$fail_count"
}

check_assumptions() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local fail_count=0

  local assumptions
  assumptions="$(extract_section "$plan_text" "Assumptions/Defaults")"
  local bullet_count
  bullet_count="$(printf '%s\n' "$assumptions" | grep -Ec '^- ' || true)"
  if [[ "$bullet_count" -eq 0 ]]; then
    report_finding "$file" "$idx" "ASSUMPTIONS_EMPTY" "Assumptions/Defaults has no bullet items."
    fail_count=$((fail_count + 1))
  fi

  while IFS= read -r line; do
    [[ "$line" =~ ^- ]] || continue
    if ! grep -Eq '(已确定|待确认|未检查)' < <(printf '%s\n' "$line"); then
      report_finding "$file" "$idx" "ASSUMPTION_TRI_STATE_MISSING" "Assumption missing tri-state marker: $line"
      fail_count=$((fail_count + 1))
    fi
  done < <(printf '%s\n' "$assumptions")

  return "$fail_count"
}

check_initiative_adr_contracts() {
  local file="$1"
  local idx="$2"
  local value="$3"
  local field_count="$4"
  local entry path previous_path=""
  local -a entries=()

  if [[ "$field_count" -gt 1 ]]; then
    report_finding "$file" "$idx" "INITIATIVE_ADR_CONTRACTS_DUPLICATE" "Initiative Flow Decision must declare adr_contracts exactly once."
    return 1
  fi

  if [[ -z "$value" ]]; then
    report_finding "$file" "$idx" "INITIATIVE_ADR_CONTRACTS_REQUIRED" "V5 Initiative plans must declare adr_contracts=none or canonical ADR path/blob bindings."
    return 1
  fi
  if [[ "$value" == "none" ]]; then
    return 0
  fi
  if [[ "$value" == *, || "$value" == ,* || "$value" == *",,"* ]]; then
    report_finding "$file" "$idx" "INITIATIVE_ADR_CONTRACTS_INVALID" "adr_contracts must not contain empty comma-separated entries."
    return 1
  fi

  IFS=',' read -r -a entries <<<"$value"
  if [[ "${#entries[@]}" -eq 0 ]]; then
    report_finding "$file" "$idx" "INITIATIVE_ADR_CONTRACTS_INVALID" "adr_contracts must be none or a comma-separated canonical ADR path/blob list."
    return 1
  fi
  for entry in "${entries[@]}"; do
    entry="$(printf '%s\n' "$entry" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [[ ! "$entry" =~ ^docs/adr/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md@[0-9a-f]{40}$ ]]; then
      report_finding "$file" "$idx" "INITIATIVE_ADR_CONTRACTS_INVALID" "adr_contracts entries must use docs/adr/<NNNN>-<slug>.md@<40-hex Git blob SHA>."
      return 1
    fi
    path="${entry%@*}"
    if [[ -n "$previous_path" ]] && [[ "$path" < "$previous_path" || "$path" == "$previous_path" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_ADR_CONTRACTS_INVALID" "adr_contracts must be path-sorted without duplicates."
      return 1
    fi
    previous_path="$path"
  done
  return 0
}

release_arrangement_any_field_declared() {
  local plan_text="$1"
  grep -Eq "^[[:space:]]*-[[:space:]]*\`?(release_scope|release_reason|release_entrypoint|release_followup)\`?[[:space:]]*:" < <(printf '%s\n' "$plan_text")
}

retired_release_plan_field_declared() {
  local plan_text="$1"
  grep -Eiq '(^|[^[:alnum:]_])`?(release_scope|release_reason|release_entrypoint|release_followup|release_disposition)`?[[:space:]]*[:=]' < <(printf '%s\n' "$plan_text")
}

release_decision_card_is_displayable() {
  local plan_text="$1"
  local phrase
  for phrase in \
    'agent default (release )?decision card|release decision card|发布决策卡' \
    'publish applicability|发布适用性' \
    'components|组件' \
    'channel|渠道' \
    'bump rule|version rule|版本.*规则' \
    'predicted version|预测版本' \
    'target (repository|repo)|目标仓库' \
    'policy source|策略来源' \
    'unknown/blocked|unknown.*blocked|未知.*阻塞' \
    'version expectation|版本预期'; do
    if ! grep -Eiq "$phrase" < <(printf '%s\n' "$plan_text"); then
      return 1
    fi
  done
  return 0
}

release_rule_is_complete() {
  local plan_text="$1"
  local phrase
  for phrase in \
    'target (repository|repo).{0,80}target branch|target repository/branch|目标仓库.{0,40}分支' \
    'base[- ]tag source|base tag source|基线.?tag.?来源' \
    'bump rule|version rule|版本提升规则' \
    'channel|渠道' \
    'components|组件' \
    'collision policy|tag collision|冲突策略' \
    'merge[- ]sha binding|merge sha binding|merge-SHA binding|merge.*sha.*绑定' \
    'never prefill.*final version|final version string.*never|不预填.*最终版本'; do
    if ! grep -Eiq "$phrase" < <(printf '%s\n' "$plan_text"); then
      return 1
    fi
  done
  return 0
}

release_arrangement_placeholder() {
  local value="$1"
  local lower
  lower="$(trim_inline_value "$value" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$lower" ]]; then
    return 0
  fi
  if grep -Eiq '^(tbd|tba|tbc|todo|unknown|none|n/?a|pending|later|待定|待确认|待补|占位|未知|无)$' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  if grep -Eiq '(^|[[:space:][:punct:]])(tbd|tba|tbc|todo|unknown|pending|later|待定|待确认|待补|占位|未知)([[:space:][:punct:]]|$)' < <(printf '%s\n' "$lower"); then
    return 0
  fi
  return 1
}

release_candidate_path_is_native() {
  local relative="$1"
  local root target
  [[ -n "$relative" && "$relative" != /* ]] || return 1
  root="$(cd -- "$PLAN_CONTRACT_REPO_ROOT" 2>/dev/null && pwd -P)" || return 1
  [[ -e "$root/$relative" ]] || return 1
  target="$(realpath "$root/$relative" 2>/dev/null)" || return 1
  [[ "$target" == "$root" || "$target" == "$root"/* ]]
}

release_candidate_file_is_native() {
  local relative="$1"
  release_candidate_path_is_native "$relative" \
    && [[ -f "$PLAN_CONTRACT_REPO_ROOT/$relative" ]]
}

release_cargo_manifest_has_version() {
  local manifest="$1"
  awk '
    BEGIN { in_versioned_section = 0; found = 0 }
    /^[[:space:]]*\[/ {
      section = $0
      gsub(/^[[:space:]]*\[/, "", section)
      gsub(/\][[:space:]]*$/, "", section)
      in_versioned_section = (section == "package" || section == "workspace.package")
      next
    }
    in_versioned_section && /^[[:space:]]*version([[:space:]]*\.workspace)?[[:space:]]*=/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$manifest"
}

release_arrangement_entrypoint_is_native() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  if [[ "$value" == *"&&"* || "$value" == *";"* || "$value" == *"|"* || "$value" == *">"* || "$value" == *"<"* || "$value" == *"&"* || "$value" == *'`'* || "$value" == *'$('* ]]; then
    return 1
  fi
  if [[ "$value" =~ ^(docs/|\.github/|bin/|scripts/)[^[:space:]]+$ ]]; then
    [[ "$value" =~ (release|publish|version|tag) ]] \
      && release_candidate_file_is_native "$value"
    return $?
  fi
  if [[ "$value" =~ ^\$([a-z][a-z0-9-]*)$ ]]; then
    local skill_name="${BASH_REMATCH[1]}"
    [[ "$skill_name" =~ (release|publish|version|tag) ]] \
      && release_candidate_file_is_native "skills/$skill_name/SKILL.md"
    return $?
  fi
  if [[ "$value" =~ ^gh[[:space:]]+release[[:space:]]+(create|edit|upload)([[:space:]]|$) ]]; then
    if [[ "$value" =~ (^|[[:space:]])(-R[^[:space:]]*|--repo)(=|[[:space:]])|(^|[[:space:]])-R[^[:space:]]+ ]]; then
      return 1
    fi
    return 0
  fi
  if [[ "$value" =~ ^gh[[:space:]]+workflow[[:space:]]+run[[:space:]]+([^[:space:]]+)([[:space:]]|$) ]]; then
    local workflow_name="${BASH_REMATCH[1]}"
    if [[ "$value" =~ (^|[[:space:]])(-R[^[:space:]]*|--repo)(=|[[:space:]])|(^|[[:space:]])-R[^[:space:]]+ ]]; then
      return 1
    fi
    if [[ ! "$workflow_name" =~ (release|publish|version|tag) ]]; then
      return 1
    fi
    if [[ "$workflow_name" =~ ^[[:alnum:]_.-]+\.(ya?ml)$ ]]; then
      release_candidate_file_is_native ".github/workflows/$workflow_name"
      return $?
    fi
    [[ "$workflow_name" =~ ^[[:alnum:]_.-]+$ ]] \
      && { release_candidate_file_is_native ".github/workflows/$workflow_name.yml" \
        || release_candidate_file_is_native ".github/workflows/$workflow_name.yaml"; }
    return $?
  fi
  if [[ "$value" =~ ^(make|just)[[:space:]]+(release|publish|version|tag)([[:space:]]|$) ]]; then
    local build_target="${BASH_REMATCH[2]}"
    if [[ "${BASH_REMATCH[1]}" == "make" ]]; then
      local makefile
      for makefile in Makefile GNUmakefile makefile; do
        if [[ -f "$PLAN_CONTRACT_REPO_ROOT/$makefile" ]] \
          && grep -Eiq "^[[:space:]]*${build_target}[[:space:]]*:{1,2}([[:space:]]|$)" "$PLAN_CONTRACT_REPO_ROOT/$makefile"; then
          return 0
        fi
      done
      return 1
    fi
    local justfile
    for justfile in justfile Justfile; do
      if [[ -f "$PLAN_CONTRACT_REPO_ROOT/$justfile" ]] \
        && grep -Eiq "^[[:space:]]*${build_target}[[:space:]]*:[[:space:]]*" "$PLAN_CONTRACT_REPO_ROOT/$justfile"; then
        return 0
      fi
    done
    return 1
  fi
  if [[ "$value" =~ ^(npm|pnpm|yarn)[[:space:]]+(run[[:space:]]+)?(release|publish|version|tag)([[:space:]]|$) ]]; then
    local package_script="${BASH_REMATCH[3]}"
    [[ -f "$PLAN_CONTRACT_REPO_ROOT/package.json" ]] || return 1
    command -v jq >/dev/null 2>&1 || return 1
    jq -e --arg script "$package_script" '(.scripts // {})[$script] | type == "string" and length > 0' \
      "$PLAN_CONTRACT_REPO_ROOT/package.json" >/dev/null 2>&1
    return $?
  fi
  if [[ "$value" =~ ^cargo[[:space:]]+release([[:space:]]|$) ]]; then
    [[ -f "$PLAN_CONTRACT_REPO_ROOT/Cargo.toml" ]] || return 1
    release_cargo_manifest_has_version "$PLAN_CONTRACT_REPO_ROOT/Cargo.toml"
    return $?
  fi
  if [[ "$value" =~ ^[[:alnum:]_.-]+(/[[:alnum:]_.-]+)+$ ]]; then
    [[ "$value" =~ (release|publish|version|tag) ]] \
      && release_candidate_file_is_native "$value"
    return $?
  fi
  if [[ "$value" =~ ^[[:alnum:]_.-]+\.(ya?ml|sh|py|md|json|toml)$ ]]; then
    [[ "$value" =~ (release|publish|version|tag) ]] \
      && release_candidate_file_is_native "$value"
    return $?
  fi
  return 1
}

release_not_applicable_reason_is_concrete() {
  local value="$1"
  if release_arrangement_scope_contradiction "$value"; then
    return 1
  fi
  grep -Eiq \
    '(no[[:space:]_-]+(release|publication|version)[[:space:]]+(mechanism|entrypoint|workflow|requirement|need)|without[[:space:]]+(a[[:space:]]+)?(release|publication|version)[[:space:]]+(mechanism|entrypoint|workflow|requirement|need)|((this|current|the).{0,24})?(release|publication|version).{0,24}(not[[:space:]]+applicable|not[[:space:]]+required|does[[:space:]]+not[[:space:]]+require).{0,32}(change|plan|delivery|scope|case)?|((没有|不存在|缺少|未配置|不具备|未发现).{0,40}(发布|发版|版本).{0,20}(入口|机制|流程|渠道|需求|必要))|(本次|当前|此次|该变更).{0,24}(无需|不需要|不适用|不包含).{0,24}(发布|发版|版本))' \
    < <(printf '%s\n' "$value")
}

release_arrangement_scope_contradiction() {
  local value="$1"
  grep -Eiq \
    '((release|publication|version).{0,48}(is[[:space:]]+(required|included|part[[:space:]]+of)|required|must[[:space:]]+(happen|run|be)|needed[[:space:]]+for[[:space:]]+(this|the)[[:space:]]+(plan|delivery|change))|((this|current)[[:space:]]+(plan|delivery|change).{0,48})(requires|includes|contains)[[:space:]]+(a[[:space:]]+)?(release|publication|version)|((this|the|current)[[:space:]]+(plan|delivery|scope).{0,24}|plan.{0,24})((is|was|will[[:space:]]+be)[[:space:]]+)?not[[:space:]]+(deferred|stopped|postponed)|((does|do|will)[[:space:]]+not|not)[[:space:]]+(stop|defer|postpone).{0,24}(before[[:space:]]+)?(release|publication)|((发布|发版|版本).{0,36}(必须|需要|属于本次|纳入本次|包含在本次))|((本次计划|本次交付|当前变更).{0,36}(必须|需要|包含|纳入).{0,20}(发布|发版|版本))|((不|未).{0,12}(在|于).{0,12}(发布|发版|版本).{0,12}(前|之前).{0,12}(停靠|延期|结束)))' \
    < <(printf '%s\n' "$value")
}

release_included_reason_is_concrete() {
  local value="$1"
  if release_text_has_conditional_marker "$value" \
    || grep -Eiq '(not[[:space:]_-]*(included|part|run|performed|required)|not[[:space:]_-]*applicable|deferred|skip|without|won.t|will[[:space:]]+not|does[[:space:]]+not|不(属于|包含|执行|运行|需要)|无需|跳过|未(包含|执行|运行))' < <(printf '%s\n' "$value"); then
    return 1
  fi
  grep -Eiq '(release|publication|publish|发布|发版|版本)' < <(printf '%s\n' "$value") \
    && grep -Eiq '(this[[:space:]]+plan|current[[:space:]]+(delivery|change|scope)|repository|part[[:space:]]+of[[:space:]]+this|included[[:space:]]+as[[:space:]]+part|本次计划|本次交付|当前变更|仓库|属于本次|纳入)' < <(printf '%s\n' "$value")
}

release_deferred_reason_is_concrete() {
  local value="$1"
  ! release_text_has_conditional_marker "$value" \
    && grep -Eiq '((release|publication|version).{0,60}(mechanism|workflow|exists|available)|(mechanism|workflow|exists|available).{0,60}(release|publication|version)|((机制|流程|存在|可用).{0,60}(发布|发版|版本))|((发布|发版|版本).{0,60}(机制|流程|存在|可用)))' < <(printf '%s\n' "$value") \
    && grep -Eiq '(this[[:space:]]+plan|current[[:space:]]+delivery|current[[:space:]]+scope|deferred|stop|before[[:space:]]+release|pr|step[[:space:]]*5|本次计划|本次交付|停靠|发布前|就绪)' < <(printf '%s\n' "$value")
}

release_text_without_no_approval_requirement() {
  local value="$1"
  local normalized_value
  normalized_value="$(printf '%s\n' "$value" | tr '[:upper:]' '[:lower:]')"
  for phrase in \
    "approval is not required" "authorization is not required" \
    "sign-off is not required" "sign off is not required" \
    "confirmation is not required" "no approval is required" \
    "no release approval is required" "no authorization is required" \
    "no sign-off is required" "no sign off is required" \
    "no confirmation is required" "no approval required" \
    "no release approval required" "no authorization required" \
    "no sign-off required" "no sign off required" "no confirmation required"; do
    normalized_value="${normalized_value//${phrase}/ }"
  done
  printf '%s\n' "$normalized_value"
}

release_text_has_unresolved_state() {
  local value="$1"
  if grep -Eiq '(^|[^[:alnum:]_])(version|channel).{0,64}(has[[:space:]]+yet[[:space:]]+to[[:space:]]+(be[[:space:]]+)?(completed|complete|made|finalized)|is[[:space:]]+not[[:space:]]+(complete|completed)|remains?[[:space:]]+incomplete|is[[:space:]]+incomplete|are[[:space:]]+incomplete|not[[:space:]]+complete)([^[:alnum:]_]|$)' < <(printf '%s\n' "$value"); then
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]_])((version|channel).{0,64}(provisional|tentative|temporary|preliminary|draft|unset|unassigned|not[[:space:]]+assigned|not[[:space:]]+fixed|not[[:space:]]+set|not[[:space:]]+final)|(provisional|tentative|temporary|preliminary|draft|unset|unassigned|not[[:space:]]+assigned|not[[:space:]]+fixed|not[[:space:]]+set|not[[:space:]]+final).{0,48}(version|channel)|((版本|渠道).{0,48}(临时|暂定|暂行|草案|未分配|尚未分配|未落实|未落定|暂缓|未固定|未设定|未确定|provisional|tentative|temporary|preliminary|draft|unset|未敲定)))' < <(printf '%s\n' "$value"); then
    return 0
  fi
  local decision_state_markers='(^|[^[:alnum:]_])(version|channel).{0,48}(not[[:space:]]+(yet|settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|has[[:space:]]+not[[:space:]]+(been[[:space:]]+)?(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|has[[:space:]]+yet[[:space:]]+to[[:space:]]+(be[[:space:]]+)?(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|was[[:space:]]+not[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|isn.t[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|hasn.t[[:space:]]+been[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|undefined|unspecified|unselected|undecided|undetermined|unconfirmed|unresolved|unsettled|unfinalized|pending|open|awaiting[[:space:]]+(selection|decision|confirmation)|to[[:space:]]+be[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|finalized|specified))([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(not[[:space:]]+(yet|settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|has[[:space:]]+not[[:space:]]+(been[[:space:]]+)?(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|has[[:space:]]+yet[[:space:]]+to[[:space:]]+(be[[:space:]]+)?(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|was[[:space:]]+not[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|isn.t[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|hasn.t[[:space:]]+been[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|required|finalized|specified)|undefined|unspecified|unselected|undecided|undetermined|unconfirmed|unresolved|unsettled|unfinalized|pending|open|awaiting[[:space:]]+(selection|decision|confirmation)|to[[:space:]]+be[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|finalized|specified)).{0,48}(version|channel)([^[:alnum:]_]|$)'
  grep -Eiq "(${decision_state_markers}|not[[:space:]]+yet|not[[:space:]]+settled|not[[:space:]]+(decided|determined|confirmed|resolved|selected|chosen|made|finalized|specified)|has[[:space:]]+yet[[:space:]]+to[[:space:]]+(be[[:space:]]+)?(settled|decided|determined|confirmed|resolved|selected|chosen|made|finalized|specified)|awaiting[[:space:]]+((the|a|an)[[:space:]]+)?(version|channel)?[[:space:]]*(selection|decision|confirmation)|(^|[^[:alnum:]_])to[[:space:]]+be[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|finalized|specified)([^[:alnum:]_]|$)|((remain|remains|still)[[:space:]]+)(to[[:space:]]+be[[:space:]]+(settled|decided|determined|confirmed|resolved|selected|chosen|made|finalized|specified)|undecided|undetermined|unconfirmed|unresolved|unsettled|unfinalized)|(^|[^[:alnum:]_])(undecided|undetermined|unconfirmed|unresolved|unsettled|unfinalized|open)([^[:alnum:]_]|$)|pending[[:space:]]+(decision|version|channel)|尚未(决定|完成|确定|确认|解决|选择|选定|敲定)|仍(待|未)(决定|完成|确定|确认|解决|选择|选定|敲定)|尚待(决定|确定|确认|选择|选定)|待(决定|确认)|未(决定|完成|确定|确认|解决|选择|选定|敲定)|未决)" < <(printf '%s\n' "$value")
}

release_text_has_conditional_marker() {
  local value="$1"
  local normalized_value
  normalized_value="$(release_text_without_no_approval_requirement "$value")"
  release_text_has_unresolved_state "$normalized_value" && return 0
  if grep -Eiq '(^|[^[:alnum:]_])as([[:space:]]+|-)needed([^[:alnum:]_]|$)' < <(printf '%s\n' "$normalized_value"); then
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]_])((release|publication|publish|version|channel).{0,80}((depend(s)?|rely|relies|reliant)[[:space:]]+(on|upon)|is[[:space:]]+predicated[[:space:]]+(on|upon)|is[[:space:]]+governed[[:space:]]+(by|through)|is[[:space:]]+tied[[:space:]]+to|is[[:space:]]+awaiting|is[[:space:]]+conditioned[[:space:]]+by|hinges[[:space:]]+(on|upon)|awaits[[:space:]]+|wait(s|ing)[[:space:]]+for|blocked[[:space:]]+by|gated[[:space:]]+(by|on)|based[[:space:]]+(on|upon)|determined[[:space:]]+by|controlled[[:space:]]+(by|through)|follows[[:space:]]+|conditioned[[:space:]]+by|predicated[[:space:]]+(on|upon)|governed[[:space:]]+(by|through)|tied[[:space:]]+to).{0,80}(version|channel|release|publication|publish))([^[:alnum:]_]|$)' < <(printf '%s\n' "$normalized_value"); then
    return 0
  fi
  if grep -Eiq '(^|[^[:alnum:]_])(version|channel)[[:space:]]+(selection|selected|decision|determination|confirmation|choice).{0,32}(must|needs?|should|requires?|mandatory|necessary|needed|prerequisite|essential|indispensable|condition)([[:space:]]+to[[:space:]]+be)?([^[:alnum:]_]|$)' < <(printf '%s\n' "$normalized_value"); then
    return 0
  fi
  local word_markers='(^|[^[:alnum:]_])(unless|except|contingent|conditional|provided|assuming|may|can|could|might|would|if|when|once|expected|expect|possible|potential|noted|documented|should|pending|skip|avoid|omit|without|won.t|can.t|cannot|don.t|doesn.t|isn.t|wasn.t|weren.t|aren.t|haven.t|hasn.t|didn.t|never)([^[:alnum:]_]|$)'
  local phrase_markers='(^|[^[:alnum:]_])(dependent[[:space:]]+on|subject[[:space:]]+to|awaiting[[:space:]]+(approval|authorization|sign[- ]?off|confirmation)|on[[:space:]]+(approval|sign[- ]?off|confirmation)|upon[[:space:]]+(approval|sign[- ]?off|confirmation)|pending[[:space:]]+(approval|authorization|sign[- ]?off|confirmation)|approval[[:space:]]+required|confirmation[[:space:]]+required|requires[[:space:]]+(approval|authorization|sign[- ]?off|confirmation)|no[[:space:]]+(release[[:space:]]+)?(approval|authorization|sign[- ]?off|confirmation)|only[[:space:]]+(after|when|if|upon)[[:space:]]+((the|an?)[[:space:]]+)?(approval|authorization|approved|authorized|confirmed|sign[- ]?off|manual[[:space:]]+approval|reviewer[[:space:]]+confirmation)|after[[:space:]]+((the|an?)[[:space:]]+)?(approval|authorization|sign[- ]?off|manual[[:space:]]+approval|reviewer[[:space:]]+confirmation|confirmation)|after[[:space:]]+(being[[:space:]]+|it[[:space:]]+is[[:space:]]+)?(approved|authorized|confirmed)|after[[:space:]]+(obtaining|receiving|getting)[[:space:]]+(approval|authorization|sign[- ]?off|confirmation)|following[[:space:]]+((the|an?)[[:space:]]+)?(approval|authorization|sign[- ]?off|manual[[:space:]]+approval|reviewer[[:space:]]+confirmation|confirmation)|sign[- ]?off|manual[[:space:]]+approval|reviewer[[:space:]]+confirmation)([^[:alnum:]_]|$)'
  local release_prerequisite_markers='(^|[^[:alnum:]_])(after|following|once|upon|before|until|prior[[:space:]]+to|subject[[:space:]]+to|dependent[[:space:]]+(on|upon)|depending[[:space:]]+on|reliant[[:space:]]+upon|as[[:space:]]+soon[[:space:]]+as|in[[:space:]]+case|whenever|where).{0,64}(version|channel)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(on)[[:space:]]+(the[[:space:]]+)?(version|channel)[[:space:]]+(selection|selected|decision|determination|confirmation|choice|is[[:space:]]+selected|is[[:space:]]+determined|is[[:space:]]+confirmed|is[[:space:]]+decided|has[[:space:]]+been[[:space:]]+selected|has[[:space:]]+been[[:space:]]+determined|has[[:space:]]+been[[:space:]]+confirmed)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(gated[[:space:]]+by|requires?|requiring)[[:space:]]+((the|an?)[[:space:]]+)?(version|channel)([[:space:]]+(selection|selected|decision|determination|confirmation|choice|is[[:space:]]+selected|is[[:space:]]+determined|is[[:space:]]+confirmed|is[[:space:]]+decided|has[[:space:]]+been[[:space:]]+selected|has[[:space:]]+been[[:space:]]+determined|has[[:space:]]+been[[:space:]]+confirmed)([^[:alnum:]_]|$)|([^[:alnum:]_]|$))|(^|[^[:alnum:]_])((version|channel)[[:space:]]+(selection|selected|decision|determination|confirmation|choice).{0,32}|(must|needs?|has[[:space:]]+to|should)[[:space:]]+be[[:space:]]+(complete|completed|finalized|confirmed|selected|determined|decided|made).{0,32})(must|needs?|has[[:space:]]+to|should)[[:space:]]+be[[:space:]]+(complete|completed|finalized|confirmed|selected|determined|decided|made)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(version|channel)[[:space:]]+(selection|selected|decision|determination|confirmation|choice)[[:space:]]+is[[:space:]]+(required|pending|open|incomplete)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(version|channel).{0,64}[^[:alnum:]_](after|before|until|prior[[:space:]]+to)[[:space:]]+(the[[:space:]]+)?(selection|decision|confirmation|release|publication|publish)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(after|following|once)[[:space:]]+(the[[:space:]]+)?(version|channel)[[:space:]]+(selection|selected|decision|determination|confirmation|choice|is[[:space:]]+selected|is[[:space:]]+determined|is[[:space:]]+confirmed|is[[:space:]]+decided|has[[:space:]]+been[[:space:]]+selected|has[[:space:]]+been[[:space:]]+determined|has[[:space:]]+been[[:space:]]+confirmed|being[[:space:]]+selected|being[[:space:]]+determined|being[[:space:]]+confirmed)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(after|following|once)[[:space:]]+(selecting|choosing|determining|confirming|deciding)[[:space:]]+(the[[:space:]]+)?(version|channel)([^[:alnum:]_]|$)|((版本|渠道).{0,12}(选择|选定|决定|确定|确认).{0,8}后)'
  grep -Eiq "(${word_markers}|${phrase_markers}|${release_prerequisite_markers}|可能|若|如|如果|预期|预计|待定|跳过|避免|除非|除外|取决于|条件|经批准|待审批|需审批|须审批|审批通过后|签字后|签署后|评审确认后|人工审批|人工确认|待签字|待确认|未必|不一定|或许|forbidden|prohibited|disallowed)" < <(printf '%s\n' "$normalized_value")
}

release_included_followup_is_concrete() {
  local value="$1"
  local normalized_value
  normalized_value="$(release_text_without_no_approval_requirement "$value")"
  if release_text_has_unresolved_state "$normalized_value" \
    || release_text_has_conditional_marker "$value" \
    || grep -Eiq '(not[[:space:]_-]*(included|part|run|performed|required|planned|intended|successful)|not[[:space:]_-]*applicable|deferred|will[[:space:]]+not|does[[:space:]]+not|failed|failure|error|errored|blocked|unsuccessful|unsuccessfully|not[[:space:]]+successful|un[-_]*(verified|executed|checked|confirmed|published|released|completed|finished|successful)|不(属于|包含|执行|运行|需要|成功)|无需|未(包含|执行|运行|成功))' < <(printf '%s\n' "$normalized_value"); then
    return 1
  fi
  grep -Eiq \
    '((release|publication|publish).{0,80}(workflow|command|gate|terminal|complete|completed|published|version|channel|decision)|(workflow|command|gate|terminal|complete|completed|published|version|channel|decision).{0,80}(release|publication|publish)|((发布|发版|版本).{0,80}(流程|命令|门禁|终态|完成|版本|渠道|决策)|(流程|命令|门禁|终态|完成|版本|渠道|决策).{0,80}(发布|发版|版本)))' \
    < <(printf '%s\n' "$value") \
    && grep -Eiq '(version|channel|decision|版本|渠道|决策|计算|沿用|确定|确认)' < <(printf '%s\n' "$value")
}

release_not_applicable_followup_is_concrete() {
  local value="$1"
  if release_not_applicable_reason_is_concrete "$value"; then
    return 0
  fi
  grep -Eiq \
    '(after|post|后续).{0,24}(if|when|若|如|新增|new).{0,40}(release|publication|version|发布|发版|版本).{0,40}(separate|independent|reassess|re-?evaluate|独立|重新评估|重新判断|另行)|(无需|不需要|不包含).{0,24}(release|publication|version|发布|发版|版本)' \
    < <(printf '%s\n' "$value")
}

release_deferred_followup_has_prerequisite() {
  local value="$1"
  release_text_has_unresolved_state "$value" && return 1
  if grep -Eiq \
    '(prerequisite|precondition)[[:space:]:=-]*(release|publication|version|channel|decision|approval|workflow|gate|complete|confirm|determin|select)|((前置(条件|要求)?|依赖(项)?)[[:space:]:：=-]*)(发布|发版|版本|渠道|决策|审批|确认|完成)|先.{0,40}(完成|确认|决定|确定).{0,12}(再|才能|方可)|需.{0,40}(完成|确认|决定|确定).{0,12}(再|才能|方可)' \
    < <(printf '%s\n' "$value"); then
    return 0
  fi
  grep -Eiq \
    '(version|channel).{0,40}(decision|choice).{0,32}(is[[:space:]]+)?(complete|confirmed|made|decided|determined).{0,32}(before|prior|then|start|run|execute|launch)|((版本|渠道).{0,32}(决策).{0,32}(完成|确认|确定).{0,32}(后再|后才能|后方可|再启动|再运行))|((完成|确认|决定|确定).{0,12}(后再|后才能|后方可))' \
    < <(printf '%s\n' "$value")
}

release_plan_task_has_affirmative_action() {
  local value="$1"
  grep -Eiq '(^|[^[:alnum:]_])(run|runs|running|execute|executes|executed|perform|performs|performed|prepare|prepares|prepared|publish|publishes|published|ship|ships|shipped|deploy|deploys|deployed|trigger|triggers|triggered|create|creates|created|upload|uploads|uploaded|promote|promotes|promoted|complete|completes|completed|finish|finishes|finished|reach|reaches|reached|release[[:space:]]+(the|an?|artifact|package|version|build|image|candidate|binary|bundle)|发布[[:space:]]*(版本|构建|产物|包|镜像|渠道|到|至)|发版[[:space:]]*(版本|构建|产物|包|镜像|渠道|到|至)|执行|运行|准备|部署|触发|创建|上传|晋级|完成|收口|到达|进入)([^[:alnum:]_]|$)' < <(printf '%s\n' "$value")
}

release_plan_has_release_task() {
  local value="$1"
  local strict="${2:-0}"
  local release_markers='release|publication|publish|version|tag|发版|发布|版本|标签'
  local line
  while IFS= read -r line; do
    if grep -Eiq "(${release_markers})" < <(printf '%s\n' "$line") \
      && release_plan_task_has_affirmative_action "$line"; then
      if [[ "$strict" -eq 1 ]]; then
        return 0
      fi
      if ! release_text_has_conditional_marker "$line" \
        && ! grep -Eiq '(do[[:space:]]+not|don.t|isn.t[[:space:]_-]*(run|runs|running|execute|executes|executed|perform|performs|performed|prepare|prepares|prepared|publish|publishes|published|release|releases|released)|must[[:space:]]+not|will[[:space:]]+not|does[[:space:]]+not|not[[:space:]_-]*(run|runs|running|execute|executes|executed|perform|performs|performed|prepare|prepares|prepared|publish|publishes|published|release|releases|released|planned|intended)|unexecuted|unrun|unperformed|unprepared|unpublished|unreleased|uncompleted|unfinished|un[-_]*(executed|run|performed|prepared|published|released|completed|finished)|(^|[^[:alnum:]_])planned([^[:alnum:]_]|$)|absent|missing|not[[:space:]]+present|no[[:space:]]+release([[:space:]]+task)?|不(要|得|可)|不会(执行|运行|准备|发布|包含)|无需|不运行|禁止|未(执行|运行|准备|发布|包含)|不存在|缺少|未包含)' < <(printf '%s\n' "$line"); then
        return 0
      fi
    fi
  done <<< "$value"
  return 1
}

release_plan_has_release_evidence() {
  local value="$1"
  local line
  while IFS= read -r line; do
    if grep -Eiq 'evidence[[:space:]]*=[[:space:]]*`?release:[^`[:space:]]*' < <(printf '%s\n' "$line") \
      && grep -Eiq 'assertions[[:space:]]*=[^`]*`?[^`]*((release|publication|publish).{0,48}(reach|complete|complet|publish|succeed|success|pass|verif|creat|upload|terminal|发布|发版|完成|成功|验证|终态|已发布|已创建)|(version|tag|channel).{0,48}(release|publish|creat|upload|verif|发布|发版|创建|上传|验证))' < <(printf '%s\n' "$line") \
      && ! release_text_has_conditional_marker "$line" \
      && ! release_text_has_unresolved_state "$line" \
      && ! grep -Eiq '(release:(failed|failure|error|errored|blocked|not[-_ ]?run|not[-_ ]?published|not[-_ ]?ready|skipped|none|missing|not[-_ ]?applicable|deferred|pending)|((release|publication|publish).{0,32})(failed|failure|error|errored|blocked|unsuccessful|unsuccessfully|not[-_[:space:]]+successful|not[[:space:]_-]*(reach|complete|finish|run|published|ready|fail)|unverified|unchecked|unconfirmed|unpublished|unreleased|uncompleted|unfinished|un[-_]*(verified|executed|checked|confirmed|published|released|completed|finished|successful))|((did|does|do)[[:space:]]+not)[[:space:]]+(reach|complete|finish|run|execute|perform|publish|release|fail|succeed|pass|verify|create|upload)|not[[:space:]]+(run|execute|perform|publish|release|fail|succeed|pass|verify|create|upload|planned|intended|verified|checked|confirmed|successful)|not[-_[:space:]]+(verified|checked|confirmed)|unverified|unchecked|unconfirmed|unpublished|unreleased|uncompleted|unfinished|(^|[^[:alnum:]_])(will|plan(ned)?)([^[:alnum:]_]|$)|no[[:space:]]+(release[[:space:]]+)?(failure|success)|without[[:space:]]+(release[[:space:]]+)?(failure|success)|不会(运行|执行|发布|包含|成功)|不(运行|执行|发布|包含|成功)|计划|记录|未(运行|执行|发布|成功))' < <(printf '%s\n' "$line"); then
      return 0
    fi
  done <<< "$value"
  return 1
}

release_plan_has_release_terminal_stop() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  if [[ "$value" != */* ]]; then
    return 1
  fi
  local terminal="${value#*/}"
  terminal="$(trim_inline_value "$terminal")"
  case "$terminal" in
    "release terminal"|"release gate"|"release complete"|"release completed"|"release reaches terminal state"|"release reaches the terminal state"|"publication terminal"|"publication gate"|"publication complete"|"publication completed"|"publish terminal"|"publish gate"|"publish complete"|"publish completed"|"published"|"Step 6 Published"|"Step 6 Release"|"Step 6 Released"|"发布终态"|"发布完成"|"发布门禁"|"发版终态"|"发版完成"|"发版门禁")
      return 0
      ;;
  esac
  return 1
}

release_plan_contains_release_terminal_stop() {
  local value="$1"
  value="$(trim_inline_value "$value")"
  release_text_has_conditional_marker "$value" && return 1
  release_plan_has_release_terminal_stop "$value" && return 0
  grep -Eiq '((release|publication|publish|发布|发版).{0,64}(published|released|complete|completed|terminal|gate|已发布|完成|终态|门禁))|((published|released|complete|completed|terminal|gate|已发布|完成|终态|门禁).{0,64}(release|publication|publish|发布|发版))' < <(printf '%s\n' "$value")
}

release_included_stop_is_flow_compatible() {
  local flow_type="$1"
  local value="$2"
  release_text_has_conditional_marker "$value" && return 1
  case "$flow_type" in
    fast-track)
      grep -Eiq '(merge-only|merge\+cleanup)' < <(printf '%s\n' "$value")
      ;;
    wave-thread)
      grep -Eiq '(merge-ready|Step 5C|merge-only|merge\+cleanup|发布|release)' < <(printf '%s\n' "$value")
      ;;
    parallel-pr)
      grep -Eiq '(merge-on-green|merge-only|merge\+cleanup)' < <(printf '%s\n' "$value")
      ;;
    initiative)
      if grep -Eiq '((aggregate|集成)[[:space:]_-]*(merge|merged|merge[[:space:]]+commit|pr[[:space:]]+merge|合并|合入))' < <(printf '%s\n' "$value"); then
        ! grep -Eiq '((aggregate|集成)[[:space:]_-]*(merge|merged|merge[[:space:]]+commit|pr[[:space:]]+merge|合并|合入)).{0,32}(readiness|ready|review|check|validation|就绪|准备|审查|检查)' < <(printf '%s\n' "$value")
        return $?
      fi
      if grep -Eiq '(^|[^[:alnum:]_-])promotion([^[:alnum:]_-]|$)|((final|最终)[[:space:]_-]*)?(promotion|晋级)' < <(printf '%s\n' "$value"); then
        ! grep -Eiq '((final|最终)[[:space:]_-]*)?(promotion|晋级).{0,32}(readiness|ready|review|check|validation|就绪|准备|审查|检查)' < <(printf '%s\n' "$value")
        return $?
      fi
      grep -Eiq '((tracking[[:space:]_-]*issue|跟踪[[:space:]]*issue)[[:space:]_-]*(close|closed|complete|completed|关闭|完成))' < <(printf '%s\n' "$value")
      ;;
    *)
      return 1
      ;;
  esac
}

extract_release_stop_condition() {
  local plan_text="$1"
  local flow_decision
  flow_decision="$(extract_section "$plan_text" "Flow Decision")"
  printf '%s\n' "$flow_decision" \
    | sed -nE 's/^[[:space:]]*-[[:space:]]*(收口条件|stop_condition|stop condition|stop)[[:space:]]*[:：][[:space:]]*`?([^`]+)`?[[:space:]]*$/\2/p' \
    | head -n1 \
    | while IFS= read -r line; do
        trim_inline_value "$line"
      done
}

release_arrangement_scope_is_eligible() {
  case "$1" in
    normal|fast-track|local-merge|parallel-pr|initiative)
      return 0
      ;;
  esac
  return 1
}

check_release_plan_contract() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local flow_type="$4"
  local routing_context="$5"
  local flow_source
  flow_source="$(extract_flow_decision_field "$plan_text" "flow_source")"
  local fail_count=0
  local task_orchestration
  task_orchestration="$(extract_section "$plan_text" "Task Orchestration")"
  local acceptance_validation
  acceptance_validation="$(extract_section "$plan_text" "Acceptance & Validation")"
  local enforce=0
  local has_new_fields=0

  if [[ "$idx" == "raw" ]]; then
    if retired_release_plan_field_declared "$plan_text"; then
      report_finding "$file" "$idx" "RETIRED_RELEASE_PLAN_FIELD" "new plan Markdown must not declare retired plan-level release arrangement fields; keep historical JSONL readable only."
      fail_count=$((fail_count + 1))
    fi
    if grep -Eiq '^[[:space:]]*-[[:space:]]*`?(release_version|release_tag|predicted_version|final_version)`?[[:space:]]*[:=]' < <(printf '%s\n' "$plan_text"); then
      report_finding "$file" "$idx" "RELEASE_PLAN_FINAL_VERSION_PREFILLED" "new plans may state a runtime rule or predicted result but must not prefill a final release version or tag."
      fail_count=$((fail_count + 1))
    fi
    local stop_condition
    stop_condition="$(extract_release_stop_condition "$plan_text")"
    if grep -Eiq 'Step[[:space:]]*5C|merge-ready|merge-only|merge\+cleanup' < <(printf '%s\n' "$stop_condition") \
      && ! release_decision_card_is_displayable "$plan_text"; then
      report_finding "$file" "$idx" "RELEASE_DECISION_CARD_MISSING" "Step 5C plans must display the Agent default release decision card and require version-expectation confirmation."
      fail_count=$((fail_count + 1))
    fi
    if grep -Eiq 'merge-only|merge\+cleanup' < <(printf '%s\n' "$stop_condition") \
      && ! release_rule_is_complete "$plan_text"; then
      report_finding "$file" "$idx" "RELEASE_RULE_INCOMPLETE" "merge-only and merge+cleanup plans must state the complete executable release rule without a final version string."
      fail_count=$((fail_count + 1))
    fi
    return "$fail_count"
  fi
  return 0

  if release_arrangement_any_field_declared "$plan_text"; then
    has_new_fields=1
  fi
  if [[ "$idx" == "raw" ]]; then
    if release_arrangement_scope_is_eligible "$flow_type"; then
      enforce=1
    fi
  elif [[ "$has_new_fields" -eq 1 ]] && contains_explicit_dev_plan_request_signal "$routing_context" \
    && [[ "$flow_type" != "implement-only" ]]; then
    enforce=1
  fi
  if [[ "$enforce" -ne 1 ]]; then
    return 0
  fi

  local scope reason entrypoint followup scope_count reason_count entrypoint_count followup_count field count
  if release_arrangement_field_continuation_invalid "$plan_text"; then
    report_finding "$file" "$idx" "RELEASE_PLAN_FIELD_SYNTAX_INVALID" "release arrangement fields must be single-line scalar declarations in Flow Decision."
    fail_count=$((fail_count + 1))
  fi
  scope="$(extract_flow_decision_field "$plan_text" "release_scope")"
  reason="$(extract_flow_decision_field "$plan_text" "release_reason")"
  entrypoint="$(extract_flow_decision_field "$plan_text" "release_entrypoint")"
  followup="$(extract_flow_decision_field "$plan_text" "release_followup")"
  scope_count="$(count_flow_decision_field "$plan_text" "release_scope")"
  reason_count="$(count_flow_decision_field "$plan_text" "release_reason")"
  entrypoint_count="$(count_flow_decision_field "$plan_text" "release_entrypoint")"
  followup_count="$(count_flow_decision_field "$plan_text" "release_followup")"
  local release_stop_condition
  release_stop_condition="$(extract_release_stop_condition "$plan_text")"

  for field in release_scope release_reason release_entrypoint release_followup; do
    count="$(count_flow_decision_field "$plan_text" "$field")"
    if [[ "$count" -ne 1 ]]; then
      report_finding "$file" "$idx" "RELEASE_PLAN_FIELD_COUNT_INVALID" "${field} must be declared exactly once in Flow Decision."
      fail_count=$((fail_count + 1))
    fi
    local total_count
    total_count="$(printf '%s\n' "$plan_text" | grep -Ec "^[[:space:]]*-[[:space:]]*\`?${field}\`?[[:space:]]*:" || true)"
    if [[ "$total_count" -ne 1 ]]; then
      report_finding "$file" "$idx" "RELEASE_PLAN_FIELD_LOCATION_INVALID" "${field} must be declared only once and inside Flow Decision."
      fail_count=$((fail_count + 1))
    fi
  done

  if [[ "$scope_count" -eq 1 ]]; then
    case "$scope" in
      included|deferred|not-applicable)
        ;;
      *)
        report_finding "$file" "$idx" "RELEASE_PLAN_SCOPE_INVALID" "release_scope must be included, deferred, or not-applicable."
        fail_count=$((fail_count + 1))
        ;;
    esac
  fi
  if [[ "$reason_count" -eq 1 ]] && release_arrangement_placeholder "$reason"; then
    report_finding "$file" "$idx" "RELEASE_PLAN_FIELD_PLACEHOLDER" "release_reason must be concrete and must not be a placeholder."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$entrypoint_count" -eq 1 && ! ( "$scope" == "not-applicable" && "$entrypoint" == "none" ) ]] \
    && release_arrangement_placeholder "$entrypoint"; then
    report_finding "$file" "$idx" "RELEASE_PLAN_FIELD_PLACEHOLDER" "release_entrypoint must be concrete and must not be a placeholder."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$followup_count" -eq 1 ]] && release_arrangement_placeholder "$followup"; then
    report_finding "$file" "$idx" "RELEASE_PLAN_FIELD_PLACEHOLDER" "release_followup must be concrete and must not be a placeholder."
    fail_count=$((fail_count + 1))
  fi

  if [[ "$scope" == "not-applicable" ]]; then
    if [[ "$entrypoint_count" -eq 1 && "$entrypoint" != "none" ]]; then
      report_finding "$file" "$idx" "RELEASE_PLAN_NOT_APPLICABLE_ENTRYPOINT_INVALID" "not-applicable release_scope requires release_entrypoint=none."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$reason_count" -eq 1 ]] && ! release_not_applicable_reason_is_concrete "$reason"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_NOT_APPLICABLE_REASON_INVALID" "not-applicable release_reason must explain the checked absence or non-requirement of release."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$followup_count" -eq 1 ]] && ! release_not_applicable_followup_is_concrete "$followup"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_FOLLOWUP_INVALID" "not-applicable release_followup must state why no release handoff follows."
      fail_count=$((fail_count + 1))
    fi
    if release_plan_has_release_task "$task_orchestration" 1 \
      || release_plan_has_release_evidence "$acceptance_validation" \
      || release_plan_contains_release_terminal_stop "$release_stop_condition"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_SCOPE_CONTRADICTION" "not-applicable release_scope cannot contain a release task, release evidence, or a release terminal stop."
      fail_count=$((fail_count + 1))
    fi
  elif [[ "$scope" == "included" ]]; then
    if [[ "$flow_type" == "fast-track" && "$flow_source" != "user_explicit" ]]; then
      if [[ "$flow_source" != "default_fast_track" && -n "$flow_source" ]]; then
        report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_FLOW_SOURCE_INVALID" "included fast-track release_scope requires a recognized flow_source; unknown flow evidence cannot authorize release delivery."
      else
        report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_AUTHORIZATION_INVALID" "included fast-track release_scope requires an explicit owner merge intent; release metadata cannot elevate default fast-track authorization."
      fi
      fail_count=$((fail_count + 1))
    fi
    if [[ "$reason_count" -eq 1 ]] && ! release_included_reason_is_concrete "$reason"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_REASON_INVALID" "included release_reason must ground release delivery in this plan and the checked repository or workflow."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$followup_count" -eq 1 ]] && ! release_included_followup_is_concrete "$followup"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_FOLLOWUP_INVALID" "included release_followup must name the release handoff and its version or channel decision."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$entrypoint_count" -eq 1 && "$entrypoint" == "none" ]]; then
      report_finding "$file" "$idx" "RELEASE_PLAN_ENTRYPOINT_INVALID" "included release_scope requires a repository-native release entrypoint."
      fail_count=$((fail_count + 1))
    elif [[ "$entrypoint_count" -eq 1 ]] && ! release_arrangement_entrypoint_is_native "$entrypoint"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_ENTRYPOINT_INVALID" "included release_entrypoint must name a repository-native document, command, or workflow."
      fail_count=$((fail_count + 1))
    fi
    if ! release_plan_has_release_task "$task_orchestration"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_TASK_MISSING" "included release_scope requires a release or publication task in Task Orchestration."
      fail_count=$((fail_count + 1))
    fi
    if ! release_plan_has_release_evidence "$acceptance_validation"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_EVIDENCE_MISSING" "included release_scope requires at least one release: evidence item."
      fail_count=$((fail_count + 1))
    fi
    if ! release_included_stop_is_flow_compatible "$flow_type" "$release_stop_condition"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_STOP_INVALID" "included release_scope is incompatible with the selected flow's non-publishing stop."
      fail_count=$((fail_count + 1))
    elif [[ "$flow_type" != "initiative" ]] && ! release_plan_has_release_terminal_stop "$release_stop_condition"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_STOP_INVALID" "included release_scope requires a release-capable terminal stop."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$flow_type" == "fast-track" ]] && ! grep -Eiq '(merge-only|merge\+cleanup)' < <(printf '%s\n' "$release_stop_condition"); then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_STOP_INVALID" "fast-track included release_scope requires an explicitly authorized merge/release stop."
      fail_count=$((fail_count + 1))
    elif [[ "$flow_type" == "parallel-pr" ]] && ! grep -Eiq '(merge-on-green|merge-only|merge\+cleanup)' < <(printf '%s\n' "$release_stop_condition"); then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_STOP_INVALID" "parallel-pr included release_scope requires an explicitly authorized merge/release stop."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$flow_type" == "parallel-pr" ]] \
      && ! grep -Eiq '^[[:space:]]*-[[:space:]]+task:pr-[a-z0-9]+[[:space:]]+=>.*merge_mode=merge-on-green[[:space:]]*$' < <(extract_section "$plan_text" "Parallel PR Contracts"); then
      report_finding "$file" "$idx" "RELEASE_PLAN_INCLUDED_PARALLEL_MERGE_MODE_INVALID" "parallel-pr included release_scope requires at least one task contract with merge_mode=merge-on-green."
      fail_count=$((fail_count + 1))
    fi
  elif [[ "$scope" == "deferred" ]]; then
    if [[ "$reason_count" -eq 1 ]] && { release_arrangement_scope_contradiction "$reason" || ! release_deferred_reason_is_concrete "$reason"; }; then
      report_finding "$file" "$idx" "RELEASE_PLAN_DEFERRED_REASON_INVALID" "deferred release_reason must identify the available release mechanism and why this plan stops before it."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$entrypoint_count" -eq 1 && "$entrypoint" == "none" ]]; then
      report_finding "$file" "$idx" "RELEASE_PLAN_ENTRYPOINT_INVALID" "deferred release_scope requires a repository-native release entrypoint."
      fail_count=$((fail_count + 1))
    elif [[ "$entrypoint_count" -eq 1 ]] && ! release_arrangement_entrypoint_is_native "$entrypoint"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_ENTRYPOINT_INVALID" "deferred release_entrypoint must name a repository-native document, command, or workflow."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$followup_count" -eq 1 ]] && { release_arrangement_scope_contradiction "$followup" || ! grep -Eiq '(after|post|next|follow|handoff|后续|合并后|停靠后|之后|后).{0,80}(release|publish|version|channel|发布|发版|版本|渠道)|(release|publish|version|channel|发布|发版|版本|渠道).{0,80}(after|post|next|follow|handoff|后续|合并后|停靠后|之后|后)' < <(printf '%s\n' "$followup") || ! release_deferred_followup_has_prerequisite "$followup"; }; then
      report_finding "$file" "$idx" "RELEASE_PLAN_DEFERRED_FOLLOWUP_INVALID" "deferred release_followup must name the post-stop release handoff and version or channel decision."
      fail_count=$((fail_count + 1))
    fi
    if release_plan_has_release_task "$task_orchestration" 1 \
      || release_plan_has_release_evidence "$acceptance_validation" \
      || release_plan_contains_release_terminal_stop "$release_stop_condition"; then
      report_finding "$file" "$idx" "RELEASE_PLAN_SCOPE_CONTRADICTION" "deferred release_scope cannot contain a release task, release evidence, or a release terminal stop."
      fail_count=$((fail_count + 1))
    fi
  fi

  return "$fail_count"
}

check_plan_block() {
  local file="$1"
  local idx="$2"
  local plan_text="$3"
  local flow_locked_before="$4"
  local flow_question_before="$5"
  local flow_locked_type="$6"
  local default_fast_track_eligible_before="$7"
  local owner_explicit_baseline="$8"
  local routing_context="$9"
  local default_parallel_pr_eligible_before="${10:-0}"
  local fail_count=0
  local has_all_required_sections=1

  if ! grep -Fq "## Summary" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_SUMMARY_SECTION" "Missing required section: ## Summary"
    fail_count=$((fail_count + 1))
    has_all_required_sections=0
  fi
  if ! grep -Fq "## Flow Decision" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_SECTION" "Missing required section: ## Flow Decision"
    fail_count=$((fail_count + 1))
    has_all_required_sections=0
  fi
  if ! grep -Fq "## Goals" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_GOALS_SECTION" "Missing required section: ## Goals"
    fail_count=$((fail_count + 1))
    has_all_required_sections=0
  fi
  if ! grep -Fq "## Non-goals" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_NON_GOALS_SECTION" "Missing required section: ## Non-goals"
    fail_count=$((fail_count + 1))
    has_all_required_sections=0
  fi
  if ! grep -Fq "## Acceptance & Validation" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_SECTION" "Missing required section: ## Acceptance & Validation"
    fail_count=$((fail_count + 1))
    has_all_required_sections=0
  fi
  if ! grep -Fq "## Assumptions/Defaults" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "MISSING_SECTION" "Missing required section: ## Assumptions/Defaults"
    fail_count=$((fail_count + 1))
    has_all_required_sections=0
  fi

  local flow_type_raw flow_type
  flow_type_raw="$(extract_flow_decision_field "$plan_text" "flow_type")"
  flow_type="$(normalize_flow_type "$flow_type_raw")"
  local flow_source
  flow_source="$(extract_flow_decision_field "$plan_text" "flow_source")"
  local lock_status
  lock_status="$(extract_flow_decision_field "$plan_text" "lock_status")"
  local development_baseline
  development_baseline="$(extract_plan_development_baseline "$plan_text")"
  local delivery_topology integration_branch child_merge_policy child_integration_policy child_owner_gate_policy final_merge_policy ticket_plan_policy schema_version schema_version_count initiative_contract_version initiative_contract_version_count promotion_policy promotion_policy_count integration_ci_surface integration_ci_surface_count integration_ci_check integration_ci_check_count plan_kind plan_kind_count final_base final_base_count spec_disposition spec_disposition_count spec_path spec_path_count supersedes_path supersedes_path_count spec_at_baseline adr_contracts adr_contracts_count task_orchestration tracking_issue_url tracking_issue_url_count bootstrap_contract_digest bootstrap_contract_digest_count ticket_topology_source ticket_topology_source_count ticket_topology_digest ticket_topology_digest_count ticket_source_sha ticket_source_sha_count native_task_budget native_task_budget_count
  delivery_topology="$(extract_flow_decision_field "$plan_text" "delivery_topology")"
  integration_branch="$(extract_flow_decision_field "$plan_text" "integration_branch")"
  child_merge_policy="$(extract_flow_decision_field "$plan_text" "child_merge_policy")"
  child_integration_policy="$(extract_flow_decision_field "$plan_text" "child_integration_policy")"
  child_owner_gate_policy="$(extract_flow_decision_field "$plan_text" "child_owner_gate_policy")"
  final_merge_policy="$(extract_flow_decision_field "$plan_text" "final_merge_policy")"
  ticket_plan_policy="$(extract_flow_decision_field "$plan_text" "ticket_plan_policy")"
  schema_version="$(extract_flow_decision_field "$plan_text" "schema_version")"
  schema_version_count="$(count_flow_decision_field "$plan_text" "schema_version")"
  initiative_contract_version="$(extract_flow_decision_field "$plan_text" "initiative_contract_version")"
  initiative_contract_version_count="$(count_flow_decision_field "$plan_text" "initiative_contract_version")"
  promotion_policy="$(extract_flow_decision_field "$plan_text" "promotion_policy")"
  promotion_policy_count="$(count_flow_decision_field "$plan_text" "promotion_policy")"
  integration_ci_surface="$(extract_flow_decision_field "$plan_text" "integration_ci_surface")"
  integration_ci_surface_count="$(count_flow_decision_field "$plan_text" "integration_ci_surface")"
  integration_ci_check="$(extract_flow_decision_field "$plan_text" "integration_ci_check")"
  integration_ci_check_count="$(count_flow_decision_field "$plan_text" "integration_ci_check")"
  plan_kind="$(extract_flow_decision_field "$plan_text" "plan_kind")"
  plan_kind_count="$(count_flow_decision_field "$plan_text" "plan_kind")"
  final_base="$(extract_flow_decision_field "$plan_text" "final_base")"
  final_base_count="$(count_flow_decision_field "$plan_text" "final_base")"
  tracking_issue_url="$(extract_flow_decision_field "$plan_text" "tracking_issue_url")"
  tracking_issue_url_count="$(count_flow_decision_field "$plan_text" "tracking_issue_url")"
  bootstrap_contract_digest="$(extract_flow_decision_field "$plan_text" "bootstrap_contract_digest")"
  bootstrap_contract_digest_count="$(count_flow_decision_field "$plan_text" "bootstrap_contract_digest")"
  ticket_topology_source="$(extract_flow_decision_field "$plan_text" "ticket_topology_source")"
  ticket_topology_source_count="$(count_flow_decision_field "$plan_text" "ticket_topology_source")"
  ticket_topology_digest="$(extract_flow_decision_field "$plan_text" "ticket_topology_digest")"
  ticket_topology_digest_count="$(count_flow_decision_field "$plan_text" "ticket_topology_digest")"
  ticket_source_sha="$(extract_flow_decision_field "$plan_text" "ticket_source_sha")"
  ticket_source_sha_count="$(count_flow_decision_field "$plan_text" "ticket_source_sha")"
  native_task_budget="$(extract_flow_decision_field "$plan_text" "native_task_budget")"
  native_task_budget_count="$(count_flow_decision_field "$plan_text" "native_task_budget")"
  spec_disposition="$(extract_flow_decision_field "$plan_text" "spec_disposition")"
  spec_disposition_count="$(count_flow_decision_field "$plan_text" "spec_disposition")"
  spec_path="$(extract_flow_decision_field "$plan_text" "spec_path")"
  spec_path_count="$(count_flow_decision_field "$plan_text" "spec_path")"
  supersedes_path="$(extract_flow_decision_field "$plan_text" "supersedes_path")"
  supersedes_path_count="$(count_flow_decision_field "$plan_text" "supersedes_path")"
  spec_at_baseline="$(extract_flow_decision_field "$plan_text" "spec_at_baseline")"
  adr_contracts="$(extract_flow_decision_field "$plan_text" "adr_contracts")"
  adr_contracts_count="$(count_flow_decision_field "$plan_text" "adr_contracts")"
  task_orchestration="$(extract_section "$plan_text" "Task Orchestration")"

  check_release_plan_contract "$file" "$idx" "$plan_text" "$flow_type" "$routing_context" || fail_count=$((fail_count + $?))

  if [[ "$flow_type" == "parallel-pr" ]] && ! grep -Fq "## Parallel PR Contracts" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "PARALLEL_PR_CONTRACTS_SECTION_REQUIRED" "parallel-pr plans require ## Parallel PR Contracts."
    fail_count=$((fail_count + 1))
  fi

  if [[ -z "$flow_type_raw" ]]; then
    report_finding "$file" "$idx" "MISSING_FLOW_TYPE" "Flow Decision must define flow_type."
    fail_count=$((fail_count + 1))
  elif [[ -z "$flow_type" ]]; then
    report_finding "$file" "$idx" "UNKNOWN_FLOW_TYPE" "Unknown flow_type=${flow_type_raw}."
    fail_count=$((fail_count + 1))
  fi
  if [[ -z "$flow_source" ]]; then
    report_finding "$file" "$idx" "MISSING_FLOW_SOURCE" "Flow Decision must define flow_source."
    fail_count=$((fail_count + 1))
  fi
  if [[ -z "$lock_status" ]]; then
    report_finding "$file" "$idx" "MISSING_LOCK_STATUS" "Flow Decision must define lock_status."
    fail_count=$((fail_count + 1))
  elif [[ "$idx" == "raw" && "$lock_status" != "locked" ]]; then
    report_finding "$file" "$idx" "LOCK_STATUS_NOT_LOCKED" "Finalized raw plans require lock_status=locked."
    fail_count=$((fail_count + 1))
  fi
  if [[ -z "$development_baseline" ]]; then
    report_finding "$file" "$idx" "MISSING_DEVELOPMENT_BASELINE" "Flow Decision must define 开发基线."
    fail_count=$((fail_count + 1))
  elif is_abstract_development_baseline "$development_baseline"; then
    report_finding "$file" "$idx" "ABSTRACT_DEVELOPMENT_BASELINE" "Flow Decision 开发基线 must be a concrete branch/ref or commit, not an abstract mainline phrase."
    fail_count=$((fail_count + 1))
  elif ! is_concrete_development_baseline "$development_baseline"; then
    report_finding "$file" "$idx" "INVALID_DEVELOPMENT_BASELINE" "Flow Decision 开发基线 must be a concrete branch/ref or commit."
    fail_count=$((fail_count + 1))
  fi
  if [[ "$idx" == "raw" && "$flow_type" == "initiative" && ! "$development_baseline" =~ ^[0-9a-fA-F]{40}$ ]]; then
    report_finding "$file" "$idx" "INITIATIVE_DEVELOPMENT_BASE_SHA_REQUIRED" "V5 Initiative plans must freeze development_base as an exact 40-character commit SHA."
    fail_count=$((fail_count + 1))
  fi
  if [[ -n "$delivery_topology" ]]; then
    report_finding "$file" "$idx" "INITIATIVE_ROUTING_FIELD_FORBIDDEN" "V5 Initiative plans derive topology from Bootstrap and must not emit delivery_topology."
    if [[ "$idx" != "raw" ]]; then
      report_finding "$file" "$idx" "LEGACY_ROUTING_FIELD_FORBIDDEN" "Historical replay plans must not introduce a new delivery_topology field."
    fi
    fail_count=$((fail_count + 1))
  fi
  if [[ "$flow_type" == "initiative" ]]; then
    if [[ "$schema_version_count" -ne 1 || "$schema_version" != "5" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_SCHEMA_VERSION_REQUIRED" "V5 initiative requires exactly one schema_version=5."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$initiative_contract_version_count" -ne 1 || "$initiative_contract_version" != "5" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_CONTRACT_VERSION_REQUIRED" "initiative requires initiative_contract_version=5."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$promotion_policy_count" -ne 1 || ( "$promotion_policy" != "final-only" && "$promotion_policy" != "checkpointed" ) ]]; then
      report_finding "$file" "$idx" "INITIATIVE_V5_PROMOTION_POLICY_REQUIRED" "V5 initiative requires promotion_policy=final-only|checkpointed."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$integration_ci_surface_count" -ne 1 || "$integration_ci_surface" != "branch-push" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_V5_CI_SURFACE_REQUIRED" "V5 initiative requires integration_ci_surface=branch-push for Child Integration CI."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$integration_ci_check_count" -ne 1 || -z "$integration_ci_check" || "$integration_ci_check" =~ [[:space:]] ]]; then
      report_finding "$file" "$idx" "INITIATIVE_V5_CI_CHECK_REQUIRED" "V5 initiative requires a non-empty exact integration_ci_check."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$plan_kind_count" -ne 1 || ( "$plan_kind" != "bootstrap" && "$plan_kind" != "delivery" ) ]]; then
      report_finding "$file" "$idx" "INITIATIVE_PLAN_KIND_REQUIRED" "initiative requires plan_kind=bootstrap|delivery."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$final_base_count" -ne 1 || ! "$final_base" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ || "$final_base" == *".."* || "$final_base" == "$integration_branch" ]] \
      || ! git check-ref-format --branch "$final_base" >/dev/null 2>&1; then
      report_finding "$file" "$idx" "INITIATIVE_FINAL_BASE_REQUIRED" "V5 initiative requires exactly one valid final_base distinct from integration_branch."
      fail_count=$((fail_count + 1))
    fi
    check_initiative_adr_contracts "$file" "$idx" "$adr_contracts" "$adr_contracts_count" || fail_count=$((fail_count + $?))
    if [[ ! "$integration_branch" =~ ^prd/[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
      report_finding "$file" "$idx" "INITIATIVE_INTEGRATION_BRANCH_MISSING" "initiative requires integration_branch=prd/<lowercase-kebab-case-topic>."
      fail_count=$((fail_count + 1))
    fi
    if [[ -n "$child_merge_policy" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_CHILD_POLICY_FORBIDDEN" "V5 initiative plans must not emit child_merge_policy."
      fail_count=$((fail_count + 1))
    fi
    local unsupported_ci_field
    unsupported_ci_field="$(extract_section "$plan_text" "Flow Decision" | sed -nE 's/^[[:space:]]*-[[:space:]]+`?([A-Za-z0-9_]+)`?[[:space:]]*:.*/\1/p' | grep -E '(^|_)(ci|preflight|workflow|provision|activation)($|_)' | grep -Ev '^(integration_ci_surface|integration_ci_check)$' || true)"
    if [[ -n "$unsupported_ci_field" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_CI_PROVISIONING_FIELD_FORBIDDEN" "V5 Bootstrap uses disposition-bound activation and must not declare a CI provisioning field."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$plan_kind" == "bootstrap" && "$task_orchestration" =~ task: ]]; then
      report_finding "$file" "$idx" "INITIATIVE_BOOTSTRAP_TASKS_FORBIDDEN" "Bootstrap plans must not declare Ticket task orchestration."
      fail_count=$((fail_count + 1))
    elif [[ "$plan_kind" == "delivery" && ! "$task_orchestration" =~ task: ]]; then
      report_finding "$file" "$idx" "INITIATIVE_DELIVERY_TASKS_REQUIRED" "Delivery plans must declare task orchestration derived from published Tickets."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$plan_kind" == "bootstrap" ]]; then
      if [[ "$tracking_issue_url_count" -ne 0 || "$bootstrap_contract_digest_count" -ne 0 || "$ticket_topology_source_count" -ne 0 || "$ticket_topology_digest_count" -ne 0 || "$ticket_source_sha_count" -ne 0 ]]; then
        report_finding "$file" "$idx" "INITIATIVE_BOOTSTRAP_DELIVERY_FACTS_FORBIDDEN" "Bootstrap plans must not emit Delivery topology facts."
        fail_count=$((fail_count + 1))
      fi
      if [[ "$native_task_budget_count" -gt 1 || ( -n "$native_task_budget" && "$native_task_budget" != "0" ) ]]; then
        report_finding "$file" "$idx" "INITIATIVE_BOOTSTRAP_BUDGET_INVALID" "Bootstrap native_task_budget must be omitted or 0."
        fail_count=$((fail_count + 1))
      fi
    elif [[ "$plan_kind" == "delivery" ]]; then
      if [[ "$tracking_issue_url_count" -ne 1 || ! "$tracking_issue_url" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[1-9][0-9]*$ ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_TRACKING_REQUIRED" "Delivery requires canonical tracking_issue_url."
        fail_count=$((fail_count + 1))
      fi
      if [[ "$bootstrap_contract_digest_count" -ne 1 || ! "$bootstrap_contract_digest" =~ ^[0-9a-f]{64}$ ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_BOOTSTRAP_DIGEST_REQUIRED" "Delivery requires bootstrap_contract_digest SHA-256."
        fail_count=$((fail_count + 1))
      fi
      if [[ "$ticket_topology_source_count" -ne 1 || "$ticket_topology_source" != "to-tickets" ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_TOPOLOGY_SOURCE_REQUIRED" "Delivery requires ticket_topology_source=to-tickets."
        fail_count=$((fail_count + 1))
      fi
      if [[ "$ticket_topology_digest_count" -ne 1 || "$ticket_source_sha_count" -ne 1 || ! "$ticket_topology_digest" =~ ^[0-9a-f]{64}$ || ! "$ticket_source_sha" =~ ^[0-9a-f]{40}$ ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_TOPOLOGY_FREEZE_REQUIRED" "Delivery requires exact topology digest and ticket source SHA."
        fail_count=$((fail_count + 1))
      fi
      local delivery_task_count
      delivery_task_count="$(printf '%s\n' "$task_orchestration" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:([^[:space:][]+).*$/\1/p' | sort -u | sed '/^$/d' | wc -l | tr -d '[:space:]')"
      if [[ "$native_task_budget_count" -ne 1 || ! "$native_task_budget" =~ ^[1-9][0-9]*$ ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_BUDGET_REQUIRED" "Delivery requires a positive native_task_budget derived from topology."
        fail_count=$((fail_count + 1))
      elif [[ "$native_task_budget" -ne "$delivery_task_count" ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_BUDGET_TOPOLOGY_MISMATCH" "Delivery native_task_budget must equal the exact task:issue-<number> topology mapping count."
        fail_count=$((fail_count + 1))
      fi
      local non_issue_task_names
      non_issue_task_names="$(printf '%s\n' "$task_orchestration" | sed -nE 's/^[[:space:]]*-[[:space:]]+task:([^[:space:][]+).*$/\1/p' | grep -Ev '^issue-[1-9][0-9]*$' || true)"
      if [[ -n "$non_issue_task_names" ]]; then
        report_finding "$file" "$idx" "INITIATIVE_DELIVERY_TASK_NAME_INVALID" "Delivery task executors must use task:issue-<number>."
        fail_count=$((fail_count + 1))
      fi
    fi
    if [[ -n "$spec_at_baseline" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_SPEC_BASELINE_FORBIDDEN" "initiative forbids spec_at_baseline; use spec_disposition and spec_path."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$spec_disposition_count" -ne 1 || ! "$spec_disposition" =~ ^(reuse|refresh|create|supersede)$ ]]; then
      report_finding "$file" "$idx" "INITIATIVE_SPEC_DISPOSITION_INVALID" "initiative requires spec_disposition=reuse|refresh|create|supersede."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$spec_path_count" -ne 1 || ! "$spec_path" =~ ^docs/specs/[a-z0-9]+(-[a-z0-9]+)*/SPEC\.md$ ]] || [[ "$spec_path" == *".."* ]]; then
      report_finding "$file" "$idx" "INITIATIVE_SPEC_PATH_INVALID" "V5 initiative requires a canonical repository-relative Spec path."
      fail_count=$((fail_count + 1))
    fi
    local initiative_topic="${integration_branch#prd/}"
    if [[ "$spec_path" != "docs/specs/${initiative_topic}/SPEC.md" ]]; then
      report_finding "$file" "$idx" "INITIATIVE_SPEC_PATH_CANONICAL_REQUIRED" "V5 initiative requires spec_path=docs/specs/<topic>/SPEC.md."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$spec_disposition" == "supersede" ]]; then
      if [[ "$supersedes_path_count" -ne 1 || -z "$supersedes_path" || "$supersedes_path" == "$spec_path" || "$supersedes_path" == *".."* ]] \
        || [[ ! "$supersedes_path" =~ ^docs/specs/[a-z0-9]+(-[a-z0-9]+)*/SPEC\.md$ ]]; then
        report_finding "$file" "$idx" "INITIATIVE_SUPERSEDES_PATH_REQUIRED" "supersede requires a distinct canonical predecessor Spec path."
        fail_count=$((fail_count + 1))
      fi
    elif [[ "$supersedes_path_count" -ne 0 ]]; then
      report_finding "$file" "$idx" "INITIATIVE_SUPERSEDES_PATH_FORBIDDEN" "supersedes_path is valid only for spec_disposition=supersede."
      fail_count=$((fail_count + 1))
    fi
  fi
  check_direct_formal_review_contract "$file" "$idx" "$plan_text" "$flow_type" || fail_count=$((fail_count + $?))
  check_direct_empirical_acceptance_contract "$file" "$idx" "$plan_text" "$flow_type" || fail_count=$((fail_count + $?))
  if [[ -n "$owner_explicit_baseline" && -n "$development_baseline" ]]; then
    local owner_baseline_cmp plan_baseline_cmp
    owner_baseline_cmp="$(normalize_baseline_compare_value "$owner_explicit_baseline")"
    plan_baseline_cmp="$(normalize_baseline_compare_value "$development_baseline")"
    if [[ "$owner_baseline_cmp" != "$plan_baseline_cmp" ]]; then
      report_finding "$file" "$idx" "OWNER_BASELINE_MISMATCH" "Flow Decision 开发基线=${development_baseline} does not match owner explicit baseline=${owner_explicit_baseline}."
      fail_count=$((fail_count + 1))
    fi
  fi

  if [[ "$flow_source" == "default_fast_track" ]]; then
    if [[ "$flow_type" != "fast-track" ]]; then
      report_finding "$file" "$idx" "DEFAULT_FAST_TRACK_INVALID_FLOW_DECISION" "flow_source=default_fast_track requires flow_type=fast-track."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$lock_status" != "locked" ]]; then
      report_finding "$file" "$idx" "DEFAULT_FAST_TRACK_INVALID_FLOW_DECISION" "flow_source=default_fast_track requires lock_status=locked."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$flow_locked_before" -eq 1 ]]; then
      report_finding "$file" "$idx" "DEFAULT_FAST_TRACK_OVERRIDES_EXPLICIT_LOCK" "default_fast_track must not override an already resolved explicit flow lock."
      fail_count=$((fail_count + 1))
    elif [[ "$default_fast_track_eligible_before" -ne 1 ]]; then
      report_finding "$file" "$idx" "DEFAULT_FAST_TRACK_NOT_ALLOWED_HERE" "default_fast_track may only be used for a no-signal happy path without ambiguity or unrelated blockers."
      fail_count=$((fail_count + 1))
    fi
    if ! contains_merge_ready_stop_condition "$plan_text"; then
      report_finding "$file" "$idx" "DEFAULT_FAST_TRACK_MISSING_MERGE_READY_STOP" "default_fast_track plan must explicitly stop at merge-ready / Step 5C Ready."
      fail_count=$((fail_count + 1))
    fi
  fi
  if [[ "$flow_source" == "default_initiative_complexity" ]]; then
    if [[ "$flow_type" != "initiative" || "$lock_status" != "locked" ]]; then
      report_finding "$file" "$idx" "DEFAULT_INITIATIVE_INVALID_FLOW_DECISION" "default_initiative_complexity requires locked flow_type=initiative."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$flow_locked_before" -eq 1 ]]; then
      report_finding "$file" "$idx" "DEFAULT_INITIATIVE_OVERRIDES_EXPLICIT_LOCK" "default_initiative_complexity must not override an explicit flow lock."
      fail_count=$((fail_count + 1))
    fi
    if ! initiative_eligibility_proved "$routing_context"$'\n'"$plan_text"; then
      report_finding "$file" "$idx" "DEFAULT_INITIATIVE_ELIGIBILITY_UNPROVEN" "default_initiative_complexity requires at least two independently acceptable and mergeable Tickets plus an Initiative mechanism."
      fail_count=$((fail_count + 1))
    fi
  fi
  if [[ "$flow_source" == "default_parallel_pr" ]]; then
    if [[ "$flow_type" != "parallel-pr" || "$lock_status" != "locked" ]]; then
      report_finding "$file" "$idx" "DEFAULT_PARALLEL_PR_INVALID_FLOW_DECISION" "default_parallel_pr requires locked flow_type=parallel-pr."
      fail_count=$((fail_count + 1))
    fi
    if [[ "$flow_locked_before" -eq 1 ]]; then
      report_finding "$file" "$idx" "DEFAULT_PARALLEL_PR_OVERRIDES_EXPLICIT_LOCK" "default_parallel_pr must not override an explicit flow lock."
      fail_count=$((fail_count + 1))
    elif [[ "$default_parallel_pr_eligible_before" -ne 1 ]] && ! parallel_pr_eligibility_proved "$routing_context"$'\n'"$plan_text"; then
      report_finding "$file" "$idx" "DEFAULT_PARALLEL_PR_ELIGIBILITY_UNPROVEN" "default_parallel_pr requires proven independent direct PR slices with no dependencies."
      fail_count=$((fail_count + 1))
    fi
    if ! contains_merge_ready_stop_condition "$plan_text"; then
      report_finding "$file" "$idx" "DEFAULT_PARALLEL_PR_MISSING_MERGE_READY_STOP" "default_parallel_pr plans must explicitly stop at merge-ready / Step 5C Ready."
      fail_count=$((fail_count + 1))
    fi
  fi
  if [[ "$flow_type" == "initiative" || "$flow_locked_type" == "initiative" || "$flow_source" == "default_initiative_complexity" ]] \
    && initiative_prerequisites_unavailable "$routing_context"; then
    report_finding "$file" "$idx" "INITIATIVE_PREREQUISITES_UNAVAILABLE" "Initiative prerequisites are unavailable; block instead of emitting a downgraded plan."
    fail_count=$((fail_count + 1))
  fi

  if grep -Fq "## Execution Steps" < <(printf '%s\n' "$plan_text"); then
    report_finding "$file" "$idx" "REDUNDANT_EXECUTION_STEPS_SECTION" "Execution Steps must be merged into Task Orchestration."
    fail_count=$((fail_count + 1))
  fi

  if [[ "$flow_locked_before" -eq 0 && "$flow_source" != "default_fast_track" && "$flow_source" != "default_initiative_complexity" && "$flow_source" != "default_parallel_pr" ]]; then
    report_finding "$file" "$idx" "FLOW_NOT_LOCKED_BEFORE_PLAN" "proposed_plan emitted before flow lock."
    fail_count=$((fail_count + 1))
    if [[ "$flow_question_before" -eq 0 ]]; then
      report_finding "$file" "$idx" "FLOW_QUESTION_MISSING" "No valid request_user_input flow_type question found before proposed_plan."
      fail_count=$((fail_count + 1))
    else
      report_finding "$file" "$idx" "FLOW_LOCK_EVIDENCE_MISSING" "flow_type question exists but no valid lock evidence before proposed_plan."
      fail_count=$((fail_count + 1))
    fi
  fi
  if [[ "$flow_locked_before" -eq 1 && -n "$flow_locked_type" && -n "$flow_type" && "$flow_locked_type" != "$flow_type" ]]; then
    report_finding "$file" "$idx" "FLOW_DECISION_MISMATCH_LOCK" "Flow Decision flow_type=${flow_type} does not match locked flow_type=${flow_locked_type}."
    fail_count=$((fail_count + 1))
  fi

  if [[ "$has_all_required_sections" -eq 1 ]]; then
    check_required_section_order "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  check_provenance_leaks "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  if grep -Fq "## Summary" < <(printf '%s\n' "$plan_text"); then
    check_summary "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  if grep -Fq "## Goals" < <(printf '%s\n' "$plan_text"); then
    check_goals "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  if grep -Fq "## Non-goals" < <(printf '%s\n' "$plan_text"); then
    check_non_goals "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  if grep -Fq "## Constraints" < <(printf '%s\n' "$plan_text"); then
    check_constraints "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  check_task_orchestration "$file" "$idx" "$plan_text" "$flow_type" || fail_count=$((fail_count + $?))
  if [[ "$flow_type" == "parallel-pr" ]]; then
    check_parallel_pr_contract "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  elif [[ "$flow_type" == "wave-thread" ]]; then
    check_wave_thread_contract "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  if grep -Fq "## Acceptance & Validation" < <(printf '%s\n' "$plan_text"); then
    check_acceptance "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
    if [[ "$flow_type" == "initiative" ]]; then
      check_initiative_acceptance_mappings "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
    fi
  fi
  if grep -Fq "## Assumptions/Defaults" < <(printf '%s\n' "$plan_text"); then
    check_assumptions "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
  fi
  if [[ "$flow_type" == "fast-track" ]]; then
    if [[ "$idx" == "raw" ]]; then
      check_fast_track_pr_contract "$file" "$idx" "$plan_text" || fail_count=$((fail_count + $?))
    fi
  fi

  return "$fail_count"
}

check_raw_plan() {
  local source="$1"
  local plan_text file_label flow_type flow_source
  if [[ "$source" == "-" ]]; then
    plan_text="$(cat)"
    file_label="<stdin>"
  else
    if [[ ! -f "$source" ]]; then
      echo "FINDING file=${source} idx=raw code=FILE_NOT_FOUND msg=Input plan file not found."
      return 1
    fi
    plan_text="$(cat "$source")"
    file_label="$source"
  fi

  flow_type="$(normalize_flow_type "$(extract_flow_decision_field "$plan_text" "flow_type")")"
  if [[ "$flow_type" == "retired-initiative" || "$flow_type" == "retired-parallel-pr" ]]; then
    echo "FINDING file=${file_label} idx=raw code=RETIRED_FLOW_TYPE msg=initiative and parallel-pr are retired; use flow_type=wave-thread."
    return 1
  fi
  flow_source="$(extract_flow_decision_field "$plan_text" "flow_source")"
  local flow_locked_before=1
  local flow_locked_type="$flow_type"
  local default_fast_track_eligible=0
  local default_parallel_pr_eligible=0
  if [[ "$flow_source" == "default_fast_track" ]]; then
    flow_locked_before=0
    flow_locked_type=""
    default_fast_track_eligible=1
  elif [[ "$flow_source" == "default_initiative_complexity" ]]; then
    flow_locked_before=0
    flow_locked_type=""
  elif [[ "$flow_source" == "default_parallel_pr" ]]; then
    flow_locked_before=0
    flow_locked_type=""
    default_parallel_pr_eligible=1
  fi

  if ! check_plan_block \
    "$file_label" "raw" "$plan_text" "$flow_locked_before" 0 "$flow_locked_type" \
    "$default_fast_track_eligible" "" "$plan_text" "$default_parallel_pr_eligible"; then
    return 1
  fi
  echo "PASS file=${file_label} checks=ok"
}

check_file() {
  local file="$1"
  local has_error=0
  local flow_locked=0
  local flow_locked_type=""
  local flow_question=0
  local flow_call_ids=""
  local plan_count=0
  local user_message_seen=0
  local default_fast_track_blocked=0
  local owner_explicit_baseline=""
  local routing_context=""

  if [[ ! -f "$file" ]]; then
    echo "FINDING file=${file} idx=- code=FILE_NOT_FOUND msg=Input file not found."
    return 1
  fi

  while IFS= read -r row; do
    local idx kind role text call_id
    idx="$(jq -r '.idx' < <(printf '%s\n' "$row"))"
    kind="$(jq -r '.kind' < <(printf '%s\n' "$row"))"
    role="$(jq -r '.role // ""' < <(printf '%s\n' "$row"))"
    text="$(jq -r '.text // ""' < <(printf '%s\n' "$row"))"
    call_id="$(jq -r '.call_id // ""' < <(printf '%s\n' "$row"))"

    if [[ "$kind" == "rui_call" ]]; then
      local flow_id_present flow_options_text
      flow_id_present="$(jq -r '.flow_id_present // false' < <(printf '%s\n' "$row"))"
      flow_options_text="$(jq -r '.flow_options_text // ""' < <(printf '%s\n' "$row"))"
      if [[ "$flow_id_present" == "true" ]]; then
        flow_question=1
        if [[ -n "$call_id" ]]; then
          if [[ -z "$flow_call_ids" ]]; then
            flow_call_ids="$call_id"
          else
            flow_call_ids+=$'\n'"$call_id"
          fi
        fi
      else
        default_fast_track_blocked=1
      fi
      continue
    fi

    if [[ "$kind" == "rui_out" ]]; then
      local flow_answer_text
      flow_answer_text="$(jq -r '.flow_answer_text // ""' < <(printf '%s\n' "$row"))"
      local normalized_flow
      normalized_flow="$(normalize_flow_type_loose "$flow_answer_text")"
      if contains_valid_flow_choice "$flow_answer_text"; then
        if [[ -z "$call_id" ]] || grep -Fqx -- "$call_id" < <(printf '%s\n' "$flow_call_ids"); then
          flow_locked=1
          if [[ -n "$normalized_flow" ]]; then
            flow_locked_type="$normalized_flow"
          fi
        fi
      fi
      continue
    fi

    if [[ "$kind" == "msg" && "$role" == "user" ]]; then
      if starts_new_plan_request_window "$text"; then
        if [[ "$flow_locked" -eq 0 && "$flow_question" -eq 1 ]] && is_flow_answer_followup "$text"; then
          :
        else
          flow_locked=0
          flow_locked_type=""
          flow_question=0
          flow_call_ids=""
          default_fast_track_blocked=0
          owner_explicit_baseline=""
          routing_context=""
        fi
      fi
      user_message_seen=1
      routing_context+=$'\n'"$text"
      if has_conflicting_explicit_flow_signals "$text"; then
        flow_locked=0
        flow_locked_type=""
        default_fast_track_blocked=1
        continue
      fi
      local explicit_flow
      explicit_flow="$(extract_explicit_flow_type "$text")"
      if [[ -n "$explicit_flow" ]]; then
        flow_locked=1
        flow_locked_type="$explicit_flow"
      fi
      local explicit_baseline
      explicit_baseline="$(extract_owner_explicit_baseline "$text" || true)"
      if [[ -n "$explicit_baseline" ]]; then
        owner_explicit_baseline="$explicit_baseline"
      fi
      if [[ -n "$explicit_flow" ]]; then
        continue
      fi
      if contains_unrelated_flow_wording "$text"; then
        default_fast_track_blocked=1
      fi
      if is_generic_continue_only "$text"; then
        default_fast_track_blocked=1
      fi
      continue
    fi

    if [[ "$kind" == "msg" && "$role" == "assistant" ]]; then
      if grep -q '<proposed_plan>' < <(printf '%s\n' "$text"); then
        plan_count=$((plan_count + 1))
        local plan_text
        local default_fast_track_eligible=0
        local default_parallel_pr_eligible=0
        if [[ "$flow_locked" -eq 0 && "$flow_question" -eq 0 && "$user_message_seen" -eq 1 && "$default_fast_track_blocked" -eq 0 ]]; then
          default_fast_track_eligible=1
        fi
        if [[ "$flow_locked" -eq 0 && "$flow_question" -eq 0 && "$user_message_seen" -eq 1 && "$default_fast_track_blocked" -eq 0 ]]; then
          if parallel_pr_eligibility_proved "$routing_context"; then
            default_parallel_pr_eligible=1
          fi
        fi
        plan_text="$(printf '%s\n' "$text" | sed -n '/<proposed_plan>/,/<\/proposed_plan>/p')"
        if ! check_plan_block "$file" "$idx" "$plan_text" "$flow_locked" "$flow_question" "$flow_locked_type" "$default_fast_track_eligible" "$owner_explicit_baseline" "$routing_context" "$default_parallel_pr_eligible"; then
          has_error=1
        fi
      fi
    fi
  done < <(jq -s -c '
      to_entries[]
      | .key as $idx
      | .value as $o
      | if ($o.type == "response_item" and $o.payload.type == "message") then
          {
            idx: $idx,
            kind: "msg",
            role: ($o.payload.role // ""),
            text: ((($o.payload.content // []) | map(.text // .input_text // .output_text // "") | join("\n")))
          }
        elif ($o.type == "response_item" and $o.payload.type == "function_call" and $o.payload.name == "request_user_input") then
          {
            idx: $idx,
            kind: "rui_call",
            call_id: ($o.payload.call_id // ""),
            flow_id_present: (
              try (
                (($o.payload.arguments // "{}") | fromjson | .questions // [])
                | map((.id // "") == "flow_type")
                | any
              ) catch false
            ),
            flow_options_text: (
              try (
                (($o.payload.arguments // "{}") | fromjson | .questions // [])
                | map(
                    select((.id // "") == "flow_type")
                    | (.options // [])
                    | map(.label // "")
                    | join("\n")
                  )
                | join("\n")
              ) catch ""
            )
          }
        elif ($o.type == "response_item" and $o.payload.type == "function_call_output") then
          {
            idx: $idx,
            kind: "rui_out",
            call_id: ($o.payload.call_id // ""),
            flow_answer_text: (
              try (
                (($o.payload.output // "{}") | fromjson | .answers.flow_type.answers // [])
                | map(tostring)
                | join("\n")
              ) catch ""
            )
          }
        else empty end
    ' "$file")

  if [[ "$plan_count" -eq 0 ]]; then
    echo "FINDING file=${file} idx=- code=NO_PROPOSED_PLAN msg=No proposed_plan block found."
    return 1
  fi

  if [[ "$has_error" -eq 1 ]]; then
    return 1
  fi

  echo "PASS file=${file} checks=ok"
  return 0
}

run_cases() {
  local cases_file="$1"
  local has_error=0
  local cases_dir=""

  if [[ ! -f "$cases_file" ]]; then
    echo "ERROR: cases file not found: ${cases_file}" >&2
    return 2
  fi

  cases_dir="$(cd "$(dirname "$cases_file")" && pwd)"

  while IFS= read -r line; do
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue

    local expect path required_code mode
    expect="$(awk '{print $1}' < <(printf '%s\n' "$line"))"
    path="$(awk '{print $2}' < <(printf '%s\n' "$line"))"
    required_code="$(awk '{print $3}' < <(printf '%s\n' "$line"))"
    required_code="${required_code:--}"
    mode="$(awk '{print $4}' < <(printf '%s\n' "$line"))"

    if [[ "$path" != /* ]]; then
      path="${cases_dir}/${path}"
    fi

    local raw_plan_case=0
    case "$mode" in
      ""|-)
        ;;
      raw-plan)
        raw_plan_case=1
        ;;
      *)
        echo "CASE_FAIL path=${path} invalid_mode=${mode}"
        has_error=1
        continue
        ;;
    esac

    set +e
    local output
    if [[ "$raw_plan_case" -eq 1 ]]; then
      output="$(check_raw_plan "$path" 2>&1)"
    else
      output="$(check_file "$path" 2>&1)"
    fi
    local rc=$?
    set -e
    printf '%s\n' "$output"

    if [[ "$expect" == "pass" && "$rc" -ne 0 ]]; then
      echo "CASE_FAIL path=${path} expected=pass actual=fail"
      has_error=1
      continue
    fi
    if [[ "$expect" == "fail" && "$rc" -eq 0 ]]; then
      echo "CASE_FAIL path=${path} expected=fail actual=pass"
      has_error=1
      continue
    fi
    if [[ "$expect" == "fail" && "$required_code" != "-" ]]; then
      if ! grep -q "code=${required_code}" < <(printf '%s\n' "$output"); then
        echo "CASE_FAIL path=${path} expected_code=${required_code} actual=missing"
        has_error=1
        continue
      fi
    fi
    echo "CASE_PASS path=${path} expected=${expect}"
  done <"$cases_file"

  if [[ "$has_error" -eq 1 ]]; then
    return 1
  fi
  return 0
}

main() {
  if [[ "${1:-}" == "--repo-root" ]]; then
    if [[ "$#" -lt 3 || ! -d "$2" ]]; then
      echo "ERROR: candidate repository root must be an existing directory." >&2
      usage >&2
      exit 2
    fi
    PLAN_CONTRACT_REPO_ROOT="$(cd "$2" && pwd -P)"
    shift 2
  fi

  if [[ "$#" -lt 1 ]]; then
    usage
    exit 2
  fi

  if [[ "${1:-}" == "--cases" ]]; then
    if [[ "$#" -ne 2 ]]; then
      usage
      exit 2
    fi
    require_tools
    run_cases "$2"
    exit $?
  fi

  if [[ "${1:-}" == "--plan" ]]; then
    if [[ "$#" -ne 2 ]]; then
      usage
      exit 2
    fi
    check_raw_plan "$2"
    exit $?
  fi

  if [[ "${1:-}" == "--wave-manifest" ]]; then
    if [[ "$#" -ne 2 ]]; then
      usage
      exit 2
    fi
    python3 "${PLAN_CONTRACT_REPO_ROOT}/skills/wave-thread-flow/scripts/wave_thread_flow.py" --manifest "$2" --check-only
    exit $?
  fi

  if [[ "${1:-}" == "--initiative-contract" || "${1:-}" == "--parallel-contract" ]]; then
    echo "ERROR: retired coordination contract; use --wave-manifest or flow_type=wave-thread." >&2
    exit 1
  fi

  require_tools

  if [[ "${1:-}" == "--emit-acceptance-manifest" ]]; then
    if [[ "$#" -ne 3 ]]; then
      usage
      exit 2
    fi
    local plan_text
    plan_text="$(jq -rs '
      [ .[]
        | select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant")
        | ((.payload.content // []) | map(.text // .input_text // .output_text // "") | join("\n"))
        | select(contains("<proposed_plan>"))
      ] | last // ""' "$2")"
    if [[ -z "$plan_text" ]]; then
      echo "ERROR: no proposed_plan found in $2" >&2
      exit 1
    fi
    printf '%s\n' "$plan_text" | python3 "$(dirname "$0")/plan_acceptance_manifest.py" --output "$3"
    exit $?
  fi

  if [[ "${1:-}" == --* ]]; then
    echo "ERROR: unknown option: ${1}" >&2
    usage >&2
    exit 2
  fi

  local overall=0
  local file
  for file in "$@"; do
    if ! check_file "$file"; then
      overall=1
    fi
  done
  exit "$overall"
}

main "$@"
