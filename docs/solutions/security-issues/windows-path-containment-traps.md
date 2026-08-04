---
title: Windows path-containment traps — 8.3 short names, alternate data streams, derived paths
date: 2026-07-26
category: security-issues
module: server
problem_type: security_issue
component: file_bridge
symptoms:
  - "Path escapes the workbook root: sample.xlsx — for a file that is plainly inside the root"
  - "A .txt target passes the .xlsx extension allowlist (NTFS alternate data stream)"
  - "Opaque EINVAL from rename instead of a policy error"
root_cause: platform_quirk
resolution_type: code_fix
severity: high
tags: [windows, ntfs, realpath, 8dot3, alternate-data-streams, symlink, path-containment]
---

# Windows path-containment traps — 8.3 short names, alternate data streams, derived paths

## Problem

Three distinct ways realpath-based path containment broke (or was bypassed) on Windows/NTFS in this repo, each found by a real failure or a hostile test:

1. **8.3 short-name false positive.** With `MOG_WORKBOOK_DIR` under `os.tmpdir()` (`C:\Users\MARKME~1\...`), every legitimate file was rejected: "Path escapes the workbook root: sample.xlsx".
2. **Alternate data streams bypass the extension allowlist.** `notes.txt:book.xlsx` names an ADS on `notes.txt`; Node's `extname()` reads the part after the colon, so the allowlist saw `.xlsx` and admitted a `.txt` target. The write then failed with an opaque `EINVAL` from `rename` instead of a policy error.
3. **Derived paths escaped the checks.** A planted symlink at `<file>.xlsx.bak` let the backup `copyFile` write outside the root; the headless lane's derived `.headless.png` screenshot path was never checked at all.

## Root Cause

1. **`fs.realpathSync` (the JS implementation) does not expand 8.3 short names; `realpathSync.native` and the promises-API `realpath` do.** `canonicalizeRoot` used the JS variant (root stayed `MARKME~1`) while target canonicalization used the native variant (target expanded to `MarkMelanson`), so `path.relative()` saw every real file as an escape. The existing 64 tests never caught it because both test files pre-expanded their roots with `await realpath(await mkdtemp(...))` — the fixtures hid the asymmetry.
2. `extname()` is not a file-type check on NTFS — the colon syntax embeds a second "extension".
3. Containment was enforced on the *requested* path but not on paths the server itself computed (`.bak`, `.headless.png`).

## Solution

- `canonicalizeRoot` switched to `realpathSync.native`, plus a regression test asserting it "agrees with the native realpath used for targets".
- Reject any path segment containing a colon **before** the extension check (`Path names an alternate data stream`). Done test-first: both new cases were confirmed failing for the right reason before the guard went in. No legitimate workbook name contains a colon.
- Unlink the backup path before copying onto it (`rm(previous, { force: true })`) so the copy always creates a fresh regular file; run every derived path (backup, screenshot) through the same `resolveSaveTarget` policy as requested paths, before the engine loads.

## Prevention

- On Windows, canonicalize **both** sides of a containment comparison with the same realpath implementation — and prefer the native one.
- Don't pre-canonicalize test fixture roots; a raw `os.tmpdir()` root is exactly the case that catches asymmetry.
- Enumerate every path the server derives from a request and validate it like a request. The two real containment bugs here were both on derived paths.
- Junctions are creatable without elevation on Windows (file symlinks need dev mode or elevation) — lexical prefix checks are unsound; realpath containment is the floor.

## Related Issues

- docs/solutions/design-patterns/crash-safe-workbook-saves.md — the staged-write pipeline these checks guard
- docs/solutions/architecture-patterns/validating-mog-mcp-apps-without-overclaiming-codex-host-support.md — the path-policy rules as shipped
