# Read-only HA runbook

1. Confirm `TAVILY_PRIMARY_ALIAS` and `TAVILY_STANDBY_ALIAS` resolve through the operator's SSH configuration.
2. Inspect service status and bounded recent logs on both roles.
3. Query local health and HA status endpoints without printing response bodies that may contain tokens or topology.
4. Confirm primary and standby build compatibility, recent sync time and role state.
5. Stop at any missing, ambiguous or contradictory evidence. Do not restart, promote, deploy or edit DNS from this Skill.

Example commands use placeholders and must be completed from the deployment card kept outside this repository:

```sh
ssh "$TAVILY_PRIMARY_ALIAS" '<primary read-only status command>'
ssh "$TAVILY_STANDBY_ALIAS" '<standby read-only status command>'
curl -fsS "$TAVILY_STANDBY_URL/health"
```

Promotion and recovery remain manual operator actions. A returned former primary stays fenced until its state and synchronization path are explicitly validated.
