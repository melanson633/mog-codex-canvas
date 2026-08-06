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

- SDK objects are **proxy-backed**: `Object.getOwnPropertyNames(prototype)` returns only `constructor`. Discover the API by calling `api.search` (plain-language query, the strongest of the three) or `api.describe('ws.<name>')`, or by reading the contracts `.d.ts` — three separate guessed names (`wb.sheets.get`, `ws.structure.setColumnWidth`, a `workbook_metadata` tool) were all wrong; the real ones were `wb.activeSheet`, `ws.layout.setColumnWidth('F', 380)`, and the 9 names registered in source. The verified surface, the `ws.`/`wb.` path grammar that fails silently, and the limits of `guidance.preflight` are in [docs/API-EVIDENCE.md](../../API-EVIDENCE.md); `npm run check:sdk-surface` re-verifies it against the installed version.
- `wb.getOrCreateSheet(name)` returns `Promise<{ sheet, created }>`, not a sheet.
- `captureScreenshot(sheet, range, opts): Promise<Uint8Array>` lives in the contracts `_types` tree and requires an actor ref — use `kind: 'user'` (privileged kinds need a host authority adapter).

## Verifying a canvas-painted UI

The grid is painted on `<canvas>` — cell text never reaches the DOM, so DOM-text assertions pass on meaningless chrome strings ("Home Insert Formulas"). The patterns that actually prove something:

- Assert on the **formula bar `<input>`** — the only DOM-observable proof the workbook's data reached the UI.
- Navigate cells by **keyboard** (Ctrl+Home + arrows), not pixel coordinates — pixel math against a canvas grid goes off-by-one-row at the slightest layout change.
- Verify saves by **reading a pre-captured, guaranteed-different value back from disk** with the headless engine, so a silently failing save can't pass.
- For browser automation on this host, self-spawned headless Chrome driven over raw CDP (`--headless=new`, throwaway profile, fixed debug port) proved reliable where `browser-use` (interactive CDP approval) and `agent-browser` (silent hang) both failed.

## Triaging an upstream defect: ask which lane it reaches

Upstream bug reports arrive undifferentiated, and most of them cannot touch this
project at all. The question that sorts them is not "is this bug real" but
**which of the three lanes does it reach** — canvas (browser/wasm32), headless
(`@mog-sdk/sdk` Node-side), or byte-first (`server/workbook-*.ts`, which reads
OOXML directly and never loads the engine). Four verdicts:

| Verdict | Meaning | What to do |
| --- | --- | --- |
| **LIVE** | Reaches a lane this project actually uses, today | Needs a local mitigation or a documented limitation |
| **LATENT** | Reaches an API this project could plausibly adopt | Note it; re-check before adopting that API |
| **GATES** | Reaches us, but an existing check already refuses it | Cite the gate; add a regression test if there isn't one |
| **N/A** | Wrong platform, wrong lane, or a surface we never call | Ignore, and record why so nobody re-triages it |

Byte-first is the lane that makes most upstream defects `N/A`, and that is the
point of it: a bug in the engine cannot corrupt a path that never loads the
engine.

**Do not mirror the upstream bug list into this repo.** It goes stale silently,
and a stale catalog is worse than none — it reads as current. Query it instead:

```bash
gh issue list --repo fundamental-research-labs/mog --state open
```

Only defects that earn a **LIVE** or **GATES** verdict deserve a durable
write-up here, and that write-up should be about *our* mitigation, not about
theirs — see the `#337` entry in
[mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md](mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md)
for the shape.

## Related Issues

- docs/solutions/runtime-errors/wasm-bindgen-ignores-wasm-base-url.md
- docs/solutions/integration-issues/mcp-apps-sandboxed-iframe-wasm-csp-and-storage.md
