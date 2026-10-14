---
name: mcu-agentd-project-integration
description: "Integrate mcu-agentd into a project."
---

# Mcu Agentd Project Integration

## Overview

Add a repo-local `mcu-agentd.toml` so the project can use `mcu-agentd` as the single entry
point for erase/flash/reset/monitor/log collection, with consistent logging and cross-project
resource arbitration via `mcu-managerd`.

## Integration Workflow

### Step 0: Confirm prerequisites and constraints

`mcu-agentd` v1 constraints (important when integrating):

- Only **ELF** artifacts are supported (`artifact_elf`).
- Only two backends:
  - `espflash` (ESP32 family)
  - `probe-rs` (chips supported by probe-rs registry/CLI)
- Runtime state directory is fixed: `./.mcu-agentd/` (should be gitignored).

### Step 1: Ask only the minimum questions

You need the following to write a correct `mcu-agentd.toml`:

- For each MCU target:
  - Backend: `espflash` or `probe-rs`
  - Chip name (`chip`) as accepted by the backend tool
  - How the device is selected:
    - ESP32: serial port path
    - probe-rs: debug probe selector (varies)
  - The path to the ELF artifact (`artifact_elf`)
- Project identity: pick a `[project].id` that is unique per machine/user.

If anything is unknown (chip name, artifact path), do not guess; inspect the repo build outputs
or ask the user.

### Step 2: Install tools (host)

Ensure the backend CLI exists (depends on the MCU targets you add):

```bash
command -v espflash || true
command -v probe-rs || true
```

Install/upgrade `mcu-agentd` + `mcu-managerd` (one-time per machine).
When building from source, set `MCU_AGENTD_SOURCE` to the checked-out repository:

```bash
export MCU_AGENTD_SOURCE=/path/to/mcu-agentd
```

Typical install:

```bash
cd "$MCU_AGENTD_SOURCE"
cargo install --path . --bins
mcu-agentd upgrade --path .
```

### Step 3: Add `mcu-agentd.toml` to the project root

Create (or update) `<project_root>/mcu-agentd.toml`:

Minimal template:

```toml
[project]
id = "my-project" # must be unique on this machine for mcu-managerd registry

[agentd]
auto_start_daemon = true
tail_default = 200

[mcu.esp_host]
backend = "espflash"
chip = "esp32s3"
artifact_elf = "path/to/firmware.elf"

[mcu.esp_host.espflash]
log_format = "defmt"
after_flash = "no-reset"
skip_update_check = true

[mcu.stm32_ctrl]
backend = "probe-rs"
chip = "STM32G431CB"
artifact_elf = "path/to/firmware.elf"

[mcu.stm32_ctrl.probe_rs]
protocol = "swd"
speed_khz = 4000
connect_under_reset = false
```

Notes:

- `mcu_id` is the table name after `mcu.`; must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, and
  must not be `all`.
- All relative paths (like `artifact_elf`) are resolved relative to the project root.
- If the project already has a legacy port/probe selector file, set
  `selector_cache_file = ".esp32-port"` (or similar) to reuse it; otherwise omit and let
  mcu-agentd use `./.mcu-agentd/selectors/<mcu_id>.txt`.

### Step 4: Ensure `.mcu-agentd/` is ignored

Add to `<project_root>/.gitignore` (if not already present):

```gitignore
.mcu-agentd/
```

### Step 5: Validate config and do a first run

From the project root:

```bash
mcu-agentd config check
mcu-agentd start
mcu-agentd mcu list

# For each target:
mcu-agentd selector list <mcu_id>
# Set selector ONLY after the user confirms the intended device/candidate:
mcu-agentd selector set <mcu_id> <value>
mcu-agentd flash <mcu_id>
mcu-agentd monitor <mcu_id>
```

If `selector list` is empty, the device is likely not connected / not recognized by the OS;
connect/power it up, then rerun `selector list`.

### Step 6 (optional): Add repo-friendly wrappers

If the project has a task runner (Make/Just/package scripts), add small wrappers so humans
do not need to remember flags:

- `flash`: `mcu-agentd flash <mcu_id>`
- `reset`: `mcu-agentd reset <mcu_id>`
- `logs`: `mcu-agentd logs <mcu_id> --tail 200 --sessions`
- `monitor`: `mcu-agentd monitor <mcu_id> --from-start`

Avoid bypassing mcu-agentd by re-introducing raw `espflash` / `probe-rs` calls.
