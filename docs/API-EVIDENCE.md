# Mog embedding: what exists, what doesn't

The Mog package and standalone-embed evidence below was verified on this
machine on 2026-07-24. The host integration status was refreshed on
2026-07-26, and again on 2026-08-04 when Claude Code replaced Codex as the
project's primary host.

## The reference clone was not available

The brief pointed at a local read-only clone of the Mog monorepo, expected in a
sibling directory beside this project and named `mog` — specifically for
`integrations/vscode/mog-xlsx-editor` and `@mog-sdk/node`. **No such clone
existed on the machine** — confirmed with both the Bash and PowerShell tools;
the only `mog`-named directory in that location was this project itself. So the
reference material came from sources that do exist:

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
  why. `src/adapters/index.ts` therefore loads the stylesheet and embed module
  together inside the guarded adapter-resolution path, before the adapter is
  returned. If either import fails, resolution returns the unavailable adapter.
  `scripts/verify.mjs` asserts both fallback paths and that the entry module's
  transformed output contains no `@mog-sdk` reference at all.

## SDK surface — verified against 0.10.5, not read off a changelog

Every row below was called on this machine against the installed
`@mog-sdk/sdk` 0.10.5 on 2026-08-06. Re-run `npm run check:sdk-surface` to
re-verify; it prints `PRESENT`/`absent` per symbol and exits non-zero if
anything this project relies on has disappeared. **Prefer re-running it over
trusting this table** — the script is the durable artifact, the table is a
snapshot.

### Self-introspection: stop guessing API names

`docs/solutions/…/mog-sdk-node-subpath-and-proxy-introspection.md` already says
to call `api.describe` / `api.search` instead of guessing. Concretely:

| Call | What it actually returns |
| --- | --- |
| `api.search('used range')` | **The one to reach for.** Plain-language query → `{path, name, kind, signature, docstring}` matches. Correctly returned `ws.getUsedRange` for that query and `wb.diagnostics.checkFormulaErrors` for `'error cells'` |
| `api.describe()` | No-arg: method-name and sub-API lists only (~3.8 KB). A map, not documentation |
| `api.describe('ws.setFormulas')` | Per-symbol: full signature + docstring (~744 B). This is the useful form |
| `api.guidance.explain(sym)` | Same content, and it normalizes `worksheet.` → `ws.` |
| `api.guidance.analyze` / `.preflight` | Present — see the limit below |
| `api.compatibility` | `byObservedPath` / `byCanonicalPath` — a rename map for migrating off moved API paths |
| `api.types`, `api.utils`, `api.a1` | Present |

**Path grammar is strict and fails silently.** `ws.setFormulas` and
`worksheet.setFormulas` resolve; bare `setFormulas` returns `null` with no
error. A `null` from `describe` means "bad path", not "no such API".

**`guidance.preflight` is a syntax check, not a semantic guard.** It was fed a
snippet using the nested-`font` shape of a known upstream defect and returned
`{ ok: true, diagnostics: [] }`. It confirms the API you called exists and
parses; it does not know whether the call will do what you meant. Do not gate
model-written Mog code on it and call that safe.

### Confirmed present

- **Worksheet** — `setFormulas(range, formulas[][])`, `setCells`, `setRange`,
  `setCell`, `getUsedRange` (returns `null` on an empty sheet), `findLastRow`,
  `findLastColumn`, `findDataEdge`, `summarize`, `describe`, `describeRange`,
  `toCSV`, `toJSON`, `formats`, `tables`, `layout`
- **Workbook** — `importWarnings` (array), `undoGroup`, `captureScreenshot`,
  `sheets`, `names`, `dispose`, `toXlsx`, `diagnostics` (below)

### Corrections to what was previously assumed

| Assumed | Actual |
| --- | --- |
| `MogSdkErrorCode` is exported | **Does not exist.** Only `MogSdkError` |
| `wb.formats`, `wb.tables` | **Worksheet-level only** — `ws.formats`, `ws.tables` |

### Upstream #328 does not reproduce on 0.10.5

[#328](https://github.com/fundamental-research-labs/mog/issues/328) reports that
a multi-row `setRange` keeps formula authorship only on the first row, so later
rows export as frozen literals. That would hit
[scripts/headless-edit.mjs](../scripts/headless-edit.mjs) directly, which writes
a four-row matrix with formulas in rows 2–4. It was tested against 0.10.5 with
that exact shape: **all formulas survived `toXlsx()` + reload**, and the values
recalculated correctly. Either it was fixed in 0.10.5, or the report's explicit
`"A1:C2"` range form differs from the top-left anchor form used here.

The script was therefore left alone — rewriting working code around an
unreproduced bug adds risk and buys nothing. `check:sdk-surface` asserts the
round trip instead, so a regression is caught by a check rather than by a
delivered workbook full of stale numbers.

### `wb.diagnostics` — engine-side error checking nobody here knew existed

`checkErrors`, `checkFormulaErrors`, `validateWorkbook`, `checkBlankRegions`,
`checkExternalReferences`. Verified live: a sheet seeded with `=A1/A2` (÷0) and
`=NOSUCHFN(1)` returned structured findings with sheet name, cell address, an
error code, and the offending value:

```json
{ "ok": false,
  "findings": [ { "code": "FORMULA_ERROR_VALUE", "severity": "error",
                  "sheetName": "Sheet1", "address": "A3",
                  "currentValue": "#DIV/0!",
                  "message": "Formula at Sheet1!A3 evaluates to #DIV/0!." } ] }
```

`checkErrors` documents that checks lacking host support return `unsupported`
rather than `passed`, "so the result stays honest" — the same verified/assumed
separation this repo enforces.

**`#CALC!` is detected — the earlier doubt was wrong.** Three formulas producing
`#CALC!` (`FILTER` over a predicate matching nothing, and a `TRANSPOSE` of one)
were each flagged `FORMULA_ERROR_VALUE` with `currentValue: "#CALC!"`. The check
reads each cell's *current value*, so it does not depend on the dependency graph
being dirty — which is exactly the condition
[#337](https://github.com/fundamental-research-labs/mog/issues/337) creates. On a
poisoned import the cells literally hold `#CALC!`, so this should flag them.

**Confirmed on the real reproducer, 2026-08-06.** Run against
`v2_heritage_cash_reporting_2026-08-02.xlsx` (a later build of the file named in
the [#337 solutions entry](solutions/integration-issues/mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md);
it reproduces identically): **10,798 findings** across 6 sheets in **15.4 s**,
`truncated: false`, and the per-column counts match that entry's analysis
exactly. A scan narrowed to the known-bad column returned in **0.14 s** — against
a 117–187 s import. Detection is not what costs.

**Pass an explicit `limit`.** With no options, `checkFormulaErrors()` stops at
**1,000 findings** and returns `truncated: true`. On that file all 1,000 came
from one sheet and the worst-affected sheet was never reached. `ok: false` is
still correct, but a caller that reads the *findings list* to decide which cells
are bad gets a badly wrong answer. The options type is
`WorkbookValidationScanOptions` — `{ limit?, sheetId?, sheetName?, range?, ranges? }`.

**But the engine's own equivalent of the fidelity gate does not run here.**
`checkErrors()` on an imported file reports its full battery, and two checks come
back `unsupported` rather than `passed`:

| check | status |
| --- | --- |
| `formula-error-values` | passed |
| `external-references` | passed |
| `dirty-state` | passed |
| `openxml-loadability` | **unsupported** |
| `stale-cached-values` | **unsupported** |

`stale-cached-values` is precisely what
[server/value-fidelity.ts](../server/value-fidelity.ts) does — compare the
engine's computed values against the cached `<v>` the file carries. It is
**unsupported in this host**, so the local gate is not redundant and cannot be
retired in favour of it. That settles the open question: keep the gate. It is
still `unsupported` on the real reproducer above — a large, genuinely poisoned
import, which is the strongest case it would ever have to answer.

The useful shape is therefore *both* — `checkFormulaErrors` is a cheap
engine-side signal that could run at **open** time, where the current gate only
acts at **save** time. It cannot replace the gate as a refusal criterion,
because it flags any error value including ones legitimately present in the
source file; the gate refuses only the high-signal shape where the file recorded
a non-error and the engine reports an error.

### Other surfaces worth knowing, verified the same way

`npm run sdk:search -- --all` enumerates 237 paths; this project calls a small
fraction. Most of the remainder is irrelevant here (slicers, sparklines, text
effects). These are not:

| Surface | Verified behavior | Why it matters here |
| --- | --- | --- |
| `wb.createCheckpoint` / `restoreCheckpoint` / `listCheckpoints` | Works. `createCheckpoint('label')` returns an id; after clobbering a cell, `restoreCheckpoint(id)` restored the original value | In-engine rollback for multi-step agent edits, distinct from the service layer's `.bak` files |
| `wb.calculationState`, `wb.isDirty`, `wb.markClean` | `"done"` / `false` on a fresh import | The surfaces that would *report* #337's "graph marked clean" state |
| `wb.getCalculationMode` / `setCalculationMode` | `'auto'` by default; `'manual'` sticks. A dependent formula still evaluated eagerly, so manual mode did not defer this path | Hypothesis 3 in the #337 write-up said no calculation-mode option exists. That remains true of `SpreadsheetOpenWorkbookRequest`; it is **not** true of the workbook object post-open |
| `wb.executeCode` | Present, not exercised | An agent-reachable code-execution surface. Worth knowing it exists before something enables it |
| `wb.security`, `wb.makePrincipal`, `wb.activePrincipal` | Present; `securityActive` is `false` | An entire principal model this project does not use |
| `createWorkbook(path, { readOnly: true })` | **Ignored** — `wb.readOnly` stayed `false` | There is no read-only open via that option shape, so "viewing is safe, saving is not" cannot be enforced at open time this way |

## Historical Codex gap and current plugin status

At the time of the original 2026-07-24 investigation, this project was a
standalone companion and did not attempt to be a Codex integration. That was a
scoping decision, not a claim that Codex had no custom UI surface — an earlier
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

That evidence did **not** establish:

- That an artifact/MCP-app surface will host a ~41 MB WASM compute core plus font
  fetches from a host-supplied origin. Untested here.
- That a Vite dev server becomes such a surface by being open beside Codex. It
  does not. The standalone app's disk access and asset routing remain
  dev-server middleware (`server/file-bridge.ts`, `server/mog-assets.ts`).

The separate Mog↔Codex integration found during the initial research ran the
opposite direction:
`plugins/mog` in the Mog repo is a *Codex plugin* exposing Mog to Codex as MCP
tools (e.g. `mog_browser_start`), driving a browser-visible Mog session. That is
Codex calling Mog, not Codex hosting this project's panel.

The current `main` branch now also contains the missing host-facing program:

- `server/mcp/` provides the stdio MCP server, workbook tools, and the
  `ui://mog-canvas/canvas.html` MCP Apps resource.
- `plugins/mog-canvas/ui/dist` is a production component bundle; it does not
  require the Vite development server at runtime.
- `plugins/mog-canvas/` and the marketplace manifests package the component and
  server as a repository-local plugin.
- `server/workbook-service.ts` gives the standalone HTTP bridge and MCP lane the
  same containment, revision, backup, validation, and screenshot behavior.

The standalone localhost app remains a useful fallback beside the host.

**Where the host gate stands now.** The Codex research above is history: this
document was written while Codex was the intended host, and the gap it
describes is a Codex gap. The project's primary host is now Claude Code, where
the canvas *has* been observed rendering and completing an edit/save round
trip. In Codex it still has not. See `docs/CLAUDE-CODE-PLUGIN.md` for the
installation boundary, host test, rollback, and current limitations of both
paths.

## Capture limits

Two screenshot paths exist here and neither one is a picture of "the workbook":

- **Engine capture** — the app's `Screenshot` button and
  `scripts/headless-edit.mjs` call `captureScreenshot` for a named range
  (`A1:H30` and `A1:D6` respectively). Rendered by the engine, so window size and
  scroll position do not affect it, but nothing outside that range is captured.
- **Page capture** — `scripts/browser-smoke.mjs` takes a CDP screenshot of the
  browser viewport, which it fixes at 520x900 (the side-panel shape this app
  targets). It shows only what fits there, so the smoke lane says nothing about
  wider layouts. The edit check uses one pixel click only to focus the grid,
  then deterministic keyboard navigation to select the target cell.

## Not exercised

The embed exposes more surface than this app uses — version control /
branching, multi-document workspaces, agent and automation edit levels,
decorations, slot contributions, approval flows. `editModel` here is
`{ user: 'write', agents: 'none', automation: 'none' }`: the human edits in the
canvas, agents edit headlessly through `@mog-sdk/sdk`. Widening that is a policy
change in `src/adapters/mog-embed-adapter.ts`, not new plumbing.
