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
  - "Browser tab hard-freezes for ~104 s during single-threaded import of the 640 KB workbook"
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

The blast radius is a data-integrity one. A canvas Save serializes engine state back to bytes and lands them on disk through the host bridge (`persistThroughHost`, [src/adapters/mog-embed-adapter.ts:152](../../../src/adapters/mog-embed-adapter.ts), the funnel every canvas save goes through). Pressing Save on this workbook would write `#CALC!` into a delivered client file. Read-only viewing is safe; saving is not.

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

## What Didn't Work

Seven hypotheses were tested and disproven. Recording them matters more than usual here, because the first one had already been written down as a diagnosis and was wrong.

**1. "Mog can't evaluate `SUMIFS` against structured table references."** False, and this was the earlier, incorrect diagnosis. Structured references, `SUMIFS`, and `_xlfn.XLOOKUP` all evaluate correctly when the same formulas are authored fresh inside the engine. The engine's formula support is not the problem.

**2. `valuesOnly: true` on import.** The option exists — `DocumentImportOptions.valuesOnly` is documented in the SDK contracts as "Import values only, skip formulas". Setting it does not mitigate the failure.

**3. An open-time calculation-mode option.** None exists. `SpreadsheetOpenWorkbookRequest` exposes exactly four members — `workbookId`, `workbookSessionId`, `displayName`, `source` — and this repo already passes three of them ([src/adapters/mog-embed-adapter.ts:143-147](../../../src/adapters/mog-embed-adapter.ts)). A repo-wide grep for `recalc|CALC|calculat|readOnly` across `src/`, `server/`, and `scripts/` matches only a doc comment on the adapter capability contract ([src/adapters/types.ts:20](../../../src/adapters/types.ts)). There is no knob to turn.

**4. "The calculation budget just ran out mid-import."** Disproven directly. `recalculateAll()` returned in **0 ms** and changed nothing. Raw output from that run: `E9 after import "#CALC!" / recalcAll ms 0 / E9 after recalc "#CALC!" / Q2 after recalc "#CALC!" N2674 "#CALC!"`. A zero-millisecond full recalculation is the tell: the engine believes the graph is already clean and there is nothing to redo. The wrong values are settled, not pending.

**5. Formula shape.** A minimal workbook crafted with `openpyxl` — same formula shapes, same calculated-column metadata in the table part — does **not** reproduce the failure. Neither does the identical formula placed in a cell **outside** the table. The trigger is size- and mix-dependent and involves table membership, which is why a small repro did not surface it.

**6. Error propagation from the upstream column.** `EffectiveCategory` reads `[@DefaultCategory]`, so an inherited error was the obvious first guess. It does not hold: `DefaultCategory` is correct on 4,159 rows, and `EffectiveCategory` fails on all 4,167 — including every row whose input computed correctly.

**7. Something shared by the 8 failing `DefaultCategory` rows.** Their inputs are unremarkable and recur constantly elsewhere in the column (the least common appears 19 times, the most common 486). No lookup misses exist anywhere in the table. What the 8 do share is *adjacency* — two tight row bands — which points at evaluation order rather than data.

The override branch was also ruled out as a trigger: `TxnLog!O` (`CategoryOverride`) is largely absent from the XML — only 18 `O` cells exist in the entire column — yet all 4,167 `Q` cells fail.

## Solution

**Not yet implemented.** What follows is a verified diagnosis plus a recommended remediation. No code in this repo has been changed, and the upstream defect is not ours to fix.

The verified diagnosis: on this large/mixed workbook, `@mog-sdk/sdk` 0.10.5 evaluates certain Excel table calculated-column formulas to an error — `#CALC!` where a `[#This Row]` reference points at another calculated column, `#VALUE!` where a range is built with `:` over structured references — and then marks the dependency graph clean, producing a settled wrong value rather than an error or a pending state. A calculated column referencing only static columns evaluates correctly, so the trigger is the reference shape rather than calculated columns in general.

**Immediate handling of the affected file.** Do not press Save in the canvas. Read the numbers via Excel or via `openpyxl` with `data_only=True`; the cached values in the file are correct, so the deliverable itself needs no repair.

**Upstream.** Report this to Mog as a **wrong-result evaluation bug**, not a performance bug. The ~104 s import is a real and separate problem, but filing it as slowness invites a scheduling fix for a correctness defect. The two symptoms travel together and should be filed apart.

**Recommended durable fix in this repo: an open-time verification guard.** After `openWorkbook` resolves and `whenReady()` settles ([src/adapters/mog-embed-adapter.ts:143-148](../../../src/adapters/mog-embed-adapter.ts)), sample formula cells that carry a cached `<v>` in the source XML and compare the engine's computed value against that cached value. On mismatch:

1. Surface the failure through the **Adapter Probe** reason. Per [CONCEPTS.md](../../../CONCEPTS.md), the probe's reason text is written to be shown verbatim to the user, and it is the one signal distinguishing a real canvas from a placeholder.
2. Disable the Save command, so a divergent engine state cannot be written back over a correct file.

The point is that the canvas must not render a plausible-looking grid full of `#CALC!` with a live Save button next to it.

## Why This Works

The guard works because the workbook ships its own answer key. Excel writes a cached `<v>` alongside every formula it evaluates. That gives a cheap, local, high-signal oracle: any formula cell where the engine disagrees with Excel's cached value is either an import defect or a deliberate recalculation — and at open time, before any user edit, it can only be the former. No knowledge of Mog's internals is required, and the check does not depend on recognizing `#CALC!` specifically; it catches any class of silent import divergence, including ones not yet seen.

It also targets the actual failure mode rather than the visible one. Every mitigation in the "What Didn't Work" list assumed the engine would tell us something was wrong — an error event, a pending calculation, a budget to raise. None of those exist here, and hypothesis 4's 0 ms recalculation proves why: the engine is confident. A guard that asks the engine how it feels learns nothing. A guard that compares the engine's output against an independent record catches exactly this.

Finally, the design follows invariants this repo already enforces rather than inventing new policy. [AGENTS.md:50-53](../../../AGENTS.md) states: "**Never draw a fake grid.** If the adapter fails to resolve, `src/adapters/unavailable-adapter.ts` renders the real reason and every session method throws. A mock grid that looks like it works is worse than a visible failure." A grid of `#CALC!` from a file whose real values are known-good is the same category of lie, arriving one layer later — the adapter resolved fine; the data did not. And [AGENTS.md:54-57](../../../AGENTS.md): "**Never hide a failure to reduce chrome.** A density flag means 'show less chrome,' never 'show fewer failures'." Routing the mismatch through the Adapter Probe reason inherits that protection, because Compact Mode is already forbidden from suppressing it.

## Prevention

- **Treat a cached-value/computed-value mismatch as a first-class import failure**, not a rendering quirk. Build the comparison into the open path so it is checked every time rather than remembered.
- **Never let a canvas Save be reachable from an unverified engine state.** Saves in this repo are last-write-wins and are refused only on revision conflict ([AGENTS.md:67-68](../../../AGENTS.md), [server/workbook-service.ts:11-14](../../../server/workbook-service.ts)) — nothing in that path inspects whether the bytes being written are semantically sound. Correctness of content is the canvas's job, and it currently does not do it.
- **When an engine reports a settled value, verify it against something outside the engine.** "It returned without erroring" is not evidence. The 0 ms `recalculateAll()` is the canonical example of a confident wrong answer.
- **A same-engine round trip is not a fidelity check.** The save path already reopens a written file with the headless engine and reads it back before trusting it ([server/workbook-service.ts:15-16](../../../server/workbook-service.ts)) — but a value the engine got wrong on import survives that round trip intact, because the engine agrees with itself. Value fidelity has to be measured against the file's own cached values.
- **Do not accept a small repro as proof of absence.** The `openpyxl` minimal file did not reproduce this; the defect is size- and mix-dependent. When a bug does not shrink, that is data about the bug, not grounds to dismiss it.
- **Keep the disproven diagnosis visible.** "Mog can't do `SUMIFS` on structured references" was written down before it was tested, and it sent the next reader in the wrong direction. Per the evidence-discipline section of [AGENTS.md:87-99](../../../AGENTS.md), this repo separates verified from assumed on purpose — a wrong diagnosis left standing costs more than no diagnosis.

## Related Issues

- [docs/solutions/ui-bugs/compact-mode-hid-adapter-failure-warning.md](../ui-bugs/compact-mode-hid-adapter-failure-warning.md) — establishes the Adapter Probe as the single surface a degradation must reach, and the compact-mode rules that keep it visible. That is the channel the proposed guard would report through. Note that its probe-failure framing assumes the live canvas failed to resolve; this defect is a second failure class where the canvas resolves fine and the *data* is wrong.
- [docs/solutions/design-patterns/crash-safe-workbook-saves.md](../design-patterns/crash-safe-workbook-saves.md) — documents the save pipeline that would faithfully persist `#CALC!`. Byte-level save safety is not value-level save safety: a save carrying `#CALC!` is durable, non-torn, and revision-clean while still destroying a delivered file.
- [docs/solutions/integration-issues/mog-sdk-node-subpath-and-proxy-introspection.md](mog-sdk-node-subpath-and-proxy-introspection.md) — the repo's catalog of `@mog-sdk/sdk` behaviors that guessing gets wrong. Its read-back-from-disk verification rule is the nearest existing prevention rule, and this defect shows where it is insufficient.
- [docs/solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md](../design-patterns/multi-pane-canvas-embedding-via-url-flags.md) — each compare pane is an independent engine runtime with its own Save, so an import-time miscalculation reproduces in every pane and the guard must gate Save per pane.
- [docs/solutions/runtime-errors/wasm-bindgen-ignores-wasm-base-url.md](../runtime-errors/wasm-bindgen-ignores-wasm-base-url.md) — prior instance of the same detection lesson: a response that looks successful but carries wrong content stays invisible until something downstream consumes it.
- No matching GitHub issues; this repo tracks related work via PRs rather than issues.
