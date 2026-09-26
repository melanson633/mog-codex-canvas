import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbookService } from './workbook-service.ts';
import { ensureConsultantExample } from './consultant-example.ts';
import { createAnalystIndex } from './analyst-index.ts';
import { createFinancialLab } from './financial-lab.ts';

test('financial example calculates, validates, screenshots and never overwrites existing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-example-'));
  try {
    const service = createWorkbookService({ root });
    const first = await ensureConsultantExample(service);
    assert.equal(first.created, true);
    if (!first.created) throw new Error('Expected a newly created example');
    assert.ok(first.screenshot && first.screenshot.bytes > 100);
    assert.deepEqual(first.validation.sheetNames, ['Model']);
    const scenarios = await createFinancialLab(service).scenario(first.name, { sheet: 'Model', input: 'B3', values: [0, 0.1, 0.2], outputs: ['B8'] });
    scenarios.cases.forEach((item, index) => assert.ok(Math.abs(item.outputs.B8 - [300000, 360000, 420000][index]) < 1e-6));
    const result = await service.readRange(first.name, 'Model', 'B8');
    assert.equal(result.read.status, 'ok');
    if (result.read.status === 'ok') assert.equal(result.read.cells[0]?.value, 360000);
    const second = await ensureConsultantExample(service);
    assert.equal(second.created, false);
    assert.equal(second.revision, first.revision);
    assert.equal(second.exampleMatches, true);
    const audit = await createAnalystIndex(service).audit(first.name, first.sheet, first.range);
    assert.ok(audit.findings.some(finding => finding.address === 'D19' && finding.kind === 'formula-pattern'));
    await assert.rejects(ensureConsultantExample({
      ...service,
      async readRange(name, sheet, range) {
        const changed = await service.readRange(name, sheet, range);
        if (changed.read.status === 'ok') return { ...changed, read: { ...changed.read, cells: changed.read.cells.map(cell => cell.address === 'B2' ? { ...cell, value: 42 } : cell) } };
        return changed;
      },
    }), /has been changed or is a different workbook/);
    assert.equal((await service.read(first.name)).revision, first.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});
