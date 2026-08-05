/**
 * Cross-sheet consumption index.
 *
 * The load-bearing distinction under test is between "measured zero" and
 * "not seen": a column nothing references and a column referenced only through
 * a shape this version cannot resolve must not read alike, because Stage 3
 * spends its budget on the difference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WIDE_REFERENCE_COLUMNS,
  buildConsumptionIndex,
  type ConsumptionIndexReport,
  type SheetConsumption,
} from './consumption-index.ts';
import { buildDependencyGraph } from './workbook-graph.ts';
import { DATASET_AMOUNT_REFS, datasetFixture, part, writeZipStored } from './test-fixtures.ts';

/** A workbook of named sheets, each given as raw `<c>` elements. */
function workbook(sheets: readonly { name: string; cells: string }[]) {
  return writeZipStored([
    part(
      'xl/workbook.xml',
      `<workbook><sheets>${sheets
        .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      `<Relationships>${sheets
        .map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ),
    ...sheets.map((sheet, index) =>
      part(`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData>${sheet.cells}</sheetData></worksheet>`),
    ),
  ]);
}

function formula(address: string, text: string) {
  return `<c r="${address}"><f>${text}</f><v>0</v></c>`;
}

function indexed(bytes: Uint8Array, options?: { referenceCap?: number }): ConsumptionIndexReport {
  const result = buildConsumptionIndex(bytes, options);
  assert.equal(result.status, 'indexed');
  return result as ConsumptionIndexReport;
}

function target(report: ConsumptionIndexReport, name: string): SheetConsumption {
  const found = report.sheets.find((sheet) => sheet.name === name);
  assert.ok(found, `no sheet named ${name}`);
  return found;
}

test('index: a cross-sheet range names the referencing sheet, cell, and rectangle', () => {
  const report = indexed(
    workbook([
      { name: 'Raw', cells: '' },
      { name: 'Summary', cells: formula('A1', 'SUM(Raw!C2:C3000)') },
    ]),
  );
  const raw = target(report, 'Raw');
  assert.equal(raw.totalInbound, 1);
  assert.deepEqual(raw.referencingSheets, ['Summary']);
  assert.equal(raw.inbound[0].fromSheet, 'Summary');
  assert.equal(raw.inbound[0].fromCell, 'A1');
  assert.equal(raw.inbound[0].ref, 'C2:C3000');
  assert.equal(raw.inbound[0].kind, 'range');
});

test('index: an intra-sheet formula is not inbound consumption', () => {
  const report = indexed(workbook([{ name: 'Raw', cells: formula('D2', 'B2*2') }]));
  assert.equal(target(report, 'Raw').totalInbound, 0);
  assert.equal(report.formulaCellsScanned, 1);
});

test('index: zero inbound references is stated as measured, not assumed', () => {
  const report = indexed(
    workbook([
      { name: 'Raw', cells: '' },
      { name: 'Other', cells: formula('A1', '1+1') },
    ]),
  );
  const raw = target(report, 'Raw');
  assert.equal(raw.totalInbound, 0);
  assert.match(raw.basis, /zero is measured, not assumed/);
  assert.match(raw.basis, /formula cells/);
});

test('index: the column roll-up names every column an inbound reference touches', () => {
  const report = indexed(
    workbook([
      { name: 'Raw', cells: '' },
      { name: 'Summary', cells: formula('A1', 'SUM(Raw!C2:C3000)+Raw!E5') },
    ]),
  );
  assert.deepEqual(
    target(report, 'Raw').columns.map((column) => column.letter),
    ['C', 'E'],
  );
});

test('index: heavy use of one column and none of another is visible as counts', () => {
  const raw = target(indexed(datasetFixture()), 'Raw');
  const byLetter = new Map(raw.columns.map((column) => [column.letter, column.references]));
  assert.equal(byLetter.get('C'), DATASET_AMOUNT_REFS);
  assert.equal(byLetter.get('G'), undefined);
  assert.equal(byLetter.get('D'), undefined);
});

test('index: a structured-reference-only formula reports the blind spot, not zero use', () => {
  const report = indexed(
    workbook([
      { name: 'Raw', cells: '' },
      { name: 'Rollup', cells: formula('A1', 'SUM(RawTable[Score])') },
    ]),
  );
  assert.equal(target(report, 'Raw').totalInbound, 0);
  assert.equal(report.unresolved.total, 1);
  assert.equal(report.unresolved.byCause['structured-table-ref'], 1);
  assert.match(report.unresolved.blindSpot, /"not seen", not "not used"/);
});

test('index: an unresolved reference turns every count into a stated floor', () => {
  const report = indexed(
    workbook([
      { name: 'Raw', cells: '' },
      { name: 'Rollup', cells: formula('A1', 'SUM(RawTable[Score])') },
    ]),
  );
  assert.match(target(report, 'Raw').basis, /this count is a floor/);
});

test('index: a rectangle spanning the sheet is sheet-level evidence, not column evidence', () => {
  const wide = `A1:${'BZ'}5000`;
  const report = indexed(
    workbook([
      { name: 'Raw', cells: '' },
      { name: 'Summary', cells: formula('A1', `COUNTA(Raw!${wide})`) },
    ]),
  );
  const raw = target(report, 'Raw');
  assert.equal(raw.totalInbound, 1);
  assert.equal(raw.sheetLevelReferences, 1);
  assert.deepEqual(raw.columns, []);
  assert.match(raw.basis, new RegExp(`more than ${WIDE_REFERENCE_COLUMNS} columns`));
});

test('index: a reference to a sheet this workbook does not declare is named, not dropped', () => {
  const report = indexed(workbook([{ name: 'Summary', cells: formula('A1', 'Ghost!A1') }]));
  assert.deepEqual(report.unknownSheetNames, ['Ghost']);
});

test('index: the reference cap reports when it bites', () => {
  const report = indexed(datasetFixture(), { referenceCap: 5 });
  assert.equal(report.truncated, true);
  assert.match(report.truncationReason ?? '', /5-reference cap bit/);
  assert.equal(target(report, 'Raw').totalInbound, 5);
});

test('index: stage 2a names itself run and the other stages not run', () => {
  const report = indexed(datasetFixture());
  assert.deepEqual(report.stagesRun, ['stage-2a']);
  assert.deepEqual(report.stagesNotRun, ['stage-0', 'stage-1', 'stage-2b', 'stage-3']);
  assert.match(report.revision, /^[0-9a-f]{64}$/);
});

test('index: the cheap answer costs less than building the graph it stands in for', () => {
  // The whole point of Stage 2a is that "is this data read, and from where" is
  // answerable without the graph. If it were not materially cheaper there would
  // be no reason to keep it as a separate stage. Compared against the graph
  // forced over both sheets, since role-gating would otherwise skip the table.
  const bytes = datasetFixture();
  const index = indexed(bytes);
  const graph = buildDependencyGraph(bytes, { includeSheets: ['Raw', 'Rollup'] });
  assert.equal(graph.status, 'built');
  assert.ok(index.elapsedMs >= 0);
  assert.ok(
    graph.status === 'built' && index.elapsedMs < graph.elapsedMs,
    `index ${index.elapsedMs}ms was not below graph ${
      graph.status === 'built' ? graph.elapsedMs : 'n/a'
    }ms`,
  );
});

test('index: non-ZIP bytes return the typed unreadable failure', () => {
  const result = buildConsumptionIndex(Buffer.from('not a zip archive'));
  assert.equal(result.status, 'unreadable');
  assert.ok(result.status === 'unreadable' && result.reason.length > 0);
});
