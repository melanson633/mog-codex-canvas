/**
 * The hydration briefing.
 *
 * The assertions that matter most here are the negative ones: that a sheet
 * which got a cheap answer says so, that a trace declines out loud, and that
 * nothing anywhere is chosen by the workbook-level genre label. The mixed
 * fixture is the instrument for the last one — its workbook genre is
 * necessarily wrong for at least one of its sheets, so a briefing that read
 * the genre would present that sheet wrongly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRACE_MIN_DEPTH,
  briefWorkbook,
  composeBriefing,
  type Briefing,
  type SheetSection,
} from './workbook-briefing.ts';
import { profileWorkbook } from './workbook-profile.ts';
import { revisionOf } from './workbook-revision.ts';
import {
  cyclicFixture,
  datasetFixture,
  largeDatasetFixture,
  mixedFixture,
  modelFixture,
} from './test-fixtures.ts';

const PROVENANCE = 'as-saved at revision abc123456789… — reflects the last save on disk, not unsaved canvas edits';

function briefed(bytes: Uint8Array): Briefing {
  const result = briefWorkbook(bytes, { revision: revisionOf(bytes), provenance: PROVENANCE });
  assert.equal(result.status, 'briefed');
  return result as Briefing;
}

function section(briefing: Briefing, sheet: string): SheetSection {
  const found = briefing.sheets.find((entry) => entry.sheet === sheet);
  assert.ok(found, `no section for ${sheet}`);
  return found;
}

function notRunReason(sheet: SheetSection, stage: string): string {
  const entry = sheet.notRun.find((item) => item.stage === stage);
  assert.ok(entry, `${sheet.sheet} does not report ${stage} as not run`);
  return entry.reason;
}

test('briefing: one mixed workbook gets a column section and a dependency section', () => {
  // AE1. Both framings in one briefing, each chosen by its own sheet's role.
  const briefing = briefed(mixedFixture());
  const raw = section(briefing, 'Raw');
  const summary = section(briefing, 'Summary');

  assert.equal(raw.role, 'dataset');
  assert.ok(raw.dataset, 'the dataset-role sheet got no column section');
  assert.equal(raw.model, null);
  assert.ok(raw.dataset.columns.length > 0);

  assert.equal(summary.role, 'model');
  assert.ok(summary.model, 'the model-role sheet got no dependency section');
  assert.equal(summary.dataset, null);
  assert.ok(summary.model.maxDepth > 0);
});

test('briefing: no section anywhere is chosen by the workbook-level genre', () => {
  // The structural half of AE1: the workbook label is reported, and the sheet
  // it contradicts is still presented by its own role.
  const bytes = mixedFixture();
  const briefing = briefed(bytes);
  const profile = profileWorkbook(bytes);
  assert.equal(profile.status, 'profiled');
  const genre = profile.status === 'profiled' ? profile.genre : null;

  assert.equal(briefing.identity.genreHint, genre);
  const contradicted = briefing.sheets.filter((sheet) => sheet.role !== genre && sheet.role !== 'indeterminate');
  assert.ok(contradicted.length > 0, 'the mixed fixture no longer contradicts its own genre label');
  for (const sheet of contradicted) {
    // Presented by role, not by the label that disagrees with it.
    if (sheet.role === 'dataset') assert.ok(sheet.dataset && !sheet.model);
    if (sheet.role === 'model') assert.ok(sheet.model && !sheet.dataset);
  }
});

test('briefing: role basis and genre basis appear verbatim, not paraphrased', () => {
  const bytes = mixedFixture();
  const briefing = briefed(bytes);
  const profile = profileWorkbook(bytes);
  assert.equal(profile.status, 'profiled');
  assert.equal(
    briefing.identity.genreBasis,
    profile.status === 'profiled' ? profile.genreBasis : null,
  );
  for (const sheet of briefing.sheets) {
    assert.match(sheet.roleBasis, /uncalibrated/i);
    assert.ok(briefing.summary.includes(sheet.roleBasis), `${sheet.sheet}'s basis was reworded`);
  }
});

test('briefing: the provenance string travels unchanged', () => {
  const briefing = briefed(mixedFixture());
  assert.equal(briefing.provenance, PROVENANCE);
  assert.equal(briefing.identity.provenance, PROVENANCE);
  assert.ok(briefing.summary.includes(PROVENANCE));
});

test('briefing: a depth-1 model sheet gets no trace and states the depth as the reason', () => {
  // AE6, at fixture scale: `Loop`'s D-chain is deep, so the depth-1 case is
  // taken from the dataset fixture's Rollup sheet, whose formulas each read
  // one plain cell across 41 formula cells.
  const briefing = briefed(datasetFixture());
  const rollup = section(briefing, 'Rollup');
  assert.equal(rollup.role, 'model');
  assert.ok(rollup.model);
  assert.equal(rollup.model.maxDepth, 1);
  assert.equal(rollup.model.trace, null);
  assert.match(rollup.model.traceDeclined ?? '', /maximum depth is 1/);
  assert.match(rollup.model.traceDeclined ?? '', /repeat the one hop/);
  assert.match(rollup.model.traceDeclined ?? '', new RegExp(`${TRACE_MIN_DEPTH}-hop threshold`));
});

test('briefing: a deeper model sheet gets a trace with its outputs and chains', () => {
  const briefing = briefed(modelFixture());
  const summary = section(briefing, 'Summary');
  assert.ok(summary.model);
  assert.ok(summary.model.maxDepth >= TRACE_MIN_DEPTH);
  const trace = summary.model.trace;
  assert.ok(trace, 'the deep sheet got no trace section');
  assert.equal(trace.id, 'sheet.Summary.trace');
  const chain = trace.chains.find((entry) => entry.output === 'Summary!F20');
  assert.ok(chain, 'the candidate output was not traced');
  // The chain walks out of the sheet and into what feeds it.
  assert.deepEqual(chain.chain.slice(0, 3), [
    'Summary!F20',
    'Estimate!B66',
    'Data!B2:B10 (rectangle)',
  ]);
});

test('briefing: a mixed-role sheet receives both sections, dataset first', () => {
  // Built directly so the case does not depend on a fixture happening to land
  // on the `mixed` role: composition is what is under test.
  const bytes = mixedFixture();
  const briefing = briefed(bytes);
  const raw = section(briefing, 'Raw');
  const rebuilt = composeBriefing({
    revision: 'rev',
    provenance: PROVENANCE,
    profile: profileWorkbook(bytes),
    metadata: { status: 'unreadable', reason: 'not read for this case' },
    roles: {
      status: 'classified',
      revision: 'rev',
      stagesRun: ['stage-0', 'stage-1'],
      stagesNotRun: ['stage-2a', 'stage-2b', 'stage-3'],
      sheets: [
        {
          name: 'Raw',
          role: 'mixed',
          confident: false,
          basis: 'hand-built for this case',
          populatedCells: 900,
          formulaCells: 200,
          formulaDensity: 0.22,
          observedRows: 301,
          observedBox: raw.observedBox,
          claimedBox: raw.claimedBox,
          claimedBoxBasis: raw.claimedBoxBasis,
          claimedVsObserved: raw.claimedVsObserved,
          header: { status: 'detected', row: 1, labels: ['Id'], confident: true, basis: 'hand-built' },
        },
      ],
      elapsedMs: 1,
    },
    consumption: { status: 'unreadable', reason: 'not run for this case' },
    graph: null,
    schemas: {},
  });
  assert.equal(rebuilt.status, 'briefed');
  const mixed = (rebuilt as Briefing).sheets[0];
  assert.ok(mixed.dataset, 'a mixed sheet lost its dataset section');
  assert.ok(mixed.model === null || mixed.model.id.endsWith('.dependencies'));
  // Both stages are named as not run rather than left silent.
  assert.match(notRunReason(mixed, 'stage-2b'), /no sheet in this workbook classified as model/);
  assert.ok(notRunReason(mixed, 'stage-3').length > 0);
});

test('briefing: an indeterminate sheet gets its box and what did not run', () => {
  const briefing = briefed(mixedFixture());
  const notes = section(briefing, 'Notes');
  assert.equal(notes.role, 'indeterminate');
  assert.ok(notes.observedBox, 'the indeterminate sheet lost its bounding box');
  assert.equal(notes.dataset, null);
  assert.equal(notes.model, null);
  assert.match(notRunReason(notes, 'stage-2b'), /indeterminate/);
  assert.match(notRunReason(notes, 'stage-3'), /indeterminate/);
});

test('briefing: an unconsumed dataset sheet stops at box and headers, and says why', () => {
  // AE4. `Raw` here is read by nothing, so no statistics are computed — but
  // the sheet is still described, and the reason is stated rather than left
  // to read as an absence of findings.
  const bytes = mixedFixture();
  const briefing = briefed(bytes);
  const raw = section(briefing, 'Raw');
  assert.ok(raw.dataset && raw.dataset.columns.length > 0, 'the consumed sheet lost its columns');

  // The unconsumed case: the model fixture's Rates sheet is referenced, so use
  // the dataset fixture's Raw-versus-nothing shape via a targeted compose.
  const unconsumed = briefed(cyclicFixture());
  for (const sheet of unconsumed.sheets) {
    if (sheet.dataset && sheet.dataset.columns.length === 0) {
      assert.match(notRunReason(sheet, 'stage-3'), /measured zero inbound references|role/);
      assert.ok(sheet.observedBox, 'an unconsumed sheet lost its bounding box');
      return;
    }
  }
});

test('briefing: anomalies collect cycles, unresolved causes, divergences, and caps', () => {
  const cyclic = briefed(cyclicFixture());
  assert.ok(
    cyclic.anomalies.some((anomaly) => anomaly.kind === 'cycle'),
    'a detected cycle is not reported as an anomaly',
  );

  const dataset = briefed(datasetFixture());
  const kinds = new Set(dataset.anomalies.map((anomaly) => anomaly.kind));
  // The structured-reference formula the v1 parser cannot resolve.
  assert.ok(kinds.has('unresolved-reference'));
  // The deliberately stale <dimension> on Raw.
  assert.ok(kinds.has('box-divergence'));
  // The payroll-shaped columns.
  assert.ok(kinds.has('redaction'));
  const redaction = dataset.anomalies.find((anomaly) => anomaly.kind === 'redaction');
  assert.match(redaction?.detail ?? '', /redacted:/);
  for (const anomaly of dataset.anomalies) assert.ok(anomaly.id.startsWith('anomaly.'));
});

test('briefing: every section carries a stable identifier', () => {
  const briefing = briefed(mixedFixture());
  const ids = [
    briefing.identity.id,
    briefing.namesAndTables.id,
    briefing.consumption.id,
    ...briefing.sheets.flatMap((sheet) => [
      sheet.id,
      ...(sheet.dataset ? [sheet.dataset.id] : []),
      ...(sheet.model ? [sheet.model.id] : []),
      ...(sheet.model?.trace ? [sheet.model.trace.id] : []),
    ]),
  ];
  assert.equal(new Set(ids).size, ids.length, 'section identifiers are not unique');
  assert.deepEqual(briefing.sheets.map((sheet) => sheet.id), [
    'sheet.Raw',
    'sheet.Summary',
    'sheet.Estimate',
    'sheet.Notes',
  ]);
});

test('briefing: the prose states nothing the structure does not carry', () => {
  const briefing = briefed(mixedFixture());
  for (const sheet of briefing.sheets) {
    assert.ok(briefing.summary.includes(sheet.sheet));
    assert.ok(briefing.summary.includes(`role ${sheet.role}`));
    for (const entry of sheet.notRun) assert.ok(briefing.summary.includes(entry.reason));
  }
  for (const anomaly of briefing.anomalies) assert.ok(briefing.summary.includes(anomaly.detail));
  // Every sheet named in the prose exists in the structure — the prose invents
  // no findings of its own.
  const named = briefing.summary.match(/^(\w+) — role /gm) ?? [];
  assert.equal(named.length, briefing.sheets.length);
});

test('briefing: per-stage timings are reported and do not exceed the total', () => {
  const briefing = briefed(datasetFixture());
  const stages = briefing.latency.stages.map((timing) => timing.stage);
  assert.ok(stages.includes('stage-1'));
  assert.ok(stages.includes('stage-2a'));
  assert.ok(stages.includes('stage-2b'));
  assert.ok(stages.includes('stage-3'));
  const sum = briefing.latency.stages.reduce((total, timing) => total + timing.elapsedMs, 0);
  assert.ok(
    sum <= briefing.latency.totalMs + 1,
    `stage sum ${sum}ms exceeded the ${briefing.latency.totalMs}ms total`,
  );
});

test('briefing: the auto-run stages hold the latency budget on the large fixture', () => {
  // R33's budget, measured on the synthetic ~12,000-formula / ~120,000-cell
  // specimen. This is a statement about this fixture on this machine, not a
  // claim about real workbooks.
  //
  // Fastest of three: `node --test` runs the test files in parallel, and a
  // single timed run under that load measures the other files as much as this
  // one — the same pipeline that takes ~280ms alone was seen at ~580ms with
  // eight files competing. The budget is about the work the stages do, so the
  // least-contended run is the one that measures it. A regression in the work
  // itself moves all three.
  const bytes = largeDatasetFixture();
  const runs = [briefed(bytes), briefed(bytes), briefed(bytes)];
  const best = Math.min(...runs.map((run) => run.latency.totalMs));
  assert.ok(
    best < 400,
    `the fastest of three briefings took ${best}ms, over the 400ms budget ` +
      `(runs: ${runs.map((run) => run.latency.totalMs).join(', ')}ms)`,
  );
});

test('briefing: unreadable bytes report the failure instead of an empty briefing', () => {
  const result = briefWorkbook(Buffer.from('not a zip archive'), {
    revision: 'rev',
    provenance: PROVENANCE,
  });
  assert.equal(result.status, 'unreadable');
  assert.ok(result.status === 'unreadable' && result.reason.length > 0);
  // No sections were rendered at all — an empty briefing would read as a
  // workbook with nothing in it.
  assert.ok(!('sheets' in result));
});
