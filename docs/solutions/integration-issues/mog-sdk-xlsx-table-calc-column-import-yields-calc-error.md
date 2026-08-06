---
title: "@mog-sdk/sdk 0.10.5 mis-evaluates some XLSX table calculated columns on import and calls the graph clean"
date: 2026-08-04
category: integration-issues
module: mog-canvas-embed-adapter-workbook-open-path
problem_type: integration_issue
component: service_object
severity: critical
symptoms:
  - "`#CALC!` fills the entire Weekly Summary grid for a workbook whose file-on-disk cached values are correct"
  - "`TxnLog[EffectiveCategory]` evaluates to `#CALC!` on all 4,167 rows; `TxnLog[DefaultCategory]` on 8 rows; `TxnLog[UniqueTxnKey]` to `#VALUE!` on all 4,167"
  - "`TxnLog[Direction]`, a calculated column referencing only static columns, is correct on all 4,167 rows"
  - "`SUMIFS` over the broken structured column cascades `#CALC!` into `E9`, `E93`, and `E95`"
  - "`recalculateAll()` returns in 0 ms and changes nothing — the dependency graph is marked clean"
  - "Browser tab hard-freezes for ~104 s during single-threaded import — a size-driven engine cost, reproduced on unrelated workbooks of similar size"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - tooling
tags:
  - mog-sdk
  - xlsx-import
  - calculated-columns
  - structured-references
  - calc-error
  - silent-data-corruption
  - adapter-probe
  - save-gate
---

# @mog-sdk/sdk 0.10.5 mis-evaluates some XLSX table calculated columns on import and calls the graph clean

## Problem

A delivered client workbook — `heritage_cash_reporting_2026-08-02.xlsx`, 640,154 bytes, with a 4,167-row `TxnLog` table — opened in the Mog canvas side panel and rendered `#CALC!` across the entire Weekly Summary grid.

The file on disk is correct. The defect is in the import/evaluation path of `@mog-sdk/sdk`, which this repo depends on at `^0.10.5` ([package.json:27](../../../package.json)), resolved to 0.10.5 in `node_modules`. Some — not all — Excel **table calculated columns**, the formulas carried as `calculatedColumnFormula` in `xl/tables/table*.xml`, evaluate to an error on import for this workbook, and the engine then marks the dependency graph clean. The engine does not report an error state or a pending calculation; it reports a *settled wrong value*.

Which ones fail is not random, and the pattern is the useful part. Measuring all four calculated columns in `TxnLog` after import:

| col | formula shape | result |
| --- | --- | --- |
| `Direction` | `IF([@Amount]<0,"Out","In")` — static column only | correct on all 4,167 rows |
| `DefaultCategory` | `IF([@CleanName]="",[@PriorCategory],XLOOKUP(...))` | `#CALC!` on 8 rows |
| `EffectiveCategory` | references `[@DefaultCategory]`, another calculated column | `#CALC!` on all 4,167 |
| `UniqueTxnKey` | `INDEX(TxnLog[TransactionKey],1):[@TransactionKey]` range | `#VALUE!` on all 4,167 |

`Direction` succeeding rules out calculated columns as such. The distinguishing property of `EffectiveCategory` is that it makes a `[#This Row]` reference to *another calculated column in the same table*; `UniqueTxnKey`'s is a range built with the `:` operator over structured references, which fails differently (`#VALUE!`) and is plausibly a second defect. And this is not error propagation: `DefaultCategory` is correct on 4,159 rows, yet `EffectiveCategory` fails on all 4,167 — the consumer fails where the producer succeeded.

That last property is what makes this dangerous rather than merely annoying. `#CALC!` is Excel's empty-array error, so the failure presents as a formula problem in the user's own spreadsheet when it is actually a problem in the importer. The grid looks finished. Nothing in the canvas says otherwise.

The blast radius is a data-integrity one. A canvas Save serializes engine state back to bytes and lands them on disk through the host bridge (`persistThroughHost`, [src/adapters/mog-embed-adapter.ts:255](../../../src/adapters/mog-embed-adapter.ts), the funnel every canvas save goes through). Pressing Save on this workbook would write `#CALC!` into a delivered client file. Read-only viewing is safe; saving is not. As of PR #14 that specific write is refused — see [Solution](#solution) — but the underlying SDK defect is unchanged.

## Symptoms

- Weekly Summary grid displays `#CALC!` in every cell; `E9`, `E93`, and `E95` are the visible casualties. Each is downstream of `SUMIFS(..., TxnLog[EffectiveCategory], "Revenue", ...)`.
- `TxnLog!Q` (`EffectiveCategory`, a calculated column) is `#CALC!` on **all 4,167 rows**, independent of whether an override value exists for that row.
- `TxnLog!N` (`DefaultCategory`, also a calculated column) is `#CALC!` on 8 of 4,167 rows — and those 8 are **position-dependent, not value-dependent**. They cluster in two narrow bands (`N2674`, `N2689`, `N2694`, `N2699`–`N2701`, then `N2883`, `N2894`), and their `CleanName` inputs are ordinary vendor strings the same column computes correctly on 19 to 486 other rows apiece. Every `CleanName` in the table is present in `VendorMap[CleanName]`, so no row takes the not-found path, and the single blank-`CleanName` row (325) computes fine. Two tight failing bands on inputs that succeed everywhere else reads like an evaluation-ordering or chunk-boundary effect.
- `TxnLog!T` (`UniqueTxnKey`) is `#VALUE!` — a different error — on all 4,167 rows. `TxnLog!R` (`Direction`) is correct on all 4,167.
- The same workbook's raw XML carries correct cached values for those cells. For example, `Q2`:
  ```xml
  <c r="Q2" t="str"><f>IF(TxnLog[[#This Row],[CategoryOverride]]&lt;&gt;"",TxnLog[[#This Row],[CategoryOverride]],TxnLog[[#This Row],[DefaultCategory]])</f><v>Subcontractors</v></c>
  ```
  Excel's cached result is `Subcontractors`. Mog's computed result is `#CALC!`.
- Import takes roughly 104 seconds in the browser and 77–91 seconds headless, single-threaded in both. Earlier in the same work the browser tab hard-froze during open — that freeze is the import cost, not the evaluation bug, but it shares the blast radius and it is what made the failure hard to observe cleanly in the first place.

  **The import cost is not a property of this file.** An unrelated 934,756-byte workbook carrying **zero** `calculatedColumnFormula` entries reproduced roughly 92 seconds to renderer-ready, and its fidelity check returned `passed` — slow without being wrong. Nothing about the calculated columns, the `TxnLog` table, or the evaluation defect is required to pay that cost; workbook size alone is. Treat the freeze as an engine characteristic at this scale and the `#CALC!` results as the file-specific defect; the two are independent and were only ever observed together by coincidence of which workbook surfaced first. Both figures are single observed runs on one host, not benchmarks — the measurements and their caveats are recorded in [docs/solutions/architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md](../architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md).

## What Didn't Work

Seven hypotheses were tested and disproven. Recording them matters more than usual here, because the first one had already been written down as a diagnosis and was wrong.

**1. "Mog can't evaluate `SUMIFS` against structured table references."** False, and this was the earlier, incorrect diagnosis. Structured references, `SUMIFS`, and `_xlfn.XLOOKUP` all evaluate correctly when the same formulas are authored fresh inside the engine. The engine's formula support is not the problem.

**2. `valuesOnly: true` on import.** The option exists — `DocumentImportOptions.valuesOnly` is documented in the SDK contracts as "Import values only, skip formulas". Setting it does not mitigate the failure.

**3. An open-time calculation-mode option.** None exists. `SpreadsheetOpenWorkbookRequest` exposes exactly four members — `workbookId`, `workbookSessionId`, `displayName`, `source` — and this repo already passes three of them ([src/adapters/mog-embed-adapter.ts:245-249](../../../src/adapters/mog-embed-adapter.ts)). At the time of diagnosis, a repo-wide grep for `recalc|CALC|calculat|readOnly` across `src/`, `server/`, and `scripts/` matched only a doc comment on the adapter capability contract ([src/adapters/types.ts:20](../../../src/adapters/types.ts)) — the guard described below has since added its own matches, but the SDK still exposes no knob to turn.

**4. "The calculation budget just ran out mid-import."** Disproven directly. `recalculateAll()` returned in **0 ms** and changed nothing. Raw output from that run: `E9 after import "#CALC!" / recalcAll ms 0 / E9 after recalc "#CALC!" / Q2 after recalc "#CALC!" N2674 "#CALC!"`. A zero-millisecond full recalculation is the tell: the engine believes the graph is already clean and there is nothing to redo. The wrong values are settled, not pending.

**5. Formula shape.** A minimal workbook crafted with `openpyxl` — same formula shapes, same calculated-column metadata in the table part — does **not** reproduce the failure. Neither does the identical formula placed in a cell **outside** the table. The trigger is size- and mix-dependent and involves table membership, which is why a small repro did not surface it.

**6. Error propagation from the upstream column.** `EffectiveCategory` reads `[@DefaultCategory]`, so an inherited error was the obvious first guess. It does not hold: `DefaultCategory` is correct on 4,159 rows, and `EffectiveCategory` fails on all 4,167 — including every row whose input computed correctly.

**7. Something shared by the 8 failing `DefaultCategory` rows.** Their inputs are unremarkable and recur constantly elsewhere in the column (the least common appears 19 times, the most common 486). No lookup misses exist anywhere in the table. What the 8 do share is *adjacency* — two tight row bands — which points at evaluation order rather than data.

The override branch was also ruled out as a trigger: `TxnLog!O` (`CategoryOverride`) is largely absent from the XML — only 18 `O` cells exist in the entire column — yet all 4,167 `Q` cells fail.

## Solution

The verified diagnosis: on this large/mixed workbook, `@mog-sdk/sdk` 0.10.5 evaluates certain Excel table calculated-column formulas to an error — `#CALC!` where a `[#This Row]` reference points at another calculated column, `#VALUE!` where a range is built with `:` over structured references — and then marks the dependency graph clean, producing a settled wrong value rather than an error or a pending state. A calculated column referencing only static columns evaluates correctly, so the trigger is the reference shape rather than calculated columns in general. **The upstream defect is not ours to fix and is still present.** What changed is that this repo no longer lets it reach disk.

**Immediate handling of the affected file.** Do not press Save in the canvas. Read the numbers via Excel or via `openpyxl` with `data_only=True`; the cached values in the file are correct, so the deliverable itself needs no repair.

**Upstream.** Report this to Mog as a **wrong-result evaluation bug**, not a performance bug. The ~104 s import is a real and separate problem — and, per the symptom note above, one that reproduces on similarly sized workbooks with no calculated columns at all — but filing it as slowness invites a scheduling fix for a correctness defect. The two should be filed apart.

### The guard shipped — as a save-time gate, not the open-time one first recommended

PR #14 (`901516c`) landed the verification guard as [server/value-fidelity.ts](../../../server/value-fidelity.ts) plus its OOXML reader [server/ooxml-cache.ts](../../../server/ooxml-cache.ts). The oracle is the one this doc identified: the cached `<v>` Excel writes alongside every formula it evaluated. The placement is different from the original recommendation, and the difference matters when reading either file:

| | Originally recommended | What shipped |
| --- | --- | --- |
| Where | Client adapter, after `whenReady()` | Server, in `workbook-service.ts` — at byte admission on save and again on validate |
| Scope | The canvas | Every editing lane (canvas, MCP tools, headless scripts) — the service is the single funnel |
| Reported through | The Adapter Probe reason | A dedicated fidelity report on the save/validate result |
| On mismatch | Disable the Save command | Refuse the save outright; preserve the attempted bytes as a `.fidelity-refused-*.xlsx` sibling |

Placing it server-side rather than in the adapter is the stronger choice for the reason `workbook-service.ts` exists at all: one policy, every lane. An adapter-side guard would have protected the canvas and left the headless and MCP lanes able to write the same `#CALC!`.

Three properties of the shipped gate are worth knowing before relying on it:

- **It refuses exactly one deterministic shape** — the file recorded a *non-error* result for a formula and the engine reports an *error literal* (`#CALC!`, `#VALUE!`, `#NAME?`, …) for that same cell. That is the high-signal shape of this defect. It is not a general value-comparison gate and will not catch an engine that computes a plausible wrong *number*.
- **Everything short of that is `unverified`, never `passed`** — unreadable bytes, no cached values, a sheet the engine cannot resolve, an engine that will not load. Unverified saves are **allowed to proceed**, because refusing them would convert missing evidence into data loss. They are reported as unverified.
- **The sample is bounded** at `FIDELITY_CELL_LIMIT` (500 cells), and the report carries `truncated` when the file has more.

The verdict surfaces as warn-text in both UIs — [src/App.tsx:313-321](../../../src/App.tsx) and [plugins/mog-canvas/ui/src/mcp-app.ts:116-125](../../../plugins/mog-canvas/ui/src/mcp-app.ts) — styled so it survives Compact Mode, which is the same protection the Adapter Probe route would have inherited.

The point still stands as originally written: the canvas must not render a plausible-looking grid full of `#CALC!` with a live Save button next to it. The grid still renders — the SDK defect is upstream — but the Save no longer lands.

### The engine can detect this itself — verified on the reproducer, 2026-08-06

`wb.diagnostics.checkFormulaErrors()` finds the defect. Measured against `v2_heritage_cash_reporting_2026-08-02.xlsx` (823,803 bytes — a later, larger build than the 640,154-byte file above; it reproduces identically):

| Scan | Time | Findings |
| --- | --- | --- |
| Whole workbook, `{ limit: 50000 }` | 15.4 s | 10,798 across 6 sheets, `truncated: false` |
| `{ sheetName: 'TxnLog', limit: 50000 }` | 12.9 s | 8,342 |
| `{ sheetName: 'TxnLog', range: 'Q1:Q4200', limit: 50000 }` | **0.14 s** | 4,167 |

The counts corroborate the column analysis above exactly: `TxnLog` reports **4,175** `#CALC!` — 4,167 from `EffectiveCategory` plus the **8** `DefaultCategory` rows — and **4,167** `#VALUE!` from `UniqueTxnKey`.

Three things this changes:

- **The blast radius is wider than recorded.** `Weekly Summary` was not the only casualty: `Monthly Summary` (143), `Checks - Internal` (49), and `Service Finance` (14) also carry `#CALC!`. The original investigation looked where the failure was visible.
- **A targeted scan is effectively free.** 0.14 s against a known column, versus a 117–187 s import (two runs on this host; treat as variance, not a benchmark — both exceed the 77–91 s recorded earlier for the smaller file). Detection is not what costs; loading is.
- **The default finding cap hides the worst of it.** With no `limit`, the scan returns 1,000 findings, `truncated: true`, and every one of them comes from `Weekly Summary` — `TxnLog` is never reached. `ok: false` is still correct, but a caller that reads the findings list to decide *which* cells are bad gets a badly wrong answer. Always pass an explicit `limit`.

**This does not retire [server/value-fidelity.ts](../../../server/value-fidelity.ts).** On this same file, `checkErrors()` reports `stale-cached-values` as **`unsupported`** — that check is the engine's own version of the cached-`<v>` comparison, and it does not run in this host. The two also answer different questions: `checkFormulaErrors` flags *any* error value, including ones legitimately present in a source file, so it cannot be a refusal criterion. The gate refuses only the high-signal shape where the file recorded a non-error and the engine reports an error.

The useful shape is both, at different moments: `checkFormulaErrors` is cheap enough to run at **open** time as a warning, where the gate acts at **save** time as a refusal.

### `importWarnings` names dropped parts that are plausibly the mechanism

`wb.importWarnings` is non-empty on this file — two `import_error` entries, `severity: "warning"`, `recoverability: "partiallySupported"`, reporting *"Dropped XLSX import data with no modeled ParseOutput owner"*. The named parts include the **calculation chain cache** and **table XML passthrough package parts**.

That is suggestive rather than proven, and it should be labelled that way: the defect is in *table calculated columns*, and the importer is reporting that it dropped both the table XML passthrough and the calculation chain. A dropped calculation chain would also explain hypothesis 4 — `recalculateAll()` returning in 0 ms because the graph has no chain to walk and believes itself settled.

Nothing here confirms causation. But `importWarnings` was never checked during the original investigation, it is free, and it fires on this file. **Read it before forming a hypothesis next time.**

## Why This Works

The guard works because the workbook ships its own answer key. Excel writes a cached `<v>` alongside every formula it evaluates. That gives a cheap, local, high-signal oracle: any formula cell where the engine disagrees with Excel's cached value is either an import defect or a deliberate recalculation — and at open time, before any user edit, it can only be the former. No knowledge of Mog's internals is required, and the check does not depend on recognizing `#CALC!` specifically; it catches any class of silent import divergence, including ones not yet seen.

It also targets the actual failure mode rather than the visible one. Every mitigation in the "What Didn't Work" list assumed the engine would tell us something was wrong — an error event, a pending calculation, a budget to raise. None of those exist here, and hypothesis 4's 0 ms recalculation proves why: the engine is confident. A guard that asks the engine how it feels learns nothing. A guard that compares the engine's output against an independent record catches exactly this.

Finally, the design follows invariants this repo already enforces rather than inventing new policy. [AGENTS.md:50-53](../../../AGENTS.md) states: "**Never draw a fake grid.** If the adapter fails to resolve, `src/adapters/unavailable-adapter.ts` renders the real reason and every session method throws. A mock grid that looks like it works is worse than a visible failure." A grid of `#CALC!` from a file whose real values are known-good is the same category of lie, arriving one layer later — the adapter resolved fine; the data did not. And [AGENTS.md:54-57](../../../AGENTS.md): "**Never hide a failure to reduce chrome.** A density flag means 'show less chrome,' never 'show fewer failures'." Routing the mismatch through the Adapter Probe reason inherits that protection, because Compact Mode is already forbidden from suppressing it.

## Prevention

- **Treat a cached-value/computed-value mismatch as a first-class import failure**, not a rendering quirk. Build the comparison into the open path so it is checked every time rather than remembered.
- **Never let a canvas Save be reachable from an unverified engine state.** Saves in this repo are last-write-wins and were originally refused only on revision conflict ([AGENTS.md:67-68](../../../AGENTS.md), [server/workbook-service.ts:11-14](../../../server/workbook-service.ts)) — nothing in that path inspected whether the bytes being written were semantically sound. The value-fidelity gate is now the second refusal reason in that same funnel, which is where it belongs: durability, identity, and content correctness are three separate properties and each needs its own check.
- **When an engine reports a settled value, verify it against something outside the engine.** "It returned without erroring" is not evidence. The 0 ms `recalculateAll()` is the canonical example of a confident wrong answer.
- **A same-engine round trip is not a fidelity check.** The save path already reopens a written file with the headless engine and reads it back before trusting it ([server/workbook-service.ts:15-16](../../../server/workbook-service.ts)) — but a value the engine got wrong on import survives that round trip intact, because the engine agrees with itself. Value fidelity has to be measured against the file's own cached values. This is now the definition of **Value Fidelity** in [CONCEPTS.md](../../../CONCEPTS.md) and the contract of `checkValueFidelity`.
- **Separate a size cost from a correctness cost before filing either.** The ~104 s freeze and the `#CALC!` results arrived on the same workbook and read as one incident. They are not: a same-size workbook with no calculated columns pays the same freeze, and a small workbook with the same formula shapes shows no error. Two symptoms on one file is a coincidence until a controlled second file says otherwise.
- **Do not accept a small repro as proof of absence.** The `openpyxl` minimal file did not reproduce this; the defect is size- and mix-dependent. When a bug does not shrink, that is data about the bug, not grounds to dismiss it.
- **Keep the disproven diagnosis visible.** "Mog can't do `SUMIFS` on structured references" was written down before it was tested, and it sent the next reader in the wrong direction. Per the evidence-discipline section of [AGENTS.md:87-99](../../../AGENTS.md), this repo separates verified from assumed on purpose — a wrong diagnosis left standing costs more than no diagnosis.

## Related Issues

- [docs/solutions/ui-bugs/compact-mode-hid-adapter-failure-warning.md](../ui-bugs/compact-mode-hid-adapter-failure-warning.md) — establishes the Adapter Probe as the single surface a degradation must reach, and the compact-mode rules that keep it visible. That is the channel the proposed guard would report through. Note that its probe-failure framing assumes the live canvas failed to resolve; this defect is a second failure class where the canvas resolves fine and the *data* is wrong.
- [docs/solutions/design-patterns/crash-safe-workbook-saves.md](../design-patterns/crash-safe-workbook-saves.md) — documents the save pipeline that would otherwise faithfully persist `#CALC!`. Byte-level save safety is not value-level save safety: a save carrying `#CALC!` is durable, non-torn, and revision-clean while still destroying a delivered file. The value-fidelity gate is the layer that closes that gap, in the same funnel and with the same "preserve the attempted bytes, do not silently choose a winner" handling.
- [docs/solutions/integration-issues/mog-sdk-node-subpath-and-proxy-introspection.md](mog-sdk-node-subpath-and-proxy-introspection.md) — the repo's catalog of `@mog-sdk/sdk` behaviors that guessing gets wrong. Its read-back-from-disk verification rule is the nearest existing prevention rule, and this defect shows where it is insufficient.
- [docs/solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md](../design-patterns/multi-pane-canvas-embedding-via-url-flags.md) — each compare pane is an independent engine runtime with its own Save, so an import-time miscalculation reproduces in every pane. Gating server-side rather than per-adapter covers all panes without per-pane wiring; it is also why the compare view pays the import cost once per pane, which is the freeze multiplied by pane count.
- [docs/solutions/runtime-errors/wasm-bindgen-ignores-wasm-base-url.md](../runtime-errors/wasm-bindgen-ignores-wasm-base-url.md) — prior instance of the same detection lesson: a response that looks successful but carries wrong content stays invisible until something downstream consumes it.
- [docs/solutions/architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md](../architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md) — the second measurement that separated this doc's two symptoms. It also shows how the `calculatedColumnFormula` trigger recorded here can be ruled in or out from the bytes in milliseconds, without opening the engine at all — the cheap pre-screen this defect wants.
- **Upstream: [`fundamental-research-labs/mog#337`](https://github.com/fundamental-research-labs/mog/issues/337)** — "XLSX import: `[#This Row]` reference to another calculated column yields `#CALC!`, and the graph is then marked clean". Filed 2026-08-04. As of 2026-08-06 it is open with no maintainer comment, label, assignee, or milestone. Treat the gate in [server/value-fidelity.ts](../../../server/value-fidelity.ts) as the standing mitigation, not a stopgap — there is no evidence of an upstream fix in progress. Re-check with `gh issue view 337 --repo fundamental-research-labs/mog` rather than trusting this line; the status is a snapshot and the issue number is the durable part.
