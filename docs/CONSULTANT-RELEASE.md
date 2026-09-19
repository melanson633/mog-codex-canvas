# Consultant release

The six selected additions and the ten-option research ranking are recorded in
[the implementation plan](plans/2026-09-18-consultant-workbench.md). Usage and
calculation limits are in [the workbench guide](CONSULTANT-WORKBENCH.md).

## Deployment

This repository has no configured internet deployment. The release runs as a
local production process at `http://127.0.0.1:5276`, with staging at port 5278.
Both use the built application and real Mog canvas. Their workbook roots are
separate and contain generated financial examples only.

The production source and built assets are copied to
`%LOCALAPPDATA%\MogFinancialWorkbench\releases\20260919-consultant`.
The workbook root is `%LOCALAPPDATA%\MogFinancialWorkbench\workbooks`.
The release uses this checkout's installed dependencies through a directory
junction; keep its `node_modules` available. Source edits do not change the
copied production files. The release directory records a SHA-256 source
manifest, process ID, standard output and error logs.

The process stays running after the task, but no Windows startup task is
installed. To restart after a reboot, run in PowerShell:

```powershell
$releaseRoot = Join-Path $env:LOCALAPPDATA 'MogFinancialWorkbench\releases\20260919-consultant'
$env:MOG_WORKBOOK_DIR = Join-Path $env:LOCALAPPDATA 'MogFinancialWorkbench\workbooks'
$env:MOG_RELEASE = '20260919-consultant'
$env:PORT = '5276'
Set-Location -LiteralPath $releaseRoot
node server/production.ts
```

## Verification

- `npm test`: 277 tests passed. Test files run sequentially; the existing
  400 ms latency threshold is unchanged.
- `npm run typecheck`, `npm run verify`, `npm run build`: passed.
- `check:app`: 11 checks passed, including real canvas edit, save and screenshot
  through MCP. The measured CSP needs `wasm-unsafe-eval` and a blob worker.
- `check:mcp`: 13 protocol checks passed. The test suite also executes the new
  analysis tool through an MCP client and verifies path rejection.
- `check:plugin`: 6 checks passed. `check:sdk-surface`: passed.
- Staging and production each passed 35 release checks. Browser evidence is in
  `artifacts/consultant-release/`. Each JSON
  receipt identifies the actual origin, release, check names and timings.
  Screenshots and result exports contain only the generated example.

The synthetic model checks EBITDA 360,000, equal 1,000,000 tie-out totals,
scenario results 300,000 / 360,000 / 420,000, the intentional D19 pattern issue,
and unchanged source bytes after analysis. Browser checks exercise all five
tools at desktop and mobile widths, evidence download, cell navigation and
selection handoff. These are bounded workflow tests, not universal Excel parity
or evidence of a remote Codex host rendering successfully.

## Review and simplification

The lead completed reuse, quality and efficiency passes inline after the
initial simplification agents hit a usage limit. Applied changes share the
bounded archive reader, use explicit action dispatch and reuse number
formatting. Privacy and revision checks remain intact. Broader parser and UI
rewrites were excluded because they were not needed for this release.

Independent review found and closed ZIP expansion and XML privacy bypasses,
misleading empty review results, workbook-picker divergence and a stale
selection-response race. Regression tests cover the privacy failures; the
browser gate covers the UI behavior. A source-only external peer review ran
through the Compound Engineering review skill. No client workbook was sent.

Final independent validation left three non-blocking items: cold multi-sheet
index construction repeats archive expansion (latency impact not measured);
an example can be saved before a later evidence-generation failure is reported;
and the scenario worker's forced-timeout branch lacks a dedicated regression
test. No runtime timeout defect was observed. These remain follow-up work,
not claims covered by the passing release checks.
