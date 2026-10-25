# Agent VM observability bundle

This directory contains the portable Grafana source for the Agent VM observability contract. It is a parameterized baseline, not a deployment export.

## Render

Copy [the example configuration](observability.config.json.example), replace every placeholder with values owned by the deployment, and render the bundle into a staging directory:

```bash
bun skills/agent-vm/scripts/render_observability_dashboard.ts \
  --config /path/to/agent-vm-observability.json \
  --output-dir /path/to/deployment/grafana/generated \
  --force
```

The renderer writes the parameterized capacity dashboard, inventory dashboard, and Grafana file-provider definition. The deployment implementation must render the approved `Agent VM / Capacity & Admission` and `Agent VM / Inventory & Operations` views; the YAML path must be visible inside the Grafana container.

The deployment repository should review and commit the rendered files together with its Prometheus scrape configuration and read-only controller metrics bridge. The public repository does not receive those rendered files, datasource credentials, hostnames, collector paths, or live inventory.

## Configuration

| Field | Meaning |
| --- | --- |
| `dashboard_uid` | Stable Grafana dashboard UID for this deployment. |
| `dashboard_title` | Dashboard title shown in Grafana. |
| `grafana_org_id` | Numeric Grafana organization ID that owns the dashboard. |
| `provider_name` | Grafana provisioning provider name. |
| `dashboard_folder` | Grafana folder for the dashboard. |
| `prometheus_datasource_uid` | Existing Prometheus datasource UID. |
| `controller_job` | Prometheus `job` label for the read-only Agent VM controller bridge. |
| `dashboard_path` | Container-visible directory that Grafana scans for JSON dashboards. |
| `dashboard_filename` | Optional rendered filename; defaults to `agent-vm-observability.json`. |
| `inventory_dashboard_uid` | Optional stable UID for the inventory dashboard; defaults to `<dashboard_uid>-inventory`. |
| `inventory_dashboard_title` | Optional inventory dashboard title; defaults to `<dashboard_title> / Inventory & Operations`. |
| `inventory_dashboard_filename` | Optional inventory filename; defaults to `agent-vm-observability-inventory.json`. |

The template uses a hidden `controller_job` variable so controller queries remain portable while the deployment supplies its actual job label. CPU capacity is read from `agent_vm_admission_cpu_capacity_vcpu`; memory and disk limits are rendered only from their authoritative metric families.

The capacity dashboard separates logical admission from runtime pressure: its summary shows logical RAM remaining, CT-local `MemAvailable`, pressure/OOM state, and compact CPU/disk readiness; the policy snapshot below shows the default request, slot estimates, and task-state counts. The inventory dashboard defaults to active and transitional/failed tasks, orders rows by lifecycle priority, and leaves cached/absent history available through the state filter.

## Validate

The renderer validates both dashboards before writing them. A previously rendered bundle can be checked directly:

```bash
bun skills/agent-vm/scripts/validate_observability_dashboard.ts \
  --dashboard /path/to/deployment/grafana/generated/agent-vm-observability.json \
  --provisioning /path/to/deployment/grafana/generated/agent-vm-observability.yml
```

Use the inventory profile when checking `agent-vm-observability-inventory.json`:

```bash
bun skills/agent-vm/scripts/validate_observability_dashboard.ts \
  --dashboard /path/to/deployment/grafana/generated/agent-vm-observability-inventory.json \
  --provisioning /path/to/deployment/grafana/generated/agent-vm-observability.yml \
  --profile inventory
```

The validator checks the selected dashboard profile's panel/metric contract, automatic refresh, datasource consistency, the controller variable, and the rule that packet-rate PromQL must not multiply by `8`.
