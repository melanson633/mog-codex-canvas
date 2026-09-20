import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTasks, createAgentContext, validateAgentAnswer, type AgentTaskState, type AgentPlanner } from './agent-tasks.ts';
import { createWorkbook } from '@mog-sdk/sdk/node';

const answer = { answer: 'Saved B8 is 360,000. This is model commentary, not recalculation.', changes: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function memory(initial: AgentTaskState | null = null) {
  let data = initial;
  return { load: async () => structuredClone(data), save: async (next: AgentTaskState) => { data = structuredClone(next); } };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for job state');
}
const note = (name: string) => ({ name, scope: 'range' as const, sheet: 'Model', range: 'A1:B8', text: 'Explain EBITDA' });

test('agent jobs overlap different workbooks, serialize case aliases, and snapshot note/revision', async () => {
  const started: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<typeof answer>>>();
  const planner: AgentPlanner = async (item, context) => { started.push(item.text); assert.equal(context.revision, 'saved-v1'); const next = deferred<typeof answer>(); pending.set(item.text, next); return next.promise; };
  const engine = createAgentTasks({ store: memory(), context: async () => ({ revision: 'saved-v1', content: {} }), planner });
  const a = await engine.saveNote({ ...note('A.xlsx'), text: 'A first' });
  const a2 = await engine.saveNote({ ...note('a.xlsx'), text: 'A second' });
  const b = await engine.saveNote({ ...note('B.xlsx'), text: 'B first' });
  const ja = await engine.run(a.id); const ja2 = await engine.run(a2.id); const jb = await engine.run(b.id);
  await until(async () => started.length === 2);
  assert.deepEqual(started, ['A first', 'B first']);
  await engine.saveNote({ ...note('A.xlsx'), id: a.id, text: 'Changed later' });
  assert.equal((await engine.list()).jobs.find(job => job.id === ja.id)?.note.text, 'A first');
  pending.get('A first')!.resolve(answer);
  await until(async () => started.length === 3);
  assert.equal(started[2], 'A second');
  pending.get('A second')!.resolve(answer); pending.get('B first')!.resolve(answer);
  await until(async () => (await engine.list()).jobs.every(job => job.status === 'completed'));
  assert.deepEqual((await engine.list('A.XLSX')).jobs.map(job => job.id), [ja.id, ja2.id]);
  assert.equal((await engine.list('B.xlsx')).jobs[0].id, jb.id);
  await engine.close();
});

test('cancellation refuses late proposals and restart never reruns interrupted jobs', async () => {
  const pending = deferred<typeof answer>();
  const store = memory();
  const engine = createAgentTasks({ store, context: async () => ({ revision: 'v1', content: {} }), planner: async () => pending.promise });
  const n = await engine.saveNote(note('A.xlsx')); const job = await engine.run(n.id);
  await until(async () => (await engine.list()).jobs[0].status === 'running');
  await engine.cancel(job.id); pending.resolve(answer);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await engine.list()).jobs[0].status, 'cancelled');
  assert.equal((await engine.list()).jobs[0].result, undefined);
  await assert.rejects(engine.apply(job.id), /no completed proposal/);
  await engine.close();
  const state = (await store.load())!; state.jobs[0].status = 'running';
  const restarted = createAgentTasks({ store: memory(state), context: async () => { throw new Error('must not run'); }, planner: async () => { throw new Error('must not run'); } });
  await restarted.ready();
  assert.equal((await restarted.list()).jobs[0].status, 'interrupted');
  assert.equal((await restarted.list()).notes[0].text, n.text);
  await restarted.close();
});

test('proposal validation bounds scope, duplicates, unsafe formulas and explicit apply', async () => {
  const n = note('A.xlsx');
  const change = { sheet: 'Model', address: 'B8', value: 42, formula: null };
  for (const invalid of [ { ...change, address: 'C8' }, { ...change, sheet: 'Other' }, { ...change, address: 'XFE1' },
    { ...change, formula: '=2+2' }, { ...change, value: null, formula: '=WEBSERVICE("https://example.com")' } ]) {
    assert.throws(() => validateAgentAnswer({ answer: 'Edit', changes: [invalid] }, n));
  }
  assert.throws(() => validateAgentAnswer({ answer: 'Edit', changes: [change, change] }, n), /duplicate/);
  let applied = 0;
  const engine = createAgentTasks({ store: memory(), context: async () => ({ revision: 'v1', content: {} }),
    planner: async () => ({ answer: 'Proposed B8', changes: [change] }), apply: async (job, changes) => {
      assert.equal(job.revision, 'v1'); assert.deepEqual(changes, [change]); applied++; return { revision: 'v2' };
    } });
  const saved = await engine.saveNote(n); const job = await engine.run(saved.id);
  await until(async () => (await engine.list()).jobs[0].status === 'completed');
  assert.equal(applied, 0);
  assert.equal((await engine.apply(job.id)).appliedRevision, 'v2');
  assert.equal((await engine.apply(job.id)).status, 'applied'); assert.equal(applied, 1);
  await engine.close();
});

test('privacy/context failures prevent any model call, invalid model output becomes visible failure', async () => {
  let calls = 0;
  const engine = createAgentTasks({ store: memory(), context: async () => { throw new Error('High-risk personal data is present and redacted (R38).'); }, planner: async () => { calls++; return answer; } });
  const n = await engine.saveNote(note('A.xlsx')); await assert.rejects(engine.run(n.id), /R38/); assert.equal(calls, 0); assert.equal((await engine.list()).jobs.length, 0); await engine.close();
  const invalid = createAgentTasks({ store: memory(), context: async () => ({ revision: 'v1', content: {} }), planner: async () => ({ answer: '', changes: [] }) });
  const saved = await invalid.saveNote(note('A.xlsx')); await invalid.run(saved.id);
  await until(async () => (await invalid.list()).jobs[0].status === 'failed');
  assert.ok((await invalid.list()).jobs[0].error); await invalid.close();
});

test('note validation rejects invalid scopes and a failed store save does not pretend to persist', async () => {
  const engine = createAgentTasks({ store: { load: async () => null, save: async () => { throw new Error('disk full'); } }, context: async () => ({ revision: 'v1', content: {} }) });
  await assert.rejects(engine.saveNote({ ...note('A.xlsx'), range: 'A1:Z999' }), /500|2,000/);
  await assert.rejects(engine.saveNote({ name: 'A.xlsx', scope: 'sheet', text: 'test' }), /sheet/);
  await assert.rejects(engine.saveNote(note('A.xlsx')), /disk full/);
  assert.equal((await engine.list()).notes.length, 0);
});

test('real workbook context checks privacy outside the chosen range before supplying evidence', async () => {
  const wb = await createWorkbook();
  try {
    const sheet = wb.sheetNames[0];
    await wb.activeSheet.setRange('A1:B2', [['Revenue', 'Amount'], ['Sales', 120000]]);
    const bytes = await wb.toXlsx();
    const context = createAgentContext({ read: async () => ({ bytes, revision: 'saved-one' }) });
    const evidence = await context({ name: 'test.xlsx', scope: 'range', sheet, range: 'A1:B2' });
    assert.equal(evidence.revision, 'saved-one'); assert.match(JSON.stringify(evidence.content), /120000/);
    await wb.activeSheet.setRange('X100:Y101', [['Employee_DOB', 'ID'], [45000, 1]]);
    const protectedBytes = await wb.toXlsx();
    const protectedContext = createAgentContext({ read: async () => ({ bytes: protectedBytes, revision: 'saved-two' }) });
    await assert.rejects(protectedContext({ name: 'test.xlsx', scope: 'range', sheet, range: 'A1:B2' }), /R38/);
  } finally { await wb.dispose(); }
});

test('a history failure after apply reports the committed save and keeps its evidence', async () => {
  const store = memory(); let failSave = false; let applied = 0;
  const engine = createAgentTasks({ store: { load: store.load, save: async state => { if (failSave) throw new Error('disk full'); await store.save(state); } },
    context: async () => ({ revision: 'v1', content: {} }), planner: async () => ({ answer: 'Set B8', changes: [{ sheet: 'Model', address: 'B8', value: 42, formula: null }] }),
    apply: async () => { applied++; failSave = true; return { revision: 'v2', receipt: { id: 'receipt-1' }, screenshots: ['image.png'], validation: { ok: true } }; } });
  const n = await engine.saveNote(note('A.xlsx')); const job = await engine.run(n.id);
  await until(async () => (await engine.list()).jobs[0].status === 'completed');
  const result = await engine.apply(job.id);
  assert.equal(result.status, 'applied'); assert.equal(result.appliedRevision, 'v2');
  assert.deepEqual(result.applyResult?.receipt, { id: 'receipt-1' });
  assert.deepEqual(result.applyResult?.screenshots, ['image.png']);
  assert.match(result.warnings!.join(' '), /changes were saved/);
  assert.equal((await engine.apply(job.id)).status, 'applied'); assert.equal(applied, 1);
  failSave = false; await engine.close();
});

test('invalid persisted job state is rejected without starting the model', async () => {
  const store = memory({ version: 1, notes: [], jobs: [{ id: 'bad', status: 'running' }] } as unknown as AgentTaskState);
  const engine = createAgentTasks({ store, context: async () => ({ revision: 'v1', content: {} }), planner: async () => { assert.fail('must not run'); } });
  await assert.rejects(engine.ready(), /invalid or unsupported/);
  await assert.rejects(engine.list(), /invalid or unsupported/);
});

test('stalled apply releases the queue lock, rejects duplicate apply and preserves another workbook execution', async () => {
  const pending = deferred<{ revision: string }>(); let calls = 0;
  const engine = createAgentTasks({ store: memory(), context: async () => ({ revision: 'v1', content: {} }),
    planner: async () => ({ answer: 'Change B8', changes: [{ sheet: 'Model', address: 'B8', value: 42, formula: null }] }),
    apply: async () => { calls++; return pending.promise; } });
  const a = await engine.saveNote(note('A.xlsx')); const first = await engine.run(a.id);
  await until(async () => (await engine.list()).jobs[0].status === 'completed');
  const applying = engine.apply(first.id);
  await until(async () => calls === 1);
  const observed = await Promise.race([engine.list(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('list blocked by apply')), 300))]);
  assert.equal(observed.jobs[0].status, 'applying');
  await assert.rejects(engine.apply(first.id), /no completed proposal/);
  const b = await engine.saveNote(note('B.xlsx')); const second = await engine.run(b.id);
  await until(async () => (await engine.list()).jobs.find(job => job.id === second.id)?.status === 'completed');
  pending.resolve({ revision: 'v2' }); assert.equal((await applying).status, 'applied');
  assert.equal((await engine.apply(first.id)).appliedRevision, 'v2'); assert.equal(calls, 1);
  await engine.close();
});

test('failed external apply restores its proposal and permits retry', async () => {
  let fail = true;
  const engine = createAgentTasks({ store: memory(), context: async () => ({ revision: 'v1', content: {} }),
    planner: async () => ({ answer: 'Change B8', changes: [{ sheet: 'Model', address: 'B8', value: 42, formula: null }] }),
    apply: async () => { if (fail) throw new Error('revision changed'); return { revision: 'v2' }; } });
  const n = await engine.saveNote(note('A.xlsx')); const job = await engine.run(n.id);
  await until(async () => (await engine.list()).jobs[0].status === 'completed');
  await assert.rejects(engine.apply(job.id), /revision changed/);
  assert.equal((await engine.list()).jobs[0].status, 'completed');
  fail = false; assert.equal((await engine.apply(job.id)).status, 'applied'); await engine.close();
});

test('explicit durable archive frees full history, preserves notes and active jobs, and rolls back failed saves', async () => {
  const store = memory(); const pending = deferred<typeof answer>();
  let capped = false, archiveFails = false, saveFails = false; const archived: AgentTaskState['jobs'][] = [];
  const engine = createAgentTasks({ store: { load: store.load, save: async state => {
    if (saveFails || capped && state.jobs.some(job => job.status === 'completed')) throw new Error('state full'); await store.save(state);
  } }, context: async () => ({ revision: 'v1', content: {} }), planner: async item => item.name === 'B.xlsx' ? pending.promise : answer,
    archive: async jobs => { if (archiveFails) throw new Error('archive disk full'); archived.push(structuredClone(jobs)); return { name: 'history.json' }; } });
  const a = await engine.saveNote(note('A.xlsx')); const b = await engine.saveNote(note('B.xlsx'));
  const done = await engine.run(a.id); await until(async () => (await engine.list()).jobs[0].status === 'completed');
  const active = await engine.run(b.id); await until(async () => (await engine.list()).jobs[1].status === 'running');
  archiveFails = true; await assert.rejects(engine.archiveCompleted('A.xlsx'), /archive disk full/);
  assert.equal((await engine.list()).jobs.length, 2);
  archiveFails = false; saveFails = true; await assert.rejects(engine.archiveCompleted('A.xlsx'), /state full/);
  assert.equal((await engine.list()).jobs.length, 2);
  saveFails = false; capped = true;
  const result = await engine.archiveCompleted('a.xlsx'); assert.equal(result.archivedCount, 1); assert.equal(result.jobs[0].id, done.id);
  assert.deepEqual(result.archive, { name: 'history.json' }); assert.equal(archived.at(-1)![0].id, done.id);
  const after = await engine.list(); assert.equal(after.notes.length, 2); assert.equal(after.jobs[0].id, active.id); assert.equal(after.jobs[0].status, 'running');
  capped = false; await engine.cancel(active.id); pending.resolve(answer); await engine.close();
});
