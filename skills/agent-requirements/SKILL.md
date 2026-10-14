---
name: agent-requirements
description: "Draft an agent brief from current context."
---

# Agent requirements brief

Use this skill when the user asks to **整理需求说明 / write a spec** intended for an Agent, especially when they emphasize **data requirements** (inputs, schemas, constraints, acceptance criteria).

The intent is to produce a **self-contained** requirements document that captures the *current conversation context*, while avoiding redundant project background that already exists on the repo’s mainline.

## Guardrails

- **Docs-first:** default to producing a requirements brief only (in chat, or as a file if asked). Do not change implementation code unless the user explicitly requests it.
- **No doc revision markers:** avoid doc-level labels like “Draft”, “v1”, “初稿/终稿”, “修订记录” in filenames/titles/headers; rely on Git history instead.
- **Context-aware, repo-light:** include enough from the current discussion to be actionable, but **do not copy/paste** existing project docs (README, architecture docs, etc.).
- **Mainline as the source of truth:** if the repository already documents its stack/setup/architecture on the main branch, **reference those files/paths** instead of restating them.
- **Only include project info if missing:** if mainline does **not** contain the minimum onboarding info (e.g., no README / no setup notes), include the **minimal necessary** project context so a new worktree/branch from main can proceed.
- **No guessing:** if key details are unknown, list them under **Open questions** and ask the smallest set of clarifying questions.

## Output (default)

Produce a single “Agent Requirements Brief” with the following sections (keep it crisp and skimmable):

1) **Context snapshot (from this conversation)**
   - 5–12 bullets capturing decisions, constraints, definitions, and “why now”.
   - Include concrete identifiers when available (dates, system names, environments, file paths, branch/base ref).

2) **Background**
   - What is the situation today? Why is this being done now?

3) **Problem statement**
   - 1–3 sentences stating what is wrong/missing and who it impacts.

4) **Goals**
   - Bullet list (prioritized). Prefer “MUST/SHOULD/COULD” if helpful.

5) **Non-goals / out of scope**
   - Explicitly list what should *not* be attempted.

6) **Deliverables**
   - What artifacts the Agent should produce (code changes? docs? datasets? reports? migrations? dashboards?).
   - If the work will start from mainline, state the **assumed base ref** (e.g. `origin/main`).

6.1) **Project references (do not duplicate)**
   - Link to existing docs by **file path** (e.g. `README.md`, `docs/...`) instead of restating them.

7) **Agent data spec (the core)**
   - **Inputs**
     - Data source(s): where they come from (files/DB/API), who owns them, access method.
     - Format: CSV/JSON/Parquet/SQL tables, encoding, compression, partitioning.
     - Schema: fields, types, required/optional, validation rules, constraints.
     - Volume & freshness: approximate size, update frequency, time range.
     - Quality: known issues, duplicates, missing values, canonical IDs, join keys.
     - Security/privacy: PII classification, retention rules, redaction requirements.
     - A **small example** (sample row/object) whenever possible.
   - **Transformations (if any)**
     - Normalization, mapping tables, dedupe rules, edge-case handling.
   - **Outputs**
     - Output artifacts: paths/names, format/schema, how consumers will use them.
     - Success metrics (if measurable).

8) **Interfaces & integration points**
   - APIs/endpoints/events, DB tables, queues, cron jobs, external services.
   - Contract expectations and error-handling behavior.

9) **Acceptance criteria (definition of done)**
   - Use a checklist and/or Given/When/Then.
   - Include: core path, major edge cases, and “how we verify”.

10) **Constraints**
   - Platforms, compatibility, performance, compliance, deadlines, rollout strategy.

11) **Open questions**
   - Any missing decisions/data access questions, clearly listed.

12) **Optional: suggested approach**
   - A brief recommended solution outline (only if it helps), with risks and tradeoffs.

If the user wants a file-based doc, use `templates/agent-requirements.md` as the base.
