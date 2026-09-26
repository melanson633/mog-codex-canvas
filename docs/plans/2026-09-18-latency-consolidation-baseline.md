# Latency baseline and Shortcut consolidation map

## Scope and current state

This records the preparation authorized after the latency/consolidation handoff:
baseline both repositories, measure synthetic workloads, and map contracts before
changing application behavior. No migration or cache implementation is included.

- Mog baseline: `main` at `1ba24d5a73cf1b6cc6a54dc436fe8e8698cced47`.
- Shortcut reference: `eef13f5f1061af758fe5f1081ac5dfcfa57ea994`.
- Working branch: `codex/latency-consolidation-baseline`.
- Pre-existing untracked `error.log` is preserved and was not read or incorporated.
- Shortcut remains an unchanged reference repository.

## Executed baseline gates

On Windows, Node `v24.16.0`, both repositories passed their own commands in order:

| Repository | `npm run typecheck` | `npm test` | `npm run verify` |
| --- | --- | --- | --- |
| Mog | Pass | 255 pass, 0 fail | 25 checks pass |
| Shortcut | Pass | 573 pass, 0 fail | 15 checks pass |

The two repository gates ran concurrently. Benchmark timing runs started after both
completed. Verification exercised the automated host/engine harnesses; it did not
establish browser readiness or Codex/Claude host rendering acceptance.

Shortcut tests emitted expected missing-test-root recording warnings while passing.
No dependency update, installation, client workbook read, external send, or commit
was needed.

## Reproducible measurement

Run `node scripts/latency-baseline.mjs` from Mog. The harness creates a fresh
`.latency-baseline-<timestamp>` directory inside the gitignored Workbook Root.
It never chooses existing workbooks. SDK edits export through Mog's authoritative
save service with expected revision `absent`, agent attribution, touched ranges,
and a required receipt. Generated fixtures have 100, 3,000, and 12,000 data rows,
ten columns, and one formula per row. Each is reopened, queried, summarized, and
given a representative screenshot of `A1:J12` (not a full-workbook visual check).

Each size uses a fresh child process. The report separates SDK import, first
engine open, same-process reopen, first query, and five repeated queries on the
same engine instance. Host session opens and byte-first range queries are timed
separately. A first process call is **not** cold disk: the OS cache is not flushed.
Warm calls are not evidence of an application cache. Fixture creation and save
admission are excluded from measurement.

The query returns 100 cells (`A2:J11`). Every engine open receives the entire
workbook. Internal engine hydration counts remain unknown. Current source shows
that each host query reads the full file, hashes its bytes, decodes all ZIP entries,
and scans the target worksheet, even though it returns only the selected cells.
The reported byte count is derived from that path and file size, not OS I/O tracing.

Existing model, dataset, large-dataset, and mixed OOXML fixtures are additionally
measured for five complete briefing calls. These minimal test archives stay on the
byte-only lane. External wall-clock timing is used because the current briefing
still reports stage 0 as a hardcoded zero.

Real workbook timing remains pending approved small/medium/large paths from Mark.
Synthetic results cannot establish performance for real models, tables, pivots,
styles, or browser hydration.

### Measured results

The validated replay completed at `2026-09-19T02:47:33.182Z`. Full runs, hashes,
counts and methodology are retained in
[`2026-09-18-latency-consolidation-baseline.json`](2026-09-18-latency-consolidation-baseline.json).
All times below are milliseconds; repeated figures are medians of five queries.

| Synthetic size | Cells / formulas | File bytes | Host first / warm open | Host first / repeated query | SDK import | Engine first / warm reopen | Engine first / retained repeated query |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Small | 1,010 / 100 | 8,606 | 3.78 / 0.64 | 2.91 / 2.22 | 247.46 | 67.55 / 26.95 | 0.78 / 0.19 |
| Medium | 30,010 / 3,000 | 161,818 | 3.83 / 1.31 | 33.02 / 15.10 | 259.87 | 316.22 / 416.13 | 1.69 / 0.32 |
| Large | 120,010 / 12,000 | 632,465 | 4.35 / 1.59 | 64.62 / 61.95 | 232.67 | 993.49 / 1,188.62 | 1.48 / 0.39 |

Host open means reading bytes and registering a revision/session; it does not open
the engine or mount the canvas. Engine warm reopen is a new workbook object in the
same process, measured once after disposing the first; it is not a retained read.
Medium and large warm reopens were slower, so these runs do not support a claim
that reopening becomes faster. Retaining an already-open engine made this query
cheap, but does not yet establish a safe production lifetime/cache design.

Briefing medians on existing byte fixtures were 1.01 ms (model, 41 cells), 92.25 ms
(dataset, 27,050 cells), 290.58 ms (large dataset, 108,050 cells), and 2.29 ms
(mixed, 924 cells). These are complete briefing wall times, not the incomplete
stage-0 timing field. Initial and repeat values are all retained in the JSON.

The original generation run completed successfully. After independent review,
the harness added complete expected-value checks, exact sheet/cell/formula counts,
and refusal of non-generated measurement selectors. The validated replay used:

```powershell
node scripts/latency-baseline.mjs --replay .latency-baseline-1789785847632
```

This replay reads only that previously generated fixture directory and refreshes
its screenshots/report. All 100 returned values agreed with deterministic expected
values on both host and engine paths; host formula text and repeat equality also
passed. The large screenshot's first 12 rows were visually inspected. Generation
time is outside the performance table and can take several minutes for the largest
fixture. Syntax and non-generated-selector refusal were checked separately.

## Contract map

Paths in the source column are relative to the separate `shortcut-canvas` repository.
Targets and tests are relative to Mog unless prefixed `Shortcut:`. Proposed test
cases below are migration gates, not claims that migration has happened.

| Capability | Shortcut source | Mog target and decision | Validation for migration |
| --- | --- | --- | --- |
| Workbook Root | `server/path-policy.ts`; `server/agent-host.ts:buildPermissionPolicy` | Reuse `server/path-policy.ts` and `server/workbook-service.ts:createWorkbookService`. Do not copy a second containment policy. | Existing `server/path-policy.test.ts`; retain traversal, absolute-path, junction and NTFS stream refusals. |
| Save Lane | `server/workbook-service.ts:save` | Reuse Mog `server/workbook-service.ts:save` and its promotion lock, fidelity gate and occupied-cell check. | Existing `trust-features.test.ts`, `actor-trust.test.ts`, `review-fixes.test.ts`, `file-bridge.test.ts`; writer-level failure must not partially apply a batch. |
| Revision | `server/workbook-revision.ts:revisionOf`; writer tools | Reuse `server/workbook-revision.ts` and existing session revisions. New writers must pass expected revision; create uses `absent`. | Existing conflict tests plus create-racing-file-appearance and edit-racing-save cases. Do not copy Shortcut's create race. |
| Receipt | `server/flight-recorder.ts:SaveReceipt`, `writeReceipt` | Reuse Mog `server/flight-recorder.ts` and existing MCP receipt tools. No parallel receipt store. | Existing normal receipt coverage in `trust-features.test.ts`; explicitly test receipt-write failure after promotion. |
| Refusal | Tool-local `refusal()` helpers | Preserve Mog `WorkbookError`, MCP `fail`/`guarded` in `server/mcp/mog-canvas-server.ts`; add operation index for failed batches. | Existing `mcp-byte-tools.test.ts`, `actor-trust.test.ts`; test stable error codes, limits, unknown sheets and conflicts through each new wrapper. |
| Turn Verdict / Turn Receipt | `server/agent-host.ts:verdictFor`; `server/turn-recorder.ts` | Deferred to Phase 8 ownership decision. Mog MCP cannot observe a host model's entire turn. No local turn owner exists to receive a direct copy. | If a local host is admitted, port Shortcut `agent-host.test.ts` and `turn-recorder.test.ts` cases: normal, dead, aborted, timeout, watchdog, late terminal events. |
| `get_range_values` | `server/get-range-values-tool.ts` | Existing `read_range` → `WorkbookService.readRange` → `server/workbook-profile.ts:readRangeFromBytes` covers saved values/formulas. Keep this byte-first path. Dense engine-computed values are a distinct contract; do not silently substitute them. | Existing `workbook-profile.test.ts`, `mcp-byte-tools.test.ts`; add revision expectation, hard UTF-8 output bound and oversized-single-cell cases if extending. Engine mode needs explicit unavailable-engine and compute semantics tests. |
| `describe_engine_api` | `server/describe-engine-api-tool.ts` | Runtime introspection exists in `scripts/sdk-search.mjs`; a bounded MCP tool is missing. Proposed `server/engine-api.ts` plus MCP wrapper, with no workbook access. | Port relevant Shortcut `describe-engine-api-tool.test.ts`, `engine-claims.test.ts`, `sdk-search.test.ts` behavior; add MCP registration, prefix, output-cap and unavailable-engine tests. |
| `create_workbook`, `edit_workbook`, `apply_workbook_ops` | Corresponding `server/*-tool.ts` files | Typed model-facing operations are missing. Proposed `server/workbook-operations.ts` owns validation/in-memory operations; persist only through existing service, with wrappers in the MCP server. Preserve current kinds and caps. | Port dedicated Shortcut writer tests. Assert all-or-nothing batches, unknown-sheet refusal, formula/value exclusivity, touched ranges, stale revisions, fidelity-unverified reporting, and receipt outcomes. |
| Human selection | `server/context-bus.ts` (copied from Mog) | Reuse Mog `server/context-bus.ts`, `get_canvas_context`, `src/App.tsx`, adapter context reporting and reveal. Add only selected-range handoff action later. | Existing epoch/order/reveal coverage in `trust-features.test.ts`, interlock coverage in `actor-trust.test.ts`; add selection identity, stale context and bounded-read tests. |
| Revision caches and retained engine | Tools currently open/dispose per operation | Mog sessions retain identity/revision, not engine objects. Proposed read-analysis cache under `workbook-service.ts`, bounded by revision/options and memory. Engine lifetime policy is a separate probe/design step. | Repeated-call work counters, same-name replacement, cross-session save invalidation, no stale writes, memory eviction and disposal. |

## Material gaps found before migration

1. **Receipt absence does not imply no save.** Both services promote workbook bytes
   before writing the receipt. Receipt failure returns `transactionId: null` and
   `receiptError` after a successful save. The handoff's proposed no-receipt/no-save
   expectation is stronger than current behavior. Resolve that requirement before
   Phase 7; do not make an unsupported atomicity claim.
2. **Shortcut's payload cap is not a hard byte cap.** Its range reader measures
   `JSON.stringify(...).length` and stops shrinking at one row. Non-ASCII text and
   a single oversized row can exceed the stated byte limit. Port intent and tested
   bounds, not this implementation unchanged.
3. **Existing hydration follow-ups remain relevant.** The August follow-up plan
   records graph cost, parsing blind spots, stage timing and redaction coverage
   debt. A passing baseline does not close those findings. This preparation does
   not repair them or reset their status.
4. **A narrow response is not a narrow load.** Current byte reads parse full archive
   content; engine requests receive full workbook bytes. Neither proves lazy
   sheet/cell hydration.

## Continuation

Keep the handoff's phase order. Phase 2 should first eliminate repeated byte-stage
analysis by content revision and query options, retaining honest coverage and
refusals. Retained engine sessions need explicit bounds, invalidation, disposal,
and concurrency ownership before implementation. Phase 3 reuses the context bus;
Phase 4 adds bounded introspection and resolves range-read semantics. Do not move
the conversation host ahead of workbook/save parity.

Approved real fixtures are pending. The present deliverable is a synthetic baseline
and contract map, not a performance improvement or completed consolidation.
