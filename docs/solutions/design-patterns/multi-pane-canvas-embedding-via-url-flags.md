---
title: Multi-pane canvas embedding via URL flags instead of a new app
date: 2026-07-26
category: design-patterns
module: dev-app
problem_type: design_pattern
component: tooling
severity: low
applies_when:
  - "Two or more workbooks need to be visible at once (progression demos, before/after comparison)"
  - "An embedded app's chrome consumes most of a small pane's height"
tags: [compare-view, compact-mode, iframe, url-parameters, embedding]
---

# Multi-pane canvas embedding via URL flags instead of a new app

## Context

The dev app showed one workbook at a time; showing a progression (original → reply → styled) meant flipping browser tabs. Building a dedicated multi-workbook app would duplicate the canvas wiring, save path, and revision protection that the single-workbook app already gets right.

## Guidance

Compose the existing app instead of forking it. Three small pieces (shipped in [melanson633/mog-codex-canvas#2](https://github.com/melanson633/mog-codex-canvas/pull/2)):

1. **`?wb=<name>`** — pins the app's initial workbook. Validated against the served file list; unknown names fall back to the default ([App.tsx:31-33](../../../src/App.tsx)).
2. **`?compact=1`** — slims chrome for small panes: one-row header, a footer reduced to its decorative children, and the embed's ribbon and status bar hidden by CSS ([styles.css](../../../src/styles.css), `.app.compact` rules). The formula bar and sheet tabs stay so it still reads as a spreadsheet. The footer hides the workbook-root path and collapses entirely via `:has()` when empty, but the adapter-failure warning is exempt and still renders — an earlier version hid the whole footer and suppressed that warning ([compact-mode-hid-adapter-failure-warning.md](../ui-bugs/compact-mode-hid-adapter-failure-warning.md)).
3. **`compare.html`** — a static shell of 2-3 iframes, each loading `/?compact=1&wb=<file>`; `left`/`mid`/`right` params pick the files, `layout=vertical` stacks them. (The `mid` param and a min-2-panes fallback were a second iteration, added when 3-up vertical was requested — leave room for N panes in the param scheme up front.)

Because every pane is the full app, each keeps its own Save/Verify/Screenshot and per-file revision protection — a save in one pane cannot silently clobber another writer; a concurrent writer gets a revision conflict instead. This protection-for-free is the actual reason composition beat forking. Note the cost model: each pane is a full engine runtime (~41 MB WASM), so panes are for comparison at human scale (2-3), not dashboards.

## Why This Matters

Measured on a 302px-tall pane, the visible grid went from 0px (all chrome) to ~213px (~70%) with `compact=1` — the difference between a decorative stripe and a usable spreadsheet. And there is exactly one app to maintain: the compare surface is ~50 lines of static HTML.

## When to Apply

- Any time a second simultaneous view of an existing single-instance app is wanted: prefer URL-flag composition in iframes over a second app.
- Chrome-hiding CSS that reaches into a third-party embed's DOM (the ribbon/status-bar selectors) is version-fragile — keep those selectors few, structural (`:first-child`/`:last-child` of the embed scope), and verify after SDK upgrades.
- A density flag means "show less chrome," never "show fewer failures." Hide the decorative *children* of a container, not the container, whenever it can host error, warning, or degradation output — a small pane is where a degraded canvas is hardest to spot by eye. See [compact-mode-hid-adapter-failure-warning.md](../ui-bugs/compact-mode-hid-adapter-failure-warning.md) for the rule and the check to run.

## Examples

```
/compare.html?left=step1.xlsx&right=step3.xlsx            # side by side
/compare.html?left=a.xlsx&mid=b.xlsx&right=c.xlsx&layout=vertical  # 3-up stacked
```

## Related

- [file-origin-compare-page-blank-iframes.md](../ui-bugs/file-origin-compare-page-blank-iframes.md) — the page must be served by the dev server, not opened as `file://`.
- [compact-mode-hid-adapter-failure-warning.md](../ui-bugs/compact-mode-hid-adapter-failure-warning.md) — the compact footer rules were rewritten so diagnostics survive the density mode this pattern introduced.
