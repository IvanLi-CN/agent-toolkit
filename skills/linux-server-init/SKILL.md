---
name: linux-server-init
description: "Initialize and harden a Linux server."
---

# Linux server init (distro-agnostic bootstrap)

## Goal

Safely turn a “fresh server I can SSH into” into:

- One **non-root** admin user that can SSH via **public key**
- A working privilege escalation path (**sudo** or **doas**) before root is locked down
- OpenSSH hardened: **no root SSH**, **no password/interactive SSH auth**
- Verified access so you **don’t lock the user out**

## Inputs to confirm (ask early)

- `HOST`: hostname/IP or an existing SSH alias (e.g. `my-vps`)
- `PORT`: SSH port (default `22`)
- `BOOTSTRAP_USER`: current remote login (often `root`, sometimes `ubuntu/ec2-user`)
- `NEW_USER`: the admin user to create
- `PUBKEY_PATH`: local public key path to authorize (e.g. `~/.ssh/id_ed25519.pub`)
- `PRIV_ESC`: `sudo` (default) or `doas`
- `SUDO_MODE`: `passwordless` (for automation) or `password` (interactive)
- `CONSOLE_ACCESS`: do they have provider console/rescue access? (needed for worst-case rollback)

## Guardrails (do not skip)

1. **Do not disable root SSH** until:
   - `NEW_USER` can SSH in with the key, and
   - `NEW_USER` can become root (`sudo`/`doas`) in the intended mode.
2. Keep one **existing admin session open** while changing sshd config; test in a second session.
3. Prefer an sshd **drop-in** file (`/etc/ssh/sshd_config.d/*.conf`) and run `sshd -t` before reload.
4. Keep `sudoers` edits safe: validate syntax (`visudo -cf`) and prefer `/etc/sudoers.d/*` drop-ins over editing `/etc/sudoers` directly.
5. Avoid “locking” the user account early: on some setups (notably OpenSSH without PAM), a “locked” account may be unable to SSH even with public keys. Prefer setting a random password and rely on sshd to disable password auth.

## Workflow (recommended order)

### 0) (Optional) Add a local SSH alias

Add to `~/.ssh/config`:

```sshconfig
Host <ALIAS>
  HostName <HOSTNAME_OR_IP>
  Port <PORT>
  User <BOOTSTRAP_USER>  # optional; you can also omit
```

Validate:

```sh
ssh -G <ALIAS> | rg -n '^(hostname|port|user)\\s'
```

### 1) Remote preflight (detect capabilities)

Run as the current admin user:

```sh
ssh <BOOTSTRAP_USER>@<HOST> 'set -e;
  whoami;
  uname -a;
  (cat /etc/os-release 2>/dev/null || true) | sed -n "1,12p";
  sshd -V 2>&1 | head -n 2 || true;
  ls -la /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null || true;
  rg -n "^[[:space:]]*Include[[:space:]]+" /etc/ssh/sshd_config 2>/dev/null || true;
  command -v sudo || true;
  command -v doas || true;
  command -v systemctl rc-service service 2>/dev/null || true;
'
```

### 2) Create `NEW_USER` and install the SSH key

Prefer capability-based commands (choose what exists):

- **Pick a shell**: use `/bin/bash` if present, else `/bin/sh`, else `/bin/ash`.
- **Create user**:
  - If `useradd` exists: `useradd -m -s <SHELL> <NEW_USER>`
  - Else use `adduser` with the distro’s syntax (ask/verify with `adduser --help` if unsure).
- **Authorize the key**:
  - Create `~/.ssh` with `0700`, `authorized_keys` with `0600`, owned by `NEW_USER`.

Minimal validation (must pass before continuing):

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 <NEW_USER>@<HOST> 'whoami && id'
```

### 3) Ensure privilege escalation works (sudo/doas)

#### A) `sudo` (most common)

1) Ensure `NEW_USER` is in an admin group (`sudo` or `wheel`) or explicitly granted in sudoers.

2) If `SUDO_MODE=passwordless`, create a rule file (as root via SSH or console):

```sh
install -d -m 750 -o root -g root /etc/sudoers.d
printf '%s ALL=(ALL) NOPASSWD: ALL\n' '<NEW_USER>' > /etc/sudoers.d/90-<NEW_USER>-nopasswd
chown root:root /etc/sudoers.d/90-<NEW_USER>-nopasswd
chmod 440 /etc/sudoers.d/90-<NEW_USER>-nopasswd

command -v visudo >/dev/null 2>&1 && visudo -cf /etc/sudoers
```

3) Verify from an SSH session as `NEW_USER`:

```sh
ssh -o BatchMode=yes <NEW_USER>@<HOST> 'sudo -n true && echo sudo_nopasswd=ok'
```

If `SUDO_MODE=password`, ensure the user has a password set (SSH password login can still be disabled later).

**Troubleshooting (only if `sudo -n true` still asks for a password):**

1) Confirm the drop-in file is readable and owned by root:

```sh
ls -la /etc/sudoers.d/90-<NEW_USER>-nopasswd
```

2) Confirm `/etc/sudoers` actually includes the directory:

```sh
grep -n '^[[:space:]]*#includedir[[:space:]]\\+/etc/sudoers\\.d' /etc/sudoers || echo MISSING_INCLUDEDIR
```

If `MISSING_INCLUDEDIR` is printed, append it and re-validate:

```sh
echo '#includedir /etc/sudoers.d' >> /etc/sudoers
command -v visudo >/dev/null 2>&1 && visudo -cf /etc/sudoers
```

#### B) `doas` (common on Alpine/OpenBSD-style setups)

Use only if requested. Ensure `doas` exists, then configure `/etc/doas.conf` and validate:

```sh
doas -n true && echo doas_nopasswd=ok
```

### 4) Harden OpenSSH (disable root + password auth)

1) Write a drop-in config (preferred):

`/etc/ssh/sshd_config.d/99-hardening.conf`

```conf
# Managed by automation: disable root SSH login and password-based SSH auth.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
```

2) Ensure `sshd_config` includes the drop-in directory (if it doesn’t already):

```sh
rg -n '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/\\*\\.conf' /etc/ssh/sshd_config \
  || echo 'Include /etc/ssh/sshd_config.d/*.conf' >> /etc/ssh/sshd_config
```

3) Validate and reload:

```sh
sshd -t
if command -v rc-service >/dev/null 2>&1; then
  rc-service sshd reload || rc-service sshd restart
elif command -v service >/dev/null 2>&1; then
  service sshd reload || service ssh reload || service sshd restart || service ssh restart
elif command -v systemctl >/dev/null 2>&1; then
  systemctl reload sshd || systemctl restart sshd || systemctl reload ssh || systemctl restart ssh
else
  echo "No service manager found; reload manually"
  exit 1
fi
```

4) Verify (must pass):

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 <NEW_USER>@<HOST> 'whoami'
(ssh -o BatchMode=yes -o ConnectTimeout=10 root@<HOST> true && echo UNEXPECTED_OK) || echo expected_fail
(ssh -o BatchMode=yes -o ConnectTimeout=10 -o PreferredAuthentications=password -o PubkeyAuthentication=no <NEW_USER>@<HOST> true && echo UNEXPECTED_OK) || echo expected_fail
```

### 5) Optional tightening

- Restrict logins explicitly (be careful not to lock out other needed users):
  - `AllowUsers <NEW_USER>`
- Keep a note of what was changed and where (e.g., drop-in file paths).

## Console copy/paste safety (avoid `>` heredoc traps)

When working in a provider console, prefer `printf` over heredocs to avoid getting stuck at `>`:

```sh
printf '%s\n' '<NEW_USER> ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-<NEW_USER>-nopasswd
```

If you see `>` and you’re stuck in multiline input, press `Ctrl+C` and re-run commands line-by-line.
