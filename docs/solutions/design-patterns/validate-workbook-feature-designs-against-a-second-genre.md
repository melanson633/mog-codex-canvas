---
title: A feature set validated on one workbook is overfit — test every feature against a second genre
date: 2026-08-05
category: design-patterns
module: canvas-feature-design
problem_type: design_pattern
component: development_workflow
severity: high
applies_when:
  - "A canvas, annotation, or workbook-inspection feature set was designed while looking at a single real workbook"
  - "A proposal's value argument rests on a structural property (deep dependency chains, per-cell meaning, cross-sheet wiring) rather than on a stated user need"
  - "Choosing the granularity of an anchor — cell, column, table, sheet, or filtered slice"
  - "A design is about to be committed to a plan, a doc, or an implementation ticket"
related_components:
  - frontend_stimulus
  - tooling
  - documentation
tags:
  - design-validation
  - workbook-genre
  - overfitting
  - second-specimen
  - annotations
  - dependency-trace
  - evidence-discipline
---

# A feature set validated on one workbook is overfit — test every feature against a second genre

## Context

On 2026-08-05 a canvas UX proposal was developed while looking at one real workbook:
a 7-sheet, 885-cell, 210-formula financial model (a tax estimate), 95 of whose 210
formulas reference another sheet. The proposal was then tested against a second real
workbook chosen to differ structurally: a 2-sheet, 122,132-cell, 12,340-formula job
log built around one 27-column table over 2,469 rows, with **zero** cross-sheet
references. Both measurements are tabulated in
[`docs/solutions/architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md`](../architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md),
which also establishes the cross-sheet reference ratio as the discriminator between
the two Workbook Genres and measures the profile cost at 1 ms and 20 ms respectively.

Two of the proposed features did not survive the second specimen.

**A derivation-chain lens** — select a cell, walk it back through its precedents.
On the model this is genuinely illuminating: chains run many hops across seven sheets,
and `Summary!F20` is nothing but `=Estimate!B66`, so the visible number and the number
that decides it are three surfaces apart. On the dataset every trace is exactly one
hop — `N2 = YEAR(Q2)` — repeated 2,469 times. The feature renders correctly and shows
nothing. It was demoted from a headline feature to a model-genre extra.

**Cell-level annotation anchors** — attach notes to individual cells. Right for the
model, where 14 accent-filled cells across 5 sheets each carry distinct meaning and a
cell is the natural unit of doubt. Wrong for the dataset, where the meaningful unit is
a *column* or a filtered slice, and a per-cell note would have to be written 2,469
times to say one thing. The dataset's own author had already settled this: the
workbook carries 14 threaded comments attached at the **column** level, including one
recording that an 18-digit ID column was precision-corrupted by Excel's 15-significant-
figure limit and is not analytically usable. The right granularity was written into the
file, and reading one more file was all it took to find it.

What survived generalization was the intersection: **region-bound annotations**, where
the region may be a cell, a column, a table, a sheet, or a filtered slice. That shape
serves both genres, and it is strictly what remained after the second specimen removed
what only fit the first.

**This is a repeat failure mode, not a one-off.** Ten days earlier, the ideation
document [`docs/ideation/2026-07-26-mog-canvas-uses-and-design-ideation.html`](../../ideation/2026-07-26-mog-canvas-uses-and-design-ideation.html),
under "Trace the cascade, not the diff", stated: *"The cost curve also inverts the
usual one: the more formulas the workbook has, the more useful the trace and the less
redundant its output."* On the dataset specimen that is backwards. 12,340 formulas,
every cascade one hop, output maximally redundant. The claim survived ten days
unchallenged because no second workbook was ever put in front of it. What actually
governs trace value is **dependency depth**, which tracks genre, not formula count.

That section has since been corrected in place — the quoted sentence is its prior
wording, retained here because the failure mode is the point of this doc and a
silently corrected claim teaches nothing.

The repo's default state makes this failure mode structural rather than careless.
[`AGENTS.md:64-66`](../../../AGENTS.md) records that `workbooks/` is a gitignored live
sandbox and `workbooks/sample.xlsx` is *the one tracked fixture*. Exactly one workbook
is permanently available to any contributor; real second specimens exist only
transiently in a developer's sandbox and cannot be committed. Nothing in the setup
nudges anyone toward a second test, so it has to be a stated rule.

## Guidance

### Before committing a design, run it against a second genre

Pick a second workbook that differs on the axis the design depends on — for this
project, that axis is Workbook Genre. If the proposal was built on a model, test it on
a dataset, and vice versa. Then take every feature in the proposal individually and
answer one question: **what does this show on the second workbook?**

Three outcomes, and each has a defined disposition:

- **Shows something useful on both.** Keep it. This is the real design.
- **Shows nothing, or shows noise, on one.** Do not delete it and do not keep it as a
  headline. Demote it to a genre-conditional feature and say which genre, in writing.
  The derivation-chain lens is this case.
- **Shows something at the wrong granularity.** The feature is right and the *anchor*
  is wrong. Generalize the anchor until it spans both, then re-check that the general
  version is still specific enough to be useful. Cell-level anchors → region-bound
  annotations is this case.

The output of the test is not a verdict on the proposal; it is a smaller, truer
proposal plus an explicit list of what was scoped to one genre.

### Distrust any value argument that rests on a structural property

The failure has a recognizable signature: the proposal's case for a feature is made in
terms of the workbook's *shape* rather than the user's *need*. "The more formulas, the
more useful the trace." "Every cell has its own story." "The chain is where the
reasoning lives." Each of these is a claim about a structural property that the one
workbook in front of you happens to have.

When you catch a sentence of that form in your own proposal, treat it as an untested
hypothesis and name the second specimen that would falsify it. Usually you can state
the falsifier in one line — *a workbook with 12,000 formulas and no cross-sheet
references* — which is most of the work of finding one.

### The test is cheap enough that there is no excuse

Host-side byte profiling characterizes a workbook in 1–20 ms without starting the
engine, and the illustrative classifier in the sibling doc prints sheets, rows, cells,
formulas, cross-sheet ratio, table parts, and comment parts in one command. Choosing a
structurally different second specimen is therefore a lookup, not a research project.
The expensive part was never the measurement; it was noticing that one specimen is not
evidence of generality.

Opening the second workbook in the canvas costs more — on the observed run, ~92 s to
renderer-ready — but the profile alone is usually enough to *choose* the specimen and
often enough to *kill* a feature, because "every trace is one hop" is visible in the
formula text without evaluating anything.

### Say which specimens a design survived

When a design reaches a plan, a doc, or a ticket, record the workbooks it was tested
against and what each one changed about it. A design that survived two structurally
different specimens is a materially stronger claim than one that survived a hundred
similar ones, and the reader cannot tell them apart unless you say.

This is the breadth counterpart to the existing evidence-discipline rules in
[`AGENTS.md`](../../../AGENTS.md), which govern the *strength* of evidence — whether a
named command ran, whether a claim was executed or derived from documentation. A
proposal can satisfy every one of those rules perfectly, with every observation
genuinely made and every limitation honestly stated, and still be entirely overfit,
because the missing evidence is a second specimen rather than a stronger check on the
first.

## Why This Matters

Overfit designs are expensive in a specific way: they do not fail loudly. They get
built, they work on the workbook they were designed for, and they degrade into dead
UI on everything else — a panel that renders correctly and communicates nothing. By
the time that is visible, the anchor granularity is in the data model and the
migration is real work.

The second cost is opportunity. The features that survive a genre test are, by
construction, the ones that generalize, and generalizing usually *simplifies*: the
region-bound annotation is one concept where cell-anchors-plus-column-anchors would
have been two. Running the test early is a design-simplification move, not just a
validation move.

The third cost is that this repo's documentation is only as good as its inputs. The
2026-07-26 ideation doc is an honest, careful document that models exactly the right
epistemics one level down — it explicitly says to "trace what is traceable and mark
where the trail goes cold." Its cost-curve claim was wrong anyway, because carefulness
about *this* workbook cannot detect an assumption about *all* workbooks. Only another
workbook can.

Finally, the epistemics here already have precedent in the tree. The sibling doc states
of its own genre threshold that "two points do not establish a threshold" and that any
cutoff in code "is a guess until more workbooks are profiled." That is the same
reasoning applied to a calibration constant. This doc applies it to a feature set,
where the stakes are higher because a wrong constant is one edit and a wrong anchor
granularity is a schema.

## When to Apply

Apply this when:

- A canvas, annotation, or workbook-inspection feature set was designed while looking
  at a single real workbook.
- A proposal argues for a feature from a structural property of the workbook rather
  than from a stated user need.
- You are choosing the granularity of an anchor — cell, column, table, sheet, or
  filtered slice. Granularity is the single decision most likely to be overfit, because
  the right answer is a property of the data's shape.
- A design is about to be committed to a plan, a doc, or an implementation ticket.
  Before is cheap; after is a migration.

Do **not** apply this when:

- The work is a bug fix, a correctness gate, or an invariant. Those are validated by
  reproduction and by named commands, which is a different discipline — see the
  evidence-discipline section of [`AGENTS.md`](../../../AGENTS.md) and
  [`docs/solutions/architecture-patterns/validating-mog-mcp-apps-without-overclaiming-host-support.md`](../architecture-patterns/validating-mog-mcp-apps-without-overclaiming-host-support.md).
- The feature is explicitly and deliberately genre-scoped from the start. Scoping is
  the *outcome* this test produces; a design that already declares its genre has
  already paid.
- Two specimens are being treated as sufficient rather than as a floor. Two structurally
  different workbooks falsify overfitting to one. They do not establish generality, and
  no number of them establishes a threshold — see the same caveat in the sibling doc.

## Examples

### The three dispositions, as applied on 2026-08-05

| Proposed feature | On the model (7 sheets, 95/210 cross-sheet) | On the dataset (2 sheets, 0/12,340 cross-sheet) | Disposition |
| --- | --- | --- | --- |
| Derivation-chain lens | Many hops across 7 sheets; `Summary!F20` = `=Estimate!B66` | Every trace one hop: `N2 = YEAR(Q2)` × 2,469 | Demoted to model-genre extra |
| Cell-level annotation anchors | Right unit: 14 distinct accent-filled cells across 5 sheets | Wrong unit: the file's own 14 comments anchor at column level | Anchor generalized to region-bound |
| Changes lane over save receipts | Useful — receipts already exist per save | Useful — same mechanism, unchanged | Kept as-is |

### The falsifier, stated in one line

The discipline is mostly this move. Write the structural assumption your feature
depends on, then write its negation as a workbook description:

> *Assumption:* trace value rises with formula count.
> *Falsifier:* a workbook with 12,000 formulas and zero cross-sheet references.
> *Result:* found one; the assumption is backwards. Trace value tracks dependency
> depth, which tracks genre, not count.

If you cannot describe the falsifying workbook, the feature's value argument is not yet
concrete enough to commit to.

### What the second specimen is allowed to prove

Precise wording, because the temptation is to overclaim in the other direction:

> Tested against two structurally distinct workbooks — one model (7 sheets, 210
> formulas, 95 cross-sheet) and one dataset (2 sheets, 12,340 formulas, 0 cross-sheet).
> Region-bound annotations were useful on both. The derivation-chain lens showed
> nothing on the dataset and is scoped to model-genre workbooks. Two specimens rule out
> fitting to one; they do not establish generality.

## Related

- [`docs/solutions/architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md`](../architecture-patterns/host-side-ooxml-profiling-outruns-engine-readiness.md)
  — the mechanism this practice consumes: the Workbook Genre discriminator, the 1–20 ms
  profile cost that makes the second-specimen test nearly free, and both workbooks'
  measurements.
- [`docs/ideation/2026-07-26-mog-canvas-uses-and-design-ideation.html`](../../ideation/2026-07-26-mog-canvas-uses-and-design-ideation.html)
  — the named prior instance: "Trace the cascade, not the diff" claims trace value rises
  with formula count. Falsified on a measured specimen; scope it to dependency depth.
- [`docs/solutions/architecture-patterns/validating-mog-mcp-apps-without-overclaiming-host-support.md`](../architecture-patterns/validating-mog-mcp-apps-without-overclaiming-host-support.md)
  — the adjacent discipline on the other axis: how *strongly* a verification may be
  claimed, where this doc governs how *broadly* a design may be claimed.
- [`docs/solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md`](multi-pane-canvas-embedding-via-url-flags.md)
  — Compare View is where two genres are visible side by side, and the concrete surface
  where per-genre presentation would land.
- [`CONCEPTS.md`](../../../CONCEPTS.md) — Workbook Genre and Workbook Profile; use the
  defined terms rather than inventing "shape" or "kind".
