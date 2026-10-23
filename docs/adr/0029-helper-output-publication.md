---
status: accepted
---

# Helper output publication

## Context

The migrated Buzzer, framebuffer, and DST helpers publish artifacts into a caller-selected directory. Directly truncating a caller path would follow a pre-existing symlink, expose partial output during a crash, and make concurrent recovery ambiguous. The public helper contract also requires bounded diagnostics and recoverable publication.

## Decision

These helpers publish through owner-private temporary files and an atomic rename. New output files use mode `0600`; an existing regular output is replaced atomically. A pre-existing output symlink is never followed: the symlink is replaced while its target remains unchanged. Publication failures retain the previous complete output when recovery is possible and report a redacted configured-output placeholder.

The behavior is part of the public helper contract, alongside the documented output paths and error envelopes. Consumers that need a shared artifact must choose a regular output path or copy the published file explicitly; the helper does not update an unrelated symlink target.

## Consequences

- Readers never observe a partially written helper artifact.
- Output permissions are private by default and do not inherit a caller-controlled symlink target.
- Existing regular files keep the publication contract through replacement rather than in-place truncation; callers must not depend on preserving the old inode or mode.
- Recovery and symlink fixtures remain required in the helper test suites.
