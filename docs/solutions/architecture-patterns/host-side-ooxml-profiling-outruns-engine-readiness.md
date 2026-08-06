---
title: Profile a workbook from its OOXML bytes on the host; never gate that on engine readiness
date: 2026-08-05
category: architecture-patterns
module: server-ooxml-profiling-and-canvas-readiness
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - the host needs the shape of a workbook (sheets, rows, formulas, tables, comments) before deciding how to present or route it
  - a decision would otherwise block on the Mog engine becoming interactive on a large workbook
  - a status indicator is driven by a mount promise rather than by renderer readiness
related_components:
  - frontend_stimulus
  - tooling
  - documentation
tags:
  - ooxml
  - byte-level-profiling
  - mog-sdk
  - engine-readiness
  - status-honesty
  - workbook-classification
  - value-fidelity
  - performance
---

# Profile a workbook from its OOXML bytes on the host; never gate that on engine readiness

## Context

This project has been built as though the embedded Mog canvas were the product and
the host were chrome around it. Every question about a workbook has therefore been
routed through the engine, and every answer has waited for it.

A measurement taken on 2026-08-05 inverts that framing. Two real client workbooks
in the live `workbooks/` sandbox — gitignored per [`AGENTS.md`](../../../AGENTS.md), so
neither file is in the tree — were profiled purely from their OOXML bytes, and the
same large workbook was then opened in the canvas:

| | workbook A — a client tax model (filename redacted) | workbook B — a client dataset (filename redacted) |
| --- | --- | --- |
| bytes | 28,727 | 934,756 |
| sheets | 7 | 2 |
| rows | 342 | 6,762 |
| cells | 885 | 122,132 |
| formulas | 210 | 12,340 |
| cross-sheet refs | 95 | 0 |
| tables | 0 | 1 (`MasterData`, `A1:AA2469`, 27 cols) |
| comment parts | 0 | 1 (14 threaded comments) |
| **host-side profile** | **1 ms** | **20 ms** |

The profiler used only `readZipEntries()`
([`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts)) plus regexes over the
sheet XML it returns. No `@mog-sdk/sdk`, no engine, no WASM. That function reads a
ZIP central directory and inflates entries with `node:zlib`; its own header comment
describes the module as deliberately small, dependency-free, and non-writing
(the module header comment in [`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts)).

On the same 934,756-byte workbook, the Mog canvas console logged
`RenderSystem: renderer became ready` at **+91,661 ms**, after a five-phase deferred
hydration — parse, YrsStorage, grid/merge/layout indexes, ComputeCore
`init_from_snapshot_minimal`, mirror finalized — punctuated by repeated
`[GRID] Status "suspended" - render loop paused`.

**Treat that ~92 s as one observed run on one machine, not a benchmark.** It was a
single open, on this Windows host, on this workbook, at the installed SDK version.
It is not an average, and nothing was controlled for.

Two facts about that run matter beyond the number itself.

**The host already had the bytes.** `read()` returns the full byte array and its
content-derived revision before anything is handed to the canvas
(`read()` in [`server/workbook-service.ts`](../../../server/workbook-service.ts)). During
the entire ~92 s wait, the material needed to answer "what shape is this workbook"
was sitting in host memory, unread.

**The app header said `ready` for all of it.** `status` is app state
(the `useState('starting')` for `status` in [`src/App.tsx`](../../../src/App.tsx))
rendered verbatim in the header (`<span className="status">{status}</span>`),
fed by the adapter through the `onStatus: setStatus` handler passed at mount. The adapter emits
`'ready'` immediately after the embed's mount attachment resolves —
`await attachment.ready; host.onStatus('ready')`
(the mount path in [`src/adapters/mog-embed-adapter.ts`](../../../src/adapters/mog-embed-adapter.ts)).
Mount resolution is not renderer readiness. The string is therefore accurate about
the mount and wrong about the product, for a minute and a half.

**This has since been fixed** (`049280f fix(adapter): stop reporting ready before
the renderer is`). The mount now reports `'canvas mounted — renderer hydrating'`,
and a `watchRendererReadiness` poller promotes it to renderer-ready only when
`attachment.getStatus() === 'ready'` **and** the view answers a real query — the
two-signal confirmation the Guidance section below asks for. The observation above
is retained as the evidence that produced the rule, not as current behavior.

That gap is a house-rules problem, not a cosmetic one. [`AGENTS.md`](../../../AGENTS.md)
states "Never hide a failure to reduce chrome" and "Prefer a stated limitation over
a confident guess" in the same evidence-discipline section that governs every claim
in `docs/`. A status word that reports the fast layer's success while the slow layer
is still suspended is the same category of lie the "never draw a fake grid"
invariant already forbids one layer lower.

Two further observations from the same session bound the scope of this doc:

- `checkValueFidelity()` on the large workbook returned `passed` — 3,000 of 12,292
  cached formula values sampled, 0 mismatches, 2,376 ms headless. That sample size
  is well above the module's default bound, `FIDELITY_CELL_LIMIT = 500`
  ([`server/value-fidelity.ts`](../../../server/value-fidelity.ts)), so the run
  passed an explicit `cellLimit` and was reported with `truncated: true`. The engine
  computed this workbook correctly; slow is not the same as wrong.
- `xl/tables/table1.xml` in that workbook carries **zero** `calculatedColumnFormula`
  entries — its 12,340 formulas are per-row A1 — so it does not meet the trigger
  recorded in
  [`docs/solutions/integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md`](../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md).
  That doc originally reported the cost as "~104 s during single-threaded import of
  the 640 KB workbook" — attributing it to that one file. The new ~92 s figure
  reproduces that order of magnitude on an unrelated workbook with an unrelated
  formula mix, which upgrades the import cost from a property of one file to an
  apparent property of the engine at this size. That doc has since been rescoped
  accordingly, so the quoted wording is its prior text, not its current text. Two
  observed runs is still two observed runs; it is a strong indication, not a curve.

Nothing here is a fix. No code was changed. This is an observation about where work
should live.

## Guidance

### Answer shape questions from bytes, engine questions from the engine

Sort every workbook question into one of two buckets before deciding what to call.

**Bytes can answer**: how many sheets, rows, cells, formulas; which sheets exist and
in what order; whether tables are present and what ranges they cover; whether the
file carries comments or threaded comments; what each formula's *text* is; what
Excel last recorded as each formula's value; whether a table declares
`calculatedColumnFormula` entries. All of these are literal contents of the OOXML
parts, reachable through `readZipEntries()`
([`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts)) in single-digit to
low-tens of milliseconds on files up to ~1 MB, per the measurements above.

**Only the engine can answer**: what a formula evaluates to *now*, what a cell
becomes after an edit, what a dependency trace looks like, what a rendered range
looks like as a PNG. These are computations, not contents.

Route accordingly. A feature in the first bucket must not import `@mog-sdk/*`, must
not await a canvas session, and must not be sequenced behind one.

### Do not gate a first screen on engine readiness

Anything that only needs the file's shape — a workbook picker with real dimensions,
a column inventory, annotation targets, receipt or revision history, a
"this is a 2-sheet, 6,762-row dataset with one table and 14 comments" summary —
should render from bytes as soon as `read()` returns
(`read()` in [`server/workbook-service.ts`](../../../server/workbook-service.ts)), and
should not be blanked or disabled while the canvas hydrates. On the observed run
that converts a ~92 s blank wait into a ~20 ms populated screen with a grid that
fills in later.

### Do not reuse `readZipEntries()` without reading what it refuses

`readZipEntries()` throws on a missing end-of-central-directory record, a bad
central-directory signature, a bad local header, and any compression method other
than stored or deflate (the `readZipEntries` body in [`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts)).
It also inflates every entry eagerly, so a profiler pays for parts it never inspects.
That was acceptable at the sizes measured; it is an assumption, not a guarantee, at
larger ones.

Profilers must decide explicitly what a throw means. The existing precedent is
`looksLikeWorkbook()`, which swallows the throw and returns `false`
([`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts)), and
`checkValueFidelity()`, which maps every failure to gather evidence to `unverified`
and never to `passed` ([`server/value-fidelity.ts`](../../../server/value-fidelity.ts)).
Follow the second pattern: an unreadable archive means *unknown*, never *empty*.

There is one hard rule attached to that. The comments on `looksLikeWorkbook()` and
`fidelityNeedsEngine()` record that `createWorkbook()` on unopenable bytes rejects
but leaves a native thread alive in SDK 0.10.5, which keeps the process from exiting
(the contract comments on `looksLikeWorkbook` in
[`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts) and on `fidelityNeedsEngine`
in [`server/value-fidelity.ts`](../../../server/value-fidelity.ts)). Never open the
engine speculatively on bytes the cheap reader rejected.

### Use the cross-sheet reference ratio as the model/dataset discriminator

The two workbooks separate on one cheap number. 95 of 210 formulas in the small
workbook reference another sheet; 0 of 12,340 in the large one do. A file whose
formulas point across sheets is a **model** — many small sheets, wired together,
where evaluation order and cross-sheet integrity matter. A file whose formulas are
all local is a **dataset** — one wide table repeated down thousands of rows, where
volume matters and cross-sheet integrity does not exist to break.

Falling out of the bytes, that classification can be made before the engine starts
and used to choose what to show, what to warn about, and what to check first.

Calibration caveat, stated because this repo separates verified from assumed: the
ratio is 0.452 and 0.000 on the two files measured. Two points do not establish a
threshold. Any cutoff used in code is a guess until more workbooks are profiled, and
should be written down as one.

### Say what the status word actually means — implemented

If `status` is going to read `ready` while the renderer is suspended, it should say
which readiness it means — `canvas mounted`, then `renderer ready` when the engine's
own readiness signal arrives. **This is now the shipped behavior**; see
`watchRendererReadiness` in
[`src/adapters/mog-embed-adapter.ts`](../../../src/adapters/mog-embed-adapter.ts),
whose contract comment states that nothing there fabricates readiness. The rule
below is what to preserve if that code is ever rewritten. Reporting the fast layer's success as the
product's readiness is exactly what the evidence-discipline rules in
[`AGENTS.md`](../../../AGENTS.md) exist to prevent, and it is worse here than a missing
indicator would be, because the user has no way to tell a 92-second hydration from a
hang.

This doc does not claim that change was made. It records that the gap exists and
where the line is.

## Why This Matters

The value of an inverted framing is that it changes what gets built, not just how
fast it runs.

Under the old framing — canvas is the product, host is chrome — every workbook
capability has one implementation path and one latency floor, and that floor was
observed at ~92 s on a 934 KB file. Features that would be trivially fast get priced
as if they were expensive, so they do not get proposed. A workbook picker that shows
real dimensions, a pre-open warning that a file is a 12,000-formula dataset, a
receipt trail keyed to sheet and range: each of these is a ~20 ms read that has been
sitting behind a ~92 s wait for no reason other than architectural habit.

That cost multiplies where the app deliberately runs more than one engine. Compare
View gives every pane its own full runtime
([`docs/solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md`](../design-patterns/multi-pane-canvas-embedding-via-url-flags.md)),
so a per-pane hydration is paid per pane while a host-side profile of all of them
costs tens of milliseconds once.

The second reason is honesty, which this repo treats as load-bearing rather than
decorative. The `ready` status during hydration is a small bug with a large shape:
it is the same failure the "never draw a fake grid" invariant already names, arriving
one layer up, and the same failure recorded in
[`docs/solutions/ui-bugs/compact-mode-hid-adapter-failure-warning.md`](../ui-bugs/compact-mode-hid-adapter-failure-warning.md)
— a surface reporting less than it knew. A host that can read the file itself does
not need to guess at the engine's state or paper over it; it can state what it knows
from the bytes and label the engine's phase separately. Independent knowledge is what
makes an honest status possible at all.

The third reason is that byte-level reading is the project's only engine-independent
oracle, and it is already load-bearing. The value-fidelity gate exists precisely
because a same-engine round trip cannot catch the engine mis-evaluating a formula,
while the file's own cached values can. Profiling is the same instrument pointed at a
different question. Investing in the byte-level reader compounds: every new thing it
can describe is a new thing that can be verified without asking the engine to grade
its own work.

Finally, the ~92 s figure independently corroborates the import cost recorded in the
calc-column doc on a workbook that does not share its trigger — no
`calculatedColumnFormula` entries anywhere in `xl/tables/table1.xml`, and a `passed`
fidelity verdict. That separation is useful on its own: it confirms the earlier doc's
recommendation to file the slowness and the wrong-result defect upstream as two
different bugs, because here the slowness appeared without the defect.

## When to Apply

Apply this when:

- A user-visible surface needs facts about a workbook's structure rather than its
  computed values — dimensions, sheet inventory, column lists, table ranges, comment
  counts, formula text.
- You are about to await a canvas session, an adapter probe, or `createWorkbook()` in
  order to obtain something that is literally written in the file.
- You need to classify or triage a workbook before deciding how to handle it —
  model versus dataset, small versus large, tables present or absent.
- You are designing a loading or empty state for a file whose open cost is unbounded.
- You need an engine-independent check, for the reason the fidelity gate exists.

Do **not** apply this when:

- The question is what a formula evaluates to, what an edit produces, or what a range
  renders as. Those require the engine, and no amount of byte reading substitutes.
- You would be reimplementing evaluation from OOXML. Reading recorded values is an
  oracle; recomputing them in a second engine is a second engine.
- The bytes did not parse. An unreadable archive is *unknown*. Report it as such,
  do not fall back to zeros, and do not hand those bytes to `createWorkbook()`
  (`looksLikeWorkbook` in [`server/ooxml-cache.ts`](../../../server/ooxml-cache.ts)).
- Disk access is involved. Every read still goes through
  `server/workbook-service.ts` and its path policy — profiling is a new consumer of
  bytes the service already returns, never a new way to reach the filesystem.

## Examples

### A byte-level workbook classifier

This is illustrative and is not currently in the repo. Save it as
`scripts/profile-workbook.ts` and run it with Node's type stripping, the same way the
server entry runs ([`AGENTS.md`](../../../AGENTS.md) setup section):

```ts
// node scripts/profile-workbook.ts workbooks/<name>.xlsx
import { readFileSync } from 'node:fs';
import { readZipEntries } from '../server/ooxml-cache.ts';

const file = process.argv[2];
const bytes = readFileSync(file);
const started = performance.now();

// Throws on anything that is not a stored/deflated ZIP — let it. An
// unreadable archive is "unknown", never "an empty workbook".
const parts = new Map(readZipEntries(bytes).map((e) => [e.name, e.data.toString('utf8')]));
const names = [...parts.keys()];
// Part paths by convention; ooxml-cache.ts resolves them properly through
// xl/workbook.xml.rels, but sheetParts() is not exported.
const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
const tables = names.filter((n) => n.startsWith('xl/tables/'));
const comments = names.filter((n) => /comments|threadedComments/i.test(n));

let rows = 0, cells = 0, formulas = 0, crossSheet = 0;
for (const part of sheets) {
  const xml = parts.get(part)!;
  rows += (xml.match(/<row\b/g) ?? []).length;
  cells += (xml.match(/<c\b/g) ?? []).length;
  // Counts shared-formula stubs too; treat as an upper bound.
  for (const [, body] of xml.matchAll(/<f\b[^>]*>([\s\S]*?)<\/f>/g)) {
    formulas += 1;
    if (/(?:'[^']+'|[A-Za-z_][\w.]*)!\$?[A-Z]/.test(body)) crossSheet += 1;
  }
}

const calcColumns = tables.reduce(
  (n, p) => n + ((parts.get(p)!.match(/calculatedColumnFormula/g) ?? []).length), 0);
const ratio = formulas ? crossSheet / formulas : 0;

console.log(JSON.stringify({
  file, bytes: bytes.length, sheets: sheets.length, rows, cells, formulas,
  crossSheetRefs: crossSheet, crossSheetRatio: Number(ratio.toFixed(3)),
  tableParts: tables.length, calcColumnFormulas: calcColumns,
  commentParts: comments.length,
  // Uncalibrated: 0.452 and 0.000 on the only two workbooks measured.
  shape: ratio > 0.1 ? 'model' : 'dataset',
  ms: Math.round(performance.now() - started),
}, null, 2));
```

On the two workbooks measured this printed `ms: 1` and `ms: 20` respectively, and
separated them as `model` (95/210 cross-sheet) and `dataset` (0/12,340). The
`calcColumnFormulas` count is `0` for both — which is how the large workbook was
ruled out as an instance of the calc-column defect without opening the engine at all.

### Precise wording for the readiness gap

The status split described in Guidance now exists, so this wording is historical —
kept because the measurement itself is still the only data point on this host, and
because it shows how to state a readiness observation without rounding it off:

> On one observed open of a 934,756-byte workbook on this Windows host, the Mog
> renderer reported ready at +91,661 ms while the app header displayed status
> `ready` from mount onward. `status` is set from the adapter's post-mount
> `onStatus('ready')` (the mount path in `src/adapters/mog-embed-adapter.ts`, as it
> stood at the time of the observation), which reflects
> mount completion rather than renderer readiness. Single run, not a benchmark.

### The two claims to keep apart

The same session produced one performance observation and one correctness result,
and they must not be merged — the calc-column doc's own remediation section says to
file the slowness and the wrong-result defect separately:

- **Performance, observed once**: ~92 s to renderer-ready on 934,756 bytes; ~104 s
  previously recorded on a different 640 KB workbook. Two runs, two files, same
  order of magnitude.
- **Correctness, verified**: `checkValueFidelity()` returned `passed` on the large
  workbook — 3,000 of 12,292 cached values sampled, 0 mismatches, 2,376 ms headless.
  The engine's answers were right. It just took a minute and a half to show them.

## Related

- [`docs/solutions/integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md`](../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md)
  — the defect this workbook does *not* have, and the source of the earlier ~104 s
  import figure this observation corroborates on unrelated bytes.
- [`docs/solutions/architecture-patterns/validating-mog-mcp-apps-without-overclaiming-host-support.md`](validating-mog-mcp-apps-without-overclaiming-host-support.md)
  — the evidence ladder that governs how the ~92 s figure is allowed to be stated;
  its "reaches ready" rung has no latency dimension and would pass on this workbook.
- [`docs/solutions/design-patterns/validate-workbook-feature-designs-against-a-second-genre.md`](../design-patterns/validate-workbook-feature-designs-against-a-second-genre.md)
  — the design-side consumer of the genre discriminator above: why you run the profiler
  twice, on two structurally different workbooks, before committing to a feature set.
- [`docs/solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md`](../design-patterns/multi-pane-canvas-embedding-via-url-flags.md)
  — each pane carries a full engine runtime, so hydration cost multiplies per pane.
- [`docs/solutions/ui-bugs/compact-mode-hid-adapter-failure-warning.md`](../ui-bugs/compact-mode-hid-adapter-failure-warning.md)
  — the prior instance of a UI surface reporting less than it knew.
- [`CONCEPTS.md`](../../../CONCEPTS.md) — Adapter Probe and Value Fidelity, the
  existing vocabulary any workbook-shape surface should reuse rather than rename.
