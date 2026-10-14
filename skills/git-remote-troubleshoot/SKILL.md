---
name: git-remote-troubleshoot
description: "Diagnose Git remote and auth issues."
---

# Git remote troubleshoot

## Hard rules (strict)

- Never “work around” SSH failures by pushing via an explicit HTTPS URL (forbidden): `git push -u https://github.com/<owner>/<repo>.git <branch>`
- Never use `git push <url> <branch>` (URL-typed remote) as a workaround; always use a configured remote name (e.g., `origin`).
- Do not rewrite `origin` (or any remote) to HTTPS as a workaround unless the user explicitly requests HTTPS.
- Prefer **read-only** connectivity checks first: `git ls-remote <remote>`.
- Do not run `git push` unless the user explicitly asks you to push.
- Do not modify global configs (`~/.ssh/config`, `~/.gitconfig`, credential helpers) without asking first; keep changes minimal and make a backup.

## 1) Collect minimal facts

Ask for (or run) these and capture the *full* error text:

```bash
git remote -v
git config --get remote.origin.url
git status -sb
```

Also collect:
- The exact failing command (`git clone/fetch/pull/push ...`)
- The network context (VPN? proxy? corporate network? captive portal?)

## 2) Classify: SSH vs HTTPS

- **SSH** if remote looks like `git@host:owner/repo.git` or `ssh://...`
- **HTTPS** if remote looks like `https://host/owner/repo.git`

Proceed based on the transport.

## Quick signature map

- `Connection closed by <ip> port 22` / `ssh: connect to host ... port 22: ...` → network path/port blocked (often port 22)
- `Permission denied (publickey)` → SSH key selection/authz problem
- `Host key verification failed` → `known_hosts` mismatch / host key not trusted
- `Repository not found` → wrong remote URL or missing access

## 3) SSH failures

### A) Port 22 blocked / network path broken

Common indicators:
- Mentions `port 22`, `Connection timed out`, `Connection closed`, `No route to host`
- `ssh -T git@github.com` fails quickly or hangs then fails

**Safe tests (no pushing):**

```bash
ssh -T git@github.com
```

If the remote is GitHub and port 22 is blocked, test GitHub’s supported SSH-over-443 endpoint:

```bash
ssh -T -p 443 git@ssh.github.com
```

If port 443 works, apply GitHub’s official fix by adding this to `~/.ssh/config` (ask before editing):

```sshconfig
Host github.com
  HostName ssh.github.com
  Port 443
  User git
```

Then re-test:

```bash
ssh -T git@github.com
git ls-remote origin
```

Reference (official GitHub docs):

```text
https://docs.github.com/en/authentication/troubleshooting-ssh/using-ssh-over-the-https-port
```

Notes:
- The first connection after switching to port 443 may show a `known_hosts` warning; verify the host key against GitHub’s published fingerprints before accepting.
- GitHub’s doc includes caveats for GitHub Enterprise Server and some Enterprise Cloud configurations (e.g., data residency).

If you need deeper SSH debug logs (still read-only), use:

```bash
GIT_SSH_COMMAND="ssh -vvv" git ls-remote origin
```

### B) `Permission denied (publickey)`

This usually means **SSH auth** (key selection, agent, account access), not networking.

Checklist:

```bash
ssh -vT git@github.com
ssh-add -L
```

Common fixes:
- Ensure the correct public key is uploaded to the Git hosting account.
- If multiple keys exist, pin the right key for the host in `~/.ssh/config`:

```sshconfig
Host github.com
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

### C) `Host key verification failed` / host key mismatch

Do **not** blindly delete `known_hosts`.

Preferred approach:
- Identify the specific offending entry, and validate the expected fingerprint from the provider docs.
- If you must remove an entry, remove only the matching host line (or use `ssh-keygen -R <host>` with explicit user approval).

## 4) HTTPS failures (when the remote already uses HTTPS)

Typical indicators:
- `fatal: Authentication failed`
- `HTTP 401/403`
- `SSL certificate problem`

Workflow:
- First confirm basic reachability: `curl -I https://<host>`
- If GitHub is involved and auth fails, you generally need a PAT (password auth is not supported) or you should switch to SSH (user decision).

If you need deeper HTTPS debug logs (read-only), use:

```bash
GIT_TRACE=1 GIT_CURL_VERBOSE=1 git ls-remote origin
```

## 5) Verification before any write

After applying a fix, verify with a read-only operation:

```bash
git ls-remote origin
```

Only after the user explicitly asks to push, run the push using the configured remote name (not a raw HTTPS URL):

```bash
git push -u origin <branch>
```
