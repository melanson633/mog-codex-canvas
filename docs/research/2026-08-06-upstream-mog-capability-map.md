# Upstream Mog ↔ `mog-codex-canvas`: capability map and integration research

> **What this is.** A repo-grounded reading of `fundamental-research-labs/mog`
> (public, `main`, shallow clone taken 2026-08-06) against this checkout, written
> so a future agent does not debug locally what upstream already answers.
> It changes no code and proposes no architecture rewrite.
>
> **What this is not.** It is not a setup guide, and it does not supersede
> [`AGENTS.md`](../../AGENTS.md), [`CONCEPTS.md`](../../CONCEPTS.md), or
> [`docs/solutions/`](../solutions/). Where it disagrees with a `docs/solutions/`
> entry, the entry wins until someone re-runs the check.
>
> **Evidence labels** used throughout, per this repo's evidence discipline:
>
> | Label | Meaning |
> | --- | --- |
> | **[SRC]** | Read directly in upstream or local source at a cited path |
> | **[DOC]** | Stated in an upstream doc; not independently exercised here |
> | **[TEST]** | Backed by an upstream test/fixture or a local check command |
> | **[INF]** | Inferred from code structure; plausible, unexercised |
> | **[UNV]** | Unverified in this session; blocker stated |
>
> Nothing below was executed. `npm install` was not run, so no local command in
> this repo was invoked and no engine was loaded. Every local claim is a read of
> committed source or of a tracked fixture's bytes. That is the session's
> standing limitation — see [§12](#12-open-questions--blockers).

---

## 1. Executive summary

Nine findings, ordered by how much they change what a future agent should do.

1. **The `#CALC!` defect this repo diagnosed is already an open upstream issue —
   [#337](https://github.com/fundamental-research-labs/mog/issues/337), filed by
   this repo's own author on 2026-08-04.** [UNV→SRC via web] The upstream tracker
   has 13 open issues, and several describe engine behavior this repo either
   compensates for or is exposed to. **Checking that tracker is now step zero of
   any canvas-side debugging session.** It was not previously anywhere in this
   repo's triage path.

2. **Upstream issue
   [#328](https://github.com/fundamental-research-labs/mog/issues/328) says
   `ws.setRange` with a multi-row matrix keeps formulas only on the first row**
   (reported at 0.10.4), and names `ws.setFormulas` / `ws.setCells` as the
   formula-safe writes. `scripts/headless-edit.mjs:65-70` uses exactly the
   reported shape. **I checked the tracked fixture and it does not reproduce
   here:** `workbooks/sample.xlsx` carries `<f>` on rows 2, 3 and 4. [TEST — read
   the OOXML directly] So this is a latent hazard at 0.10.5, not a live bug — but
   the sample generator is one SDK bump away from silently emitting a
   formula-free workbook, and upstream already names the safer API.

3. **This repo imports the wrong stylesheet export.** Upstream ships two:
   `@mog-sdk/spreadsheet-app/styles.css` (unscoped app stylesheet) and
   `@mog-sdk/spreadsheet-app/mog-embed.css` (every selector scoped to
   `[data-mog-engine]`). The guide is explicit: *"Host products should use
   `mog-embed.css` unless they intentionally want the app stylesheet to affect
   the whole page."* [SRC + DOC] `src/adapters/index.ts:36` loads `styles.css`.

4. **The CSP grant this repo discovered by building a three-rung ladder is
   verbatim in upstream source.** `integrations/vscode/mog-xlsx-editor/src/webview-html.ts`
   ships `script-src 'nonce-…' 'wasm-unsafe-eval'; worker-src ${cspSource} blob:`
   — the same rung
   [`mcp-apps-sandboxed-iframe-wasm-csp-and-storage.md`](../solutions/integration-issues/mcp-apps-sandboxed-iframe-wasm-csp-and-storage.md)
   established empirically. [SRC] The ladder was still worth building (it proved
   `'unsafe-eval'` unnecessary *in this host*), but the starting hypothesis was
   available for free.

5. **The engine's own save contract carries a version identity this repo does not
   feed.** `SpreadsheetDocumentSource` (`xlsx-bytes`) accepts `versionId`, and it
   comes back on every `SpreadsheetSaveRequest` as `baseVersionId`. [SRC]
   Upstream's VS Code host passes it; this repo does not. Wiring Workbook
   Revision into that field would let the canvas's own save request carry the
   revision the workbook service is about to check — turning a server-side
   refusal into something the canvas knew before it asked.

6. **`api.describe(...)` and `api.guidance.analyze/preflight/explain(...)` are
   entirely unused here, and they are the direct cure for the pain
   [`mog-sdk-node-subpath-and-proxy-introspection.md`](../solutions/integration-issues/mog-sdk-node-subpath-and-proxy-introspection.md)
   records** ("SDK objects are proxy-backed… three separate guessed names were all
   wrong"). Upstream ships a generated 17-entry wrong-dialect catalog and a
   preflight that blocks Office-JS-shaped code before it runs. [SRC]

7. **Compact Mode reaches into the embed's DOM with Tailwind-class selectors
   (`src/styles.css:223-224`) to hide the ribbon and status bar, when
   `chrome: { commandBar: false, statusBar: false }` is the supported policy for
   exactly that.** [SRC] The multi-pane solution doc already flags those selectors
   as "version-fragile"; upstream provides the non-fragile route, including a
   structured `commandBar` object with `tabs` / `hiddenGroups` /
   `disabledCommands`.

8. **`server/workbook-service.ts` and the byte-first briefing stack are
   *correctly* local and must not be "simplified" into engine calls.** Their whole
   value — millisecond answers while the renderer hydrates, provenance stated,
   no engine trust — is a property upstream cannot supply, and the
   value-fidelity gate exists precisely because the engine agrees with itself.
   Nothing in this report proposes moving them.

9. **The upstream boundary line is enforced, enumerated, and easy to honor.**
   Eighteen negative fixtures under `fixtures/external/negative/` name the exact
   imports that must fail. This repo is currently on the right side of all of
   them. [SRC + TEST]

---

## 2. Fast orientation: what each repo owns

### Upstream `fundamental-research-labs/mog`

A pnpm + Cargo monorepo, ~12,900 files, layered `apps → shell/ui → views → kernel
→ hardware → contracts/types` with the direction enforced by
`tools/eslint-plugin-mog/import-boundaries.cjs`. [DOC `docs/guides/architecture-overview.md`]

| Package | Status | What it is |
| --- | --- | --- |
| `@mog-sdk/sdk` | shipped public | Headless engine. Root import resolves native N-API in Node, WASM elsewhere; `./node`, `./wasm`, `./workerd`, `./version-store` subpaths force a binding |
| `@mog-sdk/spreadsheet-app` | shipped public | The full app embed. `createSpreadsheetRuntime`, `mountSpreadsheetApp`, `MogSpreadsheetApp`. CSS subpaths public-experimental |
| `@mog-sdk/embed` | shipped public root; `./react`, `./web-component`, `./config` public-experimental | Lower-level read-only browser embed |
| `@mog-sdk/sheet-view` | shipped public | Grid renderer only — no toolbar, formula bar, or sheet tabs |
| `@mog-sdk/contracts` | shipped public, many public-experimental subpaths | The contract barrel |
| `@mog-sdk/wasm`, platform binaries | binary-wrapper | Implementation deps of the facades |
| `@mog-sdk/kernel`, `@mog/transport`, `types/*` | workspace-internal | `private: true` |
| `@mog/shell`, `@mog/ui` | reserved | |
| `@mog/app-spreadsheet` | private product | The thing `spreadsheet-app` wraps |

Owns: the engine, the app UI, the public contracts, the runtime asset artifacts
(`dist/compute_core_wasm_bg.wasm`, `dist/assets/*.ttf`), the actor/capability
model, the save contract, version control, and the generated API/guidance
metadata.

### This repo `mog-codex-canvas`

Owns: **everything the engine deliberately does not** — disk, authorization,
identity, durability, evidence, host adaptation, and the two-lane edit policy.

| Surface | Owns |
| --- | --- |
| `server/workbook-service.ts` (1003 ln) | Containment, Workbook Revision, staged writes + `.bak`, value-fidelity gate, occupied-cell interlock, flight-recorder receipts, sessions |
| `server/path-policy.ts` | Root containment incl. Windows junction/ADS traps |
| `server/workbook-profile|graph|briefing|sheet-schema|consumption-index.ts` (~2,900 ln) | Byte-first OOXML analysis — Progressive Retrieval, Hydration Briefing, redaction |
| `server/value-fidelity.ts` + `ooxml-cache.ts` | The engine-vs-file-cached-value oracle |
| `server/mcp/` | MCP server, 22 tools, `ui://` app resource, loopback asset host |
| `src/adapters/` | The Canvas Adapter boundary + honest unavailable fallback |
| `server/mog-assets.ts` | Dev-server WASM/font routing at both URL shapes |
| `scripts/` | 6 verification harnesses |

**The single sentence that separates them:** upstream owns *what a workbook
computes*; this repo owns *whether that computation may reach disk, and what
evidence accompanies it*.

---

## 3. Relationship map: `mog-codex-canvas` → upstream `mog`

Classification per entry: **[CANON]** canonical upstream behavior used as
designed · **[ADAPT]** local adapter policy over a canonical API · **[LOCAL]**
local security/persistence policy with no upstream counterpart · **[HOST]**
host/MCP integration · **[HARNESS]** verification · **[SPEC]** speculative.

| Concern | Local surface | Upstream counterpart | Class |
| --- | --- | --- | --- |
| Full app embed | `src/adapters/mog-embed-adapter.ts:73-107` | `createSpreadsheetRuntime` + `mountSpreadsheetApp` (`runtime/spreadsheet-app/src/public-types.ts:636-699`) | **[CANON]** |
| Adapter probe / fallback | `src/adapters/index.ts`, `unavailable-adapter.ts` | none — upstream throws `AttachFailed`/`RuntimeError` | **[ADAPT]** |
| Headless SDK | `scripts/headless-edit.mjs`, `workbook-service.validate/captureScreenshot` | `createWorkbook` from `@mog-sdk/sdk[/node]` | **[CANON]** |
| Workbook I/O from disk | `workbook-service.read/save`, `path-policy.ts` | deliberately absent from the embed; `wb.save(path)` exists Node-side only | **[LOCAL]** |
| Runtime assets | `server/mog-assets.ts`, `server/mcp/asset-host.ts` | `SpreadsheetRuntimeAssetPolicy` (`public-types.ts:438-443`); layout set by `runtime/spreadsheet-app/scripts/finalize-assets.mjs` | **[ADAPT]** |
| wasm-bindgen self-relative fetch | dual-route serving in both asset servers | *no upstream counterpart* — upstream's copy step makes both paths one directory | **[LOCAL]** |
| Host-owned persistence | `persistThroughHost` → `HostServices.persist` → `PUT /api/workbook` / `save_workbook_canvas` | `host.persistenceMode: 'host-owned-ephemeral'` + `onSaveRequest` | **[CANON]** |
| Save contract fields | `persistThroughHost` echoes `epoch`/`dirtyEpoch`/`changeSequence`/`saveRequestId`/`bytesHash` | `SpreadsheetSaveRequest`/`SpreadsheetSaveResult` (`public-types.ts:297-338`) | **[CANON]** |
| Version identity | Workbook Revision = SHA-256 of disk bytes | `versionId` on source + `baseVersionId` on save request | **[LOCAL]**, *not yet joined to upstream's field* |
| Revision conflict | `workbook-service.ts:705-726, 806-813` | none — the engine is last-write-wins by construction | **[LOCAL]** |
| Value fidelity | `server/value-fidelity.ts` | none; the engine's own recalculation cannot detect it | **[LOCAL]** |
| Actor / edit policy | `editModel: {user:'write', agents:'none', automation:'none'}` (`mog-embed-adapter.ts:283`) | `MogSpreadsheetAppProps.editModel`, `SpreadsheetEditLevel` | **[CANON]** |
| Privileged actors | `SCREENSHOT_ACTOR` is `kind:'user'` (`mog-embed-adapter.ts:46-50`) | `host.authority: SpreadsheetHostAuthority` required for `host`/`agent`/`automation`/`system` (`public-types.ts:170-180`) | **[ADAPT]** — no authority registered, deliberately |
| Screenshot (canvas) | `session.screenshot('A1:H30')` | `SpreadsheetWorkbookSession.captureScreenshot(actor, sheet, range, opts)` | **[CANON]**, fixed range is **[ADAPT]** |
| Screenshot (headless) | `wb.captureScreenshot(ws,'A1:D6',{dpr:2})` | `Workbook.captureScreenshot(sheet, range, ScreenshotOptions)` | **[CANON]** |
| Reveal / navigation | `session.reveal` + context bus | `SpreadsheetViewHandle.setActiveSheet/select/scrollTo` | **[CANON]** wrapped in **[LOCAL]** suppression policy |
| Byte-first briefing stack | `server/workbook-*.ts` | *no upstream counterpart* — deliberately engine-free | **[LOCAL]** |
| Renderer readiness | `watchRendererReadiness` polls `getStatus()==='ready'` + a real `view()` query | `SpreadsheetAppStatus`, `attachment.ready` | **[ADAPT]** |
| MCP Apps host | `server/mcp/mog-canvas-server.ts`, `plugins/mog-canvas/` | *none* — upstream's MCP surface is `plugins/mog` (Codex→Mog, opposite direction) | **[HOST]** |
| Sandboxed-iframe storage shim | `plugins/mog-canvas/ui/src/mcp-app.ts:31-35` | *none* — upstream hosts are same-origin | **[LOCAL]** |
| API introspection / preflight | *absent* | `api.describe`, `api.guidance.*` | — |
| Version history / branching | *absent* | `wb.version.*`, `versionStore` | — |
| Decorations / slots | *absent* | `SpreadsheetDecorationHandle`, `SpreadsheetSlotHandle` | — |
| Codex rendering | manifests ship; never observed | upstream is not involved | **[SPEC]** |

---

## 4. Optimal Mog-native command practices for agents

All signatures below read from `docs/generated/api-reference.json` (generated
from `types/api/src/api/**`) and `docs/guides/sdk.md` at upstream `main`.

### 4.1 Opening workbooks: path vs bytes

```ts
// Node/native only — accepts a path, creates parent dirs on save
const wb = await createWorkbook('model.xlsx');
// Any runtime — bytes
const wb = await createWorkbook(new Uint8Array(await readFile('model.xlsx')));
// With options
const wb = await createWorkbook({ xlsx: bytes, documentId: 'model-1', userTimezone: 'UTC' });
```

**Do** prefer the *path* form Node-side when the file is already authorized —
`workbook-service.validate()` and `captureScreenshot()` already do this
(`workbook-service.ts:865, 916`), and it avoids a full copy in memory. **Do** use
the *bytes* form when the bytes have already been read for another reason —
`save()` does exactly that at `workbook-service.ts:750`, feeding the same buffer
to the fidelity gate and the dependency trace from one read.

**Avoid** opening speculatively. The comment at `workbook-service.ts:739-740`
("`createWorkbook()` on unopenable bytes leaks a native thread in 0.10.5") is a
local observation, not upstream-documented [INF] — but the guard it produced,
`looksLikeWorkbook(bytes)` before any open, is good practice regardless.

**Read `wb.importWarnings` after every open.** [SRC — `readonly importWarnings:
readonly DocumentImportWarning[]`, documented "Warnings from the XLSX import that
created this workbook (e.g., unsupported features)"] Nothing in this repo reads
it. It is the engine's own statement about what it dropped on the way in, and it
is free.

### 4.2 `@mog-sdk/sdk` root vs `/node`, `/wasm`, `/workerd`

Upstream is explicit: *"The normal import is the package root… Use explicit
subpaths only when the host or test needs to force a binding."* [DOC]

This repo's `/node` usage is exactly that documented case, and the reason is
readable in the manifest. `runtime/sdk/package.json` orders its root conditions
`workerd → node-addons → node → browser → default`, with `browser`/`default`
pointing at `dist/wasm.d.ts`. Under `moduleResolution: bundler`
(`tsconfig.json:6`) TypeScript does not apply the `node` condition, so the bare
specifier types as the WASM build, whose `createWorkbook` has no file-path
overload. **[SRC — verified from the export map, not from the doc.]** Node itself
picks `node` at runtime, which is why the `.mjs` scripts import bare and get the
native binding. Both forms in this tree are correct; `AGENTS.md:308-311` states
the rule.

> **Worth a future experiment, not a recommendation yet:** TypeScript's
> `compilerOptions.customConditions: ["node"]` under `bundler` resolution would
> let the server-side `.ts` files use the bare specifier and still type against
> the native build. [UNV] Untested here, and it would change resolution for every
> dependency, so it is a deliberate change with its own check — not a cleanup.

**Never** let `@mog-sdk/sdk` reach the browser bundle. `AGENTS.md` makes this an
invariant and `npm run verify` asserts it.

### 4.3 `setCell` vs `setRange` vs `setCells` vs `setFormulas`

| API | Signature | Use for |
| --- | --- | --- |
| `ws.setCell(addr, value, opts?)` | `Promise<void>` | One cell. `opts.asFormula` forces formula without `=`; `opts.literal`/`asText` stores a formula-shaped string as text |
| `ws.setRange(range, values[][])` | `Promise<void>` | Rectangular **value** blocks |
| `ws.setCells([{addr\|row/col, value}])` | `Promise<void>` | Scattered writes, mixed values and formulas |
| `ws.setFormulas(range, formulas[][])` | `Promise<void>` | Rectangular **formula** blocks; accepts `=SUM(...)` or bare `SUM(...)` |

**Do this** for a matrix that mixes values and formulas:

```ts
await ws.setRange('A1:C4', [
  ['Line item', 'Q1', 'Q2'],
  ['Revenue', 120000, 135000],
  ['COGS', 48000, 52000],
  ['Gross profit', null, null],
]);
await ws.setFormulas('D2:D4', [['=SUM(B2:C2)'], ['=SUM(B3:C3)'], ['=SUM(B4:C4)']]);
```

**Avoid this** — a single `setRange` carrying formulas on more than the first
row:

```ts
await ws.setRange('A1', [
  ['Line item', 'Q1', 'Q2', 'Total'],
  ['Revenue', 120000, 135000, '=SUM(B2:C2)'],   // row 2 formula
  ['COGS',     48000,  52000, '=SUM(B3:C3)'],   // row 3 formula — the reported loss
]);
```

That second block is `scripts/headless-edit.mjs:65-70` as written today. Upstream
[#328](https://github.com/fundamental-research-labs/mog/issues/328) reports rows
after the first being flattened to cached scalars at 0.10.4, with the formulas
gone after an export/reload cycle, and names `setFormulas`/`setCells` as the
workarounds.

**It does not reproduce in this checkout.** `workbooks/sample.xlsx` — the tracked
fixture that script produces — carries `<f>SUM(B2:C2)</f>`, `<f>SUM(B3:C3)</f>`,
`<f>B2-B3</f>`, `<f>C2-C3</f>` and `<f>SUM(B4:C4)</f>` on rows 2 through 4. [TEST
— unzipped and read `xl/worksheets/sheet1.xml` directly] So at `^0.10.5` the
formulas survive. Treat this as **a hazard with a named safe alternative**, not
as a bug report against this repo.

### 4.4 Computed values vs formula text

```ts
await ws.getValue('A3');    // computed value
await ws.getFormula('A3');  // '=SUM(A1:A2)'
await ws.getValues('A1:B3');   // CellValue[][] — the common LLM read pattern
await ws.getFormulas('A1:B3'); // (string|null)[][]
```

**Do** use `getValues` for bulk reads — upstream calls it "the most common read
pattern for SDK/LLM consumers." **Avoid** looping `getValue` per cell across a
range.

**In this repo specifically:** prefer `read_range` (byte-first) over an engine
read whenever the question is "what does the saved file say." It is milliseconds,
engine-free, and carries provenance — and after upstream #337, an engine read of a
freshly imported table calculated column is *the one number you should trust
least*.

### 4.5 When to call `wb.calculate()`

Upstream: *"For ordinary writes, formulas are recalculated before the write
resolves."* [DOC] So the answer is **almost never**. The documented reasons to
call it:

```ts
// Circular references — debt schedules, tax shields
const r = await wb.calculate({ iterative: { maxIterations: 100, maxChange: 0.001 } });
// r: { hasCircularRefs, converged, iterations, maxDelta, recomputedCount }
```

**Do not** use `calculate()` or `recalculateAll()` as a repair for suspicious
values. `docs/solutions/.../mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md`
records the definitive experiment: `recalculateAll()` returned in **0 ms** and
changed nothing, because the engine had marked the graph clean. A confident wrong
answer does not become right by being asked again. `ws.calculate(markAllDirty)`
exists for per-sheet forcing but did not help there either.

### 4.6 Sheets

```ts
const ws = wb.activeSheet;                        // SYNC property
const s  = await wb.getSheet('Summary');          // async lookup
const s2 = await wb.getSheetByIndex(0);
const s3 = await wb.findSheet('Maybe');           // null instead of throwing
const { sheet, created } = await wb.getOrCreateSheet('Inputs');  // NOT a bare sheet
const data = await wb.sheets.add('Data');
await wb.sheets.rename(ws.name, 'Summary');
await wb.sheets.move('Data', 0);
```

`getOrCreateSheet` returning `{ sheet, created }` is the single most-guessed-wrong
signature in this repo's history — it is in
[`mog-sdk-node-subpath-and-proxy-introspection.md`](../solutions/integration-issues/mog-sdk-node-subpath-and-proxy-introspection.md)
and it is what `workbook-service.ts:874` correctly destructures.

### 4.7 Tables and filters

```ts
const table = await ws.tables.add('A1:C3', { name: 'SalesData', hasHeaders: true });
await ws.tables.addRow(table.name, undefined, ['Service', 50, 75]);
await ws.filters.add('A1:C10');
await ws.filters.setColumnFilter(0, { type: 'value', values: ['Widget'] });
```

**Two upstream cautions before building on tables.** Issue #337 (import of
calculated columns) and issue
[#334-ish "Charts/tables created in the same session can't be targeted by
follow-up mutations"](https://github.com/fundamental-research-labs/mog/issues)
and "`tables.sortApply` appears to be a no-op" are all open. [UNV — titles read
from the tracker listing; I did not open each issue.] Table mutation is the least
settled part of the public surface right now. Verify per operation, and check the
tracker first.

### 4.8 Export and save

```ts
const bytes = await wb.toXlsx();      // pure bytes
const bytes2 = await wb.save();       // same bytes, no filesystem side effect
await wb.save('out.xlsx');            // writes AND returns the bytes; creates parent dirs (Node)
const csv  = await ws.toCSV();        // RFC 4180; escapes =,+,-,@ against formula injection
const json = await ws.toJSON();
```

**In this repo, never call `wb.save(path)`.** Every write must go through
`server/workbook-service.ts` — that is an `AGENTS.md` invariant, and the reason is
that `wb.save(path)` bypasses containment, the staged-write/`.bak` durability
path, the revision check, the fidelity gate, the occupied-cell interlock, and the
receipt. `scripts/headless-edit.mjs:81` gets this right: `wb.toXlsx()` then
`service.save(...)`.

`ws.toCSV()`'s formula-injection escaping is a real upstream safety property
worth knowing before anyone hand-rolls a CSV export here.

### 4.9 Structured `MogSdkError`

```ts
import { MogSdkError, type MogSdkErrorCode } from '@mog-sdk/sdk';
try { /* … */ } catch (e) {
  const err = MogSdkError.from(e);   // normalizes unknown values
  // err.code        stable broad category, for control flow
  // err.operation   the exact SDK route that failed
  // err.path        invalid/unresolved input fields
  // err.suggestion  concrete recovery guidance
  // err.details     resource ids, matched names, limits
  // err.diagnostics.issueCode   granular kernel reason
}
```

**This repo currently discards all of it.** `workbook-service.ts:866-870` catches
any open failure and produces `WorkbookError('validation-failed', \`${name} could
not be reopened: ${reason(error)}\`)` — message text only. The same happens at
`captureScreenshot`. Mapping `err.code`/`err.diagnostics.issueCode` into
`WorkbookError.details` would give MCP callers something to branch on instead of
a prose string, without changing the local taxonomy. See
[§8.4](#84-carry-mogsdkerror-through-workbookerror).

### 4.10 API discovery: `api.describe(...)`

```ts
import { api } from '@mog-sdk/sdk';
api.describe();                      // overview: root methods + sub-API names
api.describe('ws.tables.add');       // one signature, docstring, and its types
api.describe('type:TableOptions');   // a type definition
```

Backed by `runtime/sdk/src/generated/api-spec.json` with source locations, async
model metadata, and number-format metadata. [SRC] The generated
`docs/generated/api-reference.json` carries **249 `Workbook` members and 653
`Worksheet` members** — the surface is far larger than either repo's docs suggest,
and it is queryable at runtime.

This is the answer to "SDK objects are proxy-backed, `Object.getOwnPropertyNames`
returns only `constructor`." Do not introspect the proxies. Ask `api.describe`.

### 4.11 Codegen preflight: `api.guidance.*`

```ts
const preflight = api.guidance.preflight(source);
if (!preflight.ok) {
  const d = preflight.diagnostics[0];
  throw new Error(d?.mogReplacements[0]?.snippet ?? d?.suggestion ?? 'Invalid Mog code');
}
for (const d of api.guidance.analyze(source)) console.log(d.mogReplacements, d.references);
api.guidance.explain('context.workbook.worksheets.getActiveWorksheet');
```

`runtime/sdk/src/generated/api-guidance.json` carries **17 entries**, 16 of them
Office-JS dialect matchers marked `blocking: true` — bootstrap, host globals,
sync/load, active-sheet, sheet-lookup, range read/write/navigation, what-if data
tables, pivots, autofill, formatting, tables, filters/sort, names, file I/O —
plus one non-blocking `mog-version` entry. [SRC] Each carries `message`,
`suggestion`, and `mogReplacements` with a ready snippet.

Upstream's own instruction: *"Read `diagnostic.mogReplacements` for replacement
paths/snippets; the summary error string is not the full guidance."* [DOC]

### 4.12 Wrong-dialect: what never to write

| Do **not** write | Write instead |
| --- | --- |
| `Excel.run(async ctx => …)`, `Office.onReady` | `const ws = wb.activeSheet` (injected `wb`), or `createWorkbook(...)` at the SDK boundary |
| `Office.context.*`, `OfficeRuntime.storage` | `await wb.save(path)` / `await wb.toXlsx()` |
| `await context.sync()`, `range.load('values')` | nothing — Mog methods resolve their own reads |
| `sheet.getRange('A1:C3').values = data` | `await ws.setRange('A1:C3', data)` |
| `ctx.workbook.worksheets.getActiveWorksheet()` | `wb.activeSheet` (sync property) |
| `worksheets.getItem(name)` | `await wb.getSheet(name)` / `await wb.findSheet(name)` |
| null-object sentinels (`.isNullObject`) | `findSheet` returns `null`; other routes reject with `MogSdkError` |

Upstream: *"Mog is not a Microsoft Office JavaScript API compatibility layer.
Code shaped like that API is diagnosed as a known wrong dialect so agents can
rewrite it; it is not supported or shimmed."* [DOC]

### 4.13 Screenshots and reviewability

Two different option types — do not confuse them:

| Context | Call | Options |
| --- | --- | --- |
| Headless SDK | `wb.captureScreenshot(sheet\|Worksheet, range, opts)` | `ScreenshotOptions`: `dpr`, `showHeaders`, `showGridlines`, `maxWidth`, `maxHeight` [SRC `types/api/src/api/types.ts:2751`] |
| Embed | `session.captureScreenshot(actor, sheet, range, opts)` | `SpreadsheetScreenshotOptions`: `scale`, `background`, `format` [SRC `public-types.ts:364-368`] |

The embed form **requires an actor** and refuses privileged kinds without a
registered `SpreadsheetHostAuthority` — hence `kind:'user'` at
`mog-embed-adapter.ts:46-50`. That is correct and should stay until an authority
adapter exists.

**Stop hard-coding `A1:H30`.** `ws.getUsedRange(): Promise<WorksheetRange | null>`
exists, as do `findLastRow(col)`, `findLastColumn(row)` and `findDataEdge(...)`.
[SRC] A screenshot bounded by the used range (clamped by `maxWidth`/`maxHeight`)
is a picture of the sheet; `A1:H30` is a picture of a guess. Three call sites
hard-code it: `src/App.tsx:263`, `plugins/mog-canvas/ui/src/mcp-app.ts:67`,
`workbook-service.ts:911`.

### 4.14 Version history, branches, merge

Public, and larger than this repo has considered:

```ts
const wb = await createWorkbook({
  documentId: 'budget-2026',
  versionStore: { kind: 'memory-durable-snapshot', workspaceId: 'finance', principalScope: 'analyst-1' },
});
await wb.version.commitCurrent({ message: 'Initial' });
await wb.version.createBranchFromCurrent('scenario-a', { expectedAbsent: true });
await wb.version.checkoutBranch('scenario-a', { requireClean: true });
const diff   = await wb.version.diffBranch('scenario-a');
const review = await wb.version.previewMerge({ from: 'scenario-a', into: 'main' });
const applied = await (review.status === 'conflicted' ? review.chooseAll('acceptTheirs') : review)
  .apply({ materializeActiveCheckout: true });
```

**The catch for this repo.** Supported public `versionStore.kind` values are
`memory`, `in-memory`, `memory-durable-snapshot`, `indexeddb`, `browser`. [DOC
`docs/guides/sdk.md`] A `MogSdkNodeFileVersionStoreConfig` **type** is exported
[SRC `runtime/sdk/src/index.ts` (version-store type exports)] but node-file is *not* in the documented
supported list — and `MOG_SDK_SUPPORTED_VERSION_STORE_KINDS` /
`MOG_SDK_UNSUPPORTED_VERSION_STORE_KINDS` are exported constants you can check at
runtime. [SRC] So a durable, disk-backed version history for `workbooks/` is
**not** a drop-in today. See [§7](#7-unrealized--underused-mog-capabilities).

---

## 5. Integration point deep dive

### 5.1 Runtime assets — WASM and fonts

**Verified layout.** `runtime/spreadsheet-app/scripts/finalize-assets.mjs` copies
`compute_core_wasm_bg.wasm` to `dist/` and eight Carlito/Caladea `.ttf` files to
`dist/assets/`, then rewrites the CSS font URLs to `./assets/<file>`. [SRC] The
embed guide confirms: *"Its package `dist` currently contains
`compute_core_wasm_bg.wasm`, `styles.css`, `mog-embed.css`, and bundled Carlito
and Caladea font files under `assets/`."* [DOC]

So `assetsFor(base)` in `mog-embed-adapter.ts:38-44` —
`{wasmBaseUrl: base, fontBaseUrl: base+'assets/', staticBaseUrl: base}` — maps
exactly onto that layout, and is **byte-identical in shape** to upstream's own
`getWebviewAssets()` in `integrations/vscode/mog-xlsx-editor/src/webview-html.ts`.
[SRC] Confirmed correct.

**`fontBaseUrl` is real.** The embed guide lists only `wasmBaseUrl`, `workerUrl`,
`staticBaseUrl`, which reads as if `fontBaseUrl` were invented here. It is not:
`SpreadsheetRuntimeAssetPolicy` declares all four
(`runtime/spreadsheet-app/src/public-types.ts:438-443`). [SRC] The doc is
incomplete; the code is right. Worth recording so nobody "cleans it up."

**`workerUrl` is correctly omitted.** Upstream's VS Code build points it at a
`media/worker.js` its own build script never emits [SRC — `build.mjs` copies
`styles.css`, the wasm, and `assets/`, and nothing named `worker.js`], and the
embed guide says outright: *"Do not assume `@mog-sdk/spreadsheet-app` publishes a
standalone public `worker.js` file to copy."* [DOC] `docs/API-EVIDENCE.md` already
records this. Confirmed.

**The wasm-bindgen self-relative fetch has no upstream counterpart.** Upstream
never hits it because every host it ships copies the wasm next to the bundle.
This repo serves from `node_modules` instead, so both URL shapes must answer —
`server/mog-assets.ts:50-51` and `server/mcp/asset-host.ts:74-75` both special-case
any path ending in `/compute_core_wasm_bg.wasm`. This is **genuinely local and
must stay.** [SRC both sides]

**Do not adopt `@mog/vite-wasm-plugin`.** It exists (`tools/vite-wasm-plugin/`),
it is a Vite plugin, and it is tempting. It is `private: true`, unpublished, and
its job is running `wasm-pack` against the monorepo's Rust crate — irrelevant to a
consumer resolving a published package. [SRC]

**The embed guide's default advice does not apply here.** *"Most bundled React
hosts should omit `assets`. The current browser transport loads `@mog-sdk/wasm`
with a dynamic import, and Vite serves the wasm-pack artifact from the installed
package."* [DOC] That is the same-origin Vite-app case. The MCP Apps lane serves
from a loopback origin the document does not share, so an explicit policy is
required there. The dev app is closer to the documented case — whether it could
drop `assets` entirely is an open experiment, not a recommendation. [UNV]

### 5.2 Stylesheet: `styles.css` vs `mog-embed.css`

```jsonc
// runtime/spreadsheet-app/package.json
"./styles.css": "./dist/styles.css",
"./mog-embed.css": { "style": "./dist/mog-embed.css", "default": "./dist/mog-embed.css" }
```

`finalize-assets.mjs` builds the second by running the first through
`postcss-mog-scope`, scoping every selector to `[data-mog-engine]`, with the
comment: *"Hosts import this single file unlayered. Scoping prevents class-name
collisions without needing CSS `@layer` isolation."* [SRC]

The guide: *"Prefer the scoped host CSS export… Host products should use
`mog-embed.css` unless they intentionally want the app stylesheet to affect the
whole page."* [DOC]

`src/adapters/index.ts:36` imports `styles.css`. The comment at
`index.ts:43-45` — *"It still lands after `src/styles.css`… so the app's own
rules keep the last word"* — is a cascade-ordering workaround for a problem the
scoped export removes structurally.

**Both exports are classified public-experimental**
[`docs/architecture/typescript-package-boundaries.md`], so neither carries a
long-term compatibility promise; switching does not move from stable to unstable.

**Before switching, two things must be checked**, and neither can be checked
without `npm install`:

1. `resolveEmbedDist()` in *both* `server/mog-assets.ts:35-38` and
   `server/mcp/asset-host.ts:42-45` resolves the dist directory via
   `require.resolve('@mog-sdk/spreadsheet-app/styles.css')`. Both CSS files live
   in the same `dist/`, so the resolution target need not change — but if it is
   changed to `mog-embed.css`, note that export has only `style` and `default`
   conditions, and `require.resolve` under Node's conditions should land on
   `default`. [INF — untested]
2. The compact-mode selectors at `src/styles.css:223-224` reach into the embed's
   DOM by Tailwind class. Scoping changes specificity. Those selectors should be
   replaced by chrome policy anyway ([§5.7](#57-chrome-policy-vs-css-surgery)) —
   ideally in the same change.

### 5.3 MCP Apps iframe: CSP, sandbox, storage

**The grant matches upstream's reference host exactly.** Upstream VS Code webview:

```
default-src 'none'; img-src ${cspSource} data: blob:; font-src ${cspSource};
style-src ${cspSource} 'unsafe-inline';
script-src 'nonce-${nonce}' 'wasm-unsafe-eval';
connect-src ${cspSource} data: blob:; worker-src ${cspSource} blob:;
```
[SRC `integrations/vscode/mog-xlsx-editor/src/webview-html.ts`]

This repo's ladder converged on `'wasm-unsafe-eval'` + `worker-src blob:` as
sufficient, with `'unsafe-eval'` never needed (the three residual violations
being caught feature probes). **Upstream's own host declares the same grant and
no more.** [SRC] That is independent corroboration for a finding this repo
established the hard way — and the general lesson is the one in
[§10](#10-future-agent-triage-checklist): read the reference host's source before
building the ladder.

**Storage shim: local, necessary, no upstream counterpart.** `sandbox="allow-scripts"`
without `allow-same-origin` yields an opaque origin, where merely *accessing*
`window.localStorage` throws. The engine reads web storage at startup. Upstream
hosts (VS Code webview, same-origin React page) never have an opaque origin, so
there is nothing upstream to reuse. `plugins/mog-canvas/ui/src/mcp-app.ts:31-35`
installs the stand-in before the engine module is imported, which is the only
ordering that works.

**Isolation claims: be precise.** Upstream states *"This is a same-page React
embed. It is not an iframe isolation boundary for hostile workbook content or
untrusted same-process code"* [DOC], and
`docs/security/KNOWN-LIMITATIONS.md` adds: *"Public same-page embeds are not
browser-origin isolation, and iframe isolation is not a released public
guarantee… do not claim iframe isolation until a reviewed iframe host/child
distribution ships."* [SRC] `docs/guides/iframe-embed.md` is **status: reserved**
— `@mog-sdk/embed/iframe`, `./client`, `./full-app`, `./host-adapters/*` are not
package exports and boundary tests assert it.

None of that forbids what this repo does. The iframe here is the **MCP host's**
sandbox, not a Mog iframe transport; the embed runs same-page *inside* it. The
rule that follows: **never describe the sandbox as a Mog-provided isolation
boundary.** The isolation belongs to Claude Code; Mog is the content.

### 5.4 The save contract and revision identity

Upstream's contract is a five-field echo. `requestSave()` transitions clean only
when the acknowledgement matches the pending save on `epoch`, `dirtyEpoch`,
`changeSequence`, `saveRequestId`, and `bytesHash`. [DOC + SRC `public-types.ts:297-338`]
`persistThroughHost` (`mog-embed-adapter.ts:303-333`) echoes all five plus
`baseVersionId`. **Correct as written.**

**The gap: `versionId` is never supplied on open.** `SpreadsheetDocumentSource`
`xlsx-bytes` accepts `{ bytes, fileName, versionId }` [SRC `public-types.ts:99-104`];
`openWorkbook` at `mog-embed-adapter.ts:293-297` passes only `bytes` and
`fileName`. Upstream's VS Code host passes `versionId: message.documentId`. [SRC]

Consequences, all small but compounding:

- `request.baseVersionId` is always undefined, so the host cannot tell from the
  save request which disk revision the canvas was based on.
- `HostServices.persist` already returns `{ versionId?: string }`
  (`src/adapters/types.ts:73`) and `persistThroughHost` already threads it into
  the `saved` result — **the return half of the loop is built and the outbound
  half is not.**
- Revision conflicts are therefore only ever discovered server-side, after bytes
  have been serialized and shipped.

Feeding Workbook Revision in as `versionId`, and returning the post-save revision
as `versionId` from `persist`, joins the engine's version identity to the
service's without inventing anything. This is an alignment, not a feature.

### 5.5 Actors, edit policy, and the missing host authority

`editModel: { user:'write', agents:'none', automation:'none' }` is canonical
`MogSpreadsheetAppProps.editModel` [SRC], and it is the mechanism behind this
repo's two-lane policy. `SpreadsheetEditLevel` also offers `'read'` and
`'approval-required'` — the latter pairs with `onApprovalRequest` and
`SpreadsheetApprovalResult`. Unused here.

**Everything privileged is gated on one absent thing.** `host.authority?:
SpreadsheetHostAuthority` (`resolveActor` + `authorize`) is not configured, so:

- `resolveActor({kind:'agent'|'host'|'automation'|'system'})` refuses;
- `undoGroup(actor, label, fn)` for a labelled agent transaction is unreachable;
- `decorations(actor)` needs `decorations:write`;
- the 20-value `SpreadsheetCapability` vocabulary (`workbook:read|write|export|
  screenshot|undo-group|policy-admin`, `decorations:write`, thirteen `version:*`)
  is never consulted.

The guide is explicit that this is fine: *"If you do not configure
`host.authority`, omit the actor for trusted-host operations or use ordinary
user actors."* [DOC] `kind:'user'` for screenshots is the documented path, not a
hack. **But every in-canvas agent capability this repo might want later starts
with implementing `SpreadsheetHostAuthority`** — one interface, two methods.

### 5.6 Runtime and session lifetime

```
SpreadsheetRuntime            shared shell services, host policy, callbacks
  └ SpreadsheetWorkbookSession   one live workbook/kernel session; usable while headless
      └ SpreadsheetAppAttachmentHandle   one mounted UI attachment; detach() unmounts UI only
```
[DOC + SRC]

**Detach is not dispose.** After `attachment.detach()` the session stays live and
`workbook.getWorkbook()` still works — upstream's own fixture writes
`activeSheet.setCell('B1', 456)` on a detached session and re-mounts.
[TEST `fixtures/external/positive/spreadsheet-app-runtime-lifecycle/smoke.tsx`]

This repo's `dispose()` (`mog-embed-adapter.ts:408-416`) detaches then disposes
the *runtime*, discarding the session on every workbook switch. That is correct
for the current single-document design.

**Upstream's tabbed-host guidance is the shape a future compare view would
want:** *"create one `SpreadsheetRuntime` at the host-app level, call
`runtime.openWorkbook(...)` once per spreadsheet tab, and render
`MogSpreadsheetApp` only for the active tab."* [DOC] Today's Compare View puts
each pane in its own iframe
([`multi-pane-canvas-embedding-via-url-flags.md`](../solutions/design-patterns/multi-pane-canvas-embedding-via-url-flags.md)),
which means separate JS realms and therefore N runtimes and N × 41 MB WASM — the
doc says so and accepts the cost for the revision-protection-for-free it buys.
**One-runtime-many-sessions cannot apply across iframes.** It would only apply to
a same-document multi-pane rewrite, which nobody has asked for. Recorded so the
option is known, not recommended.

Also note `workbookId` is *semantic* and non-unique; `workbookSessionId`
addresses an exact session, and `getWorkbookSessionByWorkbookId` returns `null`
when ambiguous. [DOC] This repo passes `workbookId: request.fileName` — fine for
one session, ambiguous the moment two panes share a file.

### 5.7 Chrome policy vs CSS surgery

`src/styles.css:222-224`:

```css
/* Hide the embed's ribbon and status bar; keep formula bar and sheet tabs. */
.app.compact .canvas .mog-spreadsheet-app-theme-scope > .shrink-0.border-b:first-child,
.app.compact .canvas .mog-spreadsheet-app-theme-scope > .shrink-0.border-t:last-child { … }
```

Upstream supports this directly:

```ts
chrome: {
  commandBar: { mode: 'mog', tabs: ['home','data','view'], hiddenGroups: ['charts'], disabledCommands: ['print'] },
  fileMenu: false, formulaBar: true, sheetTabs: true, statusBar: false,
}
```
[SRC `MogSpreadsheetChromePolicy` / `MogSpreadsheetCommandBarPolicy`,
`public-types.ts:508-527`; example in the embed guide]

The multi-pane doc already warns those selectors are "version-fragile — keep them
few, structural, and verify after SDK upgrades." The policy route removes the
fragility, is smaller, and for a 520 px side panel a curated tab set is a better
answer than hiding the whole ribbon. Compact Mode's *rule* — hide decorative
chrome, never diagnostics — is untouched by this; it is a policy for how, not
whether.

### 5.8 A small internal inconsistency

`appProps` declares `commands: { … import:'host', export:'host', … }`
(`mog-embed-adapter.ts:274-281`), but `routeCommand` denies `open`/`import`
explicitly and falls through to `denied` for everything else — including
`export`. So `export` advertises host ownership and then refuses. Upstream's VS
Code host handles `export` with `format === 'xlsx'` by posting the bytes out.
[SRC] Either handle it (the session already has `exportXlsx()`) or declare
`export: 'disabled'`. Cosmetic, but it is a lie in a policy object, which is
exactly the category this repo does not tolerate elsewhere.

### 5.9 Fixed viewport and screenshot ranges

`npm run smoke` runs at a fixed 520×900 and clicks the grid at a fixed pixel
offset. The upstream-informed improvement is already recorded in this repo's own
solutions doc — *"Navigate cells by keyboard (Ctrl+Home + arrows), not pixel
coordinates"* — and the current harness does use one click only to focus, then
keyboard. That is the right shape. Upstream adds nothing here; the grid is
canvas-painted and the formula-bar `<input>` remains the only DOM-observable
proof.

### 5.10 Plugin packaging and hosts

Entirely local. Upstream's `plugins/mog` runs the opposite direction (Codex
calling Mog). The two Codex gaps —
[openai/codex#21019](https://github.com/openai/codex/issues/21019) MCP Apps
rendering, [#19582](https://github.com/openai/codex/issues/19582)
`${CLAUDE_PLUGIN_ROOT}` interpolation — are Codex-side and unaffected by anything
upstream Mog does. **Nothing in this report changes the Codex status, and it must
stay unproven until step 4 of the host test procedure passes there.**

---

## 6. Canvas-side issues that should be researched upstream first

| # | Symptom / area | Upstream answer | Where | Confidence |
| --- | --- | --- | --- | --- |
| 1 | `#CALC!` across a grid whose file cached values are correct | **Open issue [#337](https://github.com/fundamental-research-labs/mog/issues/337)**, filed 2026-08-04 by this repo's author. Not fixed. Local fidelity gate remains the mitigation | tracker | [UNV→web] |
| 2 | 77–104 s import on ~600–900 KB workbooks; tab freeze | Tracker has *"Deferred XLSX hydration traps wasm32 on formula-dense workbooks"* — same class, likely the same report | tracker | [UNV] |
| 3 | Formulas vanish from a multi-row `setRange` | **Issue [#328](https://github.com/fundamental-research-labs/mog/issues/328)**; use `setFormulas`/`setCells`. Does not reproduce at 0.10.5 in `workbooks/sample.xlsx` | tracker + local fixture | [TEST locally] |
| 4 | Guessing SDK method names | `api.describe('ws.tables.add')`, `api.describe('type:TableOptions')` | `runtime/sdk/src/api-describe.ts` | [SRC] |
| 5 | Office-JS-shaped generated code | `api.guidance.preflight(source)`; 16 blocking dialect entries | `runtime/sdk/src/generated/api-guidance.json` | [SRC] |
| 6 | Which CSP grant does the engine need? | Upstream's own webview CSP: `'wasm-unsafe-eval'` + `worker-src blob:` | `integrations/vscode/.../webview-html.ts` | [SRC] |
| 7 | Where do fonts/wasm live in the package? | `dist/compute_core_wasm_bg.wasm`, `dist/assets/*.ttf` | `runtime/spreadsheet-app/scripts/finalize-assets.mjs` | [SRC] |
| 8 | Is `fontBaseUrl` real? | Yes — `SpreadsheetRuntimeAssetPolicy` has all four fields; the guide is incomplete | `public-types.ts:438-443` | [SRC] |
| 9 | Page-wide CSS bleed from the embed | Use `mog-embed.css`, scoped to `[data-mog-engine]` | package exports + guide | [SRC+DOC] |
| 10 | Hiding ribbon/status bar without CSS surgery | `chrome.commandBar` / `chrome.statusBar` policy | `public-types.ts:508-527` | [SRC] |
| 11 | Why does a privileged actor get refused? | No `host.authority` registered; `kind:'user'` is the documented path | embed guide | [DOC] |
| 12 | `wb.dispose()` "returns undefined instead of a Promise" | It is **documented** as `dispose(): void`. Not a quirk. (`SpreadsheetWorkbookSession.dispose()` *is* `Promise<void>` — two different disposes) | `api-reference.json` | [SRC] |
| 13 | `A1:H30` is not the sheet | `ws.getUsedRange()`, `findLastRow`, `findLastColumn`, `findDataEdge` | `api-reference.json` | [SRC] |
| 14 | Opaque error text from a failed reopen | `MogSdkError` carries `code`, `operation`, `path`, `suggestion`, `details`, `diagnostics.issueCode` | sdk guide | [DOC] |
| 15 | Import silently dropped a feature | `wb.importWarnings` | `api-reference.json` | [SRC] |
| 16 | Can we branch/merge scenarios? | `wb.version.*` is public, but no supported **disk-backed** store kind | sdk guide + `version-store.ts` | [DOC+SRC] |

**Correction to a note in this repo.** `workbook-service.ts:794-796` reads: *"`dispose()`
has been observed returning undefined instead of a Promise on some paths in
0.10.5, so never chain onto its return value."* The observation is right and the
defensive code is right; the framing is off — `Workbook.dispose()` is *specified*
as `void`. Only the wording invites a future reader to treat it as a bug to chase.

---

## 7. Unrealized / underused Mog capabilities

Status per entry: **READY** (public, stable, usable now) · **VERIFY** (public,
needs a local check) · **EXPERIMENTAL** (public-experimental) · **NO** (internal /
reserved — do not use) · **N/A** (irrelevant to current goals).

| Capability | Upstream surface | Status | Value here |
| --- | --- | --- | --- |
| **API introspection** | `api.describe(...)` | **READY** | Kills the proxy-guessing failure mode outright. Highest ratio of value to effort in this table |
| **Codegen preflight** | `api.guidance.analyze/preflight/explain` | **READY** | Any tool that ever accepts model-written Mog code should gate on it |
| **Import warnings** | `wb.importWarnings` | **READY** | A second, independent open-time signal beside value fidelity. Free |
| **Used-range discovery** | `ws.getUsedRange`, `findLastRow/Column`, `findDataEdge` | **READY** | Replaces three hard-coded `A1:H30` |
| **Screenshot options** | `dpr`, `showHeaders`, `showGridlines`, `maxWidth`, `maxHeight` | **READY** | Bounded, legible review images at any sheet size |
| **Structured errors** | `MogSdkError` + `MogSdkErrorCode` | **READY** | Machine-actionable MCP failures instead of prose |
| **Formula-safe writes** | `ws.setFormulas`, `ws.setCells` | **READY** | Removes the #328 hazard class from the headless lane |
| **Chrome policy** | `chrome.commandBar{tabs,hiddenGroups,disabledCommands}`, `statusBar` | **READY** | Replaces version-fragile CSS; better small-pane layout |
| **Feature gates** | `featurePolicy.capabilities` — `freezePanes`, `dataValidation`, `conditionalFormatting`, `datePicker`, `contextMenu`, `undo`, `redo`, `print`, `export`, `versionControl` | **READY** | Narrow the surface a human can reach in a side panel |
| **`versionId` on source → `baseVersionId` on save** | `SpreadsheetDocumentSource`, `SpreadsheetSaveRequest` | **READY** | Joins Workbook Revision to the engine's save contract |
| **Save-state stream** | `onSaveStateChange` (`clean\|dirty\|saving\|error`) | **READY** | Richer than the `onDirtyChange` this repo uses; would tighten the status surface |
| **Attachment-state stream** | `onAttachmentChange`, `SpreadsheetAttachmentState` (7 states incl. `attach-failed`) | **READY** | A first-class answer to Renderer Readiness, which is polled today |
| **Detached programmatic access** | `session.getWorkbook()` while UI is detached | **READY** | A path to canvas-state (not disk-state) reads without a mounted UI |
| **Decorations** | `session.decorations(actor)` — fill/border/pulse/shimmer on a range | **VERIFY** | Highlight the ranges an agent touched, in the live canvas. Needs a `host.authority` for `decorations:write` |
| **Slots** | `attachment.slot('above-grid'\|'below-command-bar').set(ReactNode)` | **VERIFY** | Would put the fidelity warning *inside* the canvas. Friction: slots take React nodes; `mcp-app.ts` is vanilla TS |
| **Host authority** | `SpreadsheetHostAuthority` + `onApprovalRequest` | **VERIFY** | The gateway to in-canvas agent edits with approval flows. Would be a deliberate policy change, not plumbing |
| **`undoGroup`** | `session.undoGroup(actor, label, fn)` | **VERIFY** | One labelled undo entry per agent transaction. Needs an authority |
| **Version history** | `wb.version.*`, `versionStore` | **VERIFY / partly unsupported** | Branch-and-merge scenarios are compelling, but supported store kinds are memory/indexeddb/browser. **No supported disk store.** The flight recorder is the local answer today |
| **`ws.toCSV/toJSON`** | with formula-injection escaping | **READY** | Safer than a hand-rolled export if one is ever wanted |
| **`@mog-sdk/embed`** | React / web-component read-only embeds | **EXPERIMENTAL** | A lighter viewer for compare panes — but read-only, so it cannot replace the editing canvas |
| **`@mog-sdk/sheet-view`** | `createSheetView()` | **READY**, wrong tool | Grid only, no formula bar or sheet tabs. Would violate "the canvas is the real thing" |
| **CSS subpaths** | `styles.css`, `mog-embed.css` | **EXPERIMENTAL** | Both; no long-term compat promise either way |
| **`@mog-sdk/embed/iframe`** | reserved | **NO** | Not exported; boundary tests assert it fails |
| **`@mog-sdk/kernel`, `@mog/transport`, `@mog/shell`, `@mog/ui`, `@mog/app-spreadsheet`, `types/*`** | internal / reserved / private | **NO** | See [§9](#9-boundary-rules-what-not-to-import-assume-or-work-around) |
| **`@mog/vite-wasm-plugin`** | private tool | **NO** | Builds the monorepo's Rust crate; meaningless to a package consumer |
| **CRDT / collaboration** | Rust-side, host routes updates | **N/A** | Single-user local canvas; nothing to route |
| **HTTP service / self-hosting / Python SDK** | reserved or out of scope | **N/A** | |

**Explicitly not a gap:** the byte-first stack (`workbook-profile`, `-graph`,
`-briefing`, `sheet-schema`, `consumption-index`, `formula-refs`) duplicates
*information* the engine could also produce, and duplicates it on purpose. The
engine takes ~90 s to hydrate a large workbook; the briefing answers in
milliseconds, states which stages did not run, and — after #337 — is the *more*
trustworthy of the two for as-saved values. Do not "consolidate" it onto
`ws.summarize()` / `wb.searchAllSheets()`.

Related: `ws.summarize(options)` accepts `{ includeData, maxRows, maxCols }`.
`workbook-service.validate()` calls it with no options, which keeps sample cell
data out of the report. Given this repo's no-raw-values rule for briefings,
**leave it that way** — `includeData: true` would emit cell values through a path
that has no redaction guard.

---

## 8. Anti-friction recommendations

Ordered by value ÷ risk. **D** = documentation-only. **C** = code change. None
are implemented here.

### 8.1 (D) Put the upstream tracker in the triage path
Add one line to `AGENTS.md` and to the triage checklist: *before diagnosing engine
behavior, search
`https://github.com/fundamental-research-labs/mog/issues`.* Thirteen issues are
open; at least three describe behavior this repo has already paid for. Zero risk,
immediate return.

### 8.2 (D) Record the upstream corroborations in `docs/solutions/`
Three entries deserve an "upstream says the same thing" line, because the next
reader should not re-derive them:
- CSP doc → `integrations/vscode/mog-xlsx-editor/src/webview-html.ts`
- SDK-gotchas doc → `api.describe` / `api.guidance.*` as the standing cure for
  proxy-guessing; and `Workbook.dispose(): void` is the spec, not a quirk
- `#CALC!` doc → issue #337, still open

### 8.3 (C, small) Switch `scripts/headless-edit.mjs` to `setFormulas`
Values via `setRange`, the `Total`/`Gross profit` formulas via `setFormulas`, and
a post-write assertion that `getFormulas` still returns formulas on every row.
The bug does not bite at 0.10.5; the assertion is what makes a future SDK bump
fail loudly instead of quietly producing a formula-free fixture.

### 8.4 (C, small) Carry `MogSdkError` through `WorkbookError`
`workbook-service.ts:866-870` and `captureScreenshot` currently keep only
`error.message`. Adding `sdkCode`, `operation`, and `diagnostics.issueCode` to
`WorkbookError.details` gives MCP callers something to branch on. The taxonomy
does not change; the details object gets richer. Keep the message text as is.

### 8.5 (C, medium) Move from `styles.css` to `mog-embed.css`
Scoped to `[data-mog-engine]`, which is what upstream tells hosts to use. Do it
together with 8.6 so the compact-mode selectors are replaced rather than
re-tuned. Needs `npm run verify` (both fallback paths still fault correctly),
`check:app`, and a visual pass at 520×900. **This is the change most likely to
have a surprise in it** — it alters cascade and specificity for the whole panel.

### 8.6 (C, medium) Replace compact-mode CSS surgery with chrome policy
`chrome: { commandBar: false | {tabs:[…]}, statusBar: false }` driven by the same
`?compact=1` flag. Deletes `src/styles.css:222-224`. The Compact Mode invariant is
unaffected: diagnostics are the host's chrome, not the embed's.

### 8.7 (C, small) Derive the screenshot range from the used range
Headless: `ws.getUsedRange()` clamped by `ScreenshotOptions.maxWidth/maxHeight`.
Canvas: the current selection, or the used range, with `A1:H30` kept only as the
fallback. Three call sites. Update the two places the README and plugin doc
promise `A1:H30`.

### 8.8 (C, small) Feed and return `versionId`
Pass Workbook Revision as `source.versionId` on open; return the new revision as
`versionId` from `HostServices.persist`. The return path already exists
(`types.ts:73`). Makes `baseVersionId` meaningful in every save request.

### 8.9 (C, small) Read `wb.importWarnings` on validate
Surface it in `ValidationReport` beside `fidelity`. It is an independent
statement from the engine about what it dropped, and it costs one property read
on a workbook that is already open.

### 8.10 (C, small) Fix the `export` command inconsistency
Either handle `export` in `routeCommand` (the session has `exportXlsx()`) or
declare `export: 'disabled'`. §5.8.

### 8.11 (C, medium) Adopt `onSaveStateChange` / `onAttachmentChange`
`watchRendererReadiness` polls `getStatus()` every 500 ms and then probes
`view().getActiveSheet()`. The probe is genuinely load-bearing — upstream's
`ready` status precedes the renderer being able to answer, which is the whole
Renderer Readiness concept — so **do not delete it.** But subscribing to
`onAttachmentChange` alongside it would surface `attach-failed` / `detach-failed`
immediately instead of on the next tick, and `onSaveStateChange` carries a
`saving` and an `error` state the current `onDirtyChange` wiring cannot see.

### 8.12 (D) Document the two `dispose` contracts
`Workbook.dispose(): void` (SDK) vs `SpreadsheetWorkbookSession.dispose():
Promise<void>` (embed). One line in the SDK-gotchas solution doc.

### 8.13 (Later, C, large) `SpreadsheetHostAuthority`
Only if in-canvas agent edits, decorations, or approval flows are ever wanted.
Implementing it is the prerequisite for all three. It is a **policy change** — it
would let an agent edit in the human's lane — so it needs a decision, not a
refactor.

---

## 9. Boundary rules: what not to import, assume, or work around

### 9.1 Never import

Enumerated by upstream's own negative fixtures (`fixtures/external/negative/`,
18 of them), each asserting the import must fail outside the monorepo. [SRC+TEST]

| Do not import | Because |
| --- | --- |
| `@mog-sdk/kernel` (and `/host-lifecycle-internal`) | `private: true`, workspace-internal |
| `@mog/kernel-host-internal`, `@mog/kernel/*` | internal implementation |
| `@mog/transport`, `@mog/charts`, `@mog/table-engine`, `@mog/spreadsheet-utils`, `@rust-bridge/client` | workspace-internal |
| `@mog/shell`, `@mog/ui` | reserved |
| `@mog/app-spreadsheet` (and `/kernel-api`, `/shell`) | private product package |
| `@mog/types-*`, `@mog-sdk/types-*`, `@mog-sdk/types-host`, `@mog-sdk/spreadsheet-contracts` | workspace-internal type shards |
| `@mog-sdk/spreadsheet-app/internal`, `/src/*`, or any repo path | only `.`, `./styles.css`, `./mog-embed.css` are exported |
| `@mog-sdk/embed/iframe`, `/client`, `/full-app`, `/renderer*`, `/host-adapters/*`, `/publish` | not exports; reserved or bundle-private |
| `@mog-sdk/sheet-view/*` deep paths, `@mog/sheet-view` | root export only; the legacy name is unpublished |
| `@mog-sdk/sdk` deep paths / host-adapters | only `.`, `./node`, `./wasm`, `./workerd`, `./version-store` |
| `@mog-sdk/spreadsheet-app/package.json` | not exported — resolve `dist/` via an exported CSS subpath, as both asset servers already do |
| `@mog/vite-wasm-plugin` | private; builds the monorepo's Rust crate |

### 9.2 Never assume

- **That a `.d.ts` you can see is public.** *"APIs marked `public-experimental`
  are source-visible or shipped through a public package but do not yet carry a
  long-term compatibility promise."* [DOC] And: *"Low-level headless boot helpers
  and collaboration wrappers are compatibility/internal implementation surfaces
  in the SDK declarations; they are not the guide path."* [DOC] So
  `createHeadlessEngine`, `HeadlessEngine`, `CollaborativeEngine` are exported
  from `@mog-sdk/sdk` and are still not the path.
- **That the guides are complete.** `fontBaseUrl` is in the type and not in the
  guide. Check `public-types.ts` and the package manifest before concluding a
  field does not exist.
- **That the engine's agreement with itself is evidence.** The definitional
  lesson of `#CALC!` / 0 ms recalculation, already load-bearing in
  `CONCEPTS.md`'s Value Fidelity.
- **That Mog provides isolation.** Same-page embed, explicitly not an isolation
  boundary; iframe embed reserved. The MCP sandbox is Claude Code's.
- **That upstream will accept a fix.** Contributing guidance: *"The best way to
  contribute right now is to report bugs."* [DOC]

### 9.3 Never work around

- **Do not shim a missing engine API by reaching into internals.** If a capability
  is not on a public export, the answer is an upstream issue (this repo has filed
  one and it worked) plus a documented local limitation.
- **Do not bypass `server/workbook-service.ts`.** Not `wb.save(path)`, not `fs`
  with a caller-supplied path.
- **Do not weaken the value-fidelity gate to admit a workbook the engine got
  wrong.** Its refusal is the whole point.
- **Do not draw a fake grid, and do not hide a probe failure to save space.**
  Both are `AGENTS.md` invariants with checks behind them.
- **Do not soften the Codex status.** Nothing upstream changes it.

---

## 10. Future-agent triage checklist

For any `mog-codex-canvas` problem, in order. Stop as soon as an answer is
found.

**0. Is it already known?**
`docs/solutions/` first (15 entries, grouped by kind), then **the upstream
tracker** (`fundamental-research-labs/mog/issues` — 13 open as of 2026-08-06),
then this file. *Example: `#CALC!` across a grid → both a solution doc and issue
#337.*

**1. Reproduce or locate the symptom, and say which kind of evidence you have.**
A named command? A host observation? A read of source? These are different
claims and `AGENTS.md` requires keeping them apart.

**2. Name the surface.**

| Symptom shape | Surface |
| --- | --- |
| Wrong values in a rendered grid | engine import path → upstream |
| Save refused | `workbook-service.ts` — which of the four refusal codes? |
| Nothing renders / probe failed | `src/adapters/` |
| WASM/font 404 or `expected magic word` | `mog-assets.ts` / `asset-host.ts` |
| Iframe blank, stuck at "mounting canvas" | host CSP, `mcp-app.ts` storage shim |
| Tool arguments or descriptions wrong | `server/mcp/mog-canvas-server.ts` |
| Numbers that disagree with the file | byte-first stack vs engine — **which one is the file's own record?** |
| Plugin not loading | `plugins/mog-canvas/`, launcher, marketplace manifests |

**3. Check local invariants before proposing anything.**
`AGENTS.md` "Invariants"; `CONCEPTS.md` for any term with a project meaning
(Workbook Root, Value Fidelity, Fidelity Verdict, Sheet Role, Progressive
Retrieval, Adapter Probe, Renderer Readiness, Editing Lane). If a fix needs a
check weakened, the fix is wrong.

**4. Search upstream, in this order.**
`docs/guides/*.md` → `runtime/spreadsheet-app/src/public-types.ts` and
`docs/generated/api-reference.json` → `package.json` `exports` → upstream's own
host implementations (`integrations/vscode/mog-xlsx-editor/` is the reference
embedding) → `fixtures/external/positive|negative/` → tests. **Never conclude from
a package or method name alone** — that mistake is already in this repo's
solutions log three times over.

**5. Decide where the fix belongs.**

| Belongs | When |
| --- | --- |
| **Upstream (file an issue)** | The engine computes, imports, or exports something wrong. Report the *wrong result*, not the slowness — file performance separately |
| **`src/adapters/`** | Host policy: chrome, commands, edit model, actors, assets, readiness |
| **`workbook-service.ts` / `path-policy.ts`** | Anything about disk, identity, durability, containment, or admission |
| **byte-first stack** | Anything that must answer before the engine is ready, or must not trust it |
| **`server/mcp/`** | Tool shape, descriptions, resource metadata, CSP declarations |
| **`docs/`** | The behavior is correct and only the expectation was wrong |
| **`scripts/`** | A claim in the README is not backed by a command |

**6. Name the minimum verification.**

| Touched | Run |
| --- | --- |
| anything | `npm run typecheck && npm test && npm run verify` |
| adapter / mount / canvas | `+ npm run check:app` |
| MCP tools or resource | `+ npm run check:mcp` |
| plugin package or launcher | `+ npm run check:plugin` |
| dev-app browser behavior | `+ npm run smoke` (needs `npm run dev`) |
| SDK version bump | **all of them**, plus re-run the numbered host test procedure, plus re-check `workbooks/sample.xlsx` still carries `<f>` on rows 2-4 |

**7. Write it down.** New non-obvious learning → a `docs/solutions/` entry, with
the disproven hypotheses kept visible.

---

## 11. Evidence table

| # | Path | Finding | Source type | Confidence | Implication |
| --- | --- | --- | --- | --- | --- |
| 1 | upstream issues #337 | The `#CALC!` defect is filed and open; author `melanson633`, 2026-08-04 | tracker via web | **[UNV→web]** — could not enumerate via scoped GitHub API | Fidelity gate stays; check tracker first |
| 2 | upstream issues #328 | `setRange` multi-row formula loss at 0.10.4; `setFormulas`/`setCells` named as safe | tracker via web | **[UNV→web]** | §8.3 |
| 3 | `workbooks/sample.xlsx` → `xl/worksheets/sheet1.xml` | `<f>` present on D2, D3, B4, C4, D4 | read of tracked bytes | **[TEST]** | #328 does **not** reproduce at 0.10.5 here |
| 4 | `runtime/spreadsheet-app/package.json` + `docs/guides/spreadsheet-app-embed.md` | `mog-embed.css` is the export hosts should use | SRC + DOC | **verified** | §8.5 |
| 5 | `runtime/spreadsheet-app/scripts/finalize-assets.mjs` | `mog-embed.css` = `styles.css` scoped to `[data-mog-engine]` via postcss | SRC | **verified** | Structural fix for cascade ordering |
| 6 | same | wasm → `dist/`, 8 fonts → `dist/assets/` | SRC | **verified** | `assetsFor()` mapping is correct |
| 7 | `runtime/spreadsheet-app/src/public-types.ts:438-443` | `SpreadsheetRuntimeAssetPolicy` has `fontBaseUrl` | SRC | **verified** | Guide is incomplete; don't "clean up" the field |
| 8 | `integrations/vscode/.../webview-html.ts` | Upstream host CSP = `'wasm-unsafe-eval'` + `worker-src blob:` | SRC | **verified** | Corroborates the CSP ladder result |
| 9 | `integrations/vscode/.../webview-html.ts` `getWebviewAssets` | Identical asset-base shape to `assetsFor()` | SRC | **verified** | This repo's mapping is the reference mapping |
| 10 | `integrations/vscode/.../build.mjs` | Copies wasm + `assets/`; emits no `worker.js` | SRC | **verified** | `workerUrl` correctly omitted |
| 11 | `public-types.ts:99-104, 297-338` | `versionId` on source → `baseVersionId` on save | SRC | **verified** | §8.8 |
| 12 | `src/adapters/types.ts:73` | `persist` already returns `{versionId?}` | SRC (local) | **verified** | Return half of the loop exists |
| 13 | `runtime/sdk/src/generated/api-guidance.json` | 17 entries, 16 blocking Office-JS matchers | SRC | **verified** | §4.11 |
| 14 | `runtime/sdk/src/api-describe.ts` + `generated/api-spec.json` | Runtime introspection with source locations | SRC | **verified** | §4.10 |
| 15 | `docs/generated/api-reference.json` | 249 `Workbook` + 653 `Worksheet` members | SRC | **verified** | Surface far exceeds either repo's docs |
| 16 | same | `ws.getUsedRange(): Promise<WorksheetRange \| null>` | SRC | **verified** | §8.7 |
| 17 | same | `ws.setFormulas(range, formulas[][])` | SRC | **verified** | §8.3 |
| 18 | same | `Workbook.dispose(): void` (documented) | SRC | **verified** | Corrects a local comment's framing |
| 19 | `types/api/src/api/types.ts:2751` | SDK `ScreenshotOptions`: dpr/showHeaders/showGridlines/maxWidth/maxHeight | SRC | **verified** | Distinct from the embed's option type |
| 20 | `runtime/sdk/package.json` exports | Root conditions order `workerd→node-addons→node→browser→default`; browser ⇒ `wasm.d.ts` | SRC | **verified** | Confirms why `/node` is needed under `bundler` |
| 21 | `docs/guides/sdk.md` | Supported `versionStore.kind`: memory, in-memory, memory-durable-snapshot, indexeddb, browser | DOC | **documented** | No supported disk-backed store |
| 22 | `runtime/sdk/src/index.ts` (version-store type exports) | `MogSdkNodeFileVersionStoreConfig` type is exported | SRC | **verified** | Typed ≠ supported; do not infer support |
| 23 | `fixtures/external/negative/*` (18) | Enumerates every forbidden import | SRC+TEST | **verified** | §9.1; this repo currently violates none |
| 24 | `docs/architecture/typescript-package-boundaries.md` | Both CSS subpaths are public-experimental | DOC | **documented** | Switching does not lose stability |
| 25 | `docs/security/KNOWN-LIMITATIONS.md` | Same-page embeds are not origin isolation; iframe isolation not shipped | SRC | **verified** | Never claim Mog-provided sandbox isolation |
| 26 | `docs/guides/iframe-embed.md` | Status **reserved**; `./iframe` not an export | DOC | **documented** | §9.1 |
| 27 | `tools/vite-wasm-plugin/package.json` | `private: true`; builds the Rust crate | SRC | **verified** | Do not adopt |
| 28 | `public-types.ts:508-527` | `MogSpreadsheetChromePolicy` / `CommandBarPolicy` | SRC | **verified** | §8.6 |
| 29 | `src/styles.css:222-224` | Compact mode hides embed chrome via Tailwind-class selectors | SRC (local) | **verified** | Replace with policy |
| 30 | `public-types.ts:170-180`, embed guide | Privileged actors need `host.authority`; `kind:'user'` resolves directly | SRC + DOC | **verified** | `SCREENSHOT_ACTOR` is correct |
| 31 | `fixtures/.../spreadsheet-app-runtime-lifecycle/smoke.tsx` | Detached session still accepts `setCell`; re-mount works | TEST | **verified** | Detach ≠ dispose |
| 32 | embed guide, "Ownership Model" | One runtime, many sessions, one attachment per session | DOC | **documented** | Applies only to same-document multi-pane |
| 33 | `src/adapters/mog-embed-adapter.ts:274-281, 358-362` | `export:'host'` declared, then denied | SRC (local) | **verified** | §8.10 |
| 34 | `docs/internals/spreadsheet/known-formula-discrepancies.md` | Accepted f64/precision differences vs Excel cached values (KFD-001…) | DOC | **documented** | A fidelity `failed` on a *numeric* near-cancellation could be a known accepted difference, not a defect — the gate only refuses error-literal mismatches, so it is unaffected, but a future widening must read this page first |
| 35 | `file-io/xlsx/parser/src/domain/tables/*` (Rust) | `calculatedColumnFormula` handling is workspace-internal Rust | SRC | **verified** | The #337 defect is not inspectable or patchable from the canvas side |
| 36 | `docs/guides/sdk.md` | *"formulas are recalculated before the write resolves"* | DOC | **documented** | `calculate()` is for circular/iterative models only |
| 37 | `api-reference.json` | `wb.importWarnings` | SRC | **verified** | §8.9 |
| 38 | `api-reference.json` | `ws.toCSV` escapes `= + - @` against formula injection | SRC | **verified** | Prefer it over a hand-rolled CSV export |

---

## 12. Open questions / blockers

1. **No engine was run.** `npm install` was not performed (≈110 MB embed + 41 MB
   WASM + native bindings). Every claim about *runtime* behavior is [SRC]/[DOC],
   never [TEST], except the OOXML byte read of `workbooks/sample.xlsx`. Anything
   marked VERIFY in §7 stays VERIFY.
2. **The upstream tracker was read through a web fetch, not the GitHub API.**
   This session's GitHub tool scope covers only `melanson633/mog-codex-canvas`.
   I confirmed issue numbers and authors for #337 and #328 and the 13-open count;
   I did **not** open the other eleven. The "Deferred XLSX hydration traps
   wasm32" title matches this repo's ~90 s import observation but I did not
   confirm its number, author, or body. **Next agent: read all 13.**
3. **Does `mog-embed.css` actually resolve through `require.resolve`?** Its
   export declares only `style` and `default` conditions. Untested.
4. **Does the dev app still need an explicit `assets` policy at all?** The embed
   guide says most bundled React hosts should omit it. The wasm-bindgen
   self-relative fetch may make the answer "yes regardless," but it has not been
   tried. The MCP lane definitely needs it.
5. **Is the ~90 s hydration cost fixed, filed, or expected at 0.10.5?** Only
   inferable from a tracker title.
6. **Is there a supported disk-backed `versionStore`?** The docs say no; a
   node-file config *type* is exported. Someone should ask upstream rather than
   guess from a type.
7. **Would `chrome.statusBar: false` / `commandBar: {…}` actually produce the
   compact layout the CSS produces today?** Layout parity is unverified.
8. **Slots take React nodes; the MCP component is vanilla TS.** Whether a slot can
   be fed without pulling React into that bundle is unknown, and pulling React in
   would change the bundle's size and the CSP surface.
9. **The clone is shallow (`--depth 1`).** No history, no blame, no ability to see
   when a behavior changed. `git fetch --unshallow` if that matters.
10. **Version pinning.** Upstream `main` is at `0.10.5` for both packages, matching
    this repo's `^0.10.5`. Convenient today; every finding here should be
    re-checked against the manifest after any bump.

---

## 13. Suggested next implementation prompts

**Do not implement these here.** Each is scoped to be a separate, verifiable
change. Priority is value ÷ risk.

### P0 — documentation only, no code risk

1. *"Add upstream-tracker triage to `AGENTS.md` and `docs/solutions/`: before
   diagnosing engine behavior, search `fundamental-research-labs/mog/issues`. Add
   the issue #337 reference to the `#CALC!` solution doc and note it is still
   open."*
2. *"Read all 13 open upstream issues and add a `docs/solutions/` entry for every
   one that touches a surface this repo uses (tables, setRange, names, formats,
   error contract, XLSX writer, hydration). State for each whether it reproduces
   here."*
3. *"Correct the `dispose()` note in `server/workbook-service.ts:794-796`:
   `Workbook.dispose()` is specified as `void`; the defensive code stays, the
   framing changes. Add both dispose contracts to the SDK-gotchas solution doc."*
4. *"Add an 'upstream corroboration' line to the CSP solution doc pointing at
   `integrations/vscode/mog-xlsx-editor/src/webview-html.ts`."*

### P1 — small, well-bounded code changes

5. *"Rewrite `scripts/headless-edit.mjs` to write values with `setRange` and
   formulas with `setFormulas`, and assert with `getFormulas` that every written
   row still carries a formula after the save/reopen cycle. Gate: `npm test &&
   npm run verify`."*
6. *"Carry `MogSdkError` fields (`code`, `operation`, `diagnostics.issueCode`)
   into `WorkbookError.details` at every `@mog-sdk/sdk` call site in
   `workbook-service.ts`. Do not change `WorkbookErrorCode`. Gate: `npm test &&
   npm run check:mcp`."*
7. *"Derive screenshot ranges from `ws.getUsedRange()` (headless) and the current
   selection (canvas), clamped by `ScreenshotOptions.maxWidth/maxHeight`, keeping
   `A1:H30` as the fallback. Update the three call sites and the two docs that
   promise `A1:H30`. Gate: `npm run verify && npm run check:app`."*
8. *"Pass Workbook Revision as `source.versionId` on `openWorkbook`, and return
   the post-save revision as `versionId` from `HostServices.persist` in both
   lanes. Gate: `npm run check:app && npm run check:mcp`."*
9. *"Surface `wb.importWarnings` in `ValidationReport` and in the
   `validate_workbook` tool output, beside `fidelity`. Gate: `npm test && npm run
   check:mcp`."*
10. *"Resolve the `export` command inconsistency in
    `src/adapters/mog-embed-adapter.ts` — either handle it via
    `session.exportXlsx()` or declare `export: 'disabled'`. Gate: `npm run
    check:app`."*

### P2 — medium, needs visual verification

11. *"Switch `src/adapters/index.ts` from `@mog-sdk/spreadsheet-app/styles.css`
    to `mog-embed.css`, confirm `resolveEmbedDist()` still resolves in both
    `server/mog-assets.ts` and `server/mcp/asset-host.ts`, and verify the panel
    at 520×900 in both lanes. Gate: `npm run verify && npm run check:app && npm
    run smoke`."*
12. *"Replace the compact-mode embed-DOM selectors (`src/styles.css:222-224`)
    with `chrome: { commandBar, statusBar }` policy driven by `?compact=1`.
    Preserve the Compact Mode invariant that diagnostics are never hidden. Gate:
    `npm run smoke` plus a measured grid-height comparison against the ~213 px
    the multi-pane doc records."*
13. *"Subscribe to `onAttachmentChange` and `onSaveStateChange` alongside the
    existing readiness poll — do not remove the poll, which is what distinguishes
    'mounted' from 'can answer'. Surface `attach-failed`, `saving`, and `error`
    in the status line. Gate: `npm run check:app`."*

### P3 — exploratory, decision required before code

14. *"Prototype an `api.guidance.preflight` gate for any tool that would accept
    model-authored Mog code, and an `api.describe`-backed MCP tool for API
    lookup. Decide first whether this repo wants a code-execution surface at
    all — today it deliberately has none."*
15. *"Evaluate `SpreadsheetHostAuthority`: what would change if agents could edit
    in the canvas lane with approval flows, decorations marking touched ranges,
    and `undoGroup`-labelled transactions. This is a change to the two-lane edit
    policy, so it needs a decision recorded in `AGENTS.md` before any code."*
16. *"Ask upstream whether a disk-backed `versionStore` is supported or planned.
    If not, document that the flight recorder is this repo's version history and
    close the question."*
17. *"Test whether the dev app can drop the explicit `assets` policy entirely
    (the embed guide says most bundled React hosts should), given the
    wasm-bindgen self-relative fetch. Expect the answer to be no; record it
    either way."*

---

### Provenance

Written 2026-08-06 against `mog-codex-canvas` @ `f49d522` and a shallow clone of
`fundamental-research-labs/mog` @ `main`, both packages at `0.10.5`. No code was
changed. No command in this repo was executed. Upstream issue metadata was read
through web fetches of `github.com/fundamental-research-labs/mog/issues`, not
through an authenticated API, and is the least-verified material here.
</content>
</invoke>
