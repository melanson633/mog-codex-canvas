---
title: Mog SDK mutations can fail without throwing — try/catch is not sufficient error handling
date: 2026-08-06
category: integration-issues
module: sdk-usage
problem_type: integration_issue
component: headless_lane
root_cause: platform_quirk
resolution_type: workflow_improvement
severity: medium
symptoms:
  - "A mutation returns without throwing and changes nothing"
  - "formats.set with a nested { font: { bold: true } } object succeeds and applies no formatting"
  - "tables.sortApply returns undefined and leaves row order untouched"
  - "A chart or table created moments ago is reported 'not found' by the next call"
tags: [mog-sdk, error-handling, receipts, mutations, agent-lane, silent-failure, codegen]
---

# Mog SDK mutations can fail without throwing — try/catch is not sufficient error handling

## Problem

This repo does not currently write to a workbook through any engine mutation
except `ws.setCell` and `ws.setRange`. A grep across `server/`, `src/`,
`scripts/` and `plugins/` for `tables.`, `charts.`, `formats.`, `names.add`,
`sheets.copy` and `sortApply` finds only byte-first reads of table and
defined-name *definitions*, parsed straight from OOXML in
`server/workbook-metadata.ts` — never through the engine. [verified by grep,
2026-08-06]

So none of what follows is a live bug here. It is the set of traps waiting for
whoever adds the next engine write, and it changes one recommendation that was
already on the table: **wrapping SDK calls in `try`/`catch` and mapping
`MogSdkError` is necessary and not sufficient**, because several mutation
families do not signal failure by throwing.

Four open upstream issues, all from the same reporter, all unacknowledged.

## Root Cause

**The error contract is not uniform across mutation families.**
[#323](https://github.com/fundamental-research-labs/mog/issues/323), reported at
0.10.4 and reproducing at 0.10.3, documents three different behaviors sitting
side by side:

| Family | On failure |
| --- | --- |
| `tables.add` with an invalid name | **throws** |
| `charts.setLegendVisible`, `charts.setAxisTitle` | returns a receipt with `status: "failed"` — no exception |
| `formats.set` with unknown keys | **neither** — no exception, no status, no diagnostic |

The reporter's sentence is the one to remember: *"A caller (human or agent) that
assumes 'no exception = applied' silently records phantom edits."*

The three concrete instances:

- **[#322](https://github.com/fundamental-research-labs/mog/issues/322) —
  `formats.set` silently ignores unknown keys.** Mog's `CellFormat` is **flat**
  (`bold`, `fontColor`, `backgroundColor`, `horizontalAlign`, …). Passing an
  Office.js-shaped nested object — `{ font: { bold: true }, fill: { color:
  '#ADD8E6' } }` — succeeds and applies nothing. The reporter flags this as
  specifically dangerous for LLM-driven integrations, because the agent receives
  a success and reports formatting that never happened. Note this is *exactly*
  the wrong-dialect shape `api.guidance` is built to catch — but guidance
  analyses source text, and it will not catch an object assembled at runtime.

- **[#324](https://github.com/fundamental-research-labs/mog/issues/324) —
  `tables.sortApply` appears to be a no-op.** Returns `undefined`, leaves row
  order unchanged, emits no receipt and no diagnostic, at 0.10.3 and 0.10.4. The
  reporter cannot distinguish a silent failure from "sort only stores state" —
  and neither can anyone else, which is the complaint. `clearFilters` also
  returns `undefined`, so a bare return value proves nothing either way.

- **[#325](https://github.com/fundamental-research-labs/mog/issues/325) —
  create→configure fails within one session.** A chart added with `charts.add()`
  and immediately targeted by `charts.remove()` or `charts.setLegendVisible()`
  fails with *"Chart 'RevChart' not found"* — despite having just been created.
  The same calls work after exporting and reopening the workbook. Deferred
  object materialization; a 0.10.4 fix covered newly added *sheets* and did not
  extend to charts and tables.

**And the generated metadata has its own documented gaps.**
[#326](https://github.com/fundamental-research-labs/mog/issues/326) lists four
in `llms.txt` at 0.10.4: `layout.setColumnWidth` does not state 0-based index vs
column letter, or that the unit is pixels; `charts.add` placement
(`anchorRow`/`anchorCol`, 0-based) and its point units are absent from the
examples; the full flat `CellFormat` key list is not enumerated — which matters
precisely *because* #322 makes invalid keys silent; and the rule that
cell-reference-shaped table names (`T1`, `Q3`) are rejected is undocumented.

That last issue is a caveat on this repo's own plan to adopt `api.describe` and
`api.guidance.preflight`. Those surfaces are the right answer to guessing method
names, and their metadata is still reported incomplete on units and indexing.
Introspection narrows the guessing; it does not eliminate verification.

## Solution

Nothing to fix today — there is no mutation here to fix. The rules for when
there is:

**Never treat "it returned" as "it applied."** Three separate failure signals
have to be checked: an exception, a receipt with `status: "failed"`, and — for
families that give neither — a read-back proving the change is there.

**A read-back is the only signal that covers all three.** This repo already has
the pattern and the reflex, from
[mog-sdk-node-subpath-and-proxy-introspection.md](mog-sdk-node-subpath-and-proxy-introspection.md):
*"Verify saves by reading a pre-captured, guaranteed-different value back from
disk."* Extend it from saves to mutations. Set a format, then read the format
back. Sort a table, then read the first column back.

**Prefer the APIs this repo already relies on.** `setCell` and `setRange` throw
on failure and their effect is directly readable with `getValue`/`getValues`.
Formats, charts, table sorts and defined names are all newer surfaces with an
open issue apiece. If a task can be done with cell writes, do it with cell
writes.

**When mapping `MogSdkError` into `WorkbookError`, keep the receipt path
separate.** `MogSdkError.from(error)` normalizes what was *thrown*. A receipt
carrying `status: "failed"` never reaches a `catch` block and needs its own
branch. Two paths, not one — this is the correction to the earlier
"carry `MogSdkError` through" recommendation.

**For create→configure, export and reopen between the two halves** — the
workaround upstream reports, and a natural fit for this repo, whose headless lane
already funnels every write through `workbook-service.save()` and can reopen the
saved file afterwards.

## Why This Works

Because it reuses an oracle this repo already trusts rather than trusting the
engine's self-report. The `#CALC!` investigation's canonical exhibit was a
`recalculateAll()` that returned in 0 ms and changed nothing while the engine
believed the graph was clean; #322 and #324 are the same phenomenon in the
mutation path — a confident success over an operation that did not happen. A
guard that asks the engine how it feels learns nothing. A guard that reads the
result back learns everything, and it is indifferent to which of the three
failure signals the SDK chose that day.

## Prevention

- **Before adding any engine mutation to this repo, check
  [upstream-mog-open-defects-and-which-lane-they-reach.md](upstream-mog-open-defects-and-which-lane-they-reach.md).**
  Formats, tables, charts, names and sheet copies each have an open issue.
- **Assume flat `CellFormat`.** Nested `font`/`fill` objects are Office.js, and
  Mog does not shim Office.js — it diagnoses it. The nesting will not error; it
  will simply do nothing.
- **Treat a bare `undefined` return as no information.** It is not a success.
- **Do not let `api.describe` substitute for verification.** It is the right cure
  for guessed method names and, per #326, still under-specifies units and
  indexing. Introspect, then read back.
- **When an agent reports what it changed, the report must be sourced from a
  read-back, not from the absence of an exception.** The headless lane's existing
  obligation — validate with `summarize()`, screenshot the touched range — is the
  right shape; it just needs to keep holding for mutations that are not cell
  writes.

## Related Issues

- [upstream-mog-open-defects-and-which-lane-they-reach.md](upstream-mog-open-defects-and-which-lane-they-reach.md) — tracker index; all four of these are classified GATES
- [mog-sdk-node-subpath-and-proxy-introspection.md](mog-sdk-node-subpath-and-proxy-introspection.md) — the read-back-from-disk verification rule this entry extends, and the introspection APIs #326 qualifies
- [mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md](mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md) — the 0 ms `recalculateAll()`, the same confident-wrong-answer pattern in the calculation path
- [../architecture-patterns/engine-binding-decides-the-workbook-size-ceiling.md](../architecture-patterns/engine-binding-decides-the-workbook-size-ceiling.md) — #333's masked error, a fourth way a failure arrives wearing the wrong label
- Upstream [#322](https://github.com/fundamental-research-labs/mog/issues/322), [#323](https://github.com/fundamental-research-labs/mog/issues/323), [#324](https://github.com/fundamental-research-labs/mog/issues/324), [#325](https://github.com/fundamental-research-labs/mog/issues/325), [#326](https://github.com/fundamental-research-labs/mog/issues/326) — all open, no maintainer reply as of 2026-08-06
</content>
