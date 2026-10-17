# Public Skills Index

This directory contains only Skills that can be loaded from a standalone `agent-toolkit` checkout. The public boundary is recorded in [`PUBLIC_SKILLS.txt`](../PUBLIC_SKILLS.txt) and checked in CI; each listed Skill keeps its scripts, references, assets, and focused tests beside its `SKILL.md`.

Codex-specific workflow, native task, owner-facing evidence, and personal service integration Skills are intentionally kept in the consumer configuration repository. They are not public Skills and are not duplicated here.

Run the checks after adding, removing, or renaming a public Skill:

```bash
bun run bin/skills_index_check.ts
bun run bin/public_skill_boundary_check.ts
```

| Skill | Description | Path |
|---|---|---|
| `agent-vm` | Use a session-owned Incus Linux VM for isolated execution, Docker/Compose, heavy validation, and source transfer. | [Skill source](agent-vm/SKILL.md) |
| `agent-vm-ops` | Maintain a configured native Incus Agent VM installation under an explicit infrastructure task. | [Skill source](agent-vm-ops/SKILL.md) |
| `buzzer-audio-preview` | Render editable buzzer scores as MIDI and WAV previews. | [Skill source](buzzer-audio-preview/SKILL.md) |
| `cvm-imagegen` | Run an explicit OpenAI-compatible image generation fallback through configured endpoints. | [Skill source](cvm-imagegen/SKILL.md) |
| `docs-no-revision-markers` | Write timeless documentation without document-level revision markers. | [Skill source](docs-no-revision-markers/SKILL.md) |
| `dst-dedicated-server` | Operate and troubleshoot a configured Don't Starve Together dedicated server. | [Skill source](dst-dedicated-server/SKILL.md) |
| `firmware-display-preview` | Reuse firmware rendering code to produce framebuffer and PNG previews. | [Skill source](firmware-display-preview/SKILL.md) |
| `git-remote-troubleshoot` | Diagnose Git remote, authentication, and network failures. | [Skill source](git-remote-troubleshoot/SKILL.md) |
| `git-sync` | Synchronize local Git branches and confirmed baselines safely. | [Skill source](git-sync/SKILL.md) |
| `linux-server-init` | Initialize and harden a Linux server through explicit configuration. | [Skill source](linux-server-init/SKILL.md) |
| `mcu-agentd-project-integration` | Integrate the configuration-driven `mcu-agentd` workflow into a project. | [Skill source](mcu-agentd-project-integration/SKILL.md) |
| `step-stl-print-repair` | Repair and regenerate print-ready STL files from STEP/CAD sources. | [Skill source](step-stl-print-repair/SKILL.md) |
| `tavily-hikari-infra` | Inspect a configured Tavily Hikari primary/standby deployment read-only. | [Skill source](tavily-hikari-infra/SKILL.md) |
| `xp-infra` | Validate configured XP self-hosted nodes using explicit private configuration. | [Skill source](xp-infra/SKILL.md) |

Third-party or consumer-local Skills are external dependencies and are not maintained or indexed here.
