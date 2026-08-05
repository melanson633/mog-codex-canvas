/**
 * Per-sheet extent and role hypothesis.
 *
 * The role rule's edge cases are exercised against purpose-built single-sheet
 * workbooks rather than the shared specimens: a sheet built to sit exactly at
 * a threshold says what the threshold does, where a realistic fixture only
 * says what one workbook happens to be.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROLE_THRESHOLDS,
  classifySheetRoles,
  readSheetExtents,
  type SheetRoleReport,
  type SheetRolesReport,
} from './sheet-roles.ts';
import { datasetFixture, mixedFixture, modelFixture, part, writeZipStored } from './test-fixtures.ts';

/** A one-sheet workbook whose sheet XML the caller writes. */
function oneSheet(xml: string, name = 'S') {
  return writeZipStored([
    part('xl/workbook.xml', `<workbook><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', `<worksheet>${xml}</worksheet>`),
  ]);
}

function num(address: string, value = '1') {
  return `<c r="${address}"><v>${value}</v></c>`;
}
function str(address: string, text: string) {
  return `<c r="${address}" t="inlineStr"><is><t>${text}</t></is></c>`;
}
function formula(address: string, text: string) {
  return `<c r="${address}"><f>${text}</f><v>0</v></c>`;
}

function classified(bytes: Uint8Array): SheetRolesReport {
  const result = classifySheetRoles(bytes);
  assert.equal(result.status, 'classified');
  return result as SheetRolesReport;
}

function sheet(bytes: Uint8Array, name: string): SheetRoleReport {
  const found = classified(bytes).sheets.find((entry) => entry.name === name);
  assert.ok(found, `no sheet named ${name}`);
  return found;
}

/** A wide table: `rows` data rows under a string header, no formulas. */
function tableSheet(rows: number, columns = 4, dimension = '') {
  const headers = Array.from({ length: columns }, (_, index) =>
    str(`${String.fromCharCode(65 + index)}1`, `Col ${index + 1}`),
  ).join('');
  const body = Array.from({ length: rows }, (_, index) =>
    Array.from({ length: columns }, (_, column) =>
      num(`${String.fromCharCode(65 + column)}${index + 2}`, String(index)),
    ).join(''),
  ).join('');
  return oneSheet(`${dimension}<sheetData><row r="1">${headers}</row>${body}</sheetData>`);
}

// ---- Stage 0 ----------------------------------------------------------------

test('extents: a declared dimension is reported as claimed, not verified', () => {
  const result = readSheetExtents(oneSheet('<dimension ref="A1:D10"/><sheetData/>'));
  assert.equal(result.status, 'extracted');
  assert.ok(result.status === 'extracted');
  const [only] = result.sheets;
  assert.equal(only.claimedBox?.ref, 'A1:D10');
  assert.match(only.claimedBoxBasis, /<dimension/);
  assert.match(only.claimedBoxBasis, /not verified/);
});

test('extents: no dimension element is null with a stated reason, not a throw', () => {
  const result = readSheetExtents(oneSheet('<sheetData/>'));
  assert.ok(result.status === 'extracted');
  assert.equal(result.sheets[0].claimedBox, null);
  assert.match(result.sheets[0].claimedBoxBasis, /unknown, not empty/);
});

test('extents: the shipped shape counts are still reported per sheet', () => {
  const result = readSheetExtents(modelFixture());
  assert.ok(result.status === 'extracted');
  const data = result.sheets.find((entry) => entry.name === 'Data');
  assert.equal(data?.rows, 10);
  assert.equal(data?.cells, 10);
  assert.equal(data?.formulas, 0);
});

test('extents: stage 0 names itself run and every other stage not run', () => {
  const result = readSheetExtents(modelFixture());
  assert.ok(result.status === 'extracted');
  assert.deepEqual(result.stagesRun, ['stage-0']);
  assert.deepEqual(result.stagesNotRun, ['stage-1', 'stage-2a', 'stage-2b', 'stage-3']);
});

test('extents: non-ZIP bytes return the typed unreadable failure', () => {
  const result = readSheetExtents(Buffer.from('not a zip archive'));
  assert.equal(result.status, 'unreadable');
  assert.ok(result.status === 'unreadable' && result.reason.length > 0);
});

// ---- Claimed versus observed ------------------------------------------------

test('roles: a stale dimension reports both boxes and describes the divergence', () => {
  // The dataset fixture declares A1:Z5000 over a table that ends well short.
  const raw = sheet(datasetFixture(), 'Raw');
  assert.equal(raw.claimedBox?.ref, 'A1:Z5000');
  assert.equal(raw.observedBox?.ref, 'A1:I3001');
  assert.match(raw.claimedVsObserved, /declared A1:Z5000 but cells were found only in A1:I3001/);
  assert.match(raw.claimedVsObserved, /1999 rows beyond/);
  assert.match(raw.claimedVsObserved, /17 columns beyond/);
});

test('roles: matching boxes report agreement rather than a described gap', () => {
  const only = sheet(tableSheet(20, 4, '<dimension ref="A1:D21"/>'), 'S');
  assert.equal(only.claimedVsObserved, 'agrees');
});

// ---- Role rule --------------------------------------------------------------

test('roles: a large header-led table with no formulas is a dataset', () => {
  const only = sheet(tableSheet(3000), 'S');
  assert.equal(only.role, 'dataset');
  assert.equal(only.formulaDensity, 0);
  assert.match(only.basis, /formula density 0\.000/);
  assert.match(only.basis, /3001 observed rows/);
  assert.match(only.basis, /header row 1/);
});

test('roles: a formula-dense sheet is a model', () => {
  const cells =
    Array.from({ length: 33 }, (_, index) => formula(`A${index + 1}`, `B${index + 1}+1`)).join('') +
    Array.from({ length: 7 }, (_, index) => num(`B${index + 1}`)).join('');
  const only = sheet(oneSheet(`<sheetData><row r="1">${cells}</row></sheetData>`), 'S');
  assert.equal(only.role, 'model');
  assert.equal(only.populatedCells, 40);
  assert.equal(only.formulaCells, 33);
  assert.match(only.basis, /formula density 0\.825/);
});

test('roles: a sheet that is both a table and a formula block is mixed, with no regions', () => {
  const table = Array.from({ length: 40 }, (_, index) =>
    ['A', 'B', 'C'].map((column) => num(`${column}${index + 2}`)).join(''),
  ).join('');
  const headers = ['A', 'B', 'C'].map((column, index) => str(`${column}1`, `Col ${index}`)).join('');
  const block = Array.from({ length: 30 }, (_, index) => formula(`F${index + 1}`, `A${index + 2}*2`)).join('');
  const only = sheet(oneSheet(`<sheetData><row r="1">${headers}${table}${block}</row></sheetData>`), 'S');

  assert.equal(only.role, 'mixed');
  assert.equal(only.confident, false);
  assert.match(only.basis, /neither rule matched cleanly/);
  assert.match(only.basis, /segmentation is not attempted/);
  assert.ok(!('regions' in only), 'mixed must not imply a segmentation result');
});

test('roles: three populated cells is indeterminate, not model', () => {
  const only = sheet(
    oneSheet(`<sheetData><row r="1">${formula('A1', 'B1')}${formula('A2', 'B2')}${num('B1')}</row></sheetData>`),
    'S',
  );
  assert.equal(only.role, 'indeterminate');
  assert.equal(only.confident, false);
  assert.match(only.basis, /too small to judge/);
  assert.match(only.basis, new RegExp(`${ROLE_THRESHOLDS.minPopulatedCells}-cell floor`));
});

test('roles: every role result carries a basis naming a threshold value', () => {
  for (const bytes of [modelFixture(), datasetFixture(), mixedFixture()]) {
    for (const entry of classified(bytes).sheets) {
      assert.ok(entry.basis.length > 0, `${entry.name} has no basis`);
      assert.match(entry.basis, new RegExp(String(ROLE_THRESHOLDS.modelFormulaDensity)));
      assert.match(entry.basis, /uncalibrated/);
    }
  }
});

test('roles: one workbook can hold sheets of different roles', () => {
  const roles = new Map(classified(mixedFixture()).sheets.map((entry) => [entry.name, entry.role]));
  assert.equal(roles.get('Raw'), 'dataset');
  assert.equal(roles.get('Summary'), 'model');
  assert.equal(roles.get('Notes'), 'indeterminate');
});

// ---- Header detection -------------------------------------------------------

test('headers: labels come back in column order over numeric data', () => {
  const only = sheet(tableSheet(30, 4), 'S');
  assert.equal(only.header.status, 'detected');
  assert.equal(only.header.row, 1);
  assert.deepEqual(
    only.header.labels.map((entry) => entry.label),
    ['Col 1', 'Col 2', 'Col 3', 'Col 4'],
  );
  assert.deepEqual(
    only.header.labels.map((entry) => entry.column),
    [1, 2, 3, 4],
  );
  assert.equal(only.header.confident, true);
});

test('headers: an all-numeric first row reports none with a reason', () => {
  const rows = Array.from({ length: 30 }, (_, index) =>
    `<row r="${index + 1}">${num(`A${index + 1}`)}${num(`B${index + 1}`)}</row>`,
  ).join('');
  const only = sheet(oneSheet(`<sheetData>${rows}</sheetData>`), 'S');
  assert.equal(only.header.status, 'none');
  assert.equal(only.header.row, null);
  assert.match(only.header.basis, /no header row found/);
  assert.match(only.header.basis, /threshold 0\.8/);
});

test('headers: a candidate row mixing labels and numbers is detected but not confident', () => {
  const headers = `${str('A1', 'Id')}${str('B1', 'Name')}${str('C1', 'Amount')}${str('D1', 'Score')}${num('E1', '2026')}`;
  const body = Array.from({ length: 20 }, (_, index) =>
    `<row r="${index + 2}">${['A', 'B', 'C', 'D', 'E']
      .map((column) => num(`${column}${index + 2}`))
      .join('')}</row>`,
  ).join('');
  const only = sheet(oneSheet(`<sheetData><row r="1">${headers}</row>${body}</sheetData>`), 'S');
  assert.equal(only.header.status, 'detected');
  assert.equal(only.header.confident, false);
  assert.match(only.header.basis, /mixes labels and numbers/);
});

test('headers: a label-only sheet finds no header, because nothing contrasts with it', () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    `<row r="${index + 1}">${str(`A${index + 1}`, 'text')}${str(`B${index + 1}`, 'more')}</row>`,
  ).join('');
  const only = sheet(oneSheet(`<sheetData>${rows}</sheetData>`), 'S');
  assert.equal(only.header.status, 'none');
  assert.match(only.header.basis, /read like labels too/);
});

// ---- Stage reporting --------------------------------------------------------

test('roles: stage 1 names stages 0 and 1 run, and stages 2 and 3 not run', () => {
  const result = classified(modelFixture());
  assert.deepEqual(result.stagesRun, ['stage-0', 'stage-1']);
  assert.deepEqual(result.stagesNotRun, ['stage-2a', 'stage-2b', 'stage-3']);
});

test('roles: the result is keyed to the workbook revision', () => {
  assert.match(classified(modelFixture()).revision, /^[0-9a-f]{64}$/);
});

test('roles: non-ZIP bytes return the typed unreadable failure', () => {
  const result = classifySheetRoles(Buffer.from('still not a zip'));
  assert.equal(result.status, 'unreadable');
});
