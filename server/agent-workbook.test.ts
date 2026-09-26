import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbookService } from './workbook-service.ts';

test('agent state persists and scoped edits enforce revisions before headless apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-agent-workbook-'));
  try {
    const service = createWorkbookService({ root });
    assert.equal(await service.loadAgentState(), null);
    await service.saveAgentState({ version: 1, jobs: [] });
    assert.deepEqual(await createWorkbookService({ root }).loadAgentState(), { version: 1, jobs: [] });
    const created = await service.createBlank('Agent.xlsx');
    const changes = [{ sheet: 'Sheet1', address: 'B2', value: 42, formula: null }];
    await assert.rejects(service.applyAgentChanges(created.name, 'stale', changes, 'test'), /changed|revision/i);
    await assert.rejects(service.applyAgentChanges(created.name, created.revision, [{ ...changes[0], address: 'A1:B2' }], 'test'), /single|cell/i);
    await assert.rejects(service.applyAgentChanges(created.name, created.revision, [{ ...changes[0], sheet: 'Missing' }], 'test'), /sheet/i);
    service.context.report(created.name, { epoch: 1, sequence: 1, activeSheet: 'Sheet1', selection: 'A1', occupiedCell: 'A1', focused: true, dirty: true });
    await assert.rejects(service.applyAgentChanges(created.name, created.revision, changes, 'test'), /unsaved/i);
    service.context.report(created.name, { epoch: 1, sequence: 2, activeSheet: 'Sheet1', selection: 'B2', occupiedCell: 'B2', focused: true, dirty: false });
    await assert.rejects(service.applyAgentChanges(created.name, created.revision, changes, 'test'), /intersects/i);
    service.context.clear(created.name, 1);
    const before = await readFile(join(root, created.name));
    const applied = await service.applyAgentChanges(created.name, created.revision, changes, 'Set budget assumption');
    assert.notEqual(applied.revision, created.revision);
    assert.equal(applied.validation?.revision, applied.revision);
    assert.deepEqual(applied.warnings, []);
    assert.equal(applied.screenshots.length, 1);
    assert.ok((await readFile(join(root, applied.screenshots[0].name))).length > 100);
    assert.deepEqual(await readFile(join(root, 'Agent.xlsx.bak')), before);
    const range = await service.readRange(created.name, 'Sheet1', 'B2');
    assert.equal(range.read.status, 'ok');
    if (range.read.status === 'ok') assert.equal(range.read.cells[0].value, 42);
    const calculated = await service.applyAgentChanges(created.name, applied.revision, [
      { sheet: 'Sheet1', address: 'C2', value: null, formula: '=B2*2' },
      { sheet: 'Sheet1', address: 'D2', value: '=NOT_A_FORMULA', formula: null },
    ], 'Calculate and preserve literal text');
    assert.deepEqual(calculated.warnings, []);
    const check = await service.readRange(created.name, 'Sheet1', 'C2:D2');
    assert.equal(check.read.status, 'ok');
    if (check.read.status === 'ok') {
      assert.equal(check.read.cells[0].value, 84);
      assert.equal(check.read.cells[1].value, '=NOT_A_FORMULA');
      assert.equal(check.read.cells[1].formula, null);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('agent state refuses stale service writers and archives jobs without losing notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-agent-state-'));
  try {
    const a = createWorkbookService({ root }); const b = createWorkbookService({ root });
    assert.equal(await a.loadAgentState(), null); assert.equal(await b.loadAgentState(), null);
    const first = { version: 1, notes: [{ text: 'Keep this note' }], jobs: [] };
    await a.saveAgentState(first);
    await assert.rejects(b.saveAgentState({ version: 1, notes: [], jobs: [] }), /another server/);
    assert.deepEqual(await b.loadAgentState(), first);
    const second = { ...first, jobs: [{ id: 'done', status: 'completed' }] };
    await b.saveAgentState(second);
    await assert.rejects(a.saveAgentState(first), /another server/);
    assert.deepEqual(JSON.parse(await readFile(join(root, '.mog-agent-tasks.json.bak'), 'utf8')), first);
    const archive = await b.archiveAgentJobs(second.jobs);
    assert.match(archive.name, /^agent-history-[a-f0-9-]+\.json$/);
    const bytes = await readFile(join(root, archive.name)); assert.equal(bytes.length, archive.bytes);
    assert.deepEqual(JSON.parse(bytes.toString()).jobs, second.jobs);
    assert.deepEqual(await b.loadAgentState(), second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exclusive state lock refuses a busy or abandoned writer without deleting its lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-agent-lock-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const service = createWorkbookService({ root }); await service.loadAgentState();
    await writeFile(join(root, '.mog-agent-tasks-lock.json'), 'owned by another writer');
    await assert.rejects(service.saveAgentState({ notes: [] }), /Another server is saving/);
    assert.equal(await readFile(join(root, '.mog-agent-tasks-lock.json'), 'utf8'), 'owned by another writer');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('apostrophe sheet proposals remain disjoint from the same occupied coordinate on another sheet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-agent-quoted-sheet-'));
  try {
    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    const workbook = await createWorkbook();
    let bytes: Uint8Array;
    try { await workbook.getOrCreateSheet("Bob's Model"); await workbook.getOrCreateSheet('Summary'); bytes = await workbook.toXlsx(); }
    finally { await workbook.dispose(); }
    const service = createWorkbookService({ root }); const source = await service.importWorkbook('Quoted.xlsx', bytes);
    service.context.report(source.name, { epoch: 1, sequence: 1, activeSheet: 'Summary', selection: 'B8', occupiedCell: 'B8', focused: true, dirty: false });
    const result = await service.applyAgentChanges(source.name, source.revision, [{ sheet: "Bob's Model", address: 'B8', value: 42, formula: null }], 'Edit a different sheet');
    assert.notEqual(result.revision, source.revision);
    const value = await service.readRange(source.name, "Bob's Model", 'B8');
    assert.equal(value.read.status, 'ok'); if (value.read.status === 'ok') assert.equal(value.read.cells[0].value, 42);
  } finally { await rm(root, { recursive: true, force: true }); }
});
