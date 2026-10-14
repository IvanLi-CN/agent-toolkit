# Public Skills Index

This directory contains only Skills that can be loaded from a standalone `agent-toolkit` checkout. The public boundary is recorded in [`PUBLIC_SKILLS.txt`](../PUBLIC_SKILLS.txt) and checked in CI; each listed Skill keeps its scripts, references, assets, and focused tests beside its `SKILL.md`.

Codex-specific workflow, native task, owner-facing evidence, and personal service integration Skills are intentionally kept in the consumer configuration repository. They are not public Skills and are not duplicated here.

Run the checks after adding, removing, or renaming a public Skill:

```bash
python3 bin/skills_index_check.py
python3 bin/public_skill_boundary_check.py
```

| Skill | Description | Path |
|---|---|---|
| `agent-requirements` | Draft a self-contained requirements brief for another agent. | `skills/agent-requirements/` |
| `agent-vm` | Use a session-owned Incus Linux VM for isolated execution, Docker/Compose, heavy validation, and source transfer. | `skills/agent-vm/` |
| `agent-vm-ops` | Maintain a configured native Incus Agent VM installation under an explicit infrastructure task. | `skills/agent-vm-ops/` |
| `buzzer-audio-preview` | Render editable buzzer scores as MIDI and WAV previews. | `skills/buzzer-audio-preview/` |
| `cvm-imagegen` | Run an explicit OpenAI-compatible image generation fallback through configured endpoints. | `skills/cvm-imagegen/` |
| `docs-no-revision-markers` | Write timeless documentation without document-level revision markers. | `skills/docs-no-revision-markers/` |
| `dst-dedicated-server` | Operate and troubleshoot a configured Don't Starve Together dedicated server. | `skills/dst-dedicated-server/` |
| `firmware-display-preview` | Reuse firmware rendering code to produce framebuffer and PNG previews. | `skills/firmware-display-preview/` |
| `git-remote-troubleshoot` | Diagnose Git remote, authentication, and network failures. | `skills/git-remote-troubleshoot/` |
| `git-sync` | Synchronize local Git branches and confirmed baselines safely. | `skills/git-sync/` |
| `linux-server-init` | Initialize and harden a Linux server through explicit configuration. | `skills/linux-server-init/` |
| `mcu-agentd-project-integration` | Integrate the configuration-driven `mcu-agentd` workflow into a project. | `skills/mcu-agentd-project-integration/` |
| `requirements-analysis` | Clarify goals, scope, constraints, and acceptance criteria before implementation. | `skills/requirements-analysis/` |
| `step-stl-print-repair` | Repair and regenerate print-ready STL files from STEP/CAD sources. | `skills/step-stl-print-repair/` |
| `tavily-hikari-infra` | Inspect a configured Tavily Hikari primary/standby deployment read-only. | `skills/tavily-hikari-infra/` |
| `xp-infra` | Validate configured XP self-hosted nodes using explicit private configuration. | `skills/xp-infra/` |

Third-party Skills installed under `~/.agents/skills` are external dependencies and are not maintained or indexed here.
