# Financial workbench

Run `npm run build`, then `npm start`; open http://127.0.0.1:5276. The root is
`workbooks/` unless `MOG_WORKBOOK_DIR` is set. The production server binds only
to loopback, rejects foreign origins, and serves the built UI and Mog runtime.
No cloud host or external AI service is required.

## Workflow

Open a workbook or create the financial example. Human edits occur in the real
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
  unresolved formulas are refused. A 20-second process limit bounds calculation.
  This is installed-engine execution, not a guarantee of universal Excel parity.

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

The full test suite runs files sequentially because an existing latency gate
measures wall-clock time; concurrent native-engine tests distort that measurement.
Its 400 ms threshold is unchanged. Staging and production use the same built
assets with separate synthetic workbook roots and the `check:consultant` gate.
