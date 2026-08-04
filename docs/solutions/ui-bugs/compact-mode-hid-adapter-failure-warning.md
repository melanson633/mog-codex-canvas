---
title: Compact mode hid the only adapter-failure warning
date: 2026-08-04
category: ui-bugs
module: dev-app
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "In ?compact=1 panes the adapter-failure warning never appeared, even when the probe reported unavailable"
  - "Save and Screenshot render disabled in compact mode with no on-screen explanation"
  - "A degraded/stub canvas is visually indistinguishable from the real one in a narrow pane"
  - "The same failure shows its warning correctly in the full-width (non-compact) app"
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags: [compact-mode, css, error-visibility, diagnostics, has-selector, side-panel, compare-view, adapter-fallback]
---

# Compact mode hid the only adapter-failure warning

## Problem

The dev app's compact display mode (`?compact=1`) hid the entire footer with `.app.compact .foot { display: none; }`. That footer is the only place the adapter-failure warning renders, so compact mode silently suppressed the sole user-visible signal that the real `@mog-sdk/spreadsheet-app` canvas failed to resolve and a degraded adapter was in use.

Blast radius is wider than the flag suggests: `compare.html` hardcodes the flag on every pane it creates ([compare.html:46](../../../compare.html)), so this affected all compare-view panes by default, not just people who typed `?compact=1` themselves.

## Symptoms

- **Save** and **Screenshot** render disabled with no explanation anywhere on screen. `src/App.tsx:141` derives the gate — `const canEdit = probe?.capabilities.liveCanvas ?? false;` — and both buttons are gated on it at `src/App.tsx:166` and `src/App.tsx:172`. **Verify** stays enabled (gated on `!file` at `src/App.tsx:169`), so the toolbar looks partly working rather than obviously broken.
- The adapter badge that would otherwise flag the failure is *also* hidden in compact mode by `.app.compact .meta .badge { display: none; }` ([styles.css:201-203](../../../src/styles.css)) — so no fallback signal survives.
- A stub canvas in a pane a few hundred pixels tall looks like a real canvas. Compact mode is exactly the context where degradation is hardest to spot by eye: the mode that most needed the warning was the one that removed it.

The warning has exactly one render site, `src/App.tsx:204-207`:

```tsx
<footer className="foot">
  <span>{config ? config.root : '…'}</span>
  {probe && !probe.available && <span className="warn-text">{probe.detail}</span>}
</footer>
```

Two children: the workbook-root path (decorative in a narrow pane) and the conditional warning (never decorative).

## What Didn't Work

**Running the app would not have surfaced this.** In the full-window view the warning renders correctly; in the compact view during development the adapter resolved successfully, so there was nothing for the rule to hide. The bug lives only in the intersection of two states that rarely co-occur in dev — compact mode **and** a degraded dependency — and neither state alone reproduces it. It was found instead by reading the compact-mode CSS against the JSX that populates the elements it targets.

**It was already written down before it was fixed.** The `docs/ideation/2026-07-26-mog-canvas-uses-and-design-ideation.html` artifact carries it as a `Live defect, not a proposal` callout attached to idea #6, naming both the rule and its consequence and noting it needed no ideation. It then sat unfixed across several sessions. A defect recorded inside a ranked-ideas document does not get scheduled by being written down — ideation artifacts are read for direction, not worked as a queue. Findings that are already actionable should leave the ideation artifact for an issue or a branch the same day they are found.

**The hide was incidental, not a considered trade-off (session history).** Compact mode was built in one burst as a pane-space optimization after a 3-up vertical stack left effectively no visible grid. The footer was understood at the time as one thing — a containment-path bar — and the result summary recorded it as "the footer path bar is gone." Nothing in the record weighs what else could render there. This is the signature of the bug class: a container gets a name from its most common content, and then gets hidden by that name.

**The compounding pass that should have caught it was itself degraded (session history).** `/ce-compound` ran in lightweight mode right after compact mode shipped, under context pressure, and was later described in-session as not safely completed — the resulting docs were drafted from a compaction summary rather than full evidence. That is how [multi-pane-canvas-embedding-via-url-flags.md](../design-patterns/multi-pane-canvas-embedding-via-url-flags.md) came to describe compact mode as simply "no footer," which then reads as spec to the next contributor.

## Solution

Before (`src/styles.css`, compact-mode block):

```css
.app.compact .foot {
  display: none;
}
```

After ([styles.css:205-213](../../../src/styles.css)):

```css
/* Compact mode drops the workbook-root path, but never the adapter-failure
   warning — a small pane is where a stub canvas is hardest to notice. */
.app.compact .foot > span:not(.warn-text) {
  display: none;
}

.app.compact .foot:not(:has(.warn-text)) {
  display: none;
}
```

Two rules, not one. The naive one-rule fix (hide the non-warning children only) leaves an empty but still-painted strip at the bottom of every pane in the common no-warning case, because `.foot` carries its own box — `padding: 5px 8px` plus `border-top` means a childless flex column still consumes ~11px and draws a divider ([styles.css:165-174](../../../src/styles.css)). The second rule uses `:has()` to collapse the footer only when it hosts no `.warn-text`, preserving the original space saving.

That saving is a measured budget worth protecting: compact mode took the visible grid from 0px to ~213px of each 302px pane in a 3-up vertical stack. Pin the viewport when regression-checking it — the pane height was observed changing under the user mid-session, so a live pane is not a stable measuring stick.

**Merge state:** committed on `claude/canvas-ideation-side-panel-6747b1` as of this writing. Not yet merged to `main`.

## Why This Works

The fix separates the **container** from its **content**. The old rule expressed "hide the footer," a claim about a box; the intent was "hide the workbook-root path," a claim about one child. Targeting `> span:not(.warn-text)` states the real intent, so anything later added to the footer and marked as a warning surface is exempt by construction. The `:has()` rule then restores the container-level collapse, but conditionally — the box disappears exactly when it has nothing worth showing.

`:has()` is required for the second rule; it is baseline in current Chromium, Safari, and Firefox, and this app is only ever rendered in the Claude Code side panel or a desktop browser. The requirement needs no compatibility work, and the degradation if it were ever unmet is benign: the selector fails to match, the footer stays visible as an empty strip, and no warning is lost. **Both rules fail safe toward showing more, not less** — which is the property to preserve in any future rewrite.

Verified live in both directions on the running dev server (`preview_start` name `mog-dev`, port 5273) via Vite HMR in a compact pane: warning-present rendered the footer with only the warning text; warning-absent collapsed the footer completely. `npm run typecheck` exited 0.

## Prevention

**Rule: never `display: none` a container that hosts error, warning, or degradation output. Target the decorative children instead.** A density mode is a layout intent, not a diagnostics-suppression intent — `compact`, `print`, `minimal`, `embedded`, and `kiosk` variants all mean "show less chrome," and none of them means "show fewer failures."

Check to run when adding or reviewing a density-mode rule:

1. Find the hiding rules in the density block: `rg 'display:\s*none' src/styles.css`.
2. For each match, find every element the selector matches in the JSX: `rg 'className=.*\bfoot\b' src`.
3. Ask whether any child is a **conditional** render. A `{cond && <span/>}` inside a hidden container is the signature of this bug — an element absent most of the time and load-bearing the rest of it.
4. If yes, hide the specific decorative children and add a `:has()` guard so the container still collapses when the conditional child is absent.

Give every error surface a marker class — this codebase already had `.warn-text` ([styles.css:176-178](../../../src/styles.css)) — precisely so `:not()` and `:has()` can exempt it mechanically. A marker class turns "remember not to hide the warning" into something the stylesheet enforces on its own. Apply it to any future diagnostic output (validation failures, offline banners, permission notices) so one convention covers them all.

The project already holds itself to the underlying standard elsewhere: when a computer-use edit silently failed mid-action, the app was judged correct precisely because it left no phantom half-edit and kept its status honest (session history). An honest status that cannot be seen fails that same standard by a different route.

## Related Issues

- [multi-pane-canvas-embedding-via-url-flags.md](../design-patterns/multi-pane-canvas-embedding-via-url-flags.md) — introduced `?compact=1` and the `.app.compact` rules. **Its "no footer" description is now inaccurate** and would reintroduce this bug if followed as spec; it also lists embed-DOM selector fragility as the only chrome-hiding caveat, missing the diagnostics rule above.
- [file-origin-compare-page-blank-iframes.md](./file-origin-compare-page-blank-iframes.md) — sibling failure mode on the same surface: a broken canvas rendering with no visible error. Also relevant to verifying this fix, since the compare page must be served over HTTP rather than opened as `file://`.
- `docs/ideation/2026-07-26-mog-canvas-uses-and-design-ideation.html`, idea #6 ("Chrome is already a declared API; the CSS reach-in should go to zero", 95% confidence) — queued direction to replace compact mode's CSS with the adapter's declared chrome options, and the entry carrying this bug's live-defect callout. **It would not have prevented this bug.** Those booleans (`commandBar`, `fileMenu`, `formulaBar`, `sheetTabs`, `statusBar` at [mog-embed-adapter.ts:116-123](../../../src/adapters/mog-embed-adapter.ts)) govern the *embed's* chrome; the footer is this app's own DOM. Adopting the declared API removes the fragile reach-in at [styles.css:216-218](../../../src/styles.css) and leaves the footer rules exactly as they are here.
- No GitHub issues match; related work is tracked via PRs ([melanson633/mog-codex-canvas#2](https://github.com/melanson633/mog-codex-canvas/pull/2) introduced `?compact=1`).
