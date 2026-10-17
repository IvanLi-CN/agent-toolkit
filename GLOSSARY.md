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

**Private deployment configuration**:
Operator-owned information identifying an actual deployment and its approved policy, including inventory, connection details, and credentials.
_Avoid_: Public reference, for live deployment information

**Agent VM session**:
The ownership context for one agent's VM slot and operations. Its identifier describes ownership rather than proving authorization.

**VM lease**:
The bounded period during which an Agent VM session may access its VM.

**Stopped cache**:
A stopped managed VM whose retained disk may be reused or reclaimed under the deployment's policy. It carries no guarantee of recovery after lease expiry.
