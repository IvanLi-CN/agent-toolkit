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

## Agent VM control plane

**Control environment**:
The operator-owned environment that holds authoritative Agent VM lifecycle state and is permitted to coordinate Incus resources, leases, mappings, and maintenance actions.
_Avoid_: Agent VM guest, PVE host, underlying host

**One-shot control process**:
A control-plane execution that handles one request against the authoritative state and native resources, then exits; it is an invocation boundary rather than a resident broker.
_Avoid_: Control daemon, HTTP broker

**Deployment operator**:
The operator-owned authority responsible for publishing and recovering control-plane releases, protected configuration, and maintenance assets.
_Avoid_: Skill consumer, Agent VM guest

**Control-plane update**:
A coordinated change to the control components that implement the Agent VM lifecycle contract, including the client-facing compatibility surface and the control environment's executable behavior.
_Avoid_: VM image update, guest update

**Control-plane release**:
An approved set of control components intended to operate as one compatibility unit across the local client and the control environment.
_Avoid_: Guest image, runtime cache

**Admission drain**:
A maintenance state in which new lease acquisition and restart admission are blocked while observation, retrieval, release, and required cleanup remain available.
_Avoid_: VM shutdown, lease revocation

**Logical reservation ceiling**:
The maximum aggregate resource reservation permitted by an overcommit policy. It is a policy boundary, not a guarantee that the underlying runtime can provide the reserved resources without contention.
_Avoid_: Physical capacity, runtime guarantee

**CT-visible capacity**:
The resource capacity visible to the Agent VM control environment through its assigned execution boundary. It is a runtime boundary used to describe current scheduling and memory conditions, not the logical reservation ceiling.
_Avoid_: Logical reservation ceiling, host capacity

**Logical reservation headroom**:
The difference between a logical reservation ceiling and the resources currently allocated or durably reserved by managed VM tasks.
_Avoid_: Runtime available memory, physical free space

**Runtime pressure**:
An observation that the control environment is experiencing resource contention or reduced runtime headroom. It describes current operating conditions and does not change logical reservation headroom by itself.
_Avoid_: Allocation usage, admission ceiling

**Startup admission**:
The decision to allow a new or restarting VM to change native runtime state after the applicable reservation, capacity, pressure, drain, and integrity checks have passed.
_Avoid_: Lease existence, guest readiness

**CPU scheduler pressure**:
A measure of how much runnable work is delayed waiting for CPU service. It is a contention observation, not CPU utilization or a count of allocated virtual CPUs.
_Avoid_: CPU usage, CPU allocation

**Release manifest**:
The authoritative description of a control-plane release's identity, artifacts, integrity evidence, and declared compatibility.
_Avoid_: Deployment configuration, state database

**Compatible operation**:
An Agent VM operation whose request, response, and semantics are explicitly supported by both participating control-plane releases.
_Avoid_: Any operation that happens to parse

**Compatibility warning**:
A non-fatal diagnostic that records a release or capability difference while the requested operation remains explicitly compatible.
_Avoid_: Compatibility error, protocol downgrade
