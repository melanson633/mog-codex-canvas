---
title: Mog SDK gotchas — /node subpath, proxy-backed objects, canvas-safe verification
date: 2026-07-26
category: integration-issues
module: sdk-usage
problem_type: integration_issue
component: headless_lane
symptoms:
  - "createWorkbook('path') fails typecheck — no file-path overload in the browser build"
  - "ERR_PACKAGE_PATH_NOT_EXPORTED for @mog-sdk/spreadsheet-app/package.json"
  - "Object.keys / getOwnPropertyNames on SDK objects return nothing useful"
root_cause: platform_quirk
resolution_type: workflow_improvement
severity: medium
tags: [mog-sdk, node, bundler-resolution, proxies, introspection, canvas, verification]
---

# Mog SDK gotchas — /node subpath, proxy-backed objects, canvas-safe verification

## Problem

A grab-bag of Mog SDK facts that each cost real debugging time and that guessing gets wrong. Recorded here so code is written against the actual API, not a plausible one.

## Package resolution

- **Server code must import `@mog-sdk/sdk/node`.** The bare specifier resolves to the browser WASM build under bundler resolution, which has no file-path `createWorkbook` overload; the `/node` subpath forces the native binding.
- **`@mog-sdk/node` is deprecated** (0.8.1 → "use @mog-sdk/sdk instead"). The embeddable canvas is `@mog-sdk/spreadsheet-app` (peer React 19, ~110 MB unpacked, 41 MB wasm).
- `@mog-sdk/spreadsheet-app` does **not** export `./package.json` — resolve its dist directory via an exported subpath (`import.meta.resolve(...)` / `require.resolve('@mog-sdk/spreadsheet-app/styles.css')`), not by reading package.json.

## API shape — introspect, don't guess

- SDK objects are **proxy-backed**: `Object.getOwnPropertyNames(prototype)` returns only `constructor`. Discover the API by calling `api.describe` / `api.search` or reading the contracts `.d.ts` — three separate guessed names (`wb.sheets.get`, `ws.structure.setColumnWidth`, a `workbook_metadata` tool) were all wrong; the real ones were `wb.activeSheet`, `ws.layout.setColumnWidth('F', 380)`, and the 9 names registered in source.
- `wb.getOrCreateSheet(name)` returns `Promise<{ sheet, created }>`, not a sheet.
- `captureScreenshot(sheet, range, opts): Promise<Uint8Array>` lives in the contracts `_types` tree and requires an actor ref — use `kind: 'user'` (privileged kinds need a host authority adapter).
- **`wb.dispose()` is specified as `void`, not `Promise<void>`.** The generated reference gives `dispose(): void`, so a `dispose()` that returns `undefined` is the contract being honored, not a quirk to chase. Do not chain onto its return value. The embed's `SpreadsheetWorkbookSession.dispose()` *is* `Promise<void>` — two different methods with the same name.

## Formula-safe writes: `setFormulas`, not a multi-row `setRange`

Upstream [#328](https://github.com/fundamental-research-labs/mog/issues/328)
(open, reported at 0.10.4) says `ws.setRange` with a multi-row matrix keeps
formula strings only on the **first** row — later rows are stored as cached
scalars and the formulas are gone after an export/reload cycle. The reporter's
example: `"=A2"` in row 2 comes back as the number `200`.

The formula-safe writes upstream names are `ws.setFormulas(range, formulas[][])`
for rectangular formula blocks and `ws.setCells([{ addr, value }])` for sparse
mixed writes. Both preserve formulas across all rows through an export cycle.

**It does not reproduce at 0.10.5 in this repo.** `scripts/headless-edit.mjs:65-70`
writes exactly the reported shape, and the fixture it produces —
`workbooks/sample.xlsx` — carries `<f>` on rows 2, 3 and 4 (`SUM(B2:C2)`,
`SUM(B3:C3)`, `B2-B3`, `C2-C3`, `SUM(B4:C4)`). [verified by unzipping
`xl/worksheets/sheet1.xml`, 2026-08-06] So this is a hazard with a named safe
alternative, not a live defect — but the sample generator is one SDK bump away
from silently emitting a formula-free fixture, and the shape it uses is the
reported one.

**After any `@mog-sdk` bump, re-check that fixture for `<f>` on rows 2-4.** That
is the cheapest available regression test for this, and it needs no engine.

## Verifying a canvas-painted UI

The grid is painted on `<canvas>` — cell text never reaches the DOM, so DOM-text assertions pass on meaningless chrome strings ("Home Insert Formulas"). The patterns that actually prove something:

- Assert on the **formula bar `<input>`** — the only DOM-observable proof the workbook's data reached the UI.
- Navigate cells by **keyboard** (Ctrl+Home + arrows), not pixel coordinates — pixel math against a canvas grid goes off-by-one-row at the slightest layout change.
- Verify saves by **reading a pre-captured, guaranteed-different value back from disk** with the headless engine, so a silently failing save can't pass.
- For browser automation on this host, self-spawned headless Chrome driven over raw CDP (`--headless=new`, throwaway profile, fixed debug port) proved reliable where `browser-use` (interactive CDP approval) and `agent-browser` (silent hang) both failed.

## Related Issues

- docs/solutions/runtime-errors/wasm-bindgen-ignores-wasm-base-url.md
- docs/solutions/integration-issues/mcp-apps-sandboxed-iframe-wasm-csp-and-storage.md
- docs/solutions/integration-issues/upstream-mog-open-defects-and-which-lane-they-reach.md — the open upstream tracker, indexed by which lane each defect reaches; read it before diagnosing engine behavior
- docs/solutions/integration-issues/mog-sdk-mutations-that-fail-without-throwing.md — why the read-back rule above has to extend from saves to mutations
