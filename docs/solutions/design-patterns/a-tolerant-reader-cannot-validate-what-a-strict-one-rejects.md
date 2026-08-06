---
title: A tolerant reader cannot validate what a strict one rejects — validate() has three blind spots
date: 2026-08-06
category: design-patterns
module: server-workbook-service-validation
problem_type: design_pattern
component: service_object
root_cause: platform_constraint
resolution_type: workflow_improvement
severity: high
applies_when:
  - a save is being trusted because validate() reopened the file and read it back
  - a workbook that will be delivered to a person who opens it in desktop Excel passes through any lane here
  - a new check is being designed and the engine is the proposed oracle
related_components:
  - tooling
  - documentation
tags: [validation, ooxml, value-fidelity, xlsx, theme-colors, defined-names, excel, oracle]
---

# A tolerant reader cannot validate what a strict one rejects — validate() has three blind spots

## Problem

`server/workbook-service.ts` reopens every saved workbook with the headless Mog
engine and reads it back, and that read-back is what the README calls **Verify**.
The `#CALC!` investigation already established one limit of it — *"a same-engine
round trip is not a fidelity check"* — and produced the value-fidelity gate,
which compares the engine's computed values against the file's own cached `<v>`
values.

Three open upstream issues show the same limit has two more shapes the fidelity
gate does **not** cover, because the gate only ever looks at **values**.

The general form: **`validate()` uses a tolerant reader as its oracle.** Mog,
openpyxl and LibreOffice all accept files that desktop Excel rejects outright,
and none of them notices formatting that has been silently flattened. A file can
pass every check in this repo — non-torn, flushed, revision-matched, fidelity
`passed` — and still be worse than the file it replaced, or refused by the only
program the recipient will actually use.

## The three blind spots

### 1. Formatting the export silently flattens — LIVE on every canvas Save

Upstream [#329](https://github.com/fundamental-research-labs/mog/issues/329),
reported at 0.10.3, open, no maintainer reply:

- A workbook whose font colors are **theme-linked** is imported and re-exported
  with those references replaced by **literal RGB**. The link to the workbook
  theme is gone, so the colors stop tracking a theme change forever after.
- API-authored theme strings such as `'theme:accent2:-0.1'` are exported as
  `rgb="THEME:ACCENT2:-0.1"`, which is not valid SpreadsheetML at all.

The reporter names two conversion points that discard the theme: a color
resolver that flattens imported theme colors to RGB whenever a palette exists,
and a format converter that unconditionally stringifies colors to RGB.

**Why this reaches this repo.** A canvas Save is an import followed by an export:
the engine serializes its state and the bytes travel through `persistThroughHost`
([`src/adapters/mog-embed-adapter.ts:303`](../../../src/adapters/mog-embed-adapter.ts))
to disk. Any workbook opened in the canvas and saved has been round-tripped. The
file still opens, the colors still *look* right on the day, and nothing here
looks at colors at all.

This is the `#CALC!` blast radius with a quieter symptom. There, a delivered
client file would have received `#CALC!` — loud, visible, and now refused by the
fidelity gate. Here it receives correct-looking colors that have quietly stopped
being theme-linked, and no gate refuses anything.

**Not reproduced here, and the tracked fixture would not show it.**
`workbooks/sample.xlsx` carries exactly one theme reference —
`<color theme="1"/>` on the default font — and it survived Mog's own export.
[verified: unzipped `xl/styles.xml`, 2026-08-06] That is not evidence either way
about #329, which is about *imported accent colors and tints*. A regression
fixture for this would need a workbook with theme-linked accent colors and a
tint, which this repo does not have.

### 2. Structural OOXML the writer can emit and Excel rejects — GATES

Two issues, same shape, both open:

[#332](https://github.com/fundamental-research-labs/mog/issues/332) (0.10.4 and
0.10.5) — `names.add` on a workbook loaded from an existing file writes
`<definedNames>` **after** `<calcPr>` and `<extLst>`. `CT_Workbook` requires the
sequence `sheets → definedNames → calcPr → … → extLst`. Desktop Excel reports the
file as corrupt and offers repair. openpyxl and LibreOffice accept it silently.
Moving only that one block to its schema position fixes the file entirely, so it
is a serialization-ordering defect, not data loss.

[#334](https://github.com/fundamental-research-labs/mog/issues/334) — the writer
assigns a newly added sheet `sheetId = idx + 1` without checking it against
`sheetId`s retained from an import, so an imported sheet holding `sheetId="2"`
and a new sheet can both end up as `"2"` in `xl/workbook.xml`. Excel may reject
or auto-repair; re-importing perpetuates it.

Neither reaches this repo today: nothing here calls `names.add`, and nothing adds
a sheet to an imported workbook. They are recorded because the reporter's own
sentence is the finding — **"corrupted files ship from automated systems
undetected until end users open them in Excel"** — and this repo *is* an
automated system that ships files.

### 3. Anything the engine agrees with itself about — already known

The original lesson, restated for completeness: a value the engine got wrong on
import survives a same-engine round trip intact, because the engine agrees with
itself. That is why the fidelity gate measures against the file's own cached
values rather than against a re-read. See
[mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md](../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md).

## Why the existing gate does not close 1 or 2

`server/value-fidelity.ts` refuses exactly one deterministic shape: the file
recorded a **non-error** result for a formula and the engine reports an **error
literal** for that same cell. That is a high-signal check and it is deliberately
narrow.

It cannot see #329, because a flattened theme color is not a formula result — no
`<v>` disagrees with anything. It cannot see #332 or #334, because element
ordering and `sheetId` collisions are not cell values, and because the engine
that would have to notice is the tolerant reader that emitted them.

**Widening the gate is not the answer.** Its narrowness is what makes
`unverified` honest and keeps it from converting missing evidence into lost work.
A structural or formatting check is a *different* check with a different oracle,
not a bigger version of this one.

## Solution

No code shipped. What this entry establishes is the rule and the shape any future
check would have to take.

**State the limit wherever Verify is described.** "Reopened and read back with
the headless engine" is exactly true and easy to over-read. It proves the file
loads in Mog. It does not prove the file loads in Excel, and it says nothing
about formatting.

**If a structural check is ever wanted, the oracle must be outside the engine —
and outside Mog.** The pattern is already in this repo: the value-fidelity gate
works because the workbook ships its own answer key. The equivalent for structure
is the OOXML schema itself, checked against the bytes — which the byte-first
stack is already positioned to do, since it parses `xl/workbook.xml` for defined
names and tables today (`server/workbook-metadata.ts`). Element order in
`CT_Workbook` and `sheetId` uniqueness are both readable there in milliseconds,
without an engine. That is a plausible future check with a real oracle; it is not
proposed here and would need its own design.

**For formatting there is no cheap oracle**, which is worth saying plainly rather
than inventing one. Comparing style parts before and after a round trip would
detect a flattened theme color, but distinguishing "the engine flattened it" from
"the human changed it" needs the before-bytes, which the save path does have
(`current` at [`server/workbook-service.ts:703`](../../../server/workbook-service.ts)).
Recorded as a possibility, not a recommendation.

## Prevention

- **Never treat "it reopened cleanly" as "it is a good file."** Durability,
  identity, value fidelity, structural validity, and formatting fidelity are five
  separate properties. This repo checks the first three. Say so.
- **Name the reader when claiming a file is valid.** Valid-per-Mog, valid-per-
  openpyxl and valid-per-Excel are different claims, and only the last one
  matters to the person who opens the deliverable.
- **Before delivering a workbook that went through any lane here, open it in
  Excel once.** That is the only check available today for blind spots 1 and 2,
  and it is cheap.
- **When adding a check, name its oracle first.** If the oracle is the engine,
  the check can only find things the engine already disagrees with itself about
  — which, as the 0 ms `recalculateAll()` showed, is close to nothing.
- **Prefer a stated blind spot over a check that implies coverage it lacks.**
  A `validate()` that quietly did not look at formatting reads, to the next
  agent, exactly like one that looked and found nothing — the same failure the
  Hydration Briefing's `notRun` block exists to prevent, one layer over.

## Related Issues

- [../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md](../integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md) — the original "same-engine round trip is not a fidelity check" lesson and the gate it produced
- [../integration-issues/upstream-mog-open-defects-and-which-lane-they-reach.md](../integration-issues/upstream-mog-open-defects-and-which-lane-they-reach.md) — the tracker index; #329 is classified LIVE there
- [crash-safe-workbook-saves.md](crash-safe-workbook-saves.md) — byte-level save safety, which is a fourth independent property; a save can be non-torn and still flatten every theme color
- [../architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md](../architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md) — the byte-first reader that would host a structural check, if one is ever built
- Upstream [#329](https://github.com/fundamental-research-labs/mog/issues/329), [#332](https://github.com/fundamental-research-labs/mog/issues/332), [#334](https://github.com/fundamental-research-labs/mog/issues/334) — all open, no maintainer reply as of 2026-08-06
</content>
