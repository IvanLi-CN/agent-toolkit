# Agent Toolkit

Agent Toolkit is a collection of independently usable Skills for coding and automation agents. These terms distinguish shared capabilities from an operator's installation and deployment.

## Language

**Public Skill**:
A reusable agent capability with a defined purpose, usage instructions, and any resources necessary to use it in a configured environment.
_Avoid_: Codex-only Skill

**Skill consumer**:
An agent product or installation that discovers and uses Public Skills.
_Avoid_: Codex, when describing all consumers

**Skill catalog**:
The discoverable collection of Public Skills and their purposes, prerequisites, and usage boundaries.
_Avoid_: Marketplace, when no marketplace service is involved

**Public membership**:
The set of Skill names declared in `PUBLIC_SKILLS.txt`; the source tree, catalog, language matrix, and implementation coverage describe that same set.

**Target allocation**:
The accepted implementation language and execution boundary for a responsibility. An allocation alone does not establish a completed migration.

**Migration coverage**:
The implementation's declared relationship to its target allocation, separating deferred conversions, retained interface exceptions, text-only guidance, and completed conversions with behavior evidence.

**Private deployment configuration**:
Operator-owned information identifying an actual deployment and its approved policy, including inventory, connection details, and credentials.
_Avoid_: Public reference, for live deployment information
