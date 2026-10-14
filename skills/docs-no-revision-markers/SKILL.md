---
name: docs-no-revision-markers
description: "Write timeless docs without revision markers."
---

# Docs without revision markers

## Overview

Write documentation that stays stable and timeless. Use Git/PR history for revisions instead of embedding document versions (e.g., "Draft", "v1") in the file name or content.

## Rules (default)

- Do not add doc-level revision markers in file names, titles, headings, or metadata blocks (e.g., Draft, WIP, v1/v2, 初稿/终稿, Rev, 版本, 修订, revision history, document version).
- When editing an existing doc, remove doc-level revision markers if present (unless the user explicitly asks to keep them, or they are part of subject matter / repo convention).
- Do not add a "Revision history"/"版本记录" section.
- Do not add timestamps like "Last updated" unless the user asks for them or the repo already uses them consistently.
- Prefer stable, semantic paths like `docs/feature-x.md` over suffixes like `-v1`, `-draft`, `_final`.

## Allowed content

- Subject-matter versions are OK when they are part of what is being documented (e.g., API routes like `/v1/*`, product versions like "Kubernetes v1.29", or dependency versions).
- Stable IDs are OK if they are a repo convention (e.g., RFC/ADR numbers), as long as they are not used as document revisions.

## Edge cases

- If the user explicitly requests a visible doc version/draft label, confirm intent and suggest Git alternatives (tags, PR numbers, commit hashes). If they insist, comply but keep it minimal and localized (avoid filename changes unless requested).
- For release notes/`CHANGELOG`, include versions if the doc is intentionally tracking releases.

## Final sanity checklist

- File name: no draft/revision suffix.
- Title/headings: no draft/revision label.
- No revision-history block.
- Any "v1"/"v2" in text is clearly part of the subject matter, not the document's revision.
