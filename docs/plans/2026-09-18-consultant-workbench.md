# Consultant workbench

## Outcome

Turn the live workbook companion into a local financial review environment. Keep the real canvas, saved-file evidence, revision checks, privacy guard, and headless editing lane. The user authorized implementation, source publication, staging and production deployment, and synthetic production tests. This repository has no configured cloud deployment; staging and production mean separate loopback production-build instances, with independent generated workbook roots.

## Ten opportunities, ranked

| Rank | Addition | Decision |
|---|---|---|
| 1 | Revision-aware analysis index and compact range context | Build: removes repeated derivation work while checking saved revision on every request. |
| 2 | Explain a number and trace its dependencies | Build: makes model outputs inspectable beside their source cells. |
| 3 | Formula-pattern and error review | Build: exposes suspicious copied formulas and constants without claiming they are proven errors. |
| 4 | Explicit financial tie-outs | Build: deterministic reconciliations with exact ranges, numeric rules and tolerances. |
| 5 | Disposable scenario and sensitivity lab | Build: tests assumptions through the installed engine without changing the saved source. |
| 6 | Consultant workspace, evidence export and executable examples | Build: connects the capabilities into a usable workflow and a synthetic-user release gate. |
| 7 | Reviewable agent edit proposals | Defer: valuable, but read-only review plus existing revision-controlled saves gives a smaller first release. |
| 8 | Financial units, periods and business-meaning map | Defer: inference requires explicit ambiguity handling and labeled evidence. |
| 9 | Monte Carlo risk analysis | Defer: distributions and correlations require business assumptions; deterministic sensitivity comes first. |
| 10 | Cross-workbook workpaper lineage | Defer: needs an approved source registry and broader source-identity design. |

## Research basis

Two independent research agents reviewed papers and primary documentation. These are design influences, not a claim that this implementation reproduces research systems or attains their benchmark results.

- [SpreadsheetLLM (2024 preprint)](https://arxiv.org/abs/2407.09025): structural, address-preserving compression motivates compact context.
- [SpreadsheetAgent (ACL 2026)](https://aclanthology.org/2026.acl-long.86/): progressive inspection supports narrow, evidence-backed queries.
- [Puncalc (2019)](https://link.springer.com/article/10.1007/s11227-019-02823-8) and [Excel calculation performance](https://learn.microsoft.com/en-us/office/vba/excel/concepts/excel-performance/excel-improving-calculation-performance): dependency structure and invalidation motivate the cache and trace. This release does not implement Excel smart recalculation.
- [ExceLint (2019)](https://arxiv.org/abs/1901.11100) and [industrial spreadsheet auditing (2008)](https://arxiv.org/abs/0805.1741): formula regularity provides review signals, not correctness proofs.
- [FinSheet-Bench (2026 preprint)](https://arxiv.org/abs/2603.07316) and [FLARE (2025 preprint)](https://arxiv.org/abs/2506.17330): numeric execution should be deterministic and separate from language interpretation.
- [SpreadsheetBench (2024)](https://arxiv.org/abs/2406.14991), [Finch (ACL 2026)](https://aclanthology.org/2026.findings-acl.523/), and [WorkstreamBench (2026 preprint)](https://arxiv.org/abs/2605.22664): evaluate complete tasks, formula integrity, evidence, and presentation with executable examples.
- [FAST Standard](https://fast-standard.org/the-fast-standard/): transparent assumptions and readable models motivate explicit scenario controls.

## Acceptance

1. Cache reuse is observable; external saved changes invalidate results. Bounded coverage and unsupported dependencies remain visible.
2. Trace answers identify exact cells and saved revisions. Links navigate the real canvas.
3. Review detects seeded formula errors and copied-pattern breaks; valid peers remain unflagged. Findings never trigger automatic edits.
4. Tie-outs compute explicit numeric ranges, reject unsafe/missing values, disclose blank policy and enforce personal-data guards.
5. Scenario engine reproduces known formula chains, rejects unsupported cases, times out safely, and leaves source bytes unchanged.
6. Desktop/mobile workspace supports all workflows, example creation never overwrites, evidence exports retain provenance, and synthetic-user browser checks run against staging and promoted production.
7. Existing project gates pass; a dedicated code review is completed; source is pushed with a reviewable PR and deployment evidence.

## Work ownership

Analysis index worker: new index module and tests. Financial lab worker: new reconciliation/scenario modules and tests. Release runtime worker: production server and generated example modules/tests. Lead: integration, UI, MCP tools, browser release gate, review, deployment and source publication. Existing unrelated error.log remains excluded.
