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
- **Bare `@mog-sdk/sdk` resolves to the browser WASM build** under TypeScript's
  `bundler` module resolution, whose `createWorkbook` takes bytes and not a file
  path. Server-side code must import `@mog-sdk/sdk/node`.

## The actual gap: Codex integration

**This app cannot be embedded into the Codex desktop app, and this project does
not attempt to.**

There is no public, documented extension/panel/webview host API for the Codex
desktop app that a third party could render a custom UI into. The available Mog↔
Codex integration is the opposite direction: `plugins/mog` in the Mog repo is a
*Codex plugin* that exposes Mog to Codex as MCP tools (e.g. `mog_browser_start`),
driving a browser-visible Mog session. That is Codex calling Mog, not Codex
hosting a Mog panel.

Consequences for this project:

- It is a **standalone localhost app** you place beside Codex, sized for a narrow
  side panel. It is not "inside" Codex in any sense.
- Window management is the OS's job (snap it next to Codex), not the app's.
- Codex and this app share state only through **the file on disk**. That is why
  the file bridge keeps a `.bak` of the previous save and why `Verify` re-reads
  the saved file with the headless engine.

## Not exercised

The embed exposes more surface than this app uses — version control /
branching, multi-document workspaces, agent and automation edit levels,
decorations, slot contributions, approval flows. `editModel` here is
`{ user: 'write', agents: 'none', automation: 'none' }`: the human edits in the
canvas, agents edit headlessly through `@mog-sdk/sdk`. Widening that is a policy
change in `src/adapters/mog-embed-adapter.ts`, not new plumbing.
