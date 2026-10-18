# Agent VM Memory Reservation Validation

This record maps the reservation-only memory plan to its evidence boundary. It distinguishes deterministic offline behavior from operating-system and deployment observations; the public repository does not contain the operator-owned control entry, collector, Grafana provisioning source, or live addresses.

| Acceptance | Scenario and evidence | Result boundary |
| --- | --- | --- |
| A1 | `skills/agent-vm-ops/tests/test_resource_overcommit.py` and `skills/agent-vm-ops/tests/test_live_memory.py` cover pressure-only admission, logical ceiling rejection, missing/contradictory capacity, and unchanged existing-lease operations. | Offline behavior covered; real CT cgroup/LXCFS behavior remains deployment evidence. |
| A2 | Resource policy fixtures assert `memory_budget_mib=32768`, `memory_overcommit_ratio=2`, CT-visible `32768 MiB`, logical limit `65536 MiB`, and logical remaining derived from reservations. | Offline contract covered. |
| A3 | Controller and CLI tests cover sessionless `admin-metrics`, read-only rejection of session or operation fields, resource split fields, CT-local memory observations, task/audit/failure summaries, and structured errors. | Offline protocol covered. |
| A4 | `docs/specs/agent-vm/`, the successor memory ADR, operations references, Skills, and documentation tests define one 32/64GiB authority and separate pressure from admission. | Public contract synchronized. |
| A5 | The public observability contract specifies the deployment-owned read-only `admin-metrics` scrape bridge, freshness/up failure semantics, fixed 32/64GiB lines, dynamic reservation/remaining/actual/pressure series, and separate disk domains. | Incomplete until the operator-owned collector and Grafana provisioning source are applied and checked. |
| A6 | The required live checks are `agent-vm doctor`, `agent-vm admin status`, `agent-vm admin metrics`, and a Grafana reload observation with Auto refresh retained. | Incomplete without the configured CT control SSH entry and operator-owned Grafana access. No PVE or guessed host is implied. |
| A7 | The repository validation set is `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test:repo`, `bun run test:skills`, the Agent VM documentation tests, Python compilation, and `git diff --check`. | Local checks are evidence for the candidate checkout only; a clean checkout and current-head CI remain required for release. |

The logical limit is a reservation ceiling, not a promise that 64GiB of guest RAM can run simultaneously without CT memory pressure or OOM. `MemAvailable`, `memory.current`, and cgroup OOM counters remain observations; they must not be used to replace or reduce the logical reservation calculation.
