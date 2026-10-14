---
name: requirements-analysis
description: "Clarify goals, scope, and acceptance criteria."
---

# Requirements analysis

Use this skill when the request is ambiguous, high‑stakes, or likely to branch into multiple interpretations (new features, refactors, integrations, product changes, or “make it better” prompts). The goal is to converge on **a small, testable spec** before writing code.

## Guardrail: analysis-only unless explicitly requested

Treat requirements analysis as a **separate phase**.

- If the user has **not explicitly asked to implement**, you may at most produce documentation (requirements snapshot / PRD / spec / acceptance criteria) and clarifying questions.
- If you produce a doc/spec, avoid doc-level revision markers like “Draft”, “v1”, “初稿/终稿”, “修订记录” in filenames/titles/headers; rely on Git history instead.
- Do **not** write or modify implementation code, migrations, or configuration that changes runtime behavior during this phase.
- You may write/update **documentation/spec files only** when the user explicitly asks for a doc to be created/updated; keep changes limited to docs.
- If the user seems to expect code, ask a short confirmation: “Do you want me to start implementation now?”

## Output (default)

Produce a single requirements snapshot in the chat (or as a file if the user asks), containing:

1) **Problem statement** (1–3 sentences)
2) **Goals** (bullet list)
3) **Non-goals / out of scope** (bullet list)
4) **Users & scenarios** (who/when/why)
5) **Functional requirements** (prioritized; MUST/SHOULD/COULD)
6) **Non-functional requirements** (perf, reliability, security, privacy, accessibility, observability)
7) **Constraints** (tech stack, deadlines, policies, integrations, compatibility)
8) **Acceptance criteria** (Given/When/Then or checklist; include edge cases)
9) **Open questions** (explicitly listed)
10) **Assumptions** (only if user didn’t answer; mark as “assumption” and request confirmation)

If the user wants a doc, use `templates/requirements.md` as the base.

## When to stop analyzing and start building

Start implementation only when **all** are true:

- The main user goal is unambiguous.
- Scope boundaries (in/out) are stated.
- Acceptance criteria exist for the core path + major edge cases.
- Key constraints are known (platforms, dependencies, security/privacy, performance).
- Any remaining open questions are explicitly accepted as assumptions by the user.
- The user **explicitly asks** you to implement (or confirms when you ask).

## Workflow

1) **Restate the ask** in your own words; propose 1–2 interpretations if ambiguous.
2) **Ask only the minimal clarifying questions** needed to unblock (prefer 3–7 questions).
3) **Draft the requirements snapshot** with placeholders for unanswered items.
4) **Confirm** with the user; iterate quickly.
5) **Translate to an implementation plan** (tasks, milestones, risks) only after confirmation.

## Minimal clarifying questions (pick what’s relevant)

- What is the **primary goal** and what does “done” look like?
- Who are the **users** and what are the top **scenarios**?
- What is **in scope** vs **out of scope**?
- Are there **existing constraints** (stack, repo, APIs, SLAs, deadlines)?
- What are the **must-have** behaviors vs **nice-to-have**?
- Any **security/privacy/compliance** requirements (PII, authz, audit)?
- Expected **scale/performance** (latency, throughput, data size)?
- **Rollout**: behind a flag? backwards compatibility? migration?

## Acceptance criteria patterns

Prefer concrete, testable criteria:

- **Given/When/Then** for behavior
- **Examples** for tricky inputs/outputs
- **Error handling**: retries, timeouts, offline, invalid data
- **Observability**: logs/metrics/traces, dashboards, alerts
- **Compatibility**: supported OS/browsers/versions, API compatibility

## Special case: analyzing an existing codebase

If the user asks for a change in an existing repo but requirements are unclear:

1) Identify current behavior (screenshots/logs/tests if available).
2) Define “expected behavior” explicitly (acceptance criteria).
3) List constraints from the codebase (architecture, dependencies).
4) Propose a minimal change set and confirm.
