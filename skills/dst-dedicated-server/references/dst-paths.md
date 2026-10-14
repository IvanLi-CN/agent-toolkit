# DST path checklist

Confirm these paths on the configured host instead of assuming them:

- dedicated server installation and SteamCMD root;
- cluster data root containing `cluster.ini`, token files and shard directories;
- `Master/` and `Caves/` `server.ini`, `modoverrides.lua`, logs and save data;
- service manager units or the process supervisor;
- backup directory and the authoritative remote deployment runbook.

The cluster configuration and token files are sensitive. Report only existence, ownership and redacted relative layout. Treat the remote deployment card as the source of truth for commands and ports.
