/**
 * Workbook metadata, defined names, and table definitions from saved bytes.
 *
 * Engine-free by construction — the fixtures are hand-authored OOXML parts in
 * a stored ZIP. The degradation cases matter as much as the happy path: a
 * workbook missing docProps must still return everything else, with the gap
 * stated rather than silently null.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWorkbookMetadata } from './workbook-metadata.ts';
import { datasetFixture, modelFixture, part, writeZipStored } from './test-fixtures.ts';

function extracted(bytes: Uint8Array) {
  const result = extractWorkbookMetadata(bytes);
  assert.equal(result.status, 'extracted');
  return result as Extract<typeof result, { status: 'extracted' }>;
}

/** A minimal workbook whose docProps parts the caller chooses. */
function bareWorkbook(extra: readonly { name: string; data: Buffer }[]) {
  return writeZipStored([
    part('xl/workbook.xml', '<workbook><sheets><sheet name="One" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'),
    ...extra,
  ]);
}

test('metadata: full docProps come back verbatim', () => {
  const result = extracted(modelFixture());
  assert.deepEqual(result.document, {
    creator: 'Ada Lovelace',
    lastModifiedBy: 'Grace Hopper',
    created: '2026-01-02T03:04:05Z',
    modified: '2026-02-03T04:05:06Z',
    application: 'Microsoft Excel',
    appVersion: '16.0300',
  });
  assert.deepEqual(result.notes, []);
});

test('metadata: a missing app.xml degrades to nulls with a note, keeping core.xml', () => {
  const bytes = bareWorkbook([
    part('docProps/core.xml', '<cp:coreProperties><dc:creator>Ada</dc:creator></cp:coreProperties>'),
  ]);
  const result = extracted(bytes);
  assert.equal(result.document.creator, 'Ada');
  assert.equal(result.document.application, null);
  assert.equal(result.document.appVersion, null);
  assert.ok(result.notes.some((note) => note.includes('docProps/app.xml')));
});

test('metadata: no docProps at all is all-null plus notes, never a throw', () => {
  const result = extracted(bareWorkbook([]));
  assert.deepEqual(result.document, {
    creator: null,
    lastModifiedBy: null,
    created: null,
    modified: null,
    application: null,
    appVersion: null,
  });
  assert.equal(result.notes.length, 2);
});

test('metadata: defined-name scope resolves localSheetId to a sheet name', () => {
  const result = extracted(modelFixture());
  const global = result.definedNames.find((entry) => entry.name === 'TaxRate');
  const scoped = result.definedNames.find((entry) => entry.name === 'LocalBox');
  assert.equal(global?.scope, null);
  // localSheetId="1" is the second declared sheet.
  assert.equal(scoped?.scope, 'Estimate');
});

test('metadata: a defined name preserves its reference text unaltered', () => {
  const bytes = writeZipStored([
    part(
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>' +
        '<definedNames><definedName name="Span">Data!$B$2:$B$10</definedName></definedNames></workbook>',
    ),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'),
  ]);
  assert.equal(extracted(bytes).definedNames[0].reference, 'Data!$B$2:$B$10');
});

test('metadata: a table part reports its sheet, ref, and column names in order', () => {
  const result = extracted(datasetFixture());
  assert.equal(result.tables.length, 1);
  const [table] = result.tables;
  assert.equal(table.displayName, 'RawTable');
  assert.equal(table.sheet, 'Raw');
  assert.match(table.ref, /^A1:I\d+$/);
  assert.deepEqual(table.columns.slice(0, 4), ['Id', 'Name', 'Amount', 'Notes']);
  assert.equal(table.declaredColumnCount, table.columns.length);
});

test('metadata: an unnamed table column holds its position instead of collapsing the list', () => {
  // Stage 3 pairs label i with column i of the table's ref, and the R38 guard
  // reads whatever header that pairing hands it. Dropping the nameless entry
  // slides every later label one column left.
  const bytes = writeZipStored([
    part(
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'),
    part(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships><Relationship Id="rT1" Target="../tables/table1.xml"/></Relationships>',
    ),
    part(
      'xl/tables/table1.xml',
      '<table name="T1" displayName="T1" ref="A1:C9"><tableColumns count="3">' +
        '<tableColumn id="1" name="Id"/><tableColumn id="2"/><tableColumn id="3" name="Date of Birth"/>' +
        '</tableColumns></table>',
    ),
  ]);
  const result = extracted(bytes);
  assert.deepEqual(result.tables[0].columns, ['Id', '', 'Date of Birth']);
  assert.equal(result.tables[0].declaredColumnCount, 3);
  assert.ok(
    result.notes.some((note) => /1 column\(s\) with no name/.test(note)),
    'the unnamed column was not reported',
  );
});

test('metadata: a declared column count that disagrees with what was read is stated', () => {
  const bytes = writeZipStored([
    part(
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'),
    part(
      'xl/tables/table1.xml',
      '<table name="T1" displayName="T1" ref="A1:D9"><tableColumns count="4">' +
        '<tableColumn id="1" name="Id"/><tableColumn id="2" name="Name"/>' +
        '</tableColumns></table>',
    ),
  ]);
  const result = extracted(bytes);
  assert.equal(result.tables[0].declaredColumnCount, 4);
  assert.equal(result.tables[0].columns.length, 2);
  assert.ok(
    result.notes.some((note) => /declares 4 column\(s\) but 2 could be read/.test(note)),
    'the count disagreement was not reported',
  );
});

test('metadata: no tables and no defined names is empty lists, not nulls', () => {
  const result = extracted(bareWorkbook([]));
  assert.deepEqual(result.definedNames, []);
  assert.deepEqual(result.tables, []);
});

test('metadata: non-ZIP bytes surface the typed unreadable failure', () => {
  const result = extractWorkbookMetadata(Buffer.from('not a zip archive'));
  assert.equal(result.status, 'unreadable');
  assert.ok(result.status === 'unreadable' && result.reason.length > 0);
});
