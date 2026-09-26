import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbook } from '@mog-sdk/sdk/node';
import { canonicalizeRoot, resolveSaveTarget } from '../server/path-policy.ts';
import { createWorkbookService } from '../server/workbook-service.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(projectRoot, 'artifacts', 'codex-cloud');
const workbookSelector = 'basic-spreadsheet.xlsx';
const screenshotSelector = 'basic-spreadsheet.png';
const resultSelector = 'proof-result.json';

await mkdir(outputRoot, { recursive: true });
const root = canonicalizeRoot(outputRoot);
const workbookPath = await resolveSaveTarget(root, workbookSelector, 'workbook');
const screenshotPath = await resolveSaveTarget(root, screenshotSelector, 'screenshot');
const resultPath = resolve(outputRoot, resultSelector);
const service = createWorkbookService({ root });

const wb = await createWorkbook();
let xlsx;
let calculation;
try {
  const ws = wb.activeSheet;
  await ws.setRange('A1:D4', [
    ['Category', 'Budget', 'Actual', 'Variance'],
    ['Revenue', 100000, 112500, '=C2-B2'],
    ['Costs', 60000, 63500, '=C3-B3'],
    ['Net contribution', '=B2-B3', '=C2-C3', '=C4-B4'],
  ]);

  calculation = await wb.calculate({ markAllDirty: true });
  assert.equal((await ws.getCell('D2')).value, 12500);
  assert.equal((await ws.getCell('D3')).value, 3500);
  assert.equal((await ws.getCell('B4')).value, 40000);
  assert.equal((await ws.getCell('C4')).value, 49000);
  assert.equal((await ws.getCell('D4')).value, 9000);
  xlsx = Buffer.from(await wb.toXlsx());
} finally {
  await wb.dispose();
}

assert.equal(xlsx.subarray(0, 2).toString('ascii'), 'PK', 'export is not an XLSX ZIP');
const saved = await service.save(workbookSelector, xlsx, undefined, {
  lane: 'headless',
  actor: { kind: 'agent', id: 'codex-cloud-proof' },
  intent: 'create and verify a basic spreadsheet in Codex Cloud',
  touchedRanges: ['Sheet1!A1:D4'],
});

const reopened = await createWorkbook(workbookPath);
let summary;
let screenshot;
try {
  const ws = reopened.activeSheet;
  assert.deepEqual(reopened.sheetNames, ['Sheet1']);
  assert.equal((await ws.getCell('D4')).formula, '=C4-B4');
  assert.equal((await ws.getCell('D4')).value, 9000);
  summary = await ws.summarize();
  screenshot = Buffer.from(await reopened.captureScreenshot(ws, 'A1:D4', { dpr: 2 }));
} finally {
  await reopened.dispose();
}

assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
await writeFile(screenshotPath, screenshot);

const result = {
  status: 'passed',
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  outputs: {
    workbook: 'artifacts/codex-cloud/basic-spreadsheet.xlsx',
    screenshot: 'artifacts/codex-cloud/basic-spreadsheet.png',
  },
  assertions: {
    sheetNames: ['Sheet1'],
    formulas: { D2: 12500, D3: 3500, B4: 40000, C4: 49000, D4: 9000 },
    reopenedFormula: '=C4-B4',
    reopenedValue: 9000,
    xlsxSignature: 'PK',
    pngSignature: '89504e470d0a1a0a',
  },
  calculation,
  save: {
    transactionId: saved.transactionId ?? null,
    fidelity: saved.fidelity.status,
    coordination: saved.coordination.status,
  },
  summary,
};

await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`[cloud-proof] PASS ${result.outputs.workbook}`);
console.log(`[cloud-proof] screenshot ${result.outputs.screenshot}`);
console.log(`[cloud-proof] result artifacts/codex-cloud/${resultSelector}`);
