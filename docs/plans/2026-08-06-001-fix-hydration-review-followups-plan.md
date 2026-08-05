---
title: Hydration Briefing — Post-Review Follow-Ups - Plan
type: fix
date: 2026-08-06
revised: 2026-08-06
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: code-review
execution: code
---

# Hydration Briefing — Post-Review Follow-Ups - Plan

## Goal Capsule

- **Objective:** Close the findings that survived the code review of the hydration
  briefing pipeline (PR #16, merged as `f49d522`) and were not fixed before merge.
- **Provenance:** Review run `20260805-review-hydration` over
  `ec8edf40..750d05bc`. That review raised 21 findings. Five (#1, #2, #10, #11,
  #14) were the R38 redaction blocker group and were fixed on-branch in `608bc82`,
  `0227f19`, and `dfa88fc`. One (#21) was closed by documentation in `b2a4a72`.
  One (#3) was dropped during validation. The remaining 14 are the units below.
  Numbers are the review's stable identifiers and are deliberately not
  recompacted — gaps are expected.
- **Authority:** [`AGENTS.md`](../../AGENTS.md) invariants outrank this plan.
  [`CONCEPTS.md`](../../CONCEPTS.md) owns vocabulary. The parent plan is
  [`2026-08-05-001-feat-hydration-briefing-dependency-graph-plan.md`](2026-08-05-001-feat-hydration-briefing-dependency-graph-plan.md);
  its R-IDs are cited throughout.
- **Execution profile:** Engine-free throughout. No file touched by this plan may
  import `@mog-sdk/*`. Every unit is testable with `node --test` and no browser.
- **Stop conditions:** Stop and surface a blocker if U11's decision (is 400 ms a
  ceiling or a description?) cannot be settled, because it grades U7 and U8.

---

## Product Contract

### Problem Frame

The pipeline shipped with its release blocker closed, but the review left a set
of correctness, honesty, and robustness gaps that the merge did not address.
They fall into four themes:

1. **Blind spots reported as measured zeros.** Two reference-parser gaps and one
   consumer gap make the pipeline say "no consumption" where it means "could not
   measure." This is the single most damaging class, because the pipeline's value
   rests on a caller trusting its numbers without seeing the bytes.
2. **The report states things it did not measure.** A collapsed truncation
   reason, a workbook-wide cycle count printed on a per-sheet view, and a
   hardcoded `0 ms` latency.
3. **Byte-lane robustness.** A quadratic regex, a quadratic graph pass, and an
   untyped throw — all reachable from an ordinary or a crafted workbook.
4. **Invariants and tooling asserted only in prose.** Engine isolation is a
   comment; the `check:app` freshness gate has two holes in the mechanism that
   exists to close a hole.

### Requirements

- RF1. No unit may weaken R38, R39, or R40, or the "unknown is never empty"
  contract. Each unit states which parent R-ID it restores.
- RF2. Every fix lands with a regression test that fails before it and passes
  after. A fix without a test is not done.
- RF3. Reporting changes are additive where a field's meaning would otherwise
  change under an existing consumer.
- RF4. `npx tsc --noEmit`, `npm test`, `npm run verify`, `npm run check:mcp`, and
  `npm run check:app` all pass at the end of every unit. Baseline at plan time:
  **tests 255 pass / 0 fail**, `check:mcp` 13/0, `check:app` 11/0.

---

## Implementation Units

Units are grouped into sessions. Within a session, order matters. **Across
sessions it mostly does not** — the file ownership below is disjoint by
construction, so S1 through S4 are designed to run concurrently in separate
worktrees.

| Session | Units | Files owned |
|---------|-------|-------------|
| **S0** | U4 | `sheet-schema.ts`, `sheet-roles.ts`, `workbook-graph.ts` — 3 chars each |
| **S1** | U1, U2, U3 | `formula-refs.ts`, `consumption-index.ts` + tests |
| **S2** | U5 | `workbook-graph.ts` + test |
| **S3** | U6, U7, U8, U9 | `sheet-schema.ts`, `workbook-briefing.ts`, `ooxml-cache.ts` + tests |
| **S4** | U10, U11, U12 | `scripts/mcp-check.mjs`, `scripts/ui-bundle.mjs` + test |
| **S5** | U13 | all four byte-lane modules — **conflicts with S1, S2, S3** |

Two ordering constraints, and only two:

1. **S0 lands first, alone.** U4 is a three-character edit in three files that S2,
   S3, and S5 all live in. It is five minutes of work; sequencing it removes the
   only cross-session collision and buys full parallelism for everything after.
2. **S5 runs last, alone.** U13 extracts shared column-letter math out of all four
   byte-lane modules. It touches every file S1, S2, and S3 own. Running it
   concurrently guarantees conflicts, and because it is a pure extraction, a
   botched merge is a silent behavior change rather than a failed build.

S1, S2, S3, and S4 own disjoint file sets and can run in four concurrent
worktrees. Each still runs the full RF4 gate independently.

### Session 1 — Reference parsing blind spots (restores R16, R26)

**U1 — #4 — escaped apostrophes in quoted sheet names.**
`server/formula-refs.ts:94` (the `QUALIFIED` pattern). Excel escapes an
apostrophe inside a quoted sheet name by doubling it: `'Bob''s Data'!A1`. The
pattern `'[^']+'` terminates the name at the first `'`, producing sheet `Bob` — a
name that may not exist, or, worse, may. Accept `''` as an embedded quote and
unescape it when emitting the sheet name. R16 names this as an in-scope operand
class. Test: a formula referencing a sheet whose name contains an apostrophe
resolves to that sheet, not a prefix of it.

**U2 — #5 — whole-column references parse as defined names.**
`server/formula-refs.ts:95` (the `BARE`/`QUALIFIED` A1 shapes). `Sheet1!A:A`
fails the A1-range shape — both sides require a row number — and falls through to
the defined-name branch, so a legitimate range is classified as an unresolved
name. Add the column-only and row-only range shapes. R16, same clause as U1.
Test: `Sheet1!A:A` and `1:1` classify as ranges with the right sheet.

**U3 — #9 — a parse miss is reported as a measured zero.**
`server/consumption-index.ts:183`. An operand whose sheet does not resolve is
added to `unknownSheetNames` and then contributes nothing; the target sheet
subsequently reports zero inbound references with no statement that the
measurement was incomplete. R26 requires the opposite: where the measurement is
itself incomplete, say so rather than reporting "no measured consumption" as
settled. **This survives U1 and U2** — the hole is in how the index reports the
miss, not in the parse, so any future unparseable shape lands in it. Test: a
workbook with one deliberately unresolvable operand reports a blind spot, not a
zero.

*Do U1 and U2 first; U3 last, because U3's test fixture is easier to write once
the two known parse gaps no longer produce noise.*

### Session 0 — The one edit that must land first

**U4 — #12 — quadratic cell-scan regex.**
`server/sheet-schema.ts:219`, `server/sheet-roles.ts:321`,
`server/workbook-graph.ts:204` — all three carry:

```
/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
```

`[^>]*?` permits `<` inside the attribute run, so a `<c` with no closing `>`
makes the engine rescan the remainder of the part from every start position. On
a multi-megabyte sheet this does not return. The fix is three characters in three
places: `[^>]*?` → `[^<>]*?`. Worth taking even under the "we only read our own
saved bytes" argument, because the MCP server reads whatever file it is pointed
at. Test: a malformed sheet part with an unclosed `<c` completes in bounded time.

### Session 2 — Graph performance (graded by U14)

**U5 — #13 — `candidateOutputs` is O(nodes × rectangles).**
`server/workbook-graph.ts:599` and the `dependentsOf` path it drives. Every node
is tested against every range rectangle. **Measured, not hypothetical:** on a
real 12-sheet forecast workbook (1,482 rows, 24,094 cells, 7,711 formulas) the
whole briefing took 393 ms and **stage 2b alone took 217 ms** — on a specimen
roughly one fifth the size of the ~120,000-cell workbook R33's 400 ms budget was
written for. Needs an interval index for rectangle containment. This is design
work, not a mechanical edit. Test: a synthetic sheet with many nodes and many
rectangles stays within a stated ratio of a baseline operation timed in the same
run (wall-clock assertions are contention-sensitive; see the review's note on the
best-of-three latency test).

*U4 (Session 0) must already be merged — it removes a confound from U5's timing
measurements and touches a file S3 also owns.*

### Session 3 — Honest reporting (restores R31, R36, R40)

**U6 — #7 — simultaneous truncation collapses to one reason (R40).**
`server/sheet-schema.ts:604-607`:

```
    truncated: distinctCapBit || consumption.truncated,
    truncationReason: distinctCapBit
      ? `the ${distinctCap}-value distinct cap bit: …`
      : consumption.truncationReason,
```

When both caps bite, `truncated` is right but only the distinct cap is named —
the consumption truncation, the one that decided how deeply the column was
profiled at all, is dropped. R40 requires the cap that bit to be reported *with
the cap named*. The fix is a reason list, not a ternary. Keep
`truncationReason` populated for existing consumers (join the list) and add the
list additively per RF3. Test: a column where both caps bite names both.

**U7 — #15 — per-sheet view prints the workbook-wide cycle count (R31).**
`server/workbook-briefing.ts:518`: `cycles: cycleNodes.length > 0 ? graph.cycles : 0`.
`cycleNodes` is correctly filtered to the sheet; `graph.cycles` is not. A sheet
with one cycle node reports the whole workbook's cycle total as its own. R31
frames the briefing as per-sheet, keyed to that sheet's role. Test: a two-sheet
fixture where each sheet has a distinct cycle reports one each, not two each.

**U8 — #18 — malformed character reference throws `RangeError` (R36).**
`server/ooxml-cache.ts:98-99`. A malformed numeric character reference reaches
`String.fromCodePoint`, which throws. This is the shared unescape on every
byte-lane path, so one bad byte sequence takes down all six stages with an
untyped throw. R36 requires typed failures. Leave the malformed reference as
literal text and record it as a typed parse note. Test: a part containing
`&#xFFFFFFFF;` returns a result carrying a named failure rather than throwing.

**U9 — #19 — Stage-0 latency hardcoded to zero.**
`server/workbook-briefing.ts:771`: `stages.push({ stage: 'stage-0', elapsedMs: 0 })`.
This hides the real `profileWorkbook` cost, which is the largest single input to
the R33 budget question. **Confirmed live** — a real run reported stage-0 at
`elapsedMs: 0`. Measure it. Test: stage-0 elapsed is greater than zero on a
non-trivial fixture.

### Session 4 — Tooling and invariants (parallelizable; run in a worktree)

**U10 — #8 — engine isolation is a comment.**
`server/workbook-briefing.ts:27` states `Engine-free: nothing here may import
@mog-sdk.` True today — verified by grep during the review — and nothing prevents
tomorrow's edit from breaking it. `npm run verify` covers the React shell, not
this. Add a grep assertion over the byte-lane modules to `scripts/mcp-check.mjs`.
Note that `mcp-check.mjs:232` legitimately imports `@mog-sdk/sdk/node`, so the
assertion must be scoped to the byte-lane module list, not the repo. ~5 lines.
Test: the check fails when a byte-lane module gains the import.

**U11 — #16 — `ensureFreshBundle` discards the post-build verdict.**
`scripts/ui-bundle.mjs:134`. The helper rebuilds and then returns the pre-build
verdict, so a rebuild that *fails* leaves `check:app` green over a stale bundle —
the exact failure the commit exists to prevent, inside the mechanism that
prevents it. Re-read freshness after the build and return that. Test: a forced
build failure makes `check:app` fail.

**U12 — #17 — freshness hash omits `tsconfig.json`.**
`scripts/ui-bundle.mjs` (the hashed input set). A compiler-config change produces
a "fresh" stale bundle. Add `tsconfig.json` to the hashed inputs. Test: touching
`tsconfig.json` marks the bundle stale.

### Ungrouped

**U13 — #6 — column-letter math hand-copied into four modules.**
`server/sheet-schema.ts:233` and its siblings. Roughly 40 removable lines across
four or five modules. Purely mechanical, touches every file the other units
touch, and therefore should run **last and alone** to avoid conflicting with
every other session. Test: existing tests pass unchanged (this is a pure
extraction — a behavior change here is a bug).

**U14 — #20 — is the 400 ms budget a ceiling or a description? (decision, not a defect)**
`server/workbook-briefing.ts:814`. R33 states 400 ms as a budget. The code
measures elapsed time and reports it; nothing enforces it. Reporting and letting
the caller decide is a legitimate design position, but it is not what R33 says,
and **it grades U4 and U5**: if 400 ms is a ceiling, they are blockers on it; if
it is a description, they are hardening. Owner is human. Settle this before
Session 2 finishes, and record the answer here.

---

## Open Follow-Up Carried From the R38 Fix

Recorded in
[`docs/solutions/security-issues/redaction-guards-fail-by-misalignment-not-by-logic.md`](../solutions/security-issues/redaction-guards-fail-by-misalignment-not-by-logic.md):
a table-declared column with no `name` is reported `header: null`, so only the
value-shape half of R38 runs on it. That matters most for birthdates, which have
no value shape to fall back on. Merging table labels with detected-row labels
would close it, at the cost of complicating what `headerSource` can honestly
claim. Not scheduled as a unit here — it is a design decision, not a fix.

## Independent Re-Verification Debt

R38's fix was written and verified by the same session. No independent pass has
run. This is now a debt on `main` rather than a gate on a branch, but it is real
and should be discharged before the next release claim that cites R38.

---

## Validation Gate

Per RF4, at the end of each unit:

```
npx tsc --noEmit && npm test && npm run verify && npm run check:mcp && npm run check:app
```

Baseline at plan time: tests 255/0, `check:mcp` 13/0, `check:app` 11/0. A unit
that lowers any of these numbers without explanation is not done.
