---
title: Crash-safe workbook saves — staged write, fsync, backup, atomic rename
date: 2026-07-26
category: design-patterns
module: server
problem_type: design_pattern
component: file_bridge
severity: high
applies_when:
  - "A server writes user files in place and a failed write must never destroy the original"
  - "Multiple writers (canvas save, headless agent) can hit the same file"
tags: [atomic-rename, fsync, backup, windows, ntfs, concurrency, last-write-wins]
---

# Crash-safe workbook saves — staged write, fsync, backup, atomic rename

## Context

`server/file-bridge.ts` originally wrote incoming bytes directly over the target `.xlsx`. Any failure mid-write (process death, disk error, client hangup) left a truncated or zero-byte workbook — the file the user was editing.

## Guidance

Stage → fsync → backup → rename (commit `f6fd462`):

1. Write bytes to `<file>.staged` and `fsync`.
2. Copy the existing file to `<file>.bak` (unlinking `<file>.bak` first — see the containment doc).
3. `rename(staged → file)`. `fs.rename` maps to `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, which is atomic on NTFS as well as POSIX — the same pipeline is portable, no Windows-specific fallback needed.
4. On any error, remove the staged file and say explicitly whether the on-disk file changed: "The file on disk was not changed by this save." / "No file was written." Worst case after a hard crash is an orphan `.staged` file.

Concurrency stays **last-write-wins, measured not assumed**: a bounded retry on contended `rename` was prototyped and abandoned because four concurrent writers produced identical results with and without it (`succeeded 20/32, torn 0` both ways — the retry only converts `EPERM` into `EBUSY`). The loser is told it failed rather than silently merged, and the README documents the measured limit, not the imagined one.

Two deliberate non-fixes:

- **No `.staged` orphan sweeper** — a sweeper could delete another dev server's in-flight write. Orphans are gitignored instead (`workbooks/**/*.{bak,png,staged}` — the `**` matters because subdirectory workbooks are allowed).
- **Vite must not watch the workbook root** — chokidar over a directory the server writes to causes `EBUSY`/reload storms on Windows; exclude it with `watch.ignored` (using `normalizePath(workbookRoot) + '/**'`) in `vite.config.ts`.

Above the bridge, the workbook service adds revision protection: revision = SHA-256 of on-disk bytes; a stale save gets a `revision-conflict` and its attempted bytes survive as `.conflict-<stamp>.xlsx` — "do not silently choose a winner".

## Why This Matters

The tests that guard this are "under duress" tests: SIGKILL at the promotion instant, a planted `.bak` symlink, a 4-way save race, a client hanging up mid-upload. An interrupted save must never cost the workbook.

## Related

- docs/solutions/security-issues/windows-path-containment-traps.md — the `.bak` symlink and derived-path checks
- docs/solutions/architecture-patterns/validating-mog-mcp-apps-without-overclaiming-codex-host-support.md — where this pipeline sits in the overall workbook authority
