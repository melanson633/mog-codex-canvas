---
title: Redaction guards fail by misalignment, not by logic — the R38 column-pairing traps
date: 2026-08-05
category: security-issues
module: server
problem_type: security_issue
component: extraction_pipeline
symptoms:
  - "A birthdate column reports min, max, and a distinct count with redacted: false"
  - "The column beside a redacted one is marked redacted: false — a clean bill of health nothing issued"
  - "A header the guard was written to catch (EMP_DOB, Employee_SSN) is not caught"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
tags: [pii, redaction, r38, ooxml, tables, header-detection, off-by-one, fail-closed]
---

# Redaction guards fail by misalignment, not by logic — the R38 column-pairing traps

## Problem

R38 forbids emitting min/max, distinct counts, or samples for any column whose
header or value shape indicates a social-security/taxpayer number or a
birthdate. The guard itself ([`server/redaction.ts`](../../../server/redaction.ts))
was correct from the start, ran ahead of every statistic, and could not be
lifted by the depth override. It leaked anyway, three separate times:

1. **Stage 1's label list collapses blank header cells.** A gap left of an SSN
   column shifted every later label one column, so the guard read a neighbour's
   name. (Fixed earlier; the labels now carry their source column.)
2. **The table-definition header path paired labels to columns positionally.**
   With a table declared, headers came from
   `table.columns.map((label, index) => ({ column: first + index, label }))`,
   resting on two unchecked assumptions — that the label list is dense, and
   that the table's `ref` resolves. Neither is guaranteed by a file:
   [`workbook-metadata.ts`](../../../server/workbook-metadata.ts) dropped any
   `<tableColumn>` with no `name`, and a missing `ref` fell back to `?? 'A'`.
   A three-column table whose middle column was unnamed redacted `Name` and
   published the extents of the `Date of Birth` column beside it. A table
   actually at `D1:F16` with no `ref` mapped every label onto A:C and profiled
   the real birthdate column at F in full.
3. **The header patterns are word-bounded, and `\b` does not fire against an
   underscore.** `SSN` matched; `Employee_SSN`, `EMP_DOB`, `Birth_Date`,
   `Taxpayer_ID`, `TAX_TIN`, and `employeeSSN` did not. Underscored and
   camel-cased headers are the house style of anything exported from a payroll
   or HR system, which is the data R38 exists for.

Every one of these also produced the second, quieter failure: the column that
was checked *instead* is reported `redacted: false` — an affirmative statement
that a column was examined and cleared, which a caller widens on.

## Root Cause

The guard's logic was never the problem. What reached it was. All three are the
same class: **a guard is only as good as the pairing between the name it reads
and the column it protects**, and every one of those pairings was an assumption
rather than a check.

The table path is the instructive one. Its assumptions are true of any file
Excel writes — `name` is required on `<tableColumn>`, `ref` is required on
`<table>` — which is exactly why they were never checked, and exactly why the
failure is invisible until a third-party writer produces the file. The tests
missed it because all R38 coverage used `headerSource: 'detected-row'`; the
table path had none.

## Solution

- **Make positions a contract, then verify it.** `readTables` now pushes `''`
  for an unnamed `<tableColumn>` so the list stays positional, and records the
  file's own `<tableColumns count>` as `declaredColumnCount` for callers to
  check against. Both conditions add a note.
- **Refuse the table rather than guess.** Stage 3 uses the table's labels only
  when its `ref` resolves *and* its column count matches what was read.
  Otherwise the labels are refused outright and the detected header row is used
  — that path carries a real column number with every label, so no positional
  arithmetic is involved. The `?? 'A'` anchor default is gone; it was the thing
  that silently mapped a table at D:F onto A:C. `headerSourceBasis` states which
  table was refused and why.
- **Normalize the header before matching.** `normalizeHeader` splits on any
  non-alphanumeric separator and on camelCase transitions, so all eight existing
  patterns see `EMP DOB` where the file said `EMP_DOB`. This widens what matches
  and never narrows it: over-matching costs a column its extents, under-matching
  costs a roster.

## Prevention

- **A redaction guard's tests must cover every path that feeds it, not every
  branch inside it.** The guard had thorough coverage and two live leaks. The
  question to ask is "how many ways does a header reach this?", not "does this
  fire on SSN?".
- **Assert the setup before asserting the outcome.** The header-shape tests
  assert `depth === 'full'` before asserting `min === null`, so a gating change
  cannot turn a redaction test into a tautology that passes because nothing was
  computed at all.
- **Make the sensitive column's values unforgeable in fixtures.** The first
  version of the table-path leak test failed on a value a *non-redacted* column
  legitimately reported, because every column shared the same serials. Give the
  protected column values no other column can produce.
- **Pair a value with its coordinate at the point of extraction.** Any list that
  can be filtered, collapsed, or truncated between extraction and use cannot be
  indexed positionally later. Carry the column number with the label.
- **`\b` is not a word boundary in identifiers.** It does not fire against `_`,
  and it does not fire at a camelCase transition. Any pattern matched against
  machine-generated column names, keys, or field names needs normalization first.
- **Redaction false positives are cheap; false negatives are not.** When a rule
  is uncertain, widen it.

## Open follow-up

When a table declares a column with no `name`, that column is reported
`header: null` — the table named nothing, so reporting it unlabeled is the
honest answer, and the value-shape rule still runs on it. But Stage 1 usually
*does* have a correct label for that column from the detected header row, and it
is discarded. Merging the two sources (table labels for naming, detected-row
labels to fill the holes) would give the header-driven half of R38 one more shot
at a column that currently only gets the value-shape half — which matters most
for birthdates, where there is no value shape to fall back on. Not done here
because mixing header sources complicates what `headerSource` and
`headerSourceBasis` can honestly claim, and that reporting contract is
load-bearing.

## Related Issues

- [`docs/solutions/design-patterns/validate-workbook-feature-designs-against-a-second-genre.md`](../design-patterns/validate-workbook-feature-designs-against-a-second-genre.md)
  — the payroll genre is what surfaced R38 in the first place
- [`docs/solutions/security-issues/windows-path-containment-traps.md`](windows-path-containment-traps.md)
  — same shape at the filesystem boundary: the check was right, the thing being
  checked was not what the caller thought
