# Parallel workbench review and disposition

The `ce-code-review` run reviewed the change from `39859403` on
`codex/latency-consolidation-baseline`. Its receipt is at
`C:/Users/MarkMelanson/AppData/Local/Temp/compound-engineering-MarkMelanson/ce-code-review/20260919-parallel-workbench/review.json`.

Status: **degraded**, not a clean independent approval. The run included an
independent Claude adversarial review and separate merge, validation and report
passes. Other persona coverage used the documented inline capacity fallback.
Automatic approval review rejected cleanup of completed peer-job folders with
“blocked by policy”; no peer process remained running. The validator also left
finding 5 unresolved because no reachable indefinite save hang was established.

| Finding | Lead disposition and verification |
| --- | --- |
| 1. History eventually reaches the persistence limit | Fixed with explicit durable archive before removing finished jobs. Queue tests cover full-state recovery and archive failure; staging and production archive retained notes. |
| 2. Apply holds the global queue lock | Fixed with a persisted per-workbook reservation and save outside the lock. A stalled-save test proves list and another workbook's request complete independently. |
| 3. Another server can overwrite newer task state | Fixed with expected-state comparison, exclusive write lock and backup. Two-service tests reject stale writers. Earlier releases do not acquire this lock; use the current release only. |
| 4. Poll errors remain after recovery | Fixed with separate action/poll errors, single in-flight poll, abort cleanup and successful-poll clearing. The closed panel shows connection trouble. Analysis smoke checks target their own error messages. |
| 5. Apply could remain pending forever | Validator unresolved; lead rejected the indefinite-hang claim as an unsupported release blocker. No evidence established a reachable non-settling SDK call. Unlocking edits on a timer could race a real save, so the lock remains until the response. A 15-second progress notice and independent workbook execution address observed waiting behavior. This does not prove that every external operation always terminates. |
| 6. Apostrophe sheet name loses qualification | Fixed by escaping and decoding doubled apostrophes. A real workbook test edits Bob's Model while Summary has the same occupied coordinate. |

The queue/UI repairs and service/parser repairs were assigned as separate batches.
All accepted fixes are complete. Final validation: 312 tests, typecheck, verify,
11 app checks, and 81 example plus 21 parallel-workflow checks on both staging and
production. The browser checks used actual model requests and reviewed synthetic
edits. See the release report for versions, measurements and operational limits.
