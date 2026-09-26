import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbook } from '@mog-sdk/sdk/node';
import { revisionOf } from './workbook-revision.ts';
import { createConsultantAnalysis } from './consultant-analysis.ts';

async function fixture(label = 'Budget') {
  const wb = await createWorkbook();
  try {
    const ws = wb.activeSheet;
    await ws.setRange('A1:C4', [[label, 'Actual', 'Note'], [100, 120, 'Revenue'], [50, 40, 'Cost'], [0, 5, 'Other']]);
    const bytes = await wb.toXlsx();
    return { bytes, sheet: wb.sheetNames[0] };
  } finally { await wb.dispose(); }
}
test('variance bridge accounts for every positional contribution and undefined zero-base percentages', async () => {
  const { bytes, sheet } = await fixture();
  const before = Buffer.from(bytes);
  const lab = createConsultantAnalysis({ read: async () => ({ bytes, revision: revisionOf(bytes) }) });
  const result = await lab.variance('test.xlsx', { sheet, baseline: 'A2:A4', comparison: 'B2:B4' });
  assert.equal(result.baselineTotal, 150); assert.equal(result.comparisonTotal, 165);
  assert.equal(result.difference, 15); assert.equal(result.residual, 0);
  assert.deepEqual(result.rows.map(row => row.difference), [20, -10, 5]);
  assert.equal(result.rows[2].percentChange, null);
  assert.equal(result.rows[0].baselineCell, 'A2');
  assert.deepEqual(bytes, before);
  await assert.rejects(lab.variance('test.xlsx', { sheet, baseline: 'A2:A4', comparison: 'B2:B3' }), /same shape/);
  await assert.rejects(lab.variance('test.xlsx', { sheet, baseline: 'A2:A5', comparison: 'B2:B5' }), /blank/i);
  await assert.rejects(lab.variance('test.xlsx', { sheet, baseline: 'A2:A4', comparison: 'B2:B4', expectedRevision: 'old' }), /revision/);
});
test('check packs evaluate totals, target limits and tolerances with explicit pass/fail evidence', async () => {
  const { bytes, sheet } = await fixture();
  const lab = createConsultantAnalysis({ read: async () => ({ bytes, revision: revisionOf(bytes) }) });
  const result = await lab.checks('test.xlsx', { sheet, checks: [
    { label: 'Budget total', range: 'A2:A4', operator: 'equals', target: 150, tolerance: 0 },
    { label: 'Actual floor', range: 'B2:B4', operator: 'at-least', target: 160 },
    { label: 'Actual cap', range: 'B2:B4', operator: 'at-most', target: 160 },
    { label: 'Reconcile', range: 'A2:A4', operator: 'equals', compareRange: 'B2:B4', tolerance: 15 },
  ] });
  assert.equal(result.passed, 3); assert.equal(result.failed, 1);
  assert.equal(result.checks[2].actual, 165); assert.equal(result.checks[2].difference, 5);
  await assert.rejects(lab.checks('test.xlsx', { sheet, checks: [] }), /1 to 8/);
  await assert.rejects(lab.checks('test.xlsx', { sheet, checks: [{ label: 'bad', range: 'A2', operator: 'equals', target: 1, compareRange: 'B2' }] }), /exactly one/);
});
test('all saved analytics block personal data and invalid comparisons without returning derivatives', async () => {
  const { bytes, sheet } = await fixture('Employee_DOB');
  const lab = createConsultantAnalysis({ read: async () => ({ bytes, revision: revisionOf(bytes) }) });
  await assert.rejects(lab.variance('test.xlsx', { sheet, baseline: 'A2', comparison: 'B2' }), /redacted/);
  await assert.rejects(lab.checks('test.xlsx', { sheet, checks: [{ label: 'control', range: 'A2', operator: 'equals', target: 100 }] }), /redacted/);
});
