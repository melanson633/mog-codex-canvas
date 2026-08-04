# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Workbook access

### Workbook Root

The authorized local directory that bounds every workbook and generated-image operation, including canonical path checks that prevent aliases or links from escaping it.

### Workbook Revision

A content-derived identity for the workbook bytes currently on disk, used to detect whether a file changed between opening and saving it.

### Workbook Session

A server-managed handle for one opened workbook that binds subsequent operations to the file revision observed at open time.

After a successful save, the session advances to the new revision. If the workbook changes outside the session first, the save is refused and the attempted work is preserved separately rather than overwriting the newer file.

## Host validation

### Mog Canvas

The live spreadsheet surface that owns interactive editing and computation while its host owns file access, persistence, and authorization.

### Canvas Adapter

The swappable boundary between the application shell and a concrete spreadsheet engine, so the engine behind a Mog Canvas can be replaced — or reported as missing — without changing the surrounding interface.

Which adapter is in use is decided at runtime by actually loading the engine and checking its shape, not by inspecting a declared version. When the engine or its stylesheet fails to load, resolution yields an adapter that renders no grid and declares itself unavailable, rather than a partial canvas that looks real.

### Adapter Probe

The outcome of adapter resolution: whether a live interactive canvas is available, which capabilities it supports, and a human-readable reason.

The reason text is written to be shown verbatim to the user. The probe is the only thing distinguishing a real canvas from a placeholder, so any display mode that suppresses it makes degradation invisible — a display mode may drop decorative chrome, but never the probe's failure reason.

### Reference Host

A local test harness that implements the MCP Apps host contract closely enough to exercise the real application resource, sandbox, tool bridge, and user interaction without making claims about a specific production host.

### Host Acceptance Gate

The final deployment check performed in the actual target host, requiring visible application rendering plus a real edit, save, and persisted-file validation before host integration is declared working.

Reference Host success is prerequisite evidence, not a substitute for this gate.

## Editing lanes

### Editing Lane

One of the separate paths through which a workbook may be changed, each with its own writer and its own evidence obligations; which lane a given writer may use is a fixed policy of the canvas, not a per-session preference.

### Headless Lane

The Editing Lane in which a workbook is opened, changed, and saved through the spreadsheet engine directly, with no canvas rendered and no human present.

Because nothing is visible while it runs, an edit made here is expected to carry its own proof: a read-back of the saved file and an image of the range that changed, so the result is reviewable without opening the workbook. It is the lane reserved for automated writers; a Mog Canvas remains the lane for human edits.

## Canvas presentation

### Compact Mode

The display mode that strips a Mog Canvas down to the spreadsheet itself so it stays usable in a pane too short for full chrome.

It is a layout intent only. Decorative chrome — surrounding toolbars, path indicators, ribbons, status strips — may be dropped; diagnostic output such as an Adapter Probe failure reason may not, because a small pane is where a degraded canvas is hardest to notice by eye.

### Compare View

A surface that shows several workbooks at once by embedding one complete, independently operating instance of the application per pane, each pinned to a single workbook.

Panes share nothing: each carries its own save path and Workbook Session, so one pane's save cannot silently overwrite another's file — a competing write is refused as a revision conflict. Each pane also carries a full engine runtime, so the view is sized for human-scale comparison of a few workbooks, not for dashboards.
