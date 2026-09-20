import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentContext } from './agent-tasks.ts';
import { deflateRawSync } from 'node:zlib';
import { part, writeZipStored } from './test-fixtures.ts';
import { assertNavigatorPrivacy, navigateWorkbook } from './workbook-navigator.ts';

function fixture(): Buffer {
  return writeZipStored([
    part('xl/workbook.xml', '<workbook><sheets><sheet name="Model" r:id="rId1"/><sheet name="Input" r:id="rId2"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    part('xl/sharedStrings.xml', '<sst><si><t>Revenue</t></si><si><t>North</t></si></sst>'),
    part('xl/worksheets/sheet1.xml', '<worksheet><dimension ref="A1:C3"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>B2*2</f><v>12</v></c><c r="C1" t="e"><v>#DIV/0!</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><f t="shared" si="0">SUM(A1:A2)</f><v>5</v></c><c r="C2"><f t="shared" si="0"/><v>7</v></c><c r="A3"><f>A1</f></c></row></sheetData></worksheet>'),
    part('xl/worksheets/sheet2.xml', '<worksheet><dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'),
  ]);
}

test('navigator returns saved cells, formula cache state, and target dimensions without recalculation', () => {
  const result = navigateWorkbook(fixture(), { sheet: 'Model', range: 'A1:C3' });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual(result.sheets, [{ name: 'Model' }, { name: 'Input' }]);
  assert.deepEqual(result.dimensions, { ref: 'A1:C3', rows: 3, columns: 3 });
  assert.deepEqual(result.cells.find(cell => cell.address === 'B1'), { address: 'B1', value: 12, formula: 'B2*2', formulaStatus: 'saved', isError: false, cached: true });
  assert.deepEqual(result.cells.find(cell => cell.address === 'C1'), { address: 'C1', value: '#DIV/0!', formula: null, formulaStatus: 'none', isError: true, cached: true });
  assert.deepEqual(result.cells.find(cell => cell.address === 'C2'), { address: 'C2', value: 7, formula: null, formulaStatus: 'shared-unexpanded', isError: false, cached: true });
  assert.deepEqual(result.cells.find(cell => cell.address === 'A3'), { address: 'A3', value: null, formula: 'A1', formulaStatus: 'saved', isError: false, cached: false });
});

test('navigator rejects a page that exceeds its bounded cell budget', () => {
  const result = navigateWorkbook(fixture(), { sheet: 'Model', range: 'A1:T200' });
  assert.equal(result.status, 'range-too-large');
});

test('navigator privacy scan is fail closed for SSN-shaped saved values', () => {
  const bytes = fixture();
  assert.doesNotThrow(() => assertNavigatorPrivacy(bytes));
  const protectedBook = writeZipStored([
    part('xl/workbook.xml', '<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>123-45-6789</v></c></row></sheetData></worksheet>'),
  ]);
  assert.throws(() => assertNavigatorPrivacy(protectedBook), /High-risk personal data/);
});

test('navigator accepts genuinely deflated targeted parts', () => {
  const xml = '<workbook><sheets><sheet name="Compressed" r:id="r1"/></sheets></workbook>';
  const entries = [part('xl/workbook.xml', xml), part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/s.xml"/></Relationships>'), part('xl/worksheets/s.xml', '<worksheet><dimension ref="A1"/><sheetData><row><c r="A1"><v>42</v></c></row></sheetData></worksheet>')];
  const stored = writeZipStored(entries);
  // Rebuild offsets and lengths after compressing each payload.
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = deflateRawSync(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(directory, name); offset += local.length + name.length + data.length;
  }
  const end = Buffer.from(stored.subarray(-22)); const directory = Buffer.concat(central); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...locals, directory, end]);
  const result = navigateWorkbook(bytes, { range: 'A1' });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') { assert.equal(result.cells[0].value, 42); assert.deepEqual(result.dimensions, { ref: 'A1', rows: 1, columns: 1 }); }
  assert.doesNotThrow(() => assertNavigatorPrivacy(bytes));
});

function privacyFixture(cell: string, shared = '', extra = '') {
  return writeZipStored([part('xl/workbook.xml', '<workbook><sheets><sheet name="Data" r:id="r1"/></sheets></workbook>'), part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/s.xml"/></Relationships>'), part('xl/worksheets/s.xml', `<worksheet><sheetData><row>${cell}</row></sheetData>${extra}</worksheet>`), part('xl/sharedStrings.xml', `<sst>${shared}</sst>`)]);
}
test('privacy refuses unresolved, malformed and namespaced data while allowing extension metadata', () => {
  for (const cell of ['<c r="A1" t="s"><v>99</v></c>', '<c r="A1"><v>secret</v>', '<x:c r="A1"><x:v>secret</x:v></x:c>', '<c r="A1"><v>secret</c>', "<c r='A1' t='str'><v>ok</v></c>"]) assert.throws(() => assertNavigatorPrivacy(privacyFixture(cell)));
  assert.doesNotThrow(() => assertNavigatorPrivacy(privacyFixture('<c r="A1"><v>1</v></c>', '', '<extLst><xr:revision value="1"/></extLst>')));
});
test('privacy checks rich text labels and formula cached values separately', () => {
  assert.throws(() => assertNavigatorPrivacy(privacyFixture('<c r="A1" t="inlineStr"><is><r><t>Employee_</t></r><r><t>SSN</t></r></is></c>')), /High-risk/);
  assert.throws(() => assertNavigatorPrivacy(privacyFixture('<c r="A1" t="str"><f>"123-45-6789"</f><v>123-45-6789</v></c>')), /High-risk/);
  assert.throws(() => assertNavigatorPrivacy(privacyFixture('<c r="A1" t="s"><v>0</v></c>', '<si><t>Date of birth</t></si>')), /High-risk/);
});

test('agent context supports a larger workbook while returning only the selected saved cells', async () => {
  const cells = Array.from({ length: 21001 }, (_, i) => `<c r="A${i + 1}"><v>${i + 1}</v></c>`).join('');
  const bytes = privacyFixture(cells);
  const context = createAgentContext({ read: async () => ({ bytes, revision: 'large-saved' }) });
  const result = await context({ name: 'large.xlsx', scope: 'range', sheet: 'Data', range: 'A21000:A21001' });
  assert.equal(result.revision, 'large-saved');
  const content = result.content as { evidence: { cells: { value: unknown }[] }[]; limitations: string[] };
  assert.deepEqual(content.evidence[0].cells.map(cell => cell.value), [21000, 21001]);
  assert.match(content.limitations.join(' '), /not recalculated/);
});

test('conditional-format extension formulas do not block saved navigation or privacy scans', () => {
  const bytes = privacyFixture('<c r="A1"><v>42</v></c>', '', '<extLst><ext><x14:conditionalFormatting><xm:f>A1&gt;0</xm:f></x14:conditionalFormatting></ext></extLst>');
  assert.equal(navigateWorkbook(bytes).status, 'ok');
  assert.doesNotThrow(() => assertNavigatorPrivacy(bytes));
  for (const cell of ['<c r="A1"><xm:f>1</xm:f><v>1</v></c>', '<c r="A1"><extLst><xm:f>1</xm:f></extLst><v>1</v></c>']) {
    assert.equal(navigateWorkbook(privacyFixture(cell)).status, 'unreadable');
    assert.throws(() => assertNavigatorPrivacy(privacyFixture(cell)), /Namespace-prefixed/);
  }
  assert.throws(() => assertNavigatorPrivacy(privacyFixture('<c r="A1" t="str"><v>123-45-6789</v></c>', '', '<extLst><xm:f>A1</xm:f></extLst>')), /High-risk/);
});
