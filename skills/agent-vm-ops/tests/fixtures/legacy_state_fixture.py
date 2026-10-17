#!/usr/bin/env python3
"""Create a neutral SQLite journal fixture using the ac14 StateStore layout.

This file is test-only. It does not implement the controller or provide a
runtime compatibility wrapper.
"""

import json
import sqlite3
import sys
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
    state TEXT NOT NULL, instance_name TEXT NOT NULL UNIQUE, vm_ip TEXT, ssh_host_port INTEGER,
    lease_expires_at TEXT, inactive_since TEXT, cleanup_after TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, last_error TEXT, image_fingerprint TEXT NOT NULL,
    resources_json TEXT NOT NULL DEFAULT '{}', reservation_bytes INTEGER NOT NULL DEFAULT 0,
    previous_generation INTEGER, resource_reservation_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS ports (
    task_id TEXT NOT NULL, generation INTEGER NOT NULL, port_name TEXT NOT NULL,
    protocol TEXT NOT NULL, host_port INTEGER NOT NULL, vm_port INTEGER NOT NULL,
    device_name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, port_name, protocol), UNIQUE (host_port, protocol),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY, action TEXT NOT NULL, session_id TEXT,
    generation INTEGER, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, task_id TEXT,
    session_id TEXT, generation INTEGER, outcome TEXT NOT NULL, detail_json TEXT,
    created_at TEXT NOT NULL
);
"""


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: legacy_state_fixture.py DB_PATH RESPONSE_JSON")
    path = Path(sys.argv[1])
    response = json.loads(sys.argv[2])
    if not isinstance(response, dict):
        raise SystemExit("response must be an object")
    operation_id = str(response["operation_id"])
    connection = sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA)
        connection.execute(
            """
            INSERT OR REPLACE INTO operations
            (operation_id, action, session_id, generation, response_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                operation_id,
                str(response.get("action", "acquire")),
                response.get("session_id"),
                response.get("generation"),
                json.dumps(response, sort_keys=True),
                str(response.get("server_time", "2026-10-04T00:00:00+00:00")),
            ),
        )
        connection.commit()
    finally:
        connection.close()


if __name__ == "__main__":
    main()
