# Decision desk release — 19 September 2026

Six additions are live: explicit check packs, two-input sensitivity, bounded goal
seek, tornado driver analysis, a positional variance bridge, and a session evidence
notebook with a printable client brief. See the [ten-option ranking and research](DECISION-DESK-RESEARCH.md)
and [usage guide](CONSULTANT-WORKBENCH.md).

## Deployment

Production is **local**, at <http://127.0.0.1:5276>. Staging is
<http://127.0.0.1:5279>. No internet deployment is configured in this project.
Both serve the same built release, `20260919-decision-desk-r5`, with separate
synthetic workbook roots. The prior production release remains available for rollback.

The copied production source and assets are in:

```text
C:\Users\MarkMelanson\AppData\Local\MogFinancialWorkbench\releases\20260919-decision-desk-r5
```

The existing production workbook root was preserved:

```text
C:\Users\MarkMelanson\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\MogFinancialWorkbench\workbooks
```

The release's `deployment.json` records this exact root. Do not infer it from
`LOCALAPPDATA`: Codex's virtualized environment and a normal shell can resolve
that variable differently. Dependencies remain a junction to this checkout's
`node_modules`; keep it available. Source edits do not change the copied release.

The process survives the task but no Windows startup task was installed. To
restart after a reboot, use PowerShell:

```powershell
$releaseDir = 'C:\Users\MarkMelanson\AppData\Local\MogFinancialWorkbench\releases\20260919-decision-desk-r5'
$deployment = Get-Content (Join-Path $releaseDir 'deployment.json') | ConvertFrom-Json
$env:PORT = '5276'
$env:MOG_RELEASE = $deployment.release
$env:MOG_WORKBOOK_DIR = $deployment.root
$env:MOG_DIST_DIR = Join-Path $releaseDir 'dist'
Set-Location -LiteralPath $releaseDir
node server/production.ts
```

For rollback, stop only the verified process serving port 5276, then use the
same workbook root with the retained `20260919-decision-desk-r4` release directory
and its matching release name. The older `20260919-consultant` release is also
retained under the virtualized LocalAppData location above, beside `workbooks`.

## Verification

- **80 release checks passed on staging and 80 on production.** These exercise
  all ten analysis modes in desktop and mobile browsers, actual Mog rendering,
  independently calculated example answers, rejected invalid inputs, selection
  navigation, revision isolation, pack import/export and the rendered HTML brief.
- **292 automated tests passed**; typecheck, build and the 25-check adapter
  verification passed. MCP protocol checks passed 13 checks; plugin checks passed 6.
- The final MCP app browser run passed **11 checks**, including live canvas
  editing, save, revision advancement and screenshot.
- Goal-seek display and brief retain the full solution precision needed to
  reproduce the stated tolerance. A regression test checks this explicitly.
- Check results display the comparison rule and effective tolerance beside the
  outcome. Browser tests check this on desktop and mobile. Brief verification
  checks each visible Outcome region, excluding assumptions and raw evidence;
  invalid-analysis probes require the specific expected error reason.
- **New workbook** creates and opens an empty `Sheet1` from the toolbar or
  landing page. Tests cover duplicate names, concurrent creation by independent
  services, Windows case aliases, cancellation and mobile layout. Exclusive file
  creation prevents a racing request from replacing the winner's workbook.
- Production testing exposed a shared navigation queue with two open canvases.
  Evidence links now target their own iframe, with origin, sender, workbook and
  acknowledgement checks. The browser gate opens a competing same-workbook view
  and verifies that only the intended canvas follows the cited cell.
- Import races are tested by completing reads out of order and by editing the
  draft during a pending read. The regression failed against the preceding build
  and passed in both final environments. Malformed, unsupported, invalid and
  oversized check packs preserve the existing draft.
- The production example remained byte-for-byte unchanged through deployment
  and testing: SHA-256 `3333479132223AA2C5D6BEAFE2A5CA1F23BAC0C351E50C22F8DEED171EE4E0BD`.

Final evidence is in [staging](../artifacts/decision-desk-release/staging/release-checks.json)
and [production](../artifacts/decision-desk-release/production/release-checks.json).
The [downloaded client brief](../artifacts/decision-desk-release/production/decision-brief.html)
contains five pinned results from one saved revision. Screenshots alongside it
show the desktop, mobile and decision views. All evidence uses synthetic data.
The checks required no paid provider calls.

The six-feature review completed with no unresolved findings. Bounded follow-up
reviews covered exclusive blank-file creation and targeted canvas navigation.
The core review receipt is retained with the release evidence. Upper-limit
workloads have not been latency-benchmarked; the documented calculation bounds
and timeout still apply.

## Operating limits and hosted workflows

Experiments are read-only, bounded and tied to the saved workbook revision.
They support the documented single-sheet formula subset; they do not certify
the entire workbook. Check packs and variance use saved numeric values. The
notebook stays in the browser session until explicitly downloaded.

The [hosted-workflow assessment](HOSTED-WORKFLOW-ASSESSMENT.md) recommends a
synthetic, read-only Sites coordinator with an outbound local runner as a future
prototype. Sites, WebMCP, TypeSafe and TabFM were assessed, not added to the
production data path. TabFM predicts tabular outcomes; it does not replace the
spreadsheet calculation engine. Its published pretrained-weight restrictions
must be resolved before production adoption.
