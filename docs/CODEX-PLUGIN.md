# Mog Canvas as a Codex plugin

This repo ships an installable, repo-local Codex plugin at
`plugins/mog-canvas/`: an MCP server whose tools open authorized `.xlsx`
files from a confined workbook root, render them in the **real**
`@mog-sdk/spreadsheet-app` canvas through an MCP Apps (SEP-1865) UI
resource, and save edits back to disk with revision checks, automatic
backups, and headless validation.

Everything below separates **verified on this machine** from **not yet
tested in Codex**. Nothing here claims the canvas has rendered inside the
Codex host — see [Known limitations](#known-limitations).

## What is verified locally

Evidence produced by runs in this repo (commands in parentheses):

- MCP protocol surface, 13/13 checks (`npm run check:mcp`) — server boots
  over stdio, serves the `ui://mog-canvas/canvas.html` resource with MCP
  Apps metadata and CSP declarations, full open → edit → save → validate →
  screenshot round-trip, path containment, stale-save refusal.
- In-iframe rendering, 11/11 checks (`npm run check:app`) — the real Mog
  canvas mounts inside a `sandbox="allow-scripts"` iframe under a
  spec-shaped CSP, driven by a reference MCP Apps host: real keyboard edit,
  save to disk (with `.bak` and revision advance), screenshot via tool.
- Plugin package, 5/5 checks (`npm run check:plugin`) — manifest shapes
  match what Codex 0.144.0 ingests, and the launcher boots the server from
  an unrelated working directory. Codex's own bundled plugin validator also
  passes the package.

## Requirements

- This repo checked out with `npm ci` completed (the plugin runs **in
  place** from the checkout; local marketplace installs are not copied).
- The production UI bundle built once: `npm run build:mcp-app`
  (emits `plugins/mog-canvas/ui/dist`; no dev server is involved at
  runtime).
- Node on `PATH` as `node`, at the version the project requires — 22.18.0+,
  or 23.6.0+ on the 23.x line (the server entry is TypeScript run via Node's
  type stripping, which is unflagged only from those releases). This matches
  `engines.node` in `package.json`; see the README for the full rationale.
- Codex CLI 0.144.0 or later.

## Install (user-run step)

These commands change Codex's user-level configuration, so they are left
for you to run. Substitute `<path-to-checkout>` with the absolute path to
your own clone of this repo — the directory holding this `docs/` folder.
Point the commands at the checkout you want Codex to use. From anywhere:

```bash
codex plugin marketplace add "<path-to-checkout>"
```

The checkout root is the marketplace root: Codex discovers
`.agents/plugins/marketplace.json` there, and the entry's
`./plugins/mog-canvas` source path resolves against it. Then:

```bash
codex plugin add mog-canvas@mog-codex-canvas
```

`mog-codex-canvas` is the marketplace name declared in the manifest.

### If the MCP server does not start after install

Codex does not currently interpolate `${CLAUDE_PLUGIN_ROOT}` in plugin
`.mcp.json` args ([openai/codex#19582](https://github.com/openai/codex/issues/19582)),
so the plugin-declared server command may pass the placeholder through
literally. The supported workaround is registering the server directly
with an absolute path — the launcher is self-locating, so this is the only
path it needs:

```bash
codex mcp add mog-canvas -- node "<path-to-checkout>/plugins/mog-canvas/bin/mcp-launch.mjs"
```

Either way the server confines itself to `<repo>\workbooks` (override with
`MOG_WORKBOOK_DIR`) and serves the built UI from
`plugins/mog-canvas/ui/dist` (override with `MOG_UI_DIST`).

## Host test procedure (the part that needs Codex)

Run these inside a Codex session after installing:

1. `codex mcp list` — `mog-canvas` should be listed and connected.
2. Ask Codex to call `list_workbooks` — expect `sample.xlsx` (or your own
   files) from the workbook root, and nothing outside it.
3. Ask Codex to call `open_workbook` with `{"name": "sample.xlsx"}` —
   the tool result carries a session id and references the
   `ui://mog-canvas/canvas.html` resource.
4. **Rendering gate:** whether Codex displays that resource as an MCP App
   iframe is host behavior under active development
   ([openai/codex#21019](https://github.com/openai/codex/issues/21019),
   `enable_mcp_apps`). If the canvas renders: edit a cell, press Save,
   then confirm on disk (the file's mtime changes and a `.xlsx.bak`
   appears next to it), and call `validate_workbook` for a headless
   read-back.
5. If the host does not render MCP Apps yet, the tool surface still works
   (open/save/validate/screenshot are all host-independent); only the
   embedded canvas view is pending host support.

Report results against these numbered steps — "works in Codex" means step
4 passed, nothing less.

## Rollback

```bash
codex plugin remove mog-canvas@mog-codex-canvas
codex plugin marketplace remove mog-codex-canvas
```

If you used the `codex mcp add` workaround:

```bash
codex mcp remove mog-canvas
```

No other state is left behind: the plugin never writes outside the
workbook root, and installs of local marketplaces do not copy files.

## Troubleshooting

- **Server exits immediately** — run the launcher by hand:
  `node plugins\mog-canvas\bin\mcp-launch.mjs` from anywhere. It prints a
  `[mog-canvas] serving workbooks from …` banner to stderr on success.
  A missing `plugins/mog-canvas/ui/dist` means `npm run build:mcp-app`
  has not been run; a module-resolution error means `npm ci` has not.
- **Canvas iframe loads but stays on "mounting canvas"** — the host CSP
  must include `'wasm-unsafe-eval'` in `script-src` and allow
  `worker-src blob:`. The resource metadata declares the needed origins;
  a spec-literal policy without the wasm grant blocks engine startup
  (verified: that exact failure, then success once granted).
  `'unsafe-eval'` is **not** required — the engine's three startup eval
  attempts are caught feature probes.
- **Storage errors in the iframe** — none expected: the component installs
  an in-memory `localStorage`/`sessionStorage` stand-in because sandboxed
  iframes without `allow-same-origin` have an opaque origin.
- **Save fails with `revision-conflict`** — something else wrote the file
  since the canvas loaded it. The save is refused, the disk file is
  untouched, and the attempted bytes are preserved server-side; re-open
  the workbook to continue from the file's current state.
- **A workbook outside the root** — by design. Tools take root-relative
  names only; absolute paths, traversal, junction escapes, and NTFS
  alternate data streams are rejected with structured errors.

## Known limitations

- **Not yet tested inside Codex.** Every claim above is from local
  protocol/browser harnesses. The Codex host test (steps above) has not
  been run, because installing the plugin changes user-level Codex state.
- **Codex may not render MCP Apps yet.** Inline app rendering is under
  development ([openai/codex#21019](https://github.com/openai/codex/issues/21019)).
  Until it ships, the plugin's tools work but the canvas UI does not
  appear inside Codex.
- **`${CLAUDE_PLUGIN_ROOT}` interpolation** is missing in Codex plugin
  `.mcp.json` handling ([openai/codex#19582](https://github.com/openai/codex/issues/19582));
  use the `codex mcp add` fallback above if the plugin-declared server
  fails to spawn.
- **Host controls placement.** Where (and whether) the canvas panel
  appears is the Codex host's decision; nothing here can promise a
  permanent side panel, and this plugin does not replace Codex's native
  XLSX preview.
- **`list_workbooks` discloses the workbook root's absolute path** in its
  result (matching the dev app's `/api/config`). Acceptable for a local,
  single-user setup; rework it before any multi-user exposure.
- **The canvas Screenshot button captures `A1:H30`** of the active sheet.
  The model-facing `screenshot_workbook` tool accepts an optional range and
  uses `A1:H30` only as its default.
