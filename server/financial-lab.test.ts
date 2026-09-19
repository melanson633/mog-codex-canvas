import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbook } from '@mog-sdk/sdk/node';
import { createFinancialLab } from './financial-lab.ts';
import { revisionOf } from './workbook-revision.ts';
import { readZipEntries } from './ooxml-cache.ts';
import { writeZipStored } from './test-fixtures.ts';

async function fixture(label = 'Revenue', formula = '=B2*2') {
  const workbook = await createWorkbook();
  try {
    const sheet = workbook.activeSheet;
    await sheet.setRange('A1:C4', [[label, 'Amount', 'Control'], ['Input', 100, 100], ['Double', formula, '=B2*2'], ['Net', '=B3-B2', '=SUM(C2:C3)-C3']]);
    await sheet.calculate(true);
    const bytes = await workbook.toXlsx();
    return { bytes, sheet: workbook.sheetNames[0] };
  } finally { await workbook.dispose(); }
}
function service(bytes: Uint8Array) {
  const revision = revisionOf(bytes);
  return { read: async (_name: string) => ({ bytes, revision }) };
}

test('tie-outs are exact, revision-bound and explicitly handle blanks', async () => {
  const { bytes, sheet } = await fixture();
  const lab = createFinancialLab(service(bytes));
  const result = await lab.reconcile('test.xlsx', { sheet, left: 'B2:B4', right: 'C2:C4', tolerance: 0 });
  assert.equal(result.status, 'balanced');
  assert.equal(result.left.sum, 400);
  assert.equal(result.right.sum, 400);
  assert.equal(result.revision, revisionOf(bytes));
  await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'B2:B5', right: 'C2:C4' }), /blanks/);
  assert.equal((await lab.reconcile('test.xlsx', { sheet, left: 'B2:B5', right: 'C2:C4', blankPolicy: 'zero' })).left.blankCount, 1);
  await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'A1', right: 'C2' }), /numeric/);
  await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'B2', right: 'C2', tolerance: -1 }), /Tolerance/);
  await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'B2', right: 'C2', expectedRevision: 'stale' }), /revision changed/);
});

test('disposable scenarios recalculate two-step dependencies and leave original bytes unchanged', async () => {
  const { bytes, sheet } = await fixture();
  const original = Buffer.from(bytes);
  const lab = createFinancialLab(service(bytes));
  const result = await lab.scenario('test.xlsx', { sheet, input: 'B2', values: [80, 100, 120], outputs: ['B3', 'B4'] });
  assert.deepEqual(result.cases, [
    { input: 80, outputs: { B3: 160, B4: 80 } },
    { input: 100, outputs: { B3: 200, B4: 100 } },
    { input: 120, outputs: { B3: 240, B4: 120 } },
  ]);
  assert.deepEqual(Buffer.from(bytes), original);
  await assert.rejects(lab.scenario('test.xlsx', { sheet, input: 'B3', values: [20], outputs: ['B4'] }), /numeric constant/);
  await assert.rejects(lab.scenario('test.xlsx', { sheet, input: 'B2', values: [Infinity], outputs: ['B4'] }), /finite/);
  await assert.rejects(lab.scenario('test.xlsx', { sheet, input: 'B2', values: [20], outputs: ['B4'], expectedRevision: 'stale' }), /revision changed/);
});

test('high-risk headers anywhere block derivatives and statistics without emitting values', async () => {
  const { bytes, sheet } = await fixture('Employee_DOB');
  const lab = createFinancialLab(service(bytes));
  await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'B2', right: 'C2' }), /present and redacted/);
  await assert.rejects(lab.scenario('test.xlsx', { sheet, input: 'B2', values: [20], outputs: ['B4'] }), /present and redacted/);
});

test('volatile scenarios are rejected before opening an engine', async () => {
  const { bytes, sheet } = await fixture('Revenue', '=RAND()');
  await assert.rejects(createFinancialLab(service(bytes)).scenario('test.xlsx', { sheet, input: 'B2', values: [20], outputs: ['B4'] }), /unsupported formulas/);
});

test('scenario rejects overlapping requests and a changed source revision', async () => {
  const { bytes, sheet } = await fixture();
  const lab = createFinancialLab(service(bytes));
  const request = { sheet, input: 'B2', values: [90], outputs: ['B4'] };
  const first = lab.scenario('test.xlsx', request);
  await assert.rejects(lab.scenario('test.xlsx', request), /already calculating/);
  await first;
  let reads = 0;
  const changing = createFinancialLab({ read: async () => ({ bytes, revision: ++reads === 1 ? revisionOf(bytes) : 'changed' }) });
  await assert.rejects(changing.scenario('test.xlsx', request), /source changed/);
});

test('tie-outs report an actual difference and enforce full bounded numeric reads', async () => {
  const { bytes, sheet } = await fixture();
  const lab = createFinancialLab(service(bytes));
  const result = await lab.reconcile('test.xlsx', { sheet, left: 'B2', right: 'B3', tolerance: 0.001 });
  assert.equal(result.status, 'difference');
  assert.equal(result.difference, -100);
  await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'B1:B2001', right: 'B2' }), /2,000/);
  await assert.rejects(lab.scenario('test.xlsx', { sheet, input: 'B2:B3', values: [10], outputs: ['B4'] }), /one unqualified/);
});

test('privacy scans fail closed on unresolved shared headers and join rich text runs', async () => {
  const { bytes, sheet } = await fixture();
  const variants = [
    { cell: '<c r="A1" t="s"><v>999999</v></c>', reason: /unresolved shared string/ },
    { cell: '<c r="A1" t="inlineStr"><is><r><t>Employee_</t></r><r><t>DO</t></r><r><t>B</t></r></is></c>', reason: /present and redacted/ },
    { cell: '<c r="A1" t="str"><v>123-45-6789</v></c>', reason: /present and redacted/ },
    { cell: "<c r='A1' t='s'><v>999999</v></c>", reason: /Single-quoted/ },
  ];
  for (const variant of variants) {
    const modified = writeZipStored(readZipEntries(bytes).map(entry => /^xl\/worksheets\/.*\.xml$/.test(entry.name)
      ? { ...entry, data: Buffer.from(entry.data.toString('utf8').replace(/<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<\/c>/, variant.cell)) } : entry));
    assert.notDeepEqual(modified, bytes);
    const lab = createFinancialLab(service(modified));
    await assert.rejects(lab.reconcile('test.xlsx', { sheet, left: 'B2', right: 'C2' }), variant.reason);
    await assert.rejects(lab.scenario('test.xlsx', { sheet, input: 'B2', values: [10], outputs: ['B4'] }), variant.reason);
  }
});
