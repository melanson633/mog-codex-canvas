# Mog Codex Live XLSX

A **live, editable Mog spreadsheet canvas** over real `.xlsx` files on disk,
in two forms that share one workbook service and one security policy:

1. **A Codex plugin** (`plugins/mog-canvas/`) — an MCP server plus an MCP
   Apps UI resource that renders the canvas inside a host-controlled
   sandboxed iframe. Installation and status: see
   [`docs/CODEX-PLUGIN.md`](docs/CODEX-PLUGIN.md).
2. **A standalone dev companion app** — a Vite dev server you park in a
   narrow browser window beside Codex.

The canvas is the real thing in both: `@mog-sdk/spreadsheet-app`, the same
engine and UI Mog ships everywhere else. No mock grid.

## Run it

Requires **Node 22.18.0 or newer** (on the 23.x line, 23.6.0+). The server entry
and its tests are TypeScript run directly by Node, which needs a release where
type stripping is on without a flag — that landed in 22.18.0 and 23.6.0, so
23.0–23.5 will not work. `npm test` also passes glob patterns to `node --test`,
which needs 21.0.0+; the stripping requirement is the binding one.

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
| `npm test` | 65 unit tests, no server: path containment, crash-safe writes, bridge endpoints, agent lane |
| `npm run verify` | 25 checks, no browser: engine round-trip + asset routing + file bridge + adapter resolution |
| `npm run smoke` | 9 checks in a headless browser: does the canvas mount, render, and save to disk |
| `npm run build:mcp-app` | Production build of the MCP Apps canvas component (deterministic; no dev server at runtime) |
| `npm run mcp` | The Mog Canvas MCP server over stdio |
| `npm run check:mcp` | 13 MCP protocol checks: tools, ui resource + CSP metadata, containment, stale saves |
| `npm run check:app` | 11 in-iframe checks: real canvas under a sandboxed iframe + MCP Apps host, edit/save/screenshot |
| `npm run check:plugin` | 5 plugin package checks: manifests match Codex's ingestion schema, launcher boots the server |
| `npm run typecheck` | `tsc --noEmit` |

`npm run smoke` needs `npm run dev` already running in another shell. It drives
Chrome if installed — per-machine or per-user (`%LOCALAPPDATA%`) — and falls
back to Edge, always in a throwaway profile, so your browser and sessions are
untouched.

It runs at a fixed **520x900** viewport — the narrow side-panel shape this app is
built for — and that size is load-bearing: the edit check clicks the grid at a
fixed pixel offset, and `workbooks/browser-smoke.png` is a capture of that
viewport only, not of the whole sheet. Wider layouts are not covered.

The dev app itself has no `build` script — its WASM routing
(`server/mog-assets.ts`) and file bridge (`server/file-bridge.ts`) are
dev-server middleware. The production build belongs to the MCP lane:
`npm run build:mcp-app` bundles the canvas component, and the MCP server's
own loopback asset host serves it plus the engine's WASM and fonts — no
Vite process at runtime.

## What works

Verified end-to-end on this machine, not asserted:

- **Open** — pick any `.xlsx` in the workbook root; bytes are read over the bridge
  and handed to the canvas.
- **Edit** — full Mog UI: ribbon, formula bar, formula compute, multi-sheet tabs.
- **Save to disk** — `Save` funnels the canvas's `onSaveRequest` bytes through the
  host to `PUT /api/workbook`. The previous file is kept as `<name>.xlsx.bak`, and
  empty writes are refused. Bytes are staged beside the target and promoted with
  a single rename, so an interrupted save never leaves a truncated or missing
  workbook — a crash costs only an orphan `.staged` file. Saves are last-write-
  wins and not serialized across lanes: if the canvas and the agent lane write
  the same workbook at the same instant, one of them is told the save failed
  rather than the two being interleaved.
- **Verify** — `POST /api/validate` re-opens the *saved file* with the headless
  engine and shows its `summarize()` output. This is a read-back of disk, not of
  the canvas's memory.
- **Screenshot** — `captureScreenshot` of a **fixed `A1:H30`** on the active
  sheet, written next to the workbook. It is rendered by the engine, so it is
  not limited by the window size or the scroll position — but it is also not
  "what you see": anything outside `A1:H30` is not in the file. Widening it is a
  one-line change in `src/App.tsx`.
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

That fallback only holds if nothing Mog-specific is imported before it runs, so
the two `@mog-sdk` dependencies are used in deliberately different places:

- **`@mog-sdk/spreadsheet-app`** — the browser dependency, reached only through
  the adapter. `resolveCanvasAdapter()` imports the module *and* its stylesheet
  in the same guarded path (neither from `src/main.tsx`), so a missing package
  or a renamed `./styles.css` export returns the fallback before any canvas
  opens, instead of blanking the page or throwing mid-open. `npm run verify`
  asserts the entry module still pulls in no `@mog-sdk` code, and faults each
  import in turn — through `resolveCanvasAdapter(imports)` — to prove the
  fallback.
- **`@mog-sdk/sdk`** — the headless engine, Node side only; it never reaches the
  browser bundle. Used by the file bridge for `Verify` and by the scripts in
  `scripts/`. The TypeScript bridge imports `@mog-sdk/sdk/node`, because under
  `bundler` resolution the bare specifier is typed as the browser WASM build,
  whose `createWorkbook` takes bytes rather than a path; the `.mjs` scripts
  import it bare, which Node's own export conditions resolve to that same native
  build.

## Codex integration

The Codex integration is the plugin in `plugins/mog-canvas/`:

- **An MCP server** (`server/mcp/`) exposing the workbook tools —
  list/open/fetch-bytes/save/validate/screenshot/close — confined to the
  workbook root, with revision-conflict protection on every save.
- **An MCP Apps UI resource** (`ui://mog-canvas/canvas.html`) whose bundle
  mounts the real Mog canvas inside the host's sandboxed iframe. Workbook
  bytes travel only through MCP tools; the engine's WASM and fonts come
  from a loopback-only asset host the server owns.
- **A plugin package + repo marketplace manifest** so Codex can install it
  from this checkout with its supported plugin mechanism.

What has and has not been proven, the install commands, the host test
procedure, rollback, and the current Codex host gaps (MCP Apps rendering,
`${CLAUDE_PLUGIN_ROOT}` interpolation) are all in
[`docs/CODEX-PLUGIN.md`](docs/CODEX-PLUGIN.md). Until the plugin is
installed and the canvas is seen rendering inside Codex, no such claim is
made here.

Historical API evidence, including the exact published embed surface:
[`docs/API-EVIDENCE.md`](docs/API-EVIDENCE.md).

## Recommended workflow

Two lanes over one file. Pick per task, don't fight over it:

1. **Human lane — live canvas.** For structural or judgement work: laying out a
   schedule, eyeballing a variance, fixing a formula you need to *see*. Use the
   canvas (dev app or, once host support lands, the plugin's panel) and hit
   `Save` when done.
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
server/workbook-service.ts  shared workbook policy: containment, revisions, backups
server/file-bridge.ts   dev-app disk access: /api/config|workbook|validate|screenshot
server/mog-assets.ts    serves the embed's WASM + fonts from node_modules (dev)
server/mcp/       the MCP server: tools, ui:// resource, loopback asset host
plugins/mog-canvas/     the installable Codex plugin: manifests, launcher, ui dist
.agents/plugins/marketplace.json  repo marketplace Codex installs from
scripts/          harnesses: headless / verify / smoke / check:mcp|app|plugin
workbooks/        the sandbox — the only readable/writable directory
docs/CODEX-PLUGIN.md    plugin install, host test procedure, rollback, limitations
docs/API-EVIDENCE.md    what was verified, and where the API actually stops
```
