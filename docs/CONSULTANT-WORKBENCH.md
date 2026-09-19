# Financial workbench

Run `npm run build`, then `npm start`; open http://127.0.0.1:5276. The root is
`workbooks/` unless `MOG_WORKBOOK_DIR` is set. The production server binds only
to loopback, rejects foreign origins, and serves the built UI and Mog runtime.
No cloud host or external AI service is required.

## Workflow

Choose **New workbook** in the toolbar or empty state, enter a name, and create
a blank `.xlsx` with an empty `Sheet1`. Existing names are never overwritten.
You can also open an existing workbook or create the financial example. Human edits occur in the real
canvas. Save those changes before analyzing. Use selection copies the current
canvas cell/range into the analysis form.

- **Inspect:** saved values and formula text, at exact addresses. Repeated
  queries reuse a four-entry revision index. Each request still reads and hashes
  current bytes; the cache avoids repeated analysis, not disk I/O.
- **Explain:** direct inputs and a bounded upstream path (six hops, 100 nodes).
  Range operands remain rectangles. Cycles, unsupported references and limits
  are disclosed; the trace does not recalculate formulas.
- **Review:** saved Excel errors, arithmetic formula-pattern exceptions, and
  numeric constants between matching vertical formula peers. Functions and more
  complex patterns are outside this initial rule. Findings require judgment.
- **Tie out:** compare two ranges, up to 2,000 cells each, with an absolute
  tolerance. Text, errors and missing formula caches are rejected. The UI rejects
  blanks; the API also supports an explicit zero policy.
- **Scenarios:** one numeric constant, up to nine assumptions and six outputs,
  in isolated disposable engine instances. Supported models have one sheet,
  at most 10,000 populated cells and 2,000 formulas. Local arithmetic, SUM, MIN,
  MAX, AVERAGE, ABS, ROUND and IF are accepted; unsupported, volatile, cyclic and
  unresolved formulas are refused. A 30-second process limit bounds calculation.
  This is installed-engine execution, not a guarantee of universal Excel parity.
- **Sensitivity:** two distinct numeric inputs, up to five values on each axis,
  and one output. The heatmap shows all requested combinations, with exact values.
- **Drivers:** rank the output spread across explicit low/high input assumptions.
  The UI compares two drivers; the API accepts up to six. Each input changes alone,
  so the ranking does not measure interactions or prove causation.
- **Goal seek:** bracket a target between two input bounds and solve by bisection,
  up to 40 iterations. Convergence requires the output residual to meet the stated
  tolerance. Discontinuous models can fail to converge; solutions need not be unique.
- **Variance:** compare equal-shaped numeric ranges, up to 200 cells. Each row
  contributes to the total difference. Matching is positional, not by account name.
  Percentage changes use the absolute baseline; a zero baseline produces N/A.
- **Check packs:** run up to eight named equals/minimum/maximum controls against
  fixed amounts or another range total. Import/export version 1 JSON packs. Imports
  change the draft only; review and run them explicitly. Passing is not certification.
- **Evidence notebook:** pin up to 20 results from one workbook revision, then
  download the JSON record or a printable HTML brief. The notebook stays in this
  browser tab only. Export before closing; clear it before changing source revision.

Sensitivity, drivers and goal seek share the scenario model limits and never save
their disposable copies. Check packs and variance use saved numeric values and
reject blanks, text, errors and missing formula caches.

Export evidence downloads the exact result, saved revision, source addresses,
timing and coverage. Results describe the named saved revision, not subsequent
edits. Raw evidence can contain workbook data; share it only with intended recipients.

## Privacy and completeness

Analysis is local. High-risk personal-data labels or SSN-shaped values suppress
the entire workbook's new analysis results, including derivatives. This is
conservative: an unrelated sensitive label can make these tools unavailable.
Unlabelled numeric birthdates cannot be recognized. Oversized or unsupported
privacy scans fail closed. The existing raw workbook/canvas lanes retain their
established behavior.

The context index accepts up to 16 MiB compressed, 32 sheets and 20,000 populated
cells; the financial lab accepts 8 MiB compressed and 20,000 cells for its privacy
scan. Archive expansion is bounded separately. None of these limits is a sample
or a statement about cells outside the examined scope.

## Repeatable example

The generated `consultant-example.xlsx` has one Model sheet. B8 EBITDA is
360,000. Assets B11:B13 and funding D11:D13 both total 1,000,000. Growth input B3
at 0, 0.1 and 0.2 produces B8 values 300,000, 360,000 and 420,000. D19 deliberately
breaks the multiplication pattern for a review exercise. Example creation uses
the workbook service, validates through the engine and captures A1:D20.

The sensitivity center case returns 360,000. Margin B4 has a 220,000 tested output
spread versus growth B3's 120,000. Goal seek reaches 420,000 at approximately 20%
growth. The positional bridge between assets and funding has offsetting components
100,000 / -250,000 / 150,000; these are not matched accounts or actual/budget data.
The default check pack passes the balance and the 300,000 EBITDA floor.

See [the ten-option research ranking](DECISION-DESK-RESEARCH.md) and
[the Sites, WebMCP, TypeSafe and TabFM assessment](HOSTED-WORKFLOW-ASSESSMENT.md).

The full test suite runs files sequentially because an existing latency gate
measures wall-clock time; concurrent native-engine tests distort that measurement.
Its 400 ms threshold is unchanged. Staging and production use the same built
assets with separate synthetic workbook roots and the `check:consultant` gate.
