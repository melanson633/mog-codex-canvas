# Mog Canvas as a Claude Code plugin

This repo ships an installable, repo-local Claude Code plugin at
`plugins/mog-canvas/`: an MCP server whose tools open authorized `.xlsx`
files from a confined workbook root, render them in the **real**
`@mog-sdk/spreadsheet-app` canvas through an MCP Apps (SEP-1865) UI
resource, and save edits back to disk with revision checks, automatic
backups, and headless validation.

Claude Code is the host this is built for and used in. The same package
also carries Codex manifests — that path started first and still ships,
but it has not cleared the same gate; see [Codex, secondary](#codex-secondary).

Everything below separates evidence produced by a **named command in this
repo** from what was **observed in use** in the Claude Code desktop app.
Both are real; they are not the same kind of claim.

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
- Plugin package, 6/6 checks (`npm run check:plugin`) — the manifests match
  what both hosts ingest, and the launcher boots the server from an
  unrelated working directory. `claude plugin validate` passes on both the
  plugin directory and the marketplace root.

## What is verified in the host

The Claude Code host gate — the canvas rendering as an MCP App, a real
edit, and that edit reaching disk — **has passed** in the Claude Code
desktop app on this machine. That is the gate the numbered
[host test procedure](#host-test-procedure) describes, and it is the
standard this repo means by "works in the host."

This is observational evidence from ordinary use, not a harness run: no
command in this repo can assert it, because the rendering decision belongs
to the host. Re-run the numbered procedure after any change to the UI
bundle or the resource metadata rather than assuming it still holds.

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

## Install (user-run step)

These commands change Claude Code's user-level configuration, so they are
left for you to run. Substitute `<path-to-checkout>` with the absolute path
to your own clone of this repo — the directory holding this `docs/` folder.

```bash
claude plugin marketplace add "<path-to-checkout>"
```

The checkout root is the marketplace root: Claude Code discovers
`.claude-plugin/marketplace.json` there, and the entry's
`./plugins/mog-canvas` source path resolves against it. Then:

```bash
claude plugin install mog-canvas@mog-claude-canvas
```

`mog-claude-canvas` is the marketplace name declared in the manifest.

### Registering the server directly instead

The plugin route is the supported one — Claude Code interpolates
`${CLAUDE_PLUGIN_ROOT}` in plugin `.mcp.json` args, so the declared server
command resolves without help. If you would rather skip the marketplace
and register only the MCP server, the launcher is self-locating:

```bash
claude mcp add mog-canvas -- node "<path-to-checkout>/plugins/mog-canvas/bin/mcp-launch.mjs"
```

That gets you the tools but not the plugin's app declaration. Either way
the server confines itself to `<repo>\workbooks` (override with
`MOG_WORKBOOK_DIR`) and serves the built UI from
`plugins/mog-canvas/ui/dist` (override with `MOG_UI_DIST`).

## Host test procedure

Run these inside a Claude Code session after installing. This is the
procedure whose step 4 the [host gate](#what-is-verified-in-the-host)
refers to — re-run it to reconfirm after changes:

1. `claude mcp list` — `mog-canvas` should be listed and connected.
2. Ask Claude to call `list_workbooks` — expect `sample.xlsx` (or your own
   files) from the workbook root, and nothing outside it.
3. Ask Claude to call `open_workbook` with `{"name": "sample.xlsx"}` —
   the tool result carries a session id and references the
   `ui://mog-canvas/canvas.html` resource.
4. **Rendering gate:** the host displays that resource as an MCP App
   iframe. Edit a cell, press Save, then confirm on disk (the file's mtime
   changes and a `.xlsx.bak` appears next to it), and call
   `validate_workbook` for a headless read-back.
5. If a host build ever stops rendering MCP Apps, the tool surface still
   works (open/save/validate/screenshot are all host-independent); only the
   embedded canvas view is affected.

Report results against these numbered steps — "works in Claude Code" means
step 4 passed, nothing less.

## Rollback

```bash
claude plugin uninstall mog-canvas@mog-claude-canvas
claude plugin marketplace remove mog-claude-canvas
```

If you used the `claude mcp add` route:

```bash
claude mcp remove mog-canvas
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

## Codex, secondary

This started as a Codex side-panel concept, and the package still carries
what Codex ingests, so the path is kept rather than deleted. It is not the
path this repo is documented or tested against, and it has never cleared
step 4.

The package serves both hosts from one directory:

| | Claude Code | Codex |
| --- | --- | --- |
| Plugin manifest | `plugins/mog-canvas/.claude-plugin/plugin.json` | the same file |
| Marketplace | `.claude-plugin/marketplace.json` (`mog-claude-canvas`) | `.agents/plugins/marketplace.json` (`mog-codex-canvas`) |
| Manifest extras | `interface` and `apps` are ignored at load time | `interface` and `apps` are the ingestion contract |

Codex install, if you want to try it:

```bash
codex plugin marketplace add "<path-to-checkout>"
codex plugin add mog-canvas@mog-codex-canvas
```

Two Codex-side gaps stand between that and a working canvas, both upstream
and neither worked around here:

- **MCP Apps rendering** is under development
  ([openai/codex#21019](https://github.com/openai/codex/issues/21019),
  `enable_mcp_apps`). Until it ships, the tools work but the canvas does
  not appear.
- **`${CLAUDE_PLUGIN_ROOT}` is not interpolated** in Codex plugin
  `.mcp.json` handling
  ([openai/codex#19582](https://github.com/openai/codex/issues/19582)), so
  the plugin-declared server command may pass the placeholder through
  literally. The workaround is registering the server by absolute path:
  `codex mcp add mog-canvas -- node "<path-to-checkout>/plugins/mog-canvas/bin/mcp-launch.mjs"`.

Rollback mirrors the Claude Code commands with `codex` and
`mog-codex-canvas`. The plugin package checks cover the Codex manifest
shapes against what Codex 0.144.0 ingests, so the path stays honest while
it is unproven — but nothing has been seen rendering inside the Codex host,
and this repo makes no claim that it does.

## Known limitations

- **Host controls placement.** Where the canvas panel appears is the host's
  decision; nothing here can promise a permanent side panel.
- **`list_workbooks` discloses the workbook root's absolute path** in its
  result (matching the dev app's `/api/config`). Acceptable for a local,
  single-user setup; rework it before any multi-user exposure.
- **The canvas Screenshot button captures `A1:H30`** of the active sheet.
  The model-facing `screenshot_workbook` tool accepts an optional range and
  uses `A1:H30` only as its default.
