import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readAnalysisEntries } from './analysis-archive.ts';
import { writeZipStored, part } from './test-fixtures.ts';
import { createAnalystIndex } from './analyst-index.ts';
import type { createWorkbookService } from './workbook-service.ts';
import { createFinancialLab } from './financial-lab.ts';

function bomb() {
  const raw = deflateRawSync(Buffer.alloc(33 * 1024 * 1024));
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(1, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + raw.length, 16);
  return Buffer.concat([local, name, raw, central, name, end]);
}

test('analysis archive uses an actual inflate limit despite a false declared size', async () => {
  const bytes = bomb();
  assert.throws(() => readAnalysisEntries(bytes), /larger than|buffer|length/i);
  const service = { read: async () => ({ bytes, revision: 'bomb' }) } as unknown as ReturnType<typeof createWorkbookService>;
  const result = await createAnalystIndex(service).context('test.xlsx', 'Model', 'A1');
  assert.equal(result.status, 'unreadable');
  assert.deepEqual(result.cells, []);
  assert.deepEqual(result.dependencies, []);
});

test('analysis archive rejects malformed and duplicate entries', () => {
  assert.throws(() => readAnalysisEntries(Buffer.from('not a zip')), /unreadable/);
  assert.throws(() => readAnalysisEntries(writeZipStored([part('same', 'one'), part('same', 'two')])), /Duplicate/);
  const invalid = writeZipStored([part('one', 'test')]);
  invalid.writeUInt32LE(0, 0);
  assert.throws(() => readAnalysisEntries(invalid), /unreadable/);
});

test('index fails closed when a worksheet is missing or uses unsupported quoting', async () => {
  const common = [
    part('xl/workbook.xml', '<workbook><sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  ];
  for (const entries of [common, [...common, part('xl/worksheets/sheet1.xml', "<worksheet><sheetData><c r='A1' t='inlineStr'><is><t>SSN</t></is></c></sheetData></worksheet>")]]) {
    const bytes = writeZipStored(entries);
    const service = { read: async () => ({ bytes, revision: 'invalid' }) } as unknown as ReturnType<typeof createWorkbookService>;
    const result = await createAnalystIndex(service).context('test.xlsx', 'Model', 'A1');
    assert.equal(result.status, 'unreadable');
    assert.deepEqual(result.cells, []);
  }
});

test('namespace-prefixed sensitive cells with ordinary numeric cells release no derivatives', async () => {
  const bytes = writeZipStored([
    part('xl/workbook.xml', '<workbook><sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', '<worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><x:c r="A1" t="inlineStr"><x:is><x:t>DOB</x:t></x:is></x:c><c r="A2"><v>123</v></c><c r="B2"><v>456</v></c></sheetData></worksheet>'),
  ]);
  const service = { read: async () => ({ bytes, revision: 'prefixed' }) } as unknown as ReturnType<typeof createWorkbookService>;
  const index = createAnalystIndex(service);
  const context = await index.context('test.xlsx', 'Model', 'A2:B2');
  assert.equal(context.status, 'unreadable');
  assert.deepEqual(context.cells, []);
  assert.deepEqual(context.dependencies, []);
  const lab = createFinancialLab(service);
  await assert.rejects(lab.reconcile('test.xlsx', { sheet: 'Model', left: 'A2', right: 'B2' }), /Namespace-prefixed/);
  await assert.rejects(lab.scenario('test.xlsx', { sheet: 'Model', input: 'A2', outputs: ['B2'], values: [1] }), /Namespace-prefixed/);
});

test('spaced attributes and prefixed shared strings cannot conceal sensitive labels', async () => {
  for (const [label, shared] of [
    ['<c r="A1" t = "inlineStr"><is><t>DOB</t></is></c>', ''],
    ['<c r="A1" t="s"><v>0</v></c>', '<sst xmlns:s="urn:sheet"><si><s:t>DOB</s:t></si></sst>'],
  ]) {
    const bytes = writeZipStored([
      part('xl/workbook.xml', '<workbook><sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      part('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${label}<c r="A2"><v>123</v></c><c r="B2"><v>456</v></c></sheetData></worksheet>`),
      ...(shared ? [part('xl/sharedStrings.xml', shared)] : []),
    ]);
    const service = { read: async () => ({ bytes, revision: 'encoded' }) } as unknown as ReturnType<typeof createWorkbookService>;
    const context = await createAnalystIndex(service).context('test.xlsx', 'Model', 'A2:B2');
    assert.equal(context.status, 'unreadable');
    assert.deepEqual(context.cells, []);
    const lab = createFinancialLab(service);
    await assert.rejects(lab.reconcile('test.xlsx', { sheet: 'Model', left: 'A2', right: 'B2' }), /privacy scan/);
    await assert.rejects(lab.scenario('test.xlsx', { sheet: 'Model', input: 'A2', outputs: ['B2'], values: [1] }), /privacy scan/);
  }
});

test('missing and unsupported cell coordinates fail closed in both analysis lanes', async () => {
  for (const coordinate of ['', 'r="not-A1"', 'r="XFE1"', 'r="A1048577"']) {
    const bytes = writeZipStored([
      part('xl/workbook.xml', '<workbook><sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      part('xl/worksheets/sheet1.xml', `<worksheet><sheetData><c ${coordinate}><f>NOW()</f><v>123</v></c><c r="A2"><v>123</v></c></sheetData></worksheet>`),
    ]);
    const service = { read: async () => ({ bytes, revision: 'coordinates' }) } as unknown as ReturnType<typeof createWorkbookService>;
    assert.equal((await createAnalystIndex(service).context('test.xlsx', 'Model', 'A2')).status, 'unreadable');
    const lab = createFinancialLab(service);
    await assert.rejects(lab.reconcile('test.xlsx', { sheet: 'Model', left: 'A1', right: 'A2', blankPolicy: 'zero' }), /coordinates/);
    await assert.rejects(lab.scenario('test.xlsx', { sheet: 'Model', input: 'A2', outputs: ['A2'], values: [1] }), /coordinates/);
  }
});
