# Working in this repo

A live Mog spreadsheet canvas over real `.xlsx` files on disk, in two forms —
a Claude Code plugin (`plugins/mog-canvas/`) and a standalone dev app — sharing one
workbook service and one security policy. Read [`README.md`](README.md) first
for what the project is; this file is how to change it without breaking the
parts that are load-bearing.

## Setup

Requires Node **22.18.0+** (on the 23.x line, **23.6.0+** — 23.0–23.5 will not
work). The server entry is TypeScript run directly by Node's type stripping,
which is unflagged only from those releases. See `engines.node` in
`package.json`.

```bash
npm install
npm run dev        # http://127.0.0.1:5273
```

If `workbooks/` is empty, `npm run headless` writes a sample.

## Checks

| Command | Needs |
| --- | --- |
| `npm run typecheck` | — |
| `npm test` | — |
| `npm run verify` | — (no browser) |
| `npm run smoke` | `npm run dev` running in another shell |
| `npm run check:mcp` | — |
| `npm run check:app` | — |
| `npm run check:plugin` | — |

`npm run typecheck && npm test && npm run verify` is the fast gate for most
changes. Touching the MCP or plugin lane adds `check:mcp` / `check:plugin`;
touching the canvas or its mount adds `check:app`.

`plugins/mog-canvas/ui/dist` is a gitignored build artifact that the MCP server
serves and `check:app` drives, and it is built from `src/` as well as the
component's own sources. `check:app` rebuilds it when this checkout's sources
have moved since the last build; `check:mcp` says so but does not rebuild, since
nothing it asserts drives the canvas. `npm run check:ui-bundle` answers the
question on its own, and `npm run build:mcp-app` records what it built from.

## Invariants

These are enforced by checks, not just convention. Breaking one usually means
a check fails — if you find yourself weakening a check to make a change pass,
stop and reconsider the change.

- **The React shell never imports `@mog-sdk/*`.** It talks to
  `src/adapters/types.ts`. Only `resolveCanvasAdapter()` imports the real
  module *and* its stylesheet, in the same guarded path. `npm run verify`
  transforms the entry and asserts no `@mog-sdk` code is reachable from it,
  then faults each import in turn to prove the fallback.
- **Never draw a fake grid.** If the adapter fails to resolve,
  `src/adapters/unavailable-adapter.ts` renders the real reason and every
  session method throws. A mock grid that looks like it works is worse than a
  visible failure.
- **Never hide a failure to reduce chrome.** A density flag means "show less
  chrome," never "show fewer failures" — hide a container's decorative
  children, not the container. See
  [`docs/solutions/ui-bugs/compact-mode-hid-adapter-failure-warning.md`](docs/solutions/ui-bugs/compact-mode-hid-adapter-failure-warning.md).
- **All disk access goes through `server/workbook-service.ts`.** It owns
  containment, revision checks, backups, and staged writes. Do not reach for
  `fs` with a caller-supplied path — absolute paths, traversal, junction
  escapes, and NTFS alternate data streams are all rejected there for reasons
  documented in
  [`docs/solutions/security-issues/windows-path-containment-traps.md`](docs/solutions/security-issues/windows-path-containment-traps.md).
- **High-risk personal data is never emitted with statistics.** The R38 guard
  in `server/redaction.ts` runs ahead of every statistic, on every return path,
  and no option lifts it — a column naming an SSN, taxpayer ID, or birthdate is
  reported present and redacted, never omitted. When changing anything that
  supplies it a header, the question is whether the name it reads and the column
  it protects are still the same column; every leak so far has been a
  misalignment, not a logic error. See
  [`docs/solutions/security-issues/redaction-guards-fail-by-misalignment-not-by-logic.md`](docs/solutions/security-issues/redaction-guards-fail-by-misalignment-not-by-logic.md).
- **`workbooks/` is the only readable/writable directory** (override with
  `MOG_WORKBOOK_DIR`). It is a live sandbox: real data lands there and is
  gitignored. `workbooks/sample.xlsx` is the one tracked fixture.
- **Saves are last-write-wins and not serialized across lanes.** Conflicting
  writes are refused, not merged. Save before switching lanes.

## Which lane to edit in

Policy, not preference — the canvas runs with
`editModel: { user: 'write', agents: 'none', automation: 'none' }`
(`src/adapters/mog-embed-adapter.ts:133`).

- **Humans** edit in the canvas.
- **Agents** edit headlessly through `@mog-sdk/sdk` — see
  `scripts/headless-edit.mjs` — then validate with `summarize()` and
  screenshot the range they touched. The screenshot is what makes an agent
  edit reviewable without opening the file.

`@mog-sdk/sdk` is Node-side only and must never reach the browser bundle. The
TypeScript bridge imports `@mog-sdk/sdk/node` deliberately: under `bundler`
resolution the bare specifier types as the browser WASM build, whose
`createWorkbook` takes bytes rather than a path.

## Evidence discipline

This repo separates **verified** from **assumed**, and that distinction is the
point rather than a formality. Keep it:

- Claim only what a named command actually exercised, and say which kind of
  evidence you have. `docs/CLAUDE-CODE-PLUGIN.md` keeps harness results and
  host observation in separate sections on purpose: the Claude Code rendering
  gate passed by being *seen*, not by a command, and the Codex path has never
  passed at all. Do not merge the two, and do not soften the Codex status
  until step 4 of the host test procedure passes there.
- When something is derived from documentation rather than executed, say so.
  The Node floor above is derived; nothing has run below Node 24 on this
  machine.
- Prefer a stated limitation over a confident guess. Several docs here exist
  specifically to record where an API stopped working.

## Windows

Development happens on Windows. Path handling, plugin helpers, and shell
assumptions have all drawn blood here — POSIX-only helpers and short-name
(`MARKME~1`) traps are documented in
[`docs/solutions/workflow-issues/posix-only-plugin-helpers-fail-on-windows.md`](docs/solutions/workflow-issues/posix-only-plugin-helpers-fail-on-windows.md)
and the containment doc above. Do not assume a POSIX shell.

## Where knowledge lives

- [`CONCEPTS.md`](CONCEPTS.md) — shared vocabulary. If a term has a
  project-specific meaning (Workbook Root, Adapter Probe, Compact Mode), it is
  defined there. Use those words as defined rather than inventing synonyms.
- [`docs/solutions/`](docs/solutions/) — durable learnings, one per solved
  problem, grouped by kind. Check here before re-debugging something; add to
  it after solving something non-obvious.
- **Upstream Mog's issue tracker** —
  [`fundamental-research-labs/mog/issues`](https://github.com/fundamental-research-labs/mog/issues).
  Read it before diagnosing engine behavior. The `#CALC!` defect was diagnosed
  here over several sessions and filed there; the rest of that tracker was only
  read afterwards, and it held issues this repo was already exposed to.
  [`docs/solutions/integration-issues/upstream-mog-open-defects-and-which-lane-they-reach.md`](docs/solutions/integration-issues/upstream-mog-open-defects-and-which-lane-they-reach.md)
  indexes it by which lane each defect reaches.
- [`docs/CLAUDE-CODE-PLUGIN.md`](docs/CLAUDE-CODE-PLUGIN.md) — plugin install,
  host test procedure, rollback, and the secondary Codex path's gaps.
- [`docs/API-EVIDENCE.md`](docs/API-EVIDENCE.md) — a historical record of what
  was verified and where the published API actually stops. It is evidence, not
  setup instructions.

## Conventions

- Conventional commits (`fix:`, `feat:`, `docs:`, `chore:`).
- Stage named files; avoid `git add -A` and `git add .` — `workbooks/` holds
  live data.
- Match the surrounding code's density and idiom rather than importing a
  different house style.
