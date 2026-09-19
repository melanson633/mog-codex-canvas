/** Synthetic baseline only; never selects existing/client workbooks. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbookService } from '../server/workbook-service.ts';
import { profileWorkbook } from '../server/workbook-profile.ts';
import { briefWorkbook } from '../server/workbook-briefing.ts';
import { revisionOf } from '../server/workbook-revision.ts';
import { modelFixture, datasetFixture, largeDatasetFixture, mixedFixture } from '../server/test-fixtures.ts';

const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '..');
const root = resolve(project, 'workbooks');
const round = (n) => Math.round(n * 100) / 100;
const sizes = { small: 100, medium: 3000, large: 12000 };
async function timed(action) {
  const start = performance.now();
  const value = await action();
  return { ms: round(performance.now() - start), value };
}
function stats(runs) {
  const sorted = [...runs].sort((a, b) => a - b);
  return { runsMs: runs, medianMs: sorted[Math.floor(sorted.length / 2)] };
}

if (process.argv[2] === '--measure') {
  // A separate Node process per fixture: SDK import and first engine open are cold
  // for this process, but the operating-system file cache is not flushed.
  const service = createWorkbookService({ root });
  const name = process.argv[3];
  const match = /^\.latency-baseline-\d+\/(small|medium|large)\.xlsx$/.exec(name ?? '');
  assert.ok(match, 'Measurement accepts only generated synthetic fixture selectors');
  const rows = sizes[match[1]];
  const first = await timed(() => service.openSession(name));
  service.closeSession(first.value.sessionId);
  const warm = [];
  for (let i = 0; i < 5; i++) {
    const run = await timed(() => service.openSession(name));
    warm.push(run.ms);
    assert.equal(run.value.revision, first.value.revision);
    service.closeSession(run.value.sessionId);
  }
  const profile = profileWorkbook(first.value.bytes);
  assert.equal(profile.status, 'profiled');
  assert.equal(profile.sheets.length, 1);
  assert.equal(profile.cells, (rows + 1) * 10);
  assert.equal(profile.formulas, rows);
  const sheet = profile.sheets[0].name;
  const range = 'A2:J11';
  const query = await timed(() => service.readRange(name, sheet, range));
  assert.equal(query.value.read.status, 'ok');
  assert.equal(query.value.read.cells.length, 100);
  assert.equal(query.value.read.truncated, false);
  const expected = Array.from({ length: 10 }, (_, i) =>
    [...Array.from({ length: 9 }, (_, j) => i + j + 1), (i + 1) * 2]);
  for (const cell of query.value.read.cells) {
    const [, col, row] = /^([A-J])(\d+)$/.exec(cell.address);
    const c = col.charCodeAt(0) - 65;
    assert.equal(cell.value, expected[Number(row) - 2][c]);
    assert.equal(cell.formula, c === 9 ? `A${row}*2` : null);
  }
  const repeat = [];
  for (let i = 0; i < 5; i++) {
    const run = await timed(() => service.readRange(name, sheet, range));
    assert.deepEqual(run.value.read, query.value.read);
    repeat.push(run.ms);
  }
  const sdk = await timed(() => import('@mog-sdk/sdk'));
  const engineOpen = await timed(() => sdk.value.createWorkbook(Buffer.from(first.value.bytes)));
  let engineQuery;
  const engineRepeat = [];
  try {
    engineQuery = await timed(() => engineOpen.value.activeSheet.getValues(range));
    assert.deepEqual(engineQuery.value, expected);
    for (let i = 0; i < 5; i++) {
      const run = await timed(() => engineOpen.value.activeSheet.getValues(range));
      assert.deepEqual(run.value, engineQuery.value);
      engineRepeat.push(run.ms);
    }
    assert.ok((await engineOpen.value.activeSheet.summarize()).length > 0);
    const png = await engineOpen.value.captureScreenshot(engineOpen.value.activeSheet, 'A1:J12', { dpr: 1 });
    await service.writeScreenshot(name.replace(/\.xlsx$/, '.png'), png);
  } finally {
    await engineOpen.value.dispose();
  }
  const reopen = await timed(() => sdk.value.createWorkbook(Buffer.from(first.value.bytes)));
  await reopen.value.dispose();
  console.log(JSON.stringify({
    fixture: name.split('/').at(-1), revision: first.value.revision,
    fileBytes: profile.bytes, sheets: profile.sheets.length, cells: profile.cells,
    formulas: profile.formulas, range, returnedCells: 100,
    host: { firstOpenMs: first.ms, warmOpen: stats(warm), firstQueryMs: query.ms, repeatedQuery: stats(repeat),
      fileBytesReadPerQuery: profile.bytes,
      archiveCoverage: 'Every ZIP entry decoded; target worksheet scanned. Derived from current source, not I/O instrumentation.' },
    engine: { sdkImportMs: sdk.ms, firstOpenMs: engineOpen.ms, warmReopenMs: reopen.ms,
      firstQueryMs: engineQuery.ms, repeatedQuery: stats(engineRepeat),
      inputBytes: profile.bytes, hydratedCells: null,
      coverage: 'Whole workbook supplied. Internal hydration volume is not exposed or measured.' },
  }));
} else {
  assert.ok(process.argv.length === 2 || process.argv[2] === '--replay', 'Use no arguments or --replay <generated-directory>');
  const replay = process.argv[2] === '--replay' ? process.argv[3] : null;
  if (process.argv[2] === '--replay') assert.match(replay ?? '', /^\.latency-baseline-\d+$/);
  await mkdir(root, { recursive: true });
  const runDir = resolve(root, replay ?? `.latency-baseline-${Date.now()}`);
  if (!replay) await mkdir(runDir);
  const service = createWorkbookService({ root });
  const { createWorkbook } = await import('@mog-sdk/sdk');
  const measured = [];
  for (const [label, rows] of Object.entries(sizes)) {
    const name = relative(root, resolve(runDir, `${label}.xlsx`)).replaceAll('\\', '/');
    if (!replay) {
      const wb = await createWorkbook();
      let bytes;
      try {
        const values = [Array.from({ length: 10 }, (_, i) => `Column ${i + 1}`)];
        for (let i = 0; i < rows; i++) {
          values.push([...Array.from({ length: 9 }, (_, j) => i + j + 1), `=A${i + 2}*2`]);
        }
        await wb.activeSheet.setRange(`A1:J${rows + 1}`, values);
        bytes = await wb.toXlsx();
      } finally {
        await wb.dispose();
      }
      const saved = await service.save(name, bytes, 'absent', {
        lane: 'headless', actor: { kind: 'agent', id: 'latency-baseline' },
        intent: 'Create an isolated synthetic latency fixture', touchedRanges: [`A1:J${rows + 1}`],
      });
      assert.ok(saved.transactionId, saved.receiptError);
    }
    const output = execFileSync(process.execPath, [script, '--measure', name], {
      cwd: project, encoding: 'utf8', timeout: 120000, windowsHide: true,
    });
    measured.push(JSON.parse(output.trim()));
    console.error(`Measured ${label}: ${rows} data rows`);
  }
  // Existing deliberately minimal OOXML fixtures stay on the byte-only lane.
  // Do not feed them speculatively to the native engine.
  const staged = [];
  for (const [label, make] of [['model', modelFixture], ['dataset', datasetFixture],
    ['large-dataset', largeDatasetFixture], ['mixed', mixedFixture]]) {
    const bytes = make();
    const profile = profileWorkbook(bytes);
    assert.equal(profile.status, 'profiled');
    const revision = revisionOf(bytes);
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const result = await timed(() => briefWorkbook(bytes, { revision, provenance: 'synthetic baseline' }));
      assert.equal(result.value.status, 'briefed');
      runs.push(result.ms);
    }
    staged.push({ fixture: label, revision, bytes: bytes.length, sheets: profile.sheets.length,
      cells: profile.cells, formulas: profile.formulas, briefing: stats(runs) });
  }
  const report = {
    measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
    method: 'Synthetic only. Sequential after test suites. Each size measured in a fresh child process; warm = same process, not an application cache. OS cache not flushed. Five repeat queries. Screenshot shows first 12 rows only. No browser readiness measurement.',
    measured, staged,
  };
  await writeFile(resolve(runDir, 'baseline.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ reportPath: resolve(runDir, 'baseline.json'), ...report }, null, 2));
}
