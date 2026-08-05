/**
 * Byte-first workbook profiling and range reads.
 *
 * Everything here runs without the engine on purpose: the profiler exists
 * because host-side byte reads finish in milliseconds while the canvas
 * renderer can take minutes to hydrate (docs/solutions/architecture-patterns/
 * host-side-ooxml-profiling-outruns-engine-readiness.md). The fixtures are
 * hand-authored OOXML parts in a stored ZIP — no @mog-sdk import anywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { profileWorkbook, readRangeFromBytes } from './workbook-profile.ts';

// ---- Fixture builder --------------------------------------------------------

/** Rebuild a ZIP with stored (uncompressed) entries — enough for the reader. */
function writeZipStored(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const part = (name: string, xml: string) => ({ name, data: Buffer.from(xml) });

/**
 * Two sheets: "Model" carries formulas (one cross-sheet), "Data" carries a
 * shared string and plain values, plus a table part with calculated-column
 * formulas and a comments part.
 */
const fixtureBytes = writeZipStored([
  part(
    'xl/workbook.xml',
    '<workbook><sheets>' +
      '<sheet name="Model" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Data" sheetId="2" r:id="rId2"/>' +
      '</sheets></workbook>',
  ),
  part(
    'xl/_rels/workbook.xml.rels',
    '<Relationships>' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Target="sharedStrings.xml"/>' +
      '</Relationships>',
  ),
  part(
    'xl/sharedStrings.xml',
    '<sst><si><t>hello</t></si></sst>',
  ),
  part(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData>' +
      '<row r="1"><c r="A1"><v>5</v></c></row>' +
      '<row r="2">' +
      '<c r="A2"><f>Data!B1*2</f><v>10</v></c>' +
      '<c r="B2"><f>A1+1</f><v>6</v></c>' +
      '</row>' +
      '</sheetData></worksheet>',
  ),
  part(
    'xl/worksheets/sheet2.xml',
    '<worksheet><sheetData>' +
      '<row r="1">' +
      '<c r="A1" t="s"><v>0</v></c>' +
      '<c r="B1"><v>5</v></c>' +
      '<c r="C1" t="str"><f>CONCAT("x")</f><v>x</v></c>' +
      '</row>' +
      '</sheetData></worksheet>',
  ),
  part(
    'xl/tables/table1.xml',
    '<table><tableColumns>' +
      '<tableColumn id="1"><calculatedColumnFormula>A1*2</calculatedColumnFormula></tableColumn>' +
      '<tableColumn id="2"><calculatedColumnFormula>B1*3</calculatedColumnFormula></tableColumn>' +
      '</tableColumns></table>',
  ),
  part('xl/comments1.xml', '<comments/>'),
]);

// ---- profileWorkbook --------------------------------------------------------

test('profile: counts shape from bytes without the engine', () => {
  const profile = profileWorkbook(fixtureBytes);
  assert.equal(profile.status, 'profiled');
  if (profile.status !== 'profiled') return;

  assert.equal(profile.bytes, fixtureBytes.length);
  assert.deepEqual(
    profile.sheets.map((sheet) => sheet.name),
    ['Model', 'Data'],
  );
  assert.equal(profile.rows, 3);
  assert.equal(profile.cells, 6);
  assert.equal(profile.formulas, 3);
  assert.equal(profile.crossSheetRefs, 1);
  assert.ok(Math.abs(profile.crossSheetRatio - 1 / 3) < 1e-9);
  assert.equal(profile.tableParts, 1);
  assert.equal(profile.calculatedColumnFormulas, 2);
  assert.equal(profile.commentParts, 1);
  assert.ok(profile.elapsedMs >= 0);
});

test('profile: per-sheet counts are attributed to the right sheet', () => {
  const profile = profileWorkbook(fixtureBytes);
  assert.equal(profile.status, 'profiled');
  if (profile.status !== 'profiled') return;

  const model = profile.sheets.find((sheet) => sheet.name === 'Model');
  assert.deepEqual(model, { name: 'Model', rows: 2, cells: 3, formulas: 2 });
  const data = profile.sheets.find((sheet) => sheet.name === 'Data');
  assert.deepEqual(data, { name: 'Data', rows: 1, cells: 3, formulas: 1 });
});

test('profile: genre guess is labeled uncalibrated, never bare', () => {
  const profile = profileWorkbook(fixtureBytes);
  assert.equal(profile.status, 'profiled');
  if (profile.status !== 'profiled') return;

  // ratio 1/3 > 0.1 -> model, but the basis must say the threshold is a guess.
  assert.equal(profile.genre, 'model');
  assert.match(profile.genreBasis, /uncalibrated/i);
});

test('profile: unreadable bytes are unknown, never an empty profile', () => {
  const profile = profileWorkbook(Buffer.from('this is not a zip archive'));
  assert.equal(profile.status, 'unreadable');
  if (profile.status !== 'unreadable') return;
  assert.ok(profile.reason.length > 0);
});

test('profile: zero formulas yields ratio 0 and dataset genre', () => {
  const bytes = writeZipStored([
    part('xl/workbook.xml', '<workbook><sheets><sheet name="Only" r:id="rId1"/></sheets></workbook>'),
    part(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    part(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    ),
  ]);
  const profile = profileWorkbook(bytes);
  assert.equal(profile.status, 'profiled');
  if (profile.status !== 'profiled') return;
  assert.equal(profile.crossSheetRatio, 0);
  assert.equal(profile.genre, 'dataset');
});

// ---- readRangeFromBytes -----------------------------------------------------

test('read range: values and formula text come from the file, typed', () => {
  const result = readRangeFromBytes(fixtureBytes, 'Model', 'A1:B2');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  assert.deepEqual(result.cells, [
    { address: 'A1', value: 5, formula: null, isError: false },
    { address: 'A2', value: 10, formula: 'Data!B1*2', isError: false },
    { address: 'B2', value: 6, formula: 'A1+1', isError: false },
  ]);
  assert.equal(result.truncated, false);
});

test('read range: shared strings resolve on the data sheet', () => {
  const result = readRangeFromBytes(fixtureBytes, 'Data', 'A1:C1');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  assert.deepEqual(
    result.cells.map((cell) => cell.value),
    ['hello', 5, 'x'],
  );
});

test('read range: bounds exclude cells outside the requested range', () => {
  const result = readRangeFromBytes(fixtureBytes, 'Model', 'A1:A1');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual(result.cells.map((cell) => cell.address), ['A1']);
});

test('read range: cell cap reports truncation instead of silently dropping', () => {
  const result = readRangeFromBytes(fixtureBytes, 'Model', 'A1:B2', { cellLimit: 2 });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.cells.length, 2);
  assert.equal(result.truncated, true);
});

test('read range: unknown sheet and bad range are typed failures', () => {
  const missing = readRangeFromBytes(fixtureBytes, 'NoSuchSheet', 'A1:A1');
  assert.equal(missing.status, 'no-such-sheet');

  const bad = readRangeFromBytes(fixtureBytes, 'Model', 'not-a-range');
  assert.equal(bad.status, 'bad-range');

  const unreadable = readRangeFromBytes(Buffer.from('nope'), 'Model', 'A1:A1');
  assert.equal(unreadable.status, 'unreadable');
});
