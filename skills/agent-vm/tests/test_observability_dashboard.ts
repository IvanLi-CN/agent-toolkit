import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBundle, readConfig, writeBundle, type ObservabilityConfig } from "../scripts/render_observability_dashboard.ts";
import {
  INVENTORY_REQUIRED_METRICS,
  INVENTORY_REQUIRED_PANEL_TITLES,
  validateDashboard,
} from "../scripts/validate_observability_dashboard.ts";

const config: ObservabilityConfig = {
  dashboard_uid: "agent-vm-test",
  dashboard_title: "Agent VM / Incus",
  grafana_org_id: 2,
  provider_name: "agent-vm-test",
  dashboard_folder: "Observability",
  prometheus_datasource_uid: "prometheus-test",
  controller_job: "controller-test",
  dashboard_path: "/var/lib/grafana/dashboards/agent-vm",
};

test("renders a portable dashboard and provisioning bundle", () => {
  const bundle = renderBundle(config);
  expect(bundle.dashboard.uid).toBe(config.dashboard_uid);
  expect(bundle.dashboard.title).toBe(config.dashboard_title);
  expect(bundle.inventoryDashboard.uid).toBe(`${config.dashboard_uid}-inventory`);
  expect(bundle.inventoryDashboard.title).toBe(`${config.dashboard_title} / Inventory & Operations`);
  expect(bundle.dashboardText).not.toContain("__PROMETHEUS_UID__");
  expect(bundle.inventoryDashboardText).not.toContain("__PROMETHEUS_UID__");
  expect(bundle.inventoryDashboardText).toContain('"id": "joinByField"');
  expect(bundle.inventoryDashboardText).toContain('"name": "state"');
  expect(bundle.inventoryDashboardText).toContain('"vm_ip": "VM IP"');
  expect(bundle.inventoryDashboardText).toContain('"ssh_host_port": "SSH port"');
  expect(bundle.inventoryDashboardText).toContain('"options": "state_order"');
  expect(bundle.inventoryDashboardText).toContain('"state_order": true');
  expect(bundle.inventoryDashboardText).toContain('"task_id 1": true');
  expect(bundle.inventoryDashboardText).toContain('"options": "Scrape age (s)"');
  expect(bundle.inventoryDashboardText).toContain('"text": [\n            "active",\n            "preparing",\n            "closing",\n            "deleting",\n            "failed"');
  expect(bundle.inventoryDashboardText).not.toContain("or vector(0)");
  expect(bundle.inventoryDashboardText).toContain("time() - agent_vm_scrape_timestamp_seconds");
  expect(bundle.dashboardText).toContain('"uid": "prometheus-test"');
  expect(bundle.dashboardText).toContain('"value": "controller-test"');
  expect(bundle.dashboardText).toContain('job=\\"$controller_job\\"');
  expect(bundle.dashboardText).toContain("clamp_max");
  expect(bundle.dashboardText).toContain("agent_vm_admission_default_request_cpu_vcpu");
  expect(bundle.dashboardText).toContain("agent_vm_admission_default_request_disk_bytes");
  expect(bundle.dashboardText).toContain("agent_vm_admission_default_request_physical_cost_bytes");
  expect(bundle.dashboardText).toContain("agent_vm_task_states");
  expect(bundle.dashboardText).toContain("agent_vm_up");
  expect(bundle.dashboardText).toContain("agent_vm_scrape_timestamp_seconds");
  const panels = bundle.dashboard.panels as Array<Record<string, unknown>>;
  const cpuPanel = panels.find((panel) => panel.id === 328);
  const cpuTarget = (cpuPanel?.targets as Array<Record<string, unknown>>).find((target) => target.refId === "C");
  const cpuLimitTarget = (cpuPanel?.targets as Array<Record<string, unknown>>).find((target) => target.refId === "M");
  expect(String(cpuTarget?.expr)).not.toContain("by (mode)");
  expect(String(cpuLimitTarget?.expr)).toContain("agent_vm_admission_cpu_limit_vcpu");
  for (const title of ["Disk admission", "VM slot admission", "Control filesystem capacity"]) {
    const panel = panels.find((candidate) => candidate.title === title) as Record<string, any> | undefined;
    expect(panel?.fieldConfig?.defaults?.custom?.spanNulls).toBe(false);
  }
  expect(bundle.dashboardText).not.toContain("vector(1600)");
  expect(bundle.dashboardText).not.toContain("16 cores");
  expect(bundle.dashboardText).not.toContain("64 GiB");
  expect(bundle.dashboardText).not.toContain("32 GiB");
  expect(bundle.provisioningText).toContain('path: "/var/lib/grafana/dashboards/agent-vm"');
  expect(bundle.provisioningText).toContain("orgId: 2");
  expect(bundle.provisioningText).not.toContain("__DASHBOARD_PATH__");
  expect(validateDashboard(bundle.inventoryDashboard, "prometheus-test", {
    requiredPanelTitles: INVENTORY_REQUIRED_PANEL_TITLES,
    requiredMetrics: INVENTORY_REQUIRED_METRICS,
  })).toEqual([]);
});

test("rejects packet-rate expressions that convert counts to bits", () => {
  const bundle = renderBundle(config);
  const dashboard = structuredClone(bundle.dashboard) as Record<string, unknown>;
  const panels = dashboard.panels as Array<Record<string, unknown>>;
  const packetPanel = panels.find((panel) => panel.title === "Project Network Packets/s");
  expect(packetPanel).toBeDefined();
  const targets = packetPanel?.targets as Array<Record<string, unknown>>;
  targets[0].expr = `${String(targets[0].expr)} * 8`;
  expect(validateDashboard(dashboard).some((finding) => finding.includes("packet-rate target") && finding.includes("must not multiply by 8"))).toBe(true);
});

test("rejects dashboards that mix Prometheus datasource UIDs", () => {
  const bundle = renderBundle(config);
  const dashboard = structuredClone(bundle.dashboard) as Record<string, unknown>;
  const panels = dashboard.panels as Array<Record<string, unknown>>;
  const panel = panels.find((candidate) => candidate.datasource && typeof candidate.datasource === "object") as Record<string, unknown>;
  (panel.datasource as Record<string, unknown>).uid = "another-prometheus";
  expect(validateDashboard(dashboard)).toContain("dashboard must use exactly one Prometheus datasource UID");
});

test("rejects dashboards with duplicate panel ids", () => {
  const bundle = renderBundle(config);
  const dashboard = structuredClone(bundle.dashboard) as Record<string, unknown>;
  const panels = dashboard.panels as Array<Record<string, unknown>>;
  panels.push({ ...panels[0] });
  expect(validateDashboard(dashboard).some((finding) => finding.startsWith("dashboard panel id must be unique:"))).toBe(true);
});

test("refuses unresolved configuration placeholders", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-vm-observability-config-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ ...config, controller_job: "${AGENT_VM_CONTROLLER_JOB}" }));
    expect(() => readConfig(path)).toThrow("controller_job still contains a placeholder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires a positive numeric Grafana organization ID", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-vm-observability-org-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ ...config, grafana_org_id: 0 }));
    expect(() => readConfig(path)).toThrow("grafana_org_id must be a positive integer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an inventory UID that cannot fit the Grafana UID contract", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-vm-observability-uid-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
      ...config,
      dashboard_uid: "a".repeat(40),
    }));
    expect(() => readConfig(path)).toThrow("inventory_dashboard_uid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects colliding dashboard output filenames", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-vm-observability-filenames-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
      ...config,
      dashboard_filename: "agent-vm-test.json",
      inventory_dashboard_filename: "agent-vm-test.json",
    }));
    expect(() => readConfig(path)).toThrow("output filenames must be unique");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes both outputs and refuses accidental replacement", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-vm-observability-output-"));
  try {
    const bundle = renderBundle(config);
    const paths = writeBundle(bundle, root);
    expect(readFileSync(paths.dashboardPath, "utf8")).toContain('"refresh": "auto"');
    expect(readFileSync(paths.inventoryDashboardPath, "utf8")).toContain('"title": "Agent VM / Incus / Inventory & Operations"');
    expect(() => writeBundle(bundle, root)).toThrow("pass --force");
    expect(writeBundle(bundle, root, true).dashboardPath).toBe(paths.dashboardPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serializes bundle writes with an output-directory lock", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-vm-observability-lock-"));
  try {
    const bundle = renderBundle(config);
    mkdirSync(join(root, ".agent-vm-observability.lock"));
    expect(() => writeBundle(bundle, root, true)).toThrow("output directory is locked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
