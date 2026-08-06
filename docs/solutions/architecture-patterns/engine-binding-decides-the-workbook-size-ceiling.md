---
title: The engine binding decides the workbook size ceiling — the canvas lane traps where the headless lane succeeds
date: 2026-08-06
category: architecture-patterns
module: mog-canvas-embed-adapter-workbook-open-path
problem_type: architecture_pattern
component: service_object
root_cause: platform_constraint
resolution_type: workflow_improvement
severity: high
applies_when:
  - a workbook large enough to strain memory is about to be opened in the canvas
  - a user reports that a file "works headlessly but kills the panel"
  - a size or memory limit is being written down as a property of Mog rather than of a binding
  - an operation fails with an error message that names the wrong cause
related_components:
  - tooling
  - documentation
tags: [mog-sdk, wasm32, napi, memory, hydration, lanes, adapter-probe, error-masking]
---

# The engine binding decides the workbook size ceiling — the canvas lane traps where the headless lane succeeds

## Problem

This repo runs the same spreadsheet engine through two different bindings, and
has been reasoning about workbook size as if there were one limit.

- **Canvas lane** — `@mog-sdk/spreadsheet-app`, which depends on `@mog-sdk/wasm`
  and runs **wasm32 in the browser**, inside a sandboxed iframe in the plugin
  lane. [verified from `runtime/spreadsheet-app/package.json` dependencies]
- **Headless lane** — `@mog-sdk/sdk/node`, which resolves the **native N-API**
  platform package. [verified from `runtime/sdk/package.json` export conditions]

Upstream issue
[#335](https://github.com/fundamental-research-labs/mog/issues/335) shows the
two are not interchangeable at scale, and the gap is not gradual.

## Root Cause

`compute_complete_deferred_hydration` traps with `RuntimeError: unreachable` on
wasm32 for a **20.3 MB workbook with 1.57 million populated cells across 21
sheets**, the largest carrying roughly 583,000 formulas. It surfaces during
deferred hydration, notably when switching sheets — that is, *after* the canvas
has already appeared to open.

The reporter's diagnosis is that the completion path holds several
workbook-sized representations in linear memory at once: the parsed XLSX, a
range-classification snapshot, Yrs transaction state, the final runtime
snapshot, and ComputeCore/CellMirror state. [upstream issue body]

**The decisive comparison: native hydration of the same file succeeds, using
about 4.7 GB of RAM.** wasm32's linear-memory ceiling is the binding's, not the
engine's. Per-sheet transactions and incremental release were tried upstream and
give relief without resolving it.

So the failure is not "Mog cannot open this file." It is "the wasm32 binding
cannot hold this file, and the native binding can, if the machine has the RAM."

## What this means for the three lanes

| Lane | Binding | Ceiling |
| --- | --- | --- |
| Canvas | wasm32 | **Hard trap** on formula-dense workbooks at low tens of MB. Unrecoverable in-page |
| Headless | native N-API | Bounded by host RAM. ~4.7 GB observed for a 20.3 MB / 1.57 M-cell file |
| Byte-first (`server/workbook-*.ts`) | none | No engine, no ceiling. Streams OOXML parts |

This is the sharpest statement yet of why the byte-first stack exists. On a file
that traps the canvas outright, `brief_workbook`, `profile_workbook`,
`read_range`, `graph_workbook` and `describe_sheet_data` all still answer — in
milliseconds, from the saved bytes, with provenance. **On a workbook above the
wasm32 ceiling, the byte-first lane is not a fast path. It is the only path.**

## The second shape of the same lesson: masked errors

Upstream [#333](https://github.com/fundamental-research-labs/mog/issues/333) is a
different ceiling with the same moral. `sheets.copy` on a ~1.06 M-cell sheet
violates a 64 MiB kernel update cap, and the real error —
`updateBytes=84445380, pendingUpdates=1, source=user_mutation, capBytes=67108864`
— is swallowed by a `try`/`catch` in `copySheet` that reports **"Failed to copy
sheet. Source sheet may not exist."** on a sheet that plainly exists.

Two things worth carrying:

1. **The message named the wrong cause.** An agent reading it would go looking
   for a sheet-name bug and never find one. This repo's own
   `WorkbookError` taxonomy exists to prevent exactly that, and the same
   discipline has to survive contact with an SDK that does not share it: when
   wrapping an SDK failure, never substitute a guess for the cause. See
   [mog-sdk-mutations-that-fail-without-throwing.md](../integration-issues/mog-sdk-mutations-that-fail-without-throwing.md).
2. **The same content loaded fine through a different channel.** The reporter's
   workaround was to duplicate the worksheet XML inside the XLSX archive and let
   it arrive through the *bootstrap* path at `createWorkbook` time, rather than
   through the user-mutation drain the cap applies to. Which channel bytes
   arrive on changes what is possible — the same insight, one layer up, as
   choosing a binding.

## Solution

Nothing to fix here; both are upstream and unacknowledged. What changes is what
this repo says and checks.

**Do not describe a size limit as Mog's.** Say which binding. "The canvas cannot
open this" and "Mog cannot open this" are different claims and only the first
one is true.

**Do not let the Adapter Probe imply a ceiling it cannot know.** The probe
answers before any workbook is opened — it reports whether
`createSpreadsheetRuntime` and `mountSpreadsheetApp` resolved, nothing about
whether *this file* will hydrate. A wasm32 trap arrives later, during deferred
hydration, sometimes on a sheet switch long after "renderer ready." That is a
third failure class beside the two already recorded: the adapter resolved, the
data was fine, and the binding ran out of room.

**Reach for the byte-first lane earlier on large files.** `profile_workbook`
returns sheet count, cell count and formula count in milliseconds and costs
nothing. It is the cheapest available predictor of whether the canvas is a
sensible destination — not a calibrated threshold, and this repo has no
authority to invent one, but a number in hand beats opening and hoping.

**Route large-workbook work to the headless lane deliberately, not by
accident.** The two-lane split already says humans edit in the canvas and agents
edit headlessly. #335 adds a second, independent reason for the same routing: on
a large enough workbook the canvas is not merely the slower lane, it is the one
that cannot finish.

## Why This Works

Because the ceiling is a property of the binding, and the bindings are already
separated in this repo by an invariant that exists for a different reason.
`AGENTS.md` requires that `@mog-sdk/sdk` never reach the browser bundle and that
the canvas be reached only through the adapter. That separation was written for
resolution correctness and bundle hygiene; it happens to mean the two lanes
already carry different engines, so "which lane" and "which ceiling" are the
same question and no new plumbing is needed to ask it.

## Prevention

- **Name the binding whenever a limit is recorded.** wasm32 and native N-API
  fail at different sizes and in different ways: one traps, the other consumes
  RAM until the host complains.
- **Separate a size cost from a size *trap*.** The ~90 s hydration this repo
  measured on ~600–900 KB workbooks
  ([host-side-ooxml-profiling-outruns-engine-readiness.md](host-side-ooxml-profiling-outruns-engine-readiness.md))
  is a cost — slow, finishes, correct. #335 is a trap — it does not finish.
  Filing or explaining them together invites a scheduling answer to a memory
  problem, the same mistake the `#CALC!` entry warns against for correctness vs
  performance.
- **When an SDK error message names a cause, verify the cause before believing
  it.** #333's message is confidently wrong. So was the 0 ms `recalculateAll()`
  in the `#CALC!` investigation. An engine's self-report is a hypothesis.
- **Ask which channel bytes arrive on.** Bootstrap-at-open and mutation-after-open
  have different limits upstream. If a mutation path refuses a size, opening
  with the content already present may not.

## Related Issues

- [upstream-mog-open-defects-and-which-lane-they-reach.md](../integration-issues/upstream-mog-open-defects-and-which-lane-they-reach.md) — the full tracker index and per-lane classification
- [host-side-ooxml-profiling-outruns-engine-readiness.md](host-side-ooxml-profiling-outruns-engine-readiness.md) — the byte-first lane and the measurements that separated cost from correctness; this entry adds a third case where the byte-first lane is the only one that answers
- [../ui-bugs/compact-mode-hid-adapter-failure-warning.md](../ui-bugs/compact-mode-hid-adapter-failure-warning.md) — the Adapter Probe as the single surface a degradation must reach; a hydration trap is a degradation the probe cannot predict
- [../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md](../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md) — the other import-path defect, and the separate-the-symptoms rule
- Upstream [#335](https://github.com/fundamental-research-labs/mog/issues/335), [#333](https://github.com/fundamental-research-labs/mog/issues/333) — both open, no maintainer reply as of 2026-08-06
</content>
