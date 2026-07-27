---
title: Compare page opened via file:// renders blank iframes
date: 2026-07-26
category: ui-bugs
module: dev-app
problem_type: ui_bug
component: development_workflow
symptoms:
  - "compare.html shows two empty white panes with no canvas, picker, or error text"
  - "Browser tab whose origin is file:// refuses navigation to http://127.0.0.1 (blocked by policy)"
root_cause: config_error
resolution_type: workflow_improvement
severity: low
tags: [compare-view, iframe, file-origin, vite, dev-server]
---

# Compare page opened via file:// renders blank iframes

## Problem

`compare.html` (the split-screen workbook view) appeared completely blank — two empty white panes — when the file was opened directly from disk instead of through the Vite dev server.

Nobody typed the `file://` path. A PostToolUse hook auto-opened the just-edited `compare.html` as a `file://` browser tab (it did this twice, creating two such tabs), while the user's own URL was the correct `http://127.0.0.1:5273` one. The blank screenshots came from the hook-created tabs. A second, independent confound was active at the same time: the dev server had died again, so even correct-origin tabs failed until it was restarted.

## Symptoms

- The page loads and the layout renders, but both iframes stay empty; no picker, status, or error is visible.
- The same URL query works perfectly when served from `http://127.0.0.1:5273/compare.html?...`.
- A browser tab that started on a `file://` origin may also refuse later navigation to `http://127.0.0.1:5273` entirely.

## What Didn't Work

- Re-navigating the `file://` tab to the dev-server URL — the tab kept rejecting `http://127.0.0.1` navigation ("blocked by policy"). Closing the tab and using a tab that started on the dev-server origin worked.
- Debugging the page contents before checking the server: some of the "navigation denied or failed" symptoms were the dead dev server, not the origin. `preview_list` returning empty (or a failing in-page `fetch`) distinguishes the two in seconds.

## Solution

Always load `compare.html` through the dev server, never from disk:

```
http://127.0.0.1:5273/compare.html?left=<file>&right=<file>
```

If a tab is stuck on a `file://` origin, close it and open the URL in a tab whose origin is already the dev server.

## Why This Works

The compare page is a shell of iframes pointing at `/?wb=<name>` — server-relative URLs. From a `file://` origin those resolve against the filesystem and the browser blocks the mixed `file://`→`http://` iframe loads, so the panes stay empty with no visible error. Served over HTTP, the iframes resolve against the same origin as the dev server and load the app normally.

Serving over HTTP is necessary but not sufficient: the dev server works because `server/mog-assets.ts` also answers the Mog engine's WASM at both URL shapes it requests. Any alternative host (a static build, a different server) will silently regress unless it replicates those routes — see the wasm-bindgen doc below.

## Prevention

- Treat any blank-but-loaded page in the browser pane as an origin question first: check whether the tab's origin is `file://` before debugging the app — and check the dev server is actually up (`preview_list` / a quick fetch) before blaming the origin.
- Expect editor/tooling hooks to auto-open edited HTML as `file://` tabs; close them rather than re-navigating them.
- Keep the dev-server URL (with port) in the docs next to any HTML entry points that depend on server-relative paths.

## Related Issues

- docs/solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md
- docs/solutions/runtime-errors/wasm-bindgen-ignores-wasm-base-url.md — why the dev server, specifically, is required
