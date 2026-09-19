import { WorkbookError, type WorkbookService } from './workbook-service.ts';

export const consultantExample = {
  name: 'consultant-example.xlsx', sheet: 'Model', range: 'A1:D20', explainAddress: 'B8',
  scenario: { input: 'B3', values: [0, 0.1, 0.2], outputs: ['B8'], expected: [300000, 360000, 420000] },
  reconciliation: { left: 'B11:B13', right: 'D11:D13', expected: 1000000 },
  anomaly: 'D19',
} as const;

const exampleCells = [
      ['Synthetic consulting model', 'Value', 'Units', 'Illustrative only'],
      ['Revenue', 1000000, 'USD', ''],
      ['Revenue growth', 0.1, 'fraction', 'Scenario input'],
      ['Gross margin', 0.6, 'fraction', ''],
      ['Operating costs', 300000, 'USD', ''],
      ['Projected revenue', '=B2*(1+B3)', 'USD', ''],
      ['Gross profit', '=B6*B4', 'USD', ''],
      ['EBITDA', '=B7-B5', 'USD', 'Scenario output'],
      ['', '', '', ''],
      ['Assets', 'USD', 'Funding', 'USD'],
      ['Cash', 300000, 'Debt', 400000],
      ['Receivables', 500000, 'Equity', 250000],
      ['Equipment', 200000, 'Retained earnings', 350000],
      ['Total assets', '=SUM(B11:B13)', 'Total funding', '=SUM(D11:D13)'],
      ['', '', '', ''],
      ['Pattern check: row 19 intentionally wrong', 'Quantity', 'Price', 'Amount'],
      ['Product A', 10, 50, '=B17*C17'],
      ['Product B', 20, 50, '=B18*C18'],
      ['Product C: intentional formula issue', 30, 50, '=B19+C19'],
      ['Product D', 40, 50, '=B20*C20'],
    ];

/** Creates only the fixed synthetic example; never replaces a user's existing copy. */
export async function ensureConsultantExample(service: WorkbookService) {
  try {
    const existing = await service.readRange(consultantExample.name, 'Model', consultantExample.range);
    if (existing.read.status !== 'ok' || existing.read.truncated) throw new Error('The existing example cannot be verified. It was not overwritten.');
    const cells = new Map(existing.read.cells.map(cell => [cell.address, cell]));
    const matches = exampleCells.every((row, r) => row.every((value, c) => {
      const actual = cells.get(`${String.fromCharCode(65 + c)}${r + 1}`);
      if (typeof value === 'string' && value.startsWith('=')) return actual?.formula?.replace(/^=/, '') === value.slice(1);
      if (value === '') return !actual || (actual.value === '' || actual.value === null) && !actual.formula;
      return actual?.value === value && !actual.formula;
    }));
    if (!matches) throw new Error('The existing consultant-example.xlsx has been changed or is a different workbook. It was not overwritten. Rename it before creating a fresh example.');
    return { ...consultantExample, created: false as const, exampleMatches: true, revision: existing.revision };
  } catch (error) {
    if (!(error instanceof WorkbookError) || error.code !== 'not-found') throw error;
  }
  const { createWorkbook } = await import('@mog-sdk/sdk/node');
  const wb = await createWorkbook();
  let bytes: Uint8Array;
  try {
    await wb.sheets.rename(0, 'Model');
    const sheet = await wb.getSheet('Model');
    await wb.sheets.setActive('Model');
    await sheet.setRange('A1', exampleCells);
    await sheet.layout.setColumnWidths([['A', 300], ['B', 120], ['C', 180], ['D', 170]]);
    await sheet.summarize();
    const output = await sheet.getValue('B8');
    if (typeof output !== 'number' || Math.abs(output - 360000) > 0.001) {
      throw new Error('Synthetic example did not calculate its expected EBITDA.');
    }
    bytes = await wb.toXlsx();
  } finally { await wb.dispose(); }
  const saved = await service.save(consultantExample.name, bytes, 'absent', {
    lane: 'headless', actor: { kind: 'agent', id: 'consultant-example' },
    intent: 'Create synthetic financial consulting demonstration', touchedRanges: ['Model!A1:D20'],
  });
  const validation = await service.validate(consultantExample.name);
  const screenshot = await service.captureScreenshot(consultantExample.name, consultantExample.range);
  return { ...consultantExample, created: true as const, exampleMatches: true, revision: saved.revision, validation, screenshot };
}
