# Parallel workbench supplemental review

Reviewed on 2026-09-19. Scope: workbook import, agent service integration, and `AnalystWorkspace`, `ParallelWorkbench`, and `AgentDesk`. This is a bounded supplemental review of the evolving working tree, not a repeat of the completed Decision Desk review. No product files were changed by this review. Generated artifacts and `error.log` were excluded.

## Findings and resolution

| Finding | Consequence | Current source review |
| --- | --- | --- |
| P1: Apply remounted an editable canvas after its asynchronous save. | Human edits made during the request could disappear. | Repaired: iframe is inert while applying; immediate dirty checks precede Apply and prevent remounting a newer dirty canvas after its response. Browser verification belongs to the release gate. |
| P2: Multiple imports into an initially empty desk reused a stale empty-file closure. | Later imports replaced the first canvas instead of opening tabs. | Repaired for the sequential multiple-file workflow: later entries route to the parent; file count is checked against available slots before upload. |
| P2: Create/example actions reset the originating desk after opening a different tab. | An unrelated workbook acquired example sheet names, defaults, and guide text. | Repaired: those paths return immediately after delegating the new workbook to the parent. |
| P2: An outstanding note save could rebind a newly selected note draft. | The next save could overwrite another note. | Repaired: Edit note and New note are disabled during the operation. |
| P2: Agent history persistence could fail after workbook commit and produce a false Apply failure. | The UI failed to refresh despite a successful workbook save. | Repaired: the committed result is returned with an explicit history-persistence warning. This review reproduced the original failure using a synthetic store that failed its final save. |
| P2: Agent Apply dropped validation, screenshots, and warnings. | Users could not see the verification evidence returned by the service. | Repaired: result and warnings are retained in the job and rendered in the task panel. |
| P2: Notes allowed 8,000 characters but save intent allowed 2,000. | Applying a long valid note failed before mutation. | Repaired: the bridge includes the job ID and bounds its intent to 2,000 characters. |

### Final concurrency repair

The initial implementation allowed another opening action while an import was pending; its captured empty `file` could replace the intervening workbook. The final repair disables opening controls during import/create/example loading and uses an immediately updated file ref for response routing. Source inspection confirmed both guards. Another desk can consume available slots during an upload, but the parent refuses the extra tab and the revised message accurately states that imported copies remain available in the workbook list. No unresolved blocking defect remains in this bounded source review. Browser confirmation remains part of the release gate.

## Verified design properties

- Normal tab switching keeps each keyed desk and iframe mounted and hides inactive panels. Unsaved canvas edits and local note drafts remain in their desk.
- The status callback chain uses stable callbacks. No self-sustaining callback loop was identified.
- Blank/import creation uses atomic exclusive publication; existing workbook bytes are not replaced on name collisions.
- Agent writes use revision checks, bounded explicit cells, sheet validation, dirty-canvas checks, and the existing save coordination policy. Model execution has no workbook mutation tools; proposed changes require Apply.
- Navigation replies are scoped to the current iframe, same origin, and pending request ID; child requests validate the current workbook.

## Targeted simplification recommendations

Recommendations only, as requested; none applied. This is a compact local three-lens assessment, not a new completed multi-agent `ce-simplify-code` run.

1. **Efficiency:** `ParallelWorkbench.status` always creates a new array even if the reported desk is unchanged. Return the previous array when name, dirty, and busy values match. This preserves React's no-change signal across task polling.
2. **Quality:** centralize the small desk open/activate/capacity transition rather than calling other state setters inside a `setDesks` updater. A single transition also makes saved-versus-opened outcomes explicit. Preserve mounted desk IDs and existing confirmation behavior.
3. **Reuse:** no demonstrated behavior-equivalent existing helper justifies merging the two HTTP helpers. Their paths and calling conventions differ; avoid abstraction solely to remove a few lines.

## Evidence limits

The repaired frontend paths above were inspected in the current source. This supplemental review did not run a full test/build/browser suite, edit production code, or alter git state. Earlier focused import and agent-workbook tests exercised real XLSX bytes, collisions, stale revisions, dirty/occupied rejection, headless edits, formulas, and screenshots. Final browser behavior, current test counts, deployment identity, and production results must be taken from the lead's release evidence rather than inferred from this note.
