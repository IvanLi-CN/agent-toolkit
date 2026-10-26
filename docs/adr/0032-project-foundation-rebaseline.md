---
status: accepted
---

# Project foundation membership rebaseline

## Context

The public manifest and standalone Skill tree contain 11 Skills. Foundation prose and the language-policy inventory describe a larger membership, while the language matrix contains removed entries. Treating those descriptions as active membership would reintroduce capabilities outside the maintained source and misstate migration coverage.

## Decision

Use `PUBLIC_SKILLS.txt` as the sole membership authority. The Skill tree, catalog, language matrix, Spec membership count, and implementation coverage must agree exactly. This decision supersedes the membership-count assertion in ADR 0028, Language and runtime policy by responsibility; its responsibility-based language allocation and runtime policy remain accepted. The older ADR stays unchanged as decision history.

Keep all five governance requirements, six language requirements, seven cross-cutting requirements, and 48 domain verification scenarios. Apply them to the manifest-listed source. Language targets remain requirements until implementation, behavior tests, entrypoints, and prerequisites have migrated together. Explicit coverage distinguishes deferred conversions, retained interface exceptions, text-only guidance, and evidence-backed completed migrations.

Enforce the relationships through a public Bun root check and mutation tests, wired into the same local and Linux/macOS CI commands. Keep existing public safety and dependency checks; the new consistency check owns relationships between contracts rather than replacing their executable responsibilities. Source inspection is distinct from execution evidence, and CI configuration is distinct from remote enforcement or deployment.

## Consequences

Membership changes require coordinated contract updates and validation. The additional check makes stale claims fail locally and in CI without introducing consumer trees, adapters, private runtime configuration, or a second source. Domain migrations, detailed usage guides, the documentation site, and production rollout remain separate work; this decision does not claim their completion.
