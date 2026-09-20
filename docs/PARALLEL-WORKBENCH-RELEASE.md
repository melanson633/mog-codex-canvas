# Parallel workbench release — 19 September 2026

The workbench now opens local XLSX copies, keeps four live workbook tabs, and
stores scoped agent notes with a real Run action. Two different workbooks can run
requests concurrently. Proposed edits wait for review and Apply.

The [architecture comparison](plans/2026-09-19-2057-feat-parallel-agent-workbench-plan.md)
compares three end-to-end designs for notes and parallel work. The chosen local
queue keeps requests alive independently of the selected tab. The
[usage guide](CONSULTANT-WORKBENCH.md) describes actions, limits and data sharing.

## Opening and rendering

Full Canvas expands the current iframe, preserving the existing spreadsheet.
Staging measured 26.9 ms through two paint frames. Direct blank-workbook loading
measured 2,050 ms cold and 1,253 ms warm in an isolated headless Chromium profile.
The warm engine transfer was 379 bytes, compared with 41,303,660 bytes cold.
These are observed local measurements, not a universal speed guarantee.

Browser testing found a React/SDK ownership conflict: the loading overlay was a
React child inside the element whose children the spreadsheet engine replaces.
Moving it to a sibling prevents the `removeChild` exception that blanked the app.
Both browser probes assert that the rendered canvas remains mounted after ready.

## Validation

- Typecheck passed; 312 automated tests passed, none failed.
- `npm run verify` passed; `npm run check:app` passed 11 checks.
- Staging financial-example browser gate passed 81 checks.
- Staging parallel-workflow gate passed 19 checks, including two observed real
  Claude jobs running concurrently, completed answers, one previewed B2 = 42
  proposal applied to a synthetic blank, save verification and range screenshots.
- A genuine keyboard edit of A6 = 777 remained unsaved across workbook switches
  and then saved correctly. Imported source bytes remained unchanged.
- Saved notes survived reload, note drafts survived switching, and mobile layout
  had no horizontal overflow or runtime exceptions.

The packaged r7 release passed 81 example and 21 parallel-workflow checks on
staging port 5283. Production is **http://127.0.0.1:5284/**, release
`20260919-parallel-workbench-r7`, PID 23984. Production passed the same 81 example
and 21 parallel-workflow checks, including real model calls, a reviewed synthetic
edit, and explicit archiving that preserved notes. Direct `index.html?wb=test.xlsx`
rendered in 2,179 ms cold and 1,226 ms warm, retained 509 canvas elements, and
raised no browser exceptions. Expanding the already-open production canvas took
17.1 ms through two paint frames.
Both `test.xlsx` and `consultant-example.xlsx` retained their pre-release SHA256.

Evidence: `artifacts/parallel-workbench-release/production-r7` (examples)
and `artifacts/parallel-workbench-release/production-r7-parallel` (parallel jobs,
edits and archive). Direct startup evidence is `production-r7-startup.log`.
These local artifacts contain only synthetic release-test workbook data.

Automatic approval review rejected the command to stop and replace the old
production server, with the reason “blocked by policy” and no further detail.
The r5 server remains on port 5276. The final r7 server uses the same managed
workbook folder on port 5284; no global launch configuration was changed.
Use port 5284 for current work. Earlier release servers remain available but
must not be used concurrently to manage the same workbook's agent history.

## Operational boundaries

Production is the loopback application on this computer, not a public cloud site.
Release artifacts are copied under
`C:\Users\MarkMelanson\AppData\Local\MogFinancialWorkbench\releases`.
The existing managed workbook root is reused. The prior r5 release is retained.

Agent notes and job receipts live in `.mog-agent-tasks.json` inside that root.
Writes retain a backup and reject a stale server's state under an exclusive lock.
History is limited to 5 MB; explicit archives (up to 20 MB) preserve finished jobs
before removing them from active history. Notes and active requests remain.
A crash during a history write can leave `.mog-agent-tasks-lock.json`; stop all
workbook servers before manually removing that abandoned lock. It is never broken
automatically. Old releases without this protection must not write concurrently.
Restarted in-flight jobs are marked interrupted. New jobs require an installed,
signed-in Claude Code CLI. Scope limits and Claude disclosure appear before Run.
The engine returns answers and bounded cell proposals; it does not receive shell
or general filesystem tools. Sheet/workbook scope is a disclosed prefix, not a
complete audit. No WebMCP host is required.

## Post-deploy validation

The lead exercised both release gates immediately after startup and checked the
release identity at `/health`, retained canvas DOM, browser exceptions, saved-cell
values, applied-job receipts, and source-file hashes. Production stderr was empty.
The expected signals are a real retained canvas, separate job results, unchanged
source imports and an explicit save receipt for reviewed edits. A blank canvas,
lost draft, wrong-workbook result or unexpected file change is a regression.
The prior r5 server remains available on port 5276; keep affected workbooks saved
before changing versions. No recurring monitor or cloud deployment was created.

## Review disposition

The final review confirmed five issues in the initial implementation: accumulated
history, a lock held during Apply, stale server state, sticky polling errors and
apostrophe sheet qualifiers. All five were repaired and checked. An indefinite
SDK-save hang was not reproduced or established; the lead rejected it as an
unsupported blocker. A save remains protected until its result arrives, shows a
progress notice after 15 seconds, and no longer blocks other workbooks' requests.
Temporary peer-review folder cleanup was also rejected by automatic approval
review as “blocked by policy”; those terminal review artifacts were retained.
