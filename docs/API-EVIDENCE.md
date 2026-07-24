# Mog embedding: what exists, what doesn't

Everything below was verified on this machine on 2026-07-24. Nothing here is
inferred from documentation alone.

## The reference clone was not available

The brief pointed at `C:/Users/MarkMelanson/Documents/mog` (read-only reference,
specifically `integrations/vscode/mog-xlsx-editor` and `@mog-sdk/node`). That
path **does not exist on this machine** — confirmed with both the Bash and
PowerShell tools; the only `mog`-named directory under `Documents` is this
project. So the reference material came from sources that do exist:

| Source | What it gave |
| --- | --- |
| `…\npm\node_modules\shortcutxl\node_modules\@mog-sdk\` | Installed `contracts`, `sdk`, `wasm`, `win32-x64-msvc` @ 0.10.4 |
| GitHub `fundamental-research-labs/mog` @ `main` (public, pushed 2026-07-15) | `integrations/vscode/mog-xlsx-editor` source — the reference embedding |
| npm registry | Published versions and package metadata |
| VS Code Marketplace | `FundamentalResearchLabs.mog-xlsx-editor` v0.10.4, updated 2026-07-08 |

## Package status

| Package | Version | Notes |
| --- | --- | --- |
| `@mog-sdk/sdk` | 0.10.5 | Headless engine, native Node + WASM bindings |
| `@mog-sdk/spreadsheet-app` | 0.10.5 | **The embeddable canvas.** "Policy-driven full Mog spreadsheet app embed for trusted same-origin hosts" |
| `@mog-sdk/contracts` | 0.10.5 | Types/contracts only |
| `@mog-sdk/wasm` | 0.10.5 | Compute core WASM build |
| `@mog-sdk/node` | 0.8.1 | **Deprecated** — npm metadata says "use `@mog-sdk/sdk` instead" |

`@mog-sdk/node` — named in the brief — is a dead end. It is superseded by
`@mog-sdk/sdk`, which is what this project uses.

## A public embeddable canvas API does exist

This was the decisive question, and the answer is yes. `@mog-sdk/spreadsheet-app`
is published on the public npm registry and its `dist/index.d.ts` exports:

```ts
export declare function createSpreadsheetRuntime(
  options: SpreadsheetRuntimeOptions,
): Promise<SpreadsheetRuntime>;

export declare function mountSpreadsheetApp(
  container: HTMLElement,
  props: MogSpreadsheetAppProps,
): SpreadsheetAppAttachmentHandle;

export declare const MogSpreadsheetApp: ForwardRefExoticComponent<…>; // React form
```

So this app runs a **real** Mog canvas — the same engine and UI as the Mog VS
Code/Cursor extension — not a mock. `src/adapters/mog-embed-adapter.ts` mirrors
the host policy used by `integrations/vscode/mog-xlsx-editor/webview/index.ts`:
the host owns file open/save/export, the canvas owns editing and compute.

Peer dependencies are `react@^19` and `react-dom@^19`. The package ships
`LICENSE`, `package.json`, and `dist/` only — **no README and no docs**. The VS
Code integration source is the only worked example of embedding it, which is why
this project follows it closely.

## Friction that is not documented anywhere

- **Runtime assets must be hosted by you.** The embed fetches its compute-core
  WASM (~41 MB) and bundled fonts at runtime from URLs you supply via the
  `assets` policy (`wasmBaseUrl`, `fontBaseUrl`, `staticBaseUrl`). There is no
  published helper for this; upstream's VS Code build copies them next to its
  bundle (`copySpreadsheetAppAssets()` in `scripts/build.mjs`). `server/mog-assets.ts`
  serves them straight out of `node_modules` instead, so nothing is duplicated
  on disk.
- **The `assets` policy does not cover the WASM fetch.** This one cost real time.
  The wasm-bindgen loader inside the bundle resolves `compute_core_wasm_bg.wasm`
  against its own `import.meta.url`, ignoring `wasmBaseUrl` entirely. Under Vite
  that means `/node_modules/.vite/deps/compute_core_wasm_bg.wasm`, where the SPA
  fallback happily answers `200 text/html` and the browser reports
  `CompileError: WebAssembly.instantiate(): expected magic word`. Upstream never
  hits this because its copy step makes both paths the same directory.
  `server/mog-assets.ts` answers **both** URL shapes; `scripts/verify.mjs`
  asserts on both so a regression can't reach the browser silently.
- **`assets.workerUrl` is accepted but unnecessary.** Upstream's VS Code build
  points it at a `media/worker.js` that its own build script never emits. The
  field is optional in the type; this project omits it.
- **`@mog-sdk/sdk` resolves differently for TypeScript than for Node.** Its
  `exports` map has a `node` condition (`dist/index.js`, native bindings, file
  paths) and a `default`/`browser` condition (`dist/wasm.js`, whose
  `createWorkbook` takes bytes, not a path). Node picks the `node` condition on
  its own, so the `.mjs` scripts import the bare specifier and get the native
  build. TypeScript under `moduleResolution: bundler` picks the browser types, so
  the one server-side `.ts` file — `server/file-bridge.ts` — imports
  `@mog-sdk/sdk/node` explicitly. Both forms are in the tree on purpose; neither
  is a workaround for the other.
- **The embed's stylesheet is a startup hazard.** `@mog-sdk/spreadsheet-app/styles.css`
  is a separate export from the module, and a static import of it in the entry
  file is evaluated before any adapter probe runs — so a package that fails to
  resolve takes the whole page down before `unavailable-adapter.ts` can report
  why. It is therefore loaded from `src/adapters/mog-embed-adapter.ts`, after the
  embed itself has resolved, and `scripts/verify.mjs` asserts that the entry
  module's transformed output contains no `@mog-sdk` reference at all.

## The actual gap: Codex integration

**This project is not a Codex integration and does not attempt to be one.** That
is a scoping decision, not a claim that Codex has no UI surface — an earlier
version of this document asserted the latter, and it was wrong.

Custom UI surfaces for Codex plugins/MCP apps do exist, and the evidence is on
this machine. The OpenAI-curated `data-analytics` plugin in the local plugin
cache:

```
~/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/
  mcp/server.cjs
  skills/build-dashboard/specifications/mcp-artifact-dashboard.md
```

Its dashboard specification describes an MCP app rendering its own UI through
`render_artifact` / `validate_artifact`, in an artifact window, explicitly styled
against Codex chrome tokens (`--color-token-main-surface-primary`,
`--color-token-dropdown-background`, and a `#181818` Codex dark fallback). So a
plugin *can* put custom UI in front of the user.

What that does **not** establish, and what this project therefore does not claim:

- That an artifact/MCP-app surface will host a ~41 MB WASM compute core plus font
  fetches from a host-supplied origin. Untested here.
- That a Vite dev server becomes such a surface by being open beside Codex. It
  does not. The disk access and asset routing here are dev-server middleware
  (`server/file-bridge.ts`, `server/mog-assets.ts`) and there is no `build`
  output, so there is nothing a plugin host could load today. Shipping this as a
  plugin means writing an MCP server and a host-served runtime — a different
  program.

The Mog↔Codex integration that already exists runs the opposite direction:
`plugins/mog` in the Mog repo is a *Codex plugin* exposing Mog to Codex as MCP
tools (e.g. `mog_browser_start`), driving a browser-visible Mog session. That is
Codex calling Mog, not Codex hosting this panel.

Consequences for this project as it stands:

- It is a **standalone localhost app** you place beside Codex, sized for a narrow
  side panel. It is not "inside" Codex.
- Window management is the OS's job (snap it next to Codex), not the app's.
- Codex and this app share state only through **the file on disk**. That is why
  the file bridge keeps a `.bak` of the previous save and why `Verify` re-reads
  the saved file with the headless engine.

## Capture limits

Two screenshot paths exist here and neither one is a picture of "the workbook":

- **Engine capture** — the app's `Screenshot` button and
  `scripts/headless-edit.mjs` call `captureScreenshot` for a named range
  (`A1:H30` and `A1:D6` respectively). Rendered by the engine, so window size and
  scroll position do not affect it, but nothing outside that range is captured.
- **Page capture** — `scripts/browser-smoke.mjs` takes a CDP screenshot of the
  browser viewport, which it fixes at 520x900 (the side-panel shape this app
  targets). It shows only what fits there. That same fixed geometry is why the
  smoke test's grid click is expressed in raw pixels: at another window size it
  selects a different cell, so the smoke lane says nothing about wider layouts.

## Not exercised

The embed exposes more surface than this app uses — version control /
branching, multi-document workspaces, agent and automation edit levels,
decorations, slot contributions, approval flows. `editModel` here is
`{ user: 'write', agents: 'none', automation: 'none' }`: the human edits in the
canvas, agents edit headlessly through `@mog-sdk/sdk`. Widening that is a policy
change in `src/adapters/mog-embed-adapter.ts`, not new plumbing.
