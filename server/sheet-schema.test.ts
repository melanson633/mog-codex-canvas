/**
 * Column schema and population statistics.
 *
 * Three things are being held to account here. Depth must follow measured
 * consumption rather than being spent everywhere; every column below full depth
 * must say so with the threshold that caused it; and the redaction guard must
 * fire before any statistic exists, including when the caller asked for full
 * depth explicitly. A redaction failure in this file is a release blocker, not
 * a finding.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHEMA_THRESHOLDS,
  describeSheetData,
  type ColumnProfile,
  type SheetDataDescription,
} from './sheet-schema.ts';
import { classifySheetRoles, type SheetRolesReport } from './sheet-roles.ts';
import { datasetFixture, mixedFixture, part, writeZipStored } from './test-fixtures.ts';

function described(
  bytes: Uint8Array,
  sheet: string,
  options?: Parameters<typeof describeSheetData>[2],
): SheetDataDescription {
  const result = describeSheetData(bytes, sheet, options);
  assert.equal(result.status, 'described', `unexpected status: ${result.status}`);
  return result as SheetDataDescription;
}

function column(description: SheetDataDescription, header: string): ColumnProfile {
  const found = description.columns.find((entry) => entry.header === header);
  assert.ok(found, `no column headed ${header}`);
  return found;
}

/** A single-sheet workbook plus a consumer sheet, built from raw `<c>` rows. */
function workbook(sheets: readonly { name: string; rows: string }[]) {
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
      part(`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData>${sheet.rows}</sheetData></worksheet>`),
    ),
  ]);
}

const text = (address: string, value: string) =>
  `<c r="${address}" t="inlineStr"><is><t>${value}</t></is></c>`;
const num = (address: string, value: string | number) => `<c r="${address}"><v>${value}</v></c>`;
const formula = (address: string, body: string) => `<c r="${address}"><f>${body}</f><v>0</v></c>`;

/** `Data` with the given headers and a body row builder, plus a consumer sheet. */
function dataSheet(
  headers: readonly string[],
  rows: number,
  body: (row: number, index: number) => string,
  consumer = '',
) {
  const header = `<row r="1">${headers
    .map((label, index) => text(`${String.fromCharCode(65 + index)}1`, label))
    .join('')}</row>`;
  const data: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    data.push(`<row r="${index + 2}">${body(index + 2, index)}</row>`);
  }
  return workbook([
    { name: 'Data', rows: header + data.join('') },
    { name: 'Use', rows: consumer },
  ]);
}

/** N formulas on `Use` pointing at one column of `Data`. */
function consumes(letter: string, count: number, from = 1) {
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const r = from + index;
    rows.push(`<row r="${r}">${formula(`A${r}`, `Data!${letter}${index + 2}+1`)}</row>`);
  }
  return rows.join('');
}

test('schema: a detected header row supplies the labels and names its source', () => {
  const description = described(
    dataSheet(['Alpha', 'Beta', 'Gamma'], 12, (r) => num(`A${r}`, r) + text(`B${r}`, 'x') + num(`C${r}`, r),
      consumes('A', 12)),
    'Data',
  );
  assert.equal(description.headerSource, 'detected-row');
  assert.deepEqual(
    description.columns.map((entry) => entry.header),
    ['Alpha', 'Beta', 'Gamma'],
  );
  assert.match(description.headerSourceBasis, /detected header row 1/);
});

test('schema: a declared table supplies the labels and says the file stated them', () => {
  const description = described(datasetFixture(), 'Raw');
  assert.equal(description.headerSource, 'table-definition');
  assert.equal(description.columns[0].header, 'Id');
  assert.match(description.headerSourceBasis, /declared table "RawTable"/);
});

test('schema: a heavily-referenced numeric column reports counts, extents, and distinct', () => {
  const amount = column(described(datasetFixture(), 'Raw'), 'Amount');
  assert.equal(amount.depth, 'full');
  assert.equal(amount.type, 'number');
  assert.equal(amount.rowCount, 3000);
  assert.equal(amount.nullCount, 0);
  assert.equal(amount.min, 0);
  assert.equal(amount.max, 747);
  assert.equal(amount.distinctCount, 250);
});

test('schema: a column whose cells disagree reports mixed with every observed type', () => {
  const score = column(described(datasetFixture(), 'Raw'), 'Score');
  assert.equal(score.type, 'mixed');
  const counts = new Map(score.observedTypes.map((observed) => [observed.type, observed.cells]));
  assert.equal(counts.get('number'), 2994);
  assert.equal(counts.get('text'), 6);
});

test('schema: blank cells are counted as nulls, not dropped', () => {
  const description = described(
    dataSheet(['Value'], 20, (r, index) => (index % 4 === 0 ? text(`A${r}`, '') : num(`A${r}`, index)),
      consumes('A', 12)),
    'Data',
  );
  const value = column(description, 'Value');
  assert.equal(value.rowCount, 20);
  assert.equal(value.nullCount, 5);
});

test('schema: a heavily-used column is full depth and an unused one is skipped with its threshold', () => {
  const description = described(datasetFixture(), 'Raw');
  assert.equal(column(description, 'Amount').depth, 'full');
  const notes = column(description, 'Notes');
  assert.equal(notes.depth, 'summary');
  assert.equal(notes.distinctCount, null);
  assert.equal(notes.skipped.length, 2);
  assert.match(notes.skipped[0].threshold, /10 inbound references for full depth/);
  assert.match(notes.skipped[0].reason, /zero is measured, not assumed/);
});

test('schema: a lightly-referenced column returns counts with extents and distinct skipped', () => {
  const description = described(
    dataSheet(['Value'], 30, (r, index) => num(`A${r}`, index), consumes('A', 2)),
    'Data',
  );
  const value = column(description, 'Value');
  assert.equal(value.depth, 'counts');
  assert.equal(value.rowCount, 30);
  assert.equal(value.min, null);
  assert.equal(value.distinctCount, null);
  assert.deepEqual(
    value.skipped.map((entry) => entry.what),
    ['extents', 'distinct'],
  );
  assert.match(value.skipped[0].reason, new RegExp(`below the full-depth threshold of ${SCHEMA_THRESHOLDS.heavyUseReferences}`));
});

test('schema: a whole-sheet reference is sheet-level evidence and promotes nothing', () => {
  const description = described(
    dataSheet(
      ['Value', 'Other'],
      15,
      (r, index) => num(`A${r}`, index) + num(`B${r}`, index),
      `<row r="1">${formula('A1', 'COUNTA(Data!A1:BZ5000)')}</row>`,
    ),
    'Data',
  );
  assert.equal(description.gating.sheetLevelEvidence, 1);
  assert.equal(description.gating.columnEvidence, 0);
  assert.equal(description.gating.fallbackTier, 'counts');
  assert.match(description.gating.fallbackReason ?? '', /says nothing about any individual column/);
  for (const entry of description.columns) {
    assert.equal(entry.depth, 'counts');
    assert.equal(entry.distinctCount, null);
  }
});

test('schema: an unresolved inbound count fails open rather than reporting settled non-use', () => {
  const description = described(
    dataSheet(
      ['Value'],
      15,
      (r, index) => num(`A${r}`, index),
      `<row r="1">${formula('A1', 'SUM(DataTable[Value])')}</row>`,
    ),
    'Data',
  );
  assert.equal(description.gating.columnEvidence, 0);
  assert.ok(description.gating.unresolvedInbound > 0);
  const value = column(description, 'Value');
  assert.equal(value.depth, 'counts');
  assert.equal(value.rowCount, 15);
  assert.match(description.gating.blindSpot ?? '', /"not seen", not "not used"/);
});

test('schema: numeric extents on date-shaped serials are labeled raw serial values', () => {
  const description = described(
    dataSheet(['Start'], 15, (r, index) => num(`A${r}`, 45000 + index), consumes('A', 12)),
    'Data',
  );
  const start = column(description, 'Start');
  assert.equal(start.min, 45000);
  assert.equal(start.max, 45014);
  assert.match(start.extentsNote ?? '', /raw stored numbers/);
  assert.match(start.extentsNote ?? '', /styles\.xml/);
});

test('schema: a text column reports no min or max and says why', () => {
  // A numeric second column so the header row is distinguishable from the body —
  // an all-text sheet has no detectable header, which is U3's honest answer.
  const description = described(
    dataSheet(
      ['Label', 'Count'],
      15,
      (r, index) => text(`A${r}`, `row ${index}`) + num(`B${r}`, index),
      consumes('A', 12),
    ),
    'Data',
  );
  const label = column(description, 'Label');
  assert.equal(label.depth, 'full');
  assert.equal(label.min, null);
  assert.equal(label.max, null);
  assert.match(label.extentsNote ?? '', /numeric columns only/);
});

test('schema: a dataset sheet nothing references stops at box plus headers', () => {
  const description = described(mixedFixture(), 'Notes');
  assert.match(description.statisticsSkipped ?? '', /bounding box plus headers/);
  for (const entry of description.columns) {
    assert.equal(entry.rowCount, null);
    assert.equal(entry.distinctCount, null);
  }
  assert.ok(description.observedBox);
});

test('schema: SSN and date-of-birth headers are redacted, reported, and stripped of statistics', () => {
  const description = described(datasetFixture(), 'Raw');
  for (const header of ['SSN', 'Date of Birth']) {
    const entry = column(description, header);
    assert.equal(entry.redacted, true);
    assert.match(entry.redactionReason ?? '', /R38/);
    assert.equal(entry.min, null);
    assert.equal(entry.max, null);
    assert.equal(entry.distinctCount, null);
    assert.ok(entry.rowCount !== null && entry.nullCount !== null);
  }
});

test('schema: a benign header with SSN-shaped values is redacted on the value shape', () => {
  const employee = column(described(datasetFixture(), 'Raw'), 'Employee ID');
  assert.equal(employee.redacted, true);
  assert.match(employee.redactionReason ?? '', /value shape, not by header/);
  assert.equal(employee.min, null);
});

test('schema: override reaches the materiality gate and never the redaction guard', () => {
  const description = described(datasetFixture(), 'Raw', { override: true });
  const notes = column(description, 'Notes');
  assert.equal(notes.depth, 'full');
  assert.equal(notes.rowCount, 3000);
  assert.match(notes.depthBasis, /explicit override/);
  const ssn = column(description, 'SSN');
  assert.equal(ssn.redacted, true);
  assert.equal(ssn.distinctCount, null);
  assert.equal(ssn.min, null);
});

test('schema: no field anywhere in the result carries a raw cell value', () => {
  const description = described(datasetFixture(), 'Raw', { override: true });
  const serialized = JSON.stringify(description);
  // Values from the fixture's own rows, one per column shape it produces.
  for (const value of ['123-45-6', '987-65-4', 'Row 1', 'note 3', 'n/a']) {
    assert.equal(serialized.includes(value), false, `result leaked a raw value: ${value}`);
  }
});

test('schema: the distinct cap reports when it bites', () => {
  const description = described(datasetFixture(), 'Raw', { distinctCap: 25 });
  const amount = column(description, 'Amount');
  assert.equal(amount.distinctCapped, true);
  assert.equal(amount.distinctCount, 25);
  assert.equal(description.truncated, true);
  assert.match(description.truncationReason ?? '', /25-value distinct cap bit/);
});

test('schema: every gating decision carries a threshold value and a basis', () => {
  const description = described(datasetFixture(), 'Raw');
  assert.equal(description.gating.thresholds.heavyUseReferences, SCHEMA_THRESHOLDS.heavyUseReferences);
  assert.match(description.gating.basis, /uncalibrated thresholds/);
  for (const entry of description.columns) {
    assert.ok(entry.depthBasis.length > 0, `column ${entry.letter} has no depth basis`);
  }
  assert.deepEqual(description.stagesRun, ['stage-0', 'stage-1', 'stage-2a', 'stage-3']);
  assert.deepEqual(description.stagesNotRun, ['stage-2b']);
  assert.match(description.revision, /^[0-9a-f]{64}$/);
});

test('schema: an unknown sheet name is a typed failure that names the sheets that exist', () => {
  const result = describeSheetData(datasetFixture(), 'Nope');
  assert.equal(result.status, 'no-such-sheet');
  assert.ok(result.status === 'no-such-sheet' && result.sheets.includes('Raw'));
});

test('schema: non-ZIP bytes return the typed unreadable failure', () => {
  const result = describeSheetData(Buffer.from('not a zip archive'), 'Raw');
  assert.equal(result.status, 'unreadable');
  assert.ok(result.status === 'unreadable' && result.reason.length > 0);
});

// ---- R38: the guard's inputs ------------------------------------------------
//
// The guard's logic was never the problem — what it was handed was. Each case
// below feeds it a shape that used to reach it wrong, so the column it names
// and the column it protects are the same column. A failure here is a release
// blocker: it means high-risk data was profiled, or a clean bill of health was
// issued for a column nothing looked at.

/** A birthdate column, because the SSN value-shape rule would mask the header bug. */
const DOB_HEADER = 'Date of Birth';

function columnAt(description: SheetDataDescription, letter: string): ColumnProfile {
  const found = description.columns.find((entry) => entry.letter === letter);
  assert.ok(found, `no column at ${letter}`);
  return found;
}

/**
 * A header row with a hole in it: A1 is blank, so stage 1's label list holds
 * two entries for columns B and C while the body starts at column A.
 */
function gappedHeaderSheet(rows = 15, consumer = consumes('C', 12)) {
  const header = `<row r="1">${text('B1', 'Name')}${text('C1', DOB_HEADER)}</row>`;
  const body: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const r = index + 2;
    body.push(
      `<row r="${r}">${num(`A${r}`, index)}${text(`B${r}`, `row ${index}`)}${num(`C${r}`, 30000 + index)}</row>`,
    );
  }
  return workbook([{ name: 'Data', rows: header + body.join('') }, { name: 'Use', rows: consumer }]);
}

/** A merged single-cell title sitting above the real header row. */
function titledSheet(rows = 15) {
  const title = `<row r="1">${text('A1', 'Payroll Register')}</row>`;
  const header = `<row r="2">${text('A2', 'Id')}${text('B2', 'Name')}${text('C2', DOB_HEADER)}</row>`;
  const body: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const r = index + 3;
    body.push(
      `<row r="${r}">${num(`A${r}`, index)}${text(`B${r}`, `row ${index}`)}${num(`C${r}`, 30000 + index)}</row>`,
    );
  }
  return workbook([
    { name: 'Data', rows: title + header + body.join('') },
    { name: 'Use', rows: consumes('C', 12, 1) },
  ]);
}

test('R38: a blank header cell does not shift the guard onto a neighbouring column', () => {
  const description = described(gappedHeaderSheet(), 'Data');
  // Labels are matched by source column, so the hole at A leaves B and C where
  // the file put them rather than sliding every later label one column left.
  assert.equal(columnAt(description, 'A').header, null);
  assert.equal(columnAt(description, 'B').header, 'Name');
  assert.equal(columnAt(description, 'C').header, DOB_HEADER);

  const birthdate = columnAt(description, 'C');
  assert.equal(birthdate.redacted, true);
  assert.match(birthdate.redactionReason ?? '', /birthdate/);
  assert.match(birthdate.redactionReason ?? '', /R38/);
  assert.equal(birthdate.min, null);
  assert.equal(birthdate.max, null);
  assert.equal(birthdate.distinctCount, null);
  // Present, not omitted: the shape of the column still travels.
  assert.equal(birthdate.rowCount, 15);
  assert.equal(birthdate.nullCount, 0);

  // ...and the neighbour is not redacted in its place.
  assert.equal(columnAt(description, 'B').redacted, false);
});

test('R38: a single-cell title row is not accepted as the header row', () => {
  const description = described(titledSheet(), 'Data');
  assert.equal(description.headerSource, 'detected-row');
  assert.match(description.headerSourceBasis, /detected header row 2/);
  assert.deepEqual(
    description.columns.map((entry) => entry.header),
    ['Id', 'Name', DOB_HEADER],
  );
  // Row 2 is labels, not data: counting it as a body row would inflate every
  // row count by one and put a text cell in the birthdate column.
  assert.equal(columnAt(description, 'C').rowCount, 15);
  const birthdate = columnAt(description, 'C');
  assert.equal(birthdate.redacted, true);
  assert.equal(birthdate.min, null);
  assert.equal(birthdate.max, null);
});

test('R38: stage 1 marks its own labels, before any statistic exists', () => {
  const roles = classifySheetRoles(titledSheet());
  assert.equal(roles.status, 'classified');
  const data = (roles as SheetRolesReport).sheets.find((sheet) => sheet.name === 'Data');
  assert.ok(data);
  assert.equal(data.header.row, 2);
  assert.equal(data.header.confident, true);
  assert.deepEqual(
    data.header.labels.map((entry) => entry.column),
    [1, 2, 3],
  );
  const birthdate = data.header.labels.find((entry) => entry.label === DOB_HEADER);
  assert.ok(birthdate);
  assert.equal(birthdate.redacted, true);
  assert.match(birthdate.redactionReason ?? '', /R38/);
  assert.equal(data.header.labels[0].redacted, false);
  assert.equal(data.header.labels[0].redactionReason, null);
});

test('R38: the zero-consumption path states redaction rather than claiming none', () => {
  // Nothing references this sheet, so it stops at box plus headers — the
  // shallowest path, and the one most sheets take.
  const description = described(
    dataSheet(['Id', 'Taxpayer ID'], 15, (r, index) => num(`A${r}`, index) + num(`B${r}`, index)),
    'Data',
  );
  assert.match(description.statisticsSkipped ?? '', /bounding box plus headers/);
  const taxpayer = column(description, 'Taxpayer ID');
  assert.equal(taxpayer.redacted, true);
  assert.match(taxpayer.redactionReason ?? '', /taxpayer identification number/);
  assert.equal(column(description, 'Id').redacted, false);
  // The limitation is stated rather than implied away: no cell was read here,
  // so only the header half of the rule could run.
  assert.match(description.statisticsSkipped ?? '', /header-driven only/);
});

test('R38: the depth override reaches the gate and never the guard, on either path', () => {
  const gapped = described(gappedHeaderSheet(), 'Data', { override: true });
  const birthdate = columnAt(gapped, 'C');
  assert.equal(birthdate.depth, 'full');
  assert.match(birthdate.depthBasis, /explicit override/);
  assert.equal(birthdate.redacted, true);
  assert.equal(birthdate.min, null);
  assert.equal(birthdate.max, null);
  assert.equal(birthdate.distinctCount, null);
  assert.deepEqual(
    birthdate.skipped.map((entry) => entry.what),
    ['extents', 'distinct'],
  );
  for (const entry of birthdate.skipped) assert.match(entry.threshold, /not overridable/);

  // The override lifts the zero-consumption sheet onto the full path; the
  // guard is waiting there too.
  const unconsumed = described(
    dataSheet(['Id', 'Taxpayer ID'], 15, (r, index) => num(`A${r}`, index) + num(`B${r}`, index)),
    'Data',
    { override: true },
  );
  assert.equal(unconsumed.statisticsSkipped, null);
  const taxpayer = column(unconsumed, 'Taxpayer ID');
  assert.equal(taxpayer.redacted, true);
  assert.equal(taxpayer.min, null);
  assert.equal(taxpayer.distinctCount, null);
});

test('R38: no redacted column leaks a value through the serialized result', () => {
  for (const description of [
    described(gappedHeaderSheet(), 'Data'),
    described(titledSheet(), 'Data', { override: true }),
  ]) {
    const serialized = JSON.stringify(description);
    for (const value of ['30000', '30014']) {
      assert.equal(serialized.includes(value), false, `result leaked a raw value: ${value}`);
    }
  }
});
