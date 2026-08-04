---
title: POSIX-only plugin helpers fail on Windows — verify before trusting automation loops
date: 2026-07-26
category: workflow-issues
module: dev-workflow
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A Claude Code / Codex plugin ships a Python or shell helper and the host is native Windows"
  - "An automation claims to be watching or babysitting something in the background"
symptoms:
  - "ModuleNotFoundError: No module named 'fcntl' from a plugin's bundled Python script"
  - "install: cannot change permissions of /tmp/... Permission denied under Git Bash"
root_cause: incomplete_setup
resolution_type: workflow_improvement
tags: [windows, fcntl, git-bash, plugins, ce-babysit-pr, gh-cli]
---

# POSIX-only plugin helpers fail on Windows — verify before trusting automation loops

## Context

The compound-engineering `ce-babysit-pr` skill's watch loop (`pr-snapshot`) crashed at startup on this Windows 11 host: its state locking imports `fcntl`, a POSIX-only Python module that does not exist on Windows Python. Its scratch-dir setup (`install -d -m 700 /tmp/...`) also misbehaves under Git Bash's `/tmp` — a POSIX-ism hit twice in the same plugin family (`ce-babysit-pr` and `ce-handoff`; the handoff file lands with default Windows ACLs, not an enforced mode). The failure was instant and loud here — but the general risk is an automation that *appears* armed while its helper never started.

A separate session on this repo showed the sharper variant: the automation *did* start and then exited on a **false positive**. A dev-server wait loop gated on `grep -qi "ready in"`, and that string is a substring of `"Port 5273 is already in use"` — so the loop declared the server up on a startup *failure*, and the smoke test silently drove a stale dev server from a *different git worktree*, saving into the wrong `workbooks/` directory. The replacement gate `grep -qE "Local:.*5273"` also failed, because Vite's output is colorized and ANSI escape codes sit inside `Local:`.

## Guidance

- Before relying on any plugin-bundled script on this host, check for POSIX-only markers: `import fcntl`, `os.fork`, `pwd`/`grp`, `signal.SIGHUP`, hard `chmod` expectations under `/tmp`. Any of these means the script will not run on native Windows Python.
- When a watch/automation loop cannot run, degrade honestly: do the equivalent check manually (here, one `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup,comments,reviews` tick) and state plainly that continuous monitoring is not running, rather than half-running the loop.
- When asked whether a background automation from an earlier session is still alive on Windows, check processes by command line, not by memory of what was announced: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '<marker>' }`. An announced watcher that crashed at startup leaves no process.
- Readiness predicates must be able to distinguish "up" from "failed to come up": anchor the match, strip ANSI, and prefer an actual probe (HTTP request to the port) over grepping a colorized log.
- Every worktree's `npm run dev` binds the same port, and stopping the task-runner `npm` process does not kill the underlying Vite child. Verify with `Get-NetTCPConnection -LocalPort <p> -State Listen`, kill the owning PID, and confirm the listener count is 0 — otherwise the next "restart" talks to the survivor from another worktree.
- On repos with no CI, an empty `statusCheckRollup` from `gh pr view` means **no checks exist**, not that checks passed.

## Why This Matters

The dangerous outcome is not the crash — it is believing a monitor is running when it is not, or hunting for a "zombie watcher" that never existed. One process-list check resolves both directions of that confusion in seconds.

## When to Apply

- Any plugin/skill that says it will "keep watching" something on this Windows host — verify its helper actually survived startup.
- Cross-platform plugin authoring: state locking needs an `fcntl`/`msvcrt` split (or a lock-file approach) to run on Windows.

## Examples

```powershell
# Is any babysitter/watcher actually running?
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'pr-snapshot|ce-babysit' } |
  Select-Object ProcessId, Name, CommandLine
```

```bash
# Manual one-tick PR status check (the honest fallback)
gh pr view <N> --json state,mergeable,mergeStateStatus,statusCheckRollup,comments,reviews
```

## Related

- None yet.
