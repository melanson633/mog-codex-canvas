# Mog Codex Live XLSX

A standalone localhost app that runs a **live, editable Mog spreadsheet canvas**
over a real `.xlsx` file on disk. It is sized for a narrow window you park beside
the Codex desktop app.

It is **not** embedded in Codex, and it cannot be — see
[Codex integration limitation](#codex-integration-limitation).

The canvas is the real thing: `@mog-sdk/spreadsheet-app`, the same engine and UI
as the Mog VS Code/Cursor extension. No mock grid.

## Run it

```bash
npm install
npm run dev            # http://127.0.0.1:5273
```

Then snap the browser window next to Codex. Workbooks come from `workbooks/`
(override with `MOG_WORKBOOK_DIR`); that directory is the only place the app can
read or write.

If `workbooks/` is empty, create a sample first:

```bash
npm run headless       # writes workbooks/sample.xlsx + sample.headless.png
```

First load pulls a ~41 MB WASM compute core, so give it a few seconds. Later
loads are cached.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server: the canvas, the file bridge, the Mog runtime assets |
| `npm run headless` | Headless SDK lane — edit, save, re-open, validate, screenshot |
| `npm run verify` | 12 checks, no browser: engine round-trip + asset routing + file bridge |
| `npm run smoke` | 9 checks in headless Chrome: does the canvas mount, render, and save to disk |
| `npm run typecheck` | `tsc --noEmit` |

`npm run smoke` needs `npm run dev` already running in another shell. It uses its
own throwaway Chrome profile, so your browser and sessions are untouched.

There is deliberately **no `build` script**. The app is a dev-server companion:
the WASM routing that makes the canvas work (`server/mog-assets.ts`) and the file
bridge (`server/file-bridge.ts`) are both dev-server middleware. A static bundle
would need a separate host process, which nothing here has been verified against.

## What works

Verified end-to-end on this machine, not asserted:

- **Open** — pick any `.xlsx` in the workbook root; bytes are read over the bridge
  and handed to the canvas.
- **Edit** — full Mog UI: ribbon, formula bar, formula compute, multi-sheet tabs.
- **Save to disk** — `Save` funnels the canvas's `onSaveRequest` bytes through the
  host to `PUT /api/workbook`. The previous file is kept as `<name>.xlsx.bak`, and
  empty writes are refused.
- **Verify** — `POST /api/validate` re-opens the *saved file* with the headless
  engine and shows its `summarize()` output. This is a read-back of disk, not of
  the canvas's memory.
- **Screenshot** — `captureScreenshot` of a range, written next to the workbook.
- **Path containment** — the bridge rejects absolute paths and anything that
  resolves outside the workbook root (400).

The `npm run smoke` run that backs the "edit" and "save" claims clicks into the
grid, types a value with real key events, presses the host's `Save`, and then
re-opens the file with the headless engine to confirm the typed value is on disk.

### Adapter boundary

The React shell never imports `@mog-sdk/*`. It talks to `src/adapters/types.ts`:

```
CanvasAdapter.probe            -> capabilities {liveCanvas, edit, saveToDisk, screenshot}
CanvasAdapter.open(el, req, host) -> CanvasSession {save, exportXlsx, screenshot, dispose}
HostServices                   -> {persist, onDirtyChange, onStatus, onError}
```

`resolveCanvasAdapter()` actually imports `@mog-sdk/spreadsheet-app` and checks
its exports at runtime. If that ever fails, `unavailable-adapter.ts` renders the
real reason and every session method throws — it does **not** draw a fake grid.
The badge in the header tells you which adapter you got.

## Codex integration limitation

**There is no public extension/panel/webview host API for the Codex desktop app.**
Nothing here renders inside Codex, and no amount of work on this project would
change that.

The Mog↔Codex integration that does exist runs the other direction: `plugins/mog`
in the Mog repo exposes Mog *to* Codex as MCP tools. That is Codex driving Mog,
not Codex hosting a Mog panel.

So: this is a separate window next to Codex. Window management is the OS's job.
Codex and this app share exactly one thing — **the file on disk**. That is why
`Verify` re-reads from disk and why every save keeps a `.bak`.

Full evidence, including the exact published API surface and the undocumented
friction: [`docs/API-EVIDENCE.md`](docs/API-EVIDENCE.md).

## Recommended workflow

Two lanes over one file. Pick per task, don't fight over it:

1. **Human lane — live canvas.** For structural or judgement work: laying out a
   schedule, eyeballing a variance, fixing a formula you need to *see*. Use this
   app, or the Mog extension in Cursor/VS Code if you want the editor's own
   panel. Hit `Save` when done.
2. **Agent lane — headless SDK.** For repeatable or bulk work: Codex/Claude edits
   the workbook through `@mog-sdk/sdk` (see `scripts/headless-edit.mjs`), then
   *validates* with `summarize()` and *screenshots* the range it touched. The
   screenshot is what makes an agent edit reviewable without opening the file.

The handoff rule: **save before switching lanes.** Nothing merges concurrent
edits — the last writer wins, and the loser's work is in `.bak`. After an agent
edit, reload in the canvas (re-pick the file) to pull the new bytes.

This split is enforced in policy, not just convention: the canvas runs with
`editModel: { user: 'write', agents: 'none', automation: 'none' }`. Humans edit in
the canvas; agents edit headlessly.

## Layout

```
src/adapters/     adapter boundary + real embed adapter + honest fallback
src/App.tsx       the shell: picker, save/verify/screenshot, status, canvas host
server/file-bridge.ts   the only disk access: /api/config|workbook|validate|screenshot
server/mog-assets.ts    serves the embed's WASM + fonts from node_modules
scripts/          headless-edit / verify / browser-smoke
workbooks/        the sandbox — the only readable/writable directory
docs/API-EVIDENCE.md    what was verified, and where the API actually stops
```
