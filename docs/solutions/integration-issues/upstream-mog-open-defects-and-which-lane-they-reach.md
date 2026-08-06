---
title: The 12 open upstream Mog defects, and which of this repo's lanes each one reaches
date: 2026-08-06
category: integration-issues
module: sdk-usage
problem_type: integration_issue
component: service_object
root_cause: platform_constraint
resolution_type: workflow_improvement
severity: high
symptoms:
  - "An engine behavior looks like a bug in this repo and is already filed upstream"
  - "A canvas Save or headless edit produces a file that is subtly worse than the one it replaced"
  - "A mutation reports success and changes nothing"
tags: [mog-sdk, upstream, triage, issue-tracker, lanes, canvas, headless, byte-first]
---

# The 12 open upstream Mog defects, and which of this repo's lanes each one reaches

## Problem

This repo diagnosed the `#CALC!` calculated-column defect from first principles
over several sessions, wrote it up, and filed it upstream — as
[fundamental-research-labs/mog#337](https://github.com/fundamental-research-labs/mog/issues/337).
Only afterwards did anyone read the rest of that tracker. It holds **12 open
issues**, several of which describe engine behavior this repo is exposed to
right now and one of which names a safer API for something a script here already
does.

The tracker was never in the triage path. It is now: **before diagnosing engine
behavior, read
[github.com/fundamental-research-labs/mog/issues](https://github.com/fundamental-research-labs/mog/issues).**

This page is the index. Read it to find out whether a symptom is already known,
and — more usefully — which of this repo's three lanes a given upstream defect
can actually reach.

## The three lanes have different exposure

| Lane | Binding | What it does with the engine |
| --- | --- | --- |
| **Canvas** (`@mog-sdk/spreadsheet-app`) | wasm32, in the browser | Imports bytes, renders, serializes back on Save |
| **Headless** (`@mog-sdk/sdk/node`) | native N-API | Imports bytes or a path, mutates, exports |
| **Byte-first** (`server/workbook-*.ts`) | none | Reads OOXML directly; the engine is never loaded |

A defect in the engine's **import** path reaches the first two. A defect in its
**export** path reaches any lane that writes. The byte-first lane is reached by
none of them, which is most of why it exists.

One fact that decides several rows below: **this repo makes almost no engine
mutation calls.** A repo-wide grep for `tables.`, `charts.`, `formats.`,
`names.add`, `sheets.copy`, and `sortApply` against `server/`, `src/`,
`scripts/`, and `plugins/` returns only byte-first reads of table and
defined-name *definitions* (`server/workbook-metadata.ts`, parsed from OOXML with
regexes, never through the engine). The only engine writes in the tree are
`ws.setRange` / `ws.setCell` in `scripts/headless-edit.mjs` and `ws.setCell` in
`scripts/mcp-check.mjs`. [verified by grep, 2026-08-06]

That is why most of the tracker does not currently bite. It is also why it will
bite the first agent who adds a mutation.

## The catalog

Reach classification: **LIVE** — reaches a lane on ordinary use today ·
**LATENT** — reaches a lane only in a shape this repo does not currently produce,
or is version-gated · **GATES** — does not reach today, but constrains any future
work in that area · **N/A**.

| # | Title (abbreviated) | Version | Reach | Lane | Note |
| --- | --- | --- | --- | --- | --- |
| [#337](https://github.com/fundamental-research-labs/mog/issues/337) | `[#This Row]` ref to another calculated column yields `#CALC!`; graph marked clean | 0.10.5 | **LIVE** | canvas + headless import | Already documented — see [the dedicated entry](mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md). Filed by this repo 2026-08-04, **no maintainer reply, no labels** |
| [#329](https://github.com/fundamental-research-labs/mog/issues/329) | XLSX export loses theme colors; writes API theme strings as RGB | 0.10.3 | **LIVE** | any lane that writes | Every canvas Save is an import→export round trip. See [tolerant-reader entry](../design-patterns/a-tolerant-reader-cannot-validate-what-a-strict-one-rejects.md) |
| [#335](https://github.com/fundamental-research-labs/mog/issues/335) | Deferred XLSX hydration traps wasm32 on formula-dense workbooks | — | **LIVE** | **canvas only** | `RuntimeError: unreachable` at 20.3 MB / 1.57 M cells. Native survives the same file at ~4.7 GB RAM. See [binding-ceiling entry](../architecture-patterns/engine-binding-decides-the-workbook-size-ceiling.md) |
| [#328](https://github.com/fundamental-research-labs/mog/issues/328) | `setRange` multi-row matrix keeps formulas only on the first row | 0.10.4 | **LATENT** | headless | `scripts/headless-edit.mjs:65-70` writes exactly this shape. **Does not reproduce at 0.10.5** — see [the SDK-gotchas entry](mog-sdk-node-subpath-and-proxy-introspection.md#formula-safe-writes-setformulas-not-a-multi-row-setrange) |
| [#334](https://github.com/fundamental-research-labs/mog/issues/334) | XLSX writer emits duplicate worksheet `sheetId` after import | — | **LATENT** | any lane that adds a sheet | Needs import + `sheets.add` + export. Nothing here adds a sheet to an imported workbook — yet |
| [#332](https://github.com/fundamental-research-labs/mog/issues/332) | `names.add` writes `<definedNames>` after `<extLst>`; Excel calls the file corrupt | 0.10.4, 0.10.5 | **GATES** | any lane calling `names.add` | Excel rejects; openpyxl and LibreOffice accept silently. **So does `validate()`** |
| [#333](https://github.com/fundamental-research-labs/mog/issues/333) | `sheets.copy` fails above a 64 MiB update cap; real error masked as "Source sheet may not exist" | — | **GATES** | headless | The masked-error lesson generalizes past `copySheet` |
| [#323](https://github.com/fundamental-research-labs/mog/issues/323) | Inconsistent error contract — some mutations return `status:"failed"` receipts instead of throwing | 0.10.3, 0.10.4 | **GATES** | any lane that mutates | Changes how error handling must be written here. See [silent-failure entry](mog-sdk-mutations-that-fail-without-throwing.md) |
| [#322](https://github.com/fundamental-research-labs/mog/issues/322) | `formats.set` silently ignores unknown keys — nested `font`/`fill` objects apply nothing | 0.10.3, 0.10.4 | **GATES** | any lane that formats | Same entry |
| [#324](https://github.com/fundamental-research-labs/mog/issues/324) | `tables.sortApply` appears to be a no-op — no receipt, no reorder, no diagnostics | 0.10.3, 0.10.4 | **GATES** | any lane using tables | Same entry |
| [#325](https://github.com/fundamental-research-labs/mog/issues/325) | Charts/tables created in a session can't be targeted by follow-up mutations | 0.10.4 | **GATES** | any lane creating objects | Create→configure fails in one session; works after export+reopen |
| [#326](https://github.com/fundamental-research-labs/mog/issues/326) | `llms.txt` gaps: layout indexing + units, chart config units, flat `CellFormat` key list, table-name rules | 0.10.4 | **GATES** | codegen | The generated metadata this repo has not yet adopted has documented gaps of its own |

Authorship: #337 is ours. #335, #334, #333, #332, #328 are `buildwithrohith`;
#326, #325, #324, #323, #322 are `bcssewl`; #329 is `ADH97`. **None of the twelve
carries a maintainer reply, a label, an assignee, or a milestone.** [read from
the tracker, 2026-08-06] Treat every one of them as unacknowledged and unfixed.

## What actually changes here

Three things, and only three. The rest of the catalog is a reading list for
whoever adds the next engine call.

**1. `#329` is live on every canvas Save, and it has `#337`'s blast radius.**
A canvas Save is an import followed by an export (`persistThroughHost`,
[`src/adapters/mog-embed-adapter.ts:303`](../../../src/adapters/mog-embed-adapter.ts)),
so a workbook whose fonts are theme-linked comes back with literal RGB and no
theme linkage. The file still opens. The colors still look right *today*. They
stop tracking the theme, permanently, in a delivered client file — and no check
in this repo looks at colors. **Not reproduced here** — see the caveat in
[the tolerant-reader entry](../design-patterns/a-tolerant-reader-cannot-validate-what-a-strict-one-rejects.md);
the tracked fixture is not a specimen that would show it.

**2. `#335` gives the canvas lane a hard ceiling the headless lane does not
have.** Not "slow" — a wasm32 trap. The Adapter Probe cannot predict it, because
the probe answers before any workbook is opened.

**3. `#328` names a safer API for something `scripts/headless-edit.mjs` already
does.** It does not reproduce at 0.10.5, and the fix is one line either way.

## What Didn't Work

**Assuming the tracker was empty.** The prior version of the `#CALC!` entry ended
with "No matching GitHub issues; this repo tracks related work via PRs rather
than issues." That sentence was written about *this* repo's issue tracker and
read, by the next reader, as a statement about upstream's. Upstream's had ten
open issues at the time. The sentence has been corrected.

**Assuming filing an issue closes the loop.** #337 has been open since
2026-08-04 with no reply. The local mitigation — the value-fidelity gate — is
what is actually protecting files, and it will keep being what protects them.
Filing is not a fix and should never be logged as one.

## Prevention

- **Read the tracker before diagnosing engine behavior.** Twelve issues is ten
  minutes. The `#CALC!` investigation was days.
- **Ask which lane a defect reaches before deciding how much it matters.** An
  import defect that only affects wasm32 is a canvas problem and not a headless
  one; an export defect is everyone's problem; a mutation defect is nobody's
  problem here until someone adds a mutation.
- **When adding *any* engine mutation to this repo, check this table first.**
  Formats, tables, charts, names, and sheet copies each have an open defect
  against them. The byte-first lane is not affected by any of them, and for
  *reads* it remains the better answer regardless.
- **Re-read this page after every `@mog-sdk` bump**, and re-check the version
  column. Several of these are reported against 0.10.3 or 0.10.4 and have not
  been retested at 0.10.5 by anyone, including us.
- **Do not fold an upstream defect's status into this repo's verified/assumed
  distinction by osmosis.** "Filed upstream" is not "handled"; "does not
  reproduce in our fixture" is not "fixed".

## Related Issues

- [mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md](mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md) — #337 in full, and the value-fidelity gate that mitigates it
- [../architecture-patterns/engine-binding-decides-the-workbook-size-ceiling.md](../architecture-patterns/engine-binding-decides-the-workbook-size-ceiling.md) — #335 and #333
- [../design-patterns/a-tolerant-reader-cannot-validate-what-a-strict-one-rejects.md](../design-patterns/a-tolerant-reader-cannot-validate-what-a-strict-one-rejects.md) — #329, #332, #334
- [mog-sdk-mutations-that-fail-without-throwing.md](mog-sdk-mutations-that-fail-without-throwing.md) — #322, #323, #324, #325
- [mog-sdk-node-subpath-and-proxy-introspection.md](mog-sdk-node-subpath-and-proxy-introspection.md) — #328, plus the standing catalog of SDK facts guessing gets wrong
- [../../research/2026-08-06-upstream-mog-capability-map.md](../../research/2026-08-06-upstream-mog-capability-map.md) — the full upstream capability map these entries came out of
</content>
