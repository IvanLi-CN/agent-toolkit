# Project foundation implementation coverage

## Current Status

The source baseline is 870c563ccdc12b24121668cf9033e67b6f8c90d3. It supplies 16 public Skills, Python repository checks, a short public index, and Agent VM public contracts. The accepted target architecture and language allocation are documented; this documentation does not establish that the target implementations or website exist.

## Implementation Coverage

- Public membership and direct-source consumption: PUBLIC_SKILLS.txt, skills/README.md, and existing consumer instructions.
- Repository validation: the baseline index, public-data, and Skill coupling checks are Python. Some unrelated root tools still refer to absent private workflow modules; maintained validation and dependency ownership need standalone verification.
- Skill implementations: [SCRIPT-LANGUAGE-MATRIX.md](SCRIPT-LANGUAGE-MATRIX.md) distinguishes source implementations from accepted targets. Existing Python/Shell tests remain authoritative until their replacements preserve the covered behavior.
- Public design material: Agent VM lifecycle, CLI, retention/reclamation designs and ADRs are already present. Public XP and CVM traceability, root agent guidance, complete usage guides, and a documentation site require implementation.
- Verification coverage: SPEC.md retains seven cross-cutting evidence requirements and 48 detailed domain scenarios, in addition to the project requirement assertions. No result is inferred from their presence in the document.

## Verification Commands

The currently available structural checks are:

```bash
python3 bin/spec_contract_check.py --path docs/specs/project-foundation/SPEC.md
python3 bin/skills_index_check.py
python3 bin/public_boundary_check.py
python3 bin/public_skill_boundary_check.py
```

The accepted Bun validation interface is bun run typecheck, bun run check, bun run test:repo, and bun run test:skills. These commands must be implemented and verified before they are presented as available maintenance commands. Documentation build commands belong here when the Bun/Rspress implementation exists.

## Compatibility and Deployment

Language migration must preserve existing request envelopes, canonical digests, durable state, native locking/atomicity, and recoverability. Test evidence must separate fake infrastructure, native isolated behavior, and actual deployment observations. Control-host and managed-guest runtime prerequisites require explicit deployment validation; documentation does not authorize installing them on a production system.

A linked-consumer experiment must preserve third-party/private entries. A site preview must exercise production static output under the repository subpath. Formal site publication and production Agent VM rollout are separate operational outcomes.

## References

- [Requirements and verification](SPEC.md)
- [Topic history](HISTORY.md)
