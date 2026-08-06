---
title: Bounded checks are prefixes, not samples — and the damage they miss is clustered
date: 2026-08-06
category: design-patterns
module: server
problem_type: incorrect_assumption
component: validation
symptoms:
  - "A check reports passed after examining a bounded number of cells, and the caller reads that as a statement about the file"
  - "checkFormulaErrors returns 1,000 findings, truncated: true, every one from the same sheet — the worst-affected sheet never appears"
  - "A fidelity verdict says passed on 500 of 88,045 cells with no indication which 500"
root_cause: incorrect_assumption
resolution_type: documentation
severity: medium
tags: [validation, sampling, truncation, value-fidelity, diagnostics, coverage, evidence]
---

# Bounded checks are prefixes, not samples — and the damage they miss is clustered

## Problem

Two independent bounded checks in this system stop after the first N cells **in
scan order**. Neither draws a sample:

- [`server/value-fidelity.ts`](../../../server/value-fidelity.ts) takes
  `extract.cells.slice(0, limit)` with `FIDELITY_CELL_LIMIT = 500` — the first
  500 cached formula values in document order, sheet by sheet, row by row.
- `wb.diagnostics.checkFormulaErrors()` with no options stops at **1,000
  findings** and sets `truncated: true`.

Both are honest about the bound. Neither is a random draw, and the difference
matters the moment anyone reasons from the result to the rest of the file.

It is not hypothetical. On the real reproducer for
[the table calculated-column defect](../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md),
the default `checkFormulaErrors()` call returned 1,000 findings **all from
`Weekly Summary`** and never reached `TxnLog` — which held 8,342 of the
workbook's 10,798 error cells. The scan was correct, bounded, and reported its
own truncation. It also would have told a caller that the worst-damaged sheet in
the workbook was clean, had the caller read the findings list.

## Why the miss is systematic rather than unlucky

Spreadsheet damage is **clustered by column and by sheet**, because that is how
spreadsheets are built. A broken calculated column fails in every row of one
column; a broken import fails on the sheets using the affected feature. In that
same file, 4,167 of the failures sat in a single column.

Clustered damage plus a scan-order prefix is the worst possible pairing: whether
the check sees the problem depends entirely on where the damage sits in
enumeration order, which is an accident of sheet naming and layout. A genuine
random sample of 500 cells over 88,045 would almost certainly hit a 4,167-cell
cluster. A prefix of 500 either lands on it or is blind to it, and nothing in
the result tells you which.

## What this means for each consumer

**A bounded check is sound as a refusal gate.** The fidelity gate exists to
catch an engine that mis-evaluates, and a broken engine fails pervasively — the
first 500 cells catch that. Refusing to save on any mismatch is a fail-closed
use of a prefix, and it works.

**It is not sound as a certificate.** "Passed on the first 500" does not license
any claim about the other 87,545. Any feature that wants to treat a `passed`
verdict as evidence *about the file* — serving cached values as answers,
skipping a re-check, reporting the workbook healthy — needs either a real
stratified sample (across sheets and columns, since that is how damage clusters)
or per-cell verdicts. Reusing a prefix as a certificate is the trap this entry
exists to name.

## Rules

1. **Always pass an explicit `limit` to `checkFormulaErrors`.** The default cap
   is low enough to truncate on any real workbook. A whole-workbook scan at
   `{ limit: 50000 }` took 15.4 s on the 88,045-cell reproducer; a scan narrowed
   with `sheetName` and `range` took 0.14 s. Coverage is cheap — the engine
   *open* is what costs minutes.
2. **Read `truncated` before reading `findings`.** `ok: false` stays correct
   under truncation. The findings list does not.
3. **When a check is bounded, say what was not examined.** This repo already has
   the vocabulary for it in
   [`server/extraction-stages.ts`](../../../server/extraction-stages.ts):
   unexamined is not the same as clean. A verdict that reports `checkedCells`
   without reporting *which* cells is a weaker claim than it appears.
4. **Do not widen a bound to make a claim true.** If a feature needs
   file-level confidence, change the sampling strategy or the granularity of the
   verdict. Raising 500 to 5,000 buys a longer prefix, not a sample.

## Open

[`server/value-fidelity.ts`](../../../server/value-fidelity.ts) is unchanged.
Its prefix is defensible for what it currently does, and stratifying it is a
design decision with a cost, not a bug fix. It becomes load-bearing the moment
anything reads a `FidelityReport` as evidence about the file rather than as a
save-time refusal — which is exactly what a "certified cold read" would do.
Decide the sampling strategy *before* building that, not after.
