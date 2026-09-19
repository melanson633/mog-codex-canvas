# Decision desk: ten opportunities and the six selected additions

Assessment date: 2026-09-19. The objective is a financial consultant's local,
evidence-backed spreadsheet environment. Two independent research agents reviewed
primary papers, professional guidance, and published product documentation.
The ranking below is an engineering judgment, not a benchmark claim.

## Ranked opportunities

| Rank | Addition | Practical benefit | Decision |
| --- | --- | --- | --- |
| 1 | Explicit model check packs | Re-run named financial controls against the saved model and see exact pass/fail evidence | Implement |
| 2 | Two-input sensitivity heatmap | See interaction between two assumptions rather than isolated scenarios | Implement |
| 3 | Bounded goal seek | Work backward from an output target to a tested input | Implement |
| 4 | Tornado driver analysis | Prioritize the assumptions whose tested ranges move an output most | Implement |
| 5 | Positional variance bridge | Account for every component of the difference between two explicitly aligned numeric ranges | Implement |
| 6 | Evidence notebook and client brief | Assemble results from one saved revision into a portable, printable working paper | Implement |
| 7 | Formula-reference outlier detection | Expand existing arithmetic-pattern review toward ExceLint-style structural anomalies | Defer; needs false-positive calibration and broader formula parsing |
| 8 | Unit and period consistency inference | Flag dollars versus thousands, monthly versus annual, stock versus flow mismatches | Defer; inferred labels must not silently become accounting facts |
| 9 | Correlated probabilistic scenarios | Model uncertainty distributions and quantify outcome intervals | Defer; needs explicit distributions, correlation choices and a larger calculation budget |
| 10 | Hosted parallel research workspaces | Run isolated experiments with semantic/model assistance and revision-checked local promotion | Assess Sites, WebMCP, TypeSafe and TabFM separately; requires a cloud/local boundary |

The selected six complete a useful sequence: check the model, examine assumptions,
find a target, explain a difference, and preserve the evidence. They use the
installed engine and existing service. No dependency upgrade or external AI
account is required. “State of the art” is an aspiration here, not a measured
performance or correctness certification.

## Research and consequences for implementation

- [Grossman, A Primer on Spreadsheet Analytics (2008)](https://arxiv.org/abs/0809.3586)
  discusses sensitivity, tornado diagrams and backsolving. The implementation
  therefore exposes assumptions and output cells, rather than offering a single
  unexplained score.
- [Powell, Baker and Lawson, An Auditing Protocol for Spreadsheet Models (2008)](https://faculty.tuck.dartmouth.edu/images/uploads/faculty/serp/Auditing.pdf)
  supports systematic review procedures. Named checks are configured explicitly;
  passing them does not certify the whole workbook.
- [ICAEW, Financial Modelling Code](https://www.icaew.com/-/media/corporate/files/technical/technology/excel/financial-modelling-code.ashx)
  supports sensitivity analysis, transparent assumptions and financial checks.
- [Saltelli and Annoni, How to avoid a perfunctory sensitivity analysis (2010)](https://doi.org/10.1016/j.envsoft.2010.04.012)
  explains the limits of one-factor-at-a-time analysis. Driver ranks are local to
  the selected low/high bounds; the heatmap separately explores two-way interaction.
- [Microsoft, Introduction to What-If Analysis](https://support.microsoft.com/en-us/excel/introduction-to-what-if-analysis)
  distinguishes scenarios, data tables and one-input goal seeking. The tools keep
  these operations separate and label what actually ran.
- [ICAEW, How to Review a Spreadsheet](https://www.icaew.com/-/media/corporate/files/technical/technology/excel/how-to-review-a-spreadsheet-report.ashx)
  informs explicit scope and limitations. A numeric variance is not proof of
  business causation or assurance that the two ranges represent comparable periods.
- [W3C PROV Primer](https://www.w3.org/TR/prov-primer/) and
  [Cunha et al., Explaining Spreadsheets with Spreadsheets (2018)](https://web.engr.oregonstate.edu/~erwig/papers/ExplainingSpreadsheets_GPCE18.pdf)
  motivate results tied to their source, procedure and time. Evidence briefs keep
  the workbook, sheet, full saved revision, request, results and limitations.
- [ExceLint (OOPSLA 2018)](https://arxiv.org/abs/1901.11100) offers a stronger
  reference-based formula anomaly approach. It is a future improvement, not an
  algorithm this release claims to implement.
- [Microsoft Research, Understanding and Inferring Units in Spreadsheets](https://www.microsoft.com/en-us/research/publication/understanding-and-inferring-units-in-spreadsheets/)
  motivates unit checking; ambiguous financial conventions make automatic adoption
  less defensible than explicit checks in this release.
- [NIST TN 1297, Propagation of Uncertainty](https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-appendix-law-propagation-uncertainty)
  highlights covariance. A future probabilistic feature must not invent independent
  distributions for correlated business assumptions.

## Boundaries and verification contract

The canvas remains the human editing lane. All analysis reads through the
workbook service. Experiments receive bytes in a disposable child process and
never save. Personal-data guards run before derivatives are released. Revision
changes invalidate an in-flight experiment. Supported engine models remain
one sheet, 10,000 populated cells, 2,000 formulas and the existing formula subset.

- Sensitivity: at most 5 by 5 points, two distinct numeric constants; known-answer
  tests verify the whole example grid, not just its center.
- Drivers: at most six explicit low/high intervals; baseline is recalculated,
  sorted effects remain linked to their inputs, and interactions are not claimed.
- Goal seek: increasing finite bracket, 40 bisections, explicit output tolerance;
  residual determines convergence. A sign change across a discontinuity must not
  be presented as a solution. No claim of global uniqueness or optimality.
- Variance: at most 200 paired numeric cells, equal rectangular dimensions,
  strict blanks/errors policy, zero-base percentages undefined, total reconciliation
  and floating-point residual disclosed. Matching is by position, not entity name.
- Checks: one to eight labelled range sums against an explicit number or another
  range, with equality/minimum/maximum and an absolute tolerance. Invalid cells
  stop the pack rather than silently passing or skipping a check.
- Brief: in-memory evidence collection, one workbook revision, explicit download,
  escaped data, no external scripts/assets, printable tables and raw evidence.

Release gates include meaningful numeric and privacy tests, type checking,
existing verification and MCP checks, real-canvas browser checks, and synthetic
desktop/mobile workflows against separate local staging and production instances.
The existing project is loopback software, not an internet-hosted SaaS.

## Upstream Mog

The published packages in this checkout remain unchanged. The upstream source
README describes a Rust CLI with persistent sessions and a partial Office.js
surface; that does not establish availability in the installed Node SDK.
Research did not establish streaming import/export as a published capability.
No upstream feature is claimed adopted merely because it appears in source docs.
