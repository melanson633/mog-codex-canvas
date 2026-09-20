---
title: Parallel Agent Workbench - Plan
type: feat
date: 2026-09-19
topic: parallel-agent-workbench
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Parallel Agent Workbench - Plan

## Goal Capsule

**Objective:** Mark can leave instructions beside a workbook, run them, and continue working in another workbook while results arrive in the right place.

**Product authority:** The user's September 19 request explicitly asks for three architectures for notes and parallel work, an autonomous choice, and implementation. This contract covers those two connected parts. Local-file opening and full-canvas speed are adjacent work owned by the same release.

**Open blockers:** None for the selected design. Real authenticated concurrent model runs passed on staging and production; see the release report.

## Product Contract

### Summary

Add durable instructions and a Run button to each workbook's Review Desk. Keep multiple workbook desks open in tabs, preserve each desk's state, and run independent jobs concurrently through a local queue.

### Three architectures considered

| Architecture | Notes and immediate execution | Parallel workbook experience | Deliverables and tradeoff |
| --- | --- | --- | --- |
| A. Browser notes and host-controlled WebMCP | Store notes in browser storage; expose note and analysis actions to a connected browser agent. Run requests depend on that host being attached. | Independent browser tabs, each with its own workbook and agent conversation. | Small note editor, browser tool registration, launch instructions. Lowest server complexity, but closed tabs lose execution continuity and a Run button cannot promise a live agent without a host. |
| B. Local durable jobs and workbook tabs — selected | Persist workbook/sheet/range notes locally; Run creates a tracked job. An installed authenticated model returns a bounded plan; the server validates and executes supported workbook operations. | In-app workbook tabs retain their canvas and analysis state. A bounded queue runs different workbooks concurrently and serializes jobs for the same workbook. | Notes, task status/results, cancellable queue, model runner, validated executor, per-workbook tabs, reload recovery and tests. Works with the existing local production service and requires no new cloud application. |
| C. Hosted workspace coordinator and local runner | A hosted service stores notes and schedules remote agents; an outbound local runner supplies approved workbook snapshots and applies checked results. | Cloud workspace board with parallel remote jobs and local synchronization. | Hosted identity/storage/queue, runner pairing, sync conflict handling, remote job UI. Supports cross-device use, but adds deployment and data-transfer boundaries unrelated to the immediate local need. |

Architecture B best satisfies both objectives now. It uses the existing local workbook service and makes a job's lifetime independent of the selected tab. Architecture A remains useful as an optional access path to the same validated actions; it must not be the sole Run mechanism. Architecture C remains deferred.

### Requirements

- R1. A note belongs to a named workbook and optionally a sheet or cell range; the user can capture the current selection without typing its address.
- R2. Notes and completed job results survive page reload and server restart in local storage controlled by the workbook service.
- R3. Save note preserves instructions for later; Run saves the note and begins a real model-backed job with visible queued, running, completed, failed or cancelled state.
- R4. Running a note sends its text and the explicitly scoped, privacy-filtered saved workbook context to the signed-in model service; the UI states this before the Run action.
- R5. The model receives no general filesystem or shell tools and returns a validated plan from the application's supported operations; unsupported requests finish with a clear explanation rather than invented success.
- R6. The agent returns answers and proposed cell edits; Preview and Apply show the proposal before changes pass through the existing headless service, revision checks, occupied-cell interlock and receipts.
- R7. Distinct workbooks can run up to two jobs concurrently, while jobs targeting the same canonical workbook run in order.
- R8. Up to four open workbook tabs preserve each tab's canvas, unsaved changes, analysis inputs, notes and results; switching must not remount a healthy canvas.
- R9. Each tab shows its workbook name and working or attention status, and closing a dirty tab requires a clear save-or-keep-open decision.
- R10. A job captures its workbook, scope and revision when submitted; later tab changes never retarget that job or place its result in another workbook.
- R11. Cancellation prevents any later write from that job, and a server restart marks interrupted jobs clearly instead of silently rerunning them.
- R12. Model errors, invalid output, timeouts and authentication failures remain visible with a retry action; no failure is reported as completed execution.

### Key decisions and evidence

The selected design is an agent recommendation under the user's instruction to decide autonomously, not a previously user-approved architectural choice.

- Use the existing service boundary for R2 and R6. `server/workbook-service.ts` already owns path containment, revision checks, save receipts and the human/agent occupied-cell interlock. No general file path supplied by a model should bypass it.
- Prefer a model with explicitly disabled tools for R5. Local `claude --help` reports `--tools ""`, `--strict-mcp-config`, `--json-schema`, `--output-format json`, `--no-session-persistence` and `--disable-slash-commands`; version is 2.1.278. Authentication status reports a signed-in Claude subscription. The `--bare` option is unsuitable for that login because its help explicitly says OAuth is not read.
- Codex is an available alternative, not a verified fallback contract. `codex login status` reports ChatGPT login and `codex exec --help` offers structured output and read-only execution. Its read-only sandbox alone does not establish R5 because read access and tools still exist.
- Preserve live desk instances for R8. `src/AnalystWorkspace.tsx` currently stores one file and resets results, errors and dirty state when it changes; merely adding a row of tab buttons around that state does not preserve independent sessions.
- Reuse loopback host/origin checks for job endpoints. `server/production.ts` already rejects other hosts, mismatched origins and cross-site requests. The queue is local application functionality, not a public remote execution endpoint.

### Acceptance examples

- AE1. **Covers R1–R4.** Mark selects B3:B8, writes “Explain the change in margin,” saves it, reloads, and sees the same note. Run produces a real model answer citing that saved scope.
- AE2. **Covers R7, R8, R10.** Workbook A has a running request; Mark switches to B, starts another, and edits a cell there. Both results return to their original desks and the edit remains present.
- AE3. **Covers R5, R6, R12.** An instruction outside supported operations receives an explicit unsupported result. A stale revision cannot overwrite a newer human save.
- AE4. **Covers R9, R11.** Closing a dirty workbook does not discard its edits. Cancelling a job prevents its pending write, and restarting the server preserves its note while reporting the interrupted run.

### Scope boundaries

This release delivers a local single-user workbench with bounded agent actions. It does not deliver arbitrary autonomous shell access, cross-device collaboration, automatic cloud workbook synchronization or guaranteed WebMCP host availability. These exclusions do not prevent adding another access path to the same validated local actions later.

### Implementation and acceptance

Completed: answer generation and previewable literal/formula cell proposals, durable service-owned JSON state, two concurrent jobs on distinct workbooks, four mounted workbook desks, local XLSX import, and same-canvas expansion.

| Requirements | Evidence |
| --- | --- |
| R1–R4 | Scoped note editor and disclosure; real Save & run; saved note survives browser reload. Queue restart unit test verifies persistence and interruption. |
| R5–R6 | Tool-disabled runner; scoped output validation; service tests for revisions, dirty/occupied protection, literals/formulas and screenshots. Production synthetic B2 = 42 preview/apply passes. |
| R7–R10 | Unit tests prove same-workbook serialization and immutable job context. Production browser gate observes two concurrent jobs, distinct results, retained iframes, note drafts and an unsaved human cell edit across switches. Dirty close checks the immediate canvas as well as reported state. |
| R11–R12 | Tests cover cancellation, late-result rejection, restart interruption, invalid output, privacy failure and storage failure; visible failed/interrupted status and Run again remain available. |

The final release report is [PARALLEL-WORKBENCH-RELEASE.md](../PARALLEL-WORKBENCH-RELEASE.md). These checks distinguish actual model/browser execution from source-inspected controls; they do not claim universal Excel parity or a whole-workbook agent audit.
