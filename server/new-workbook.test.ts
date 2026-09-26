import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeHandler } from './file-bridge.ts';
import { createWorkbookService, replaceFile, WorkbookError } from './workbook-service.ts';
import { createWorkbook } from '@mog-sdk/sdk/node';

test('exclusive staged promotion never replaces an existing target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-exclusive-create-'));
  try {
    const file = join(root, 'exclusive.xlsx');
    await replaceFile(file, Buffer.from('winner'), { backup: true, exclusive: true });
    await assert.rejects(replaceFile(file, Buffer.from('loser'), { backup: true, exclusive: true }),
      (error: unknown) => error instanceof WorkbookError && error.code === 'revision-conflict');
    assert.equal(await readFile(file, 'utf8'), 'winner');
    assert.deepEqual(await readdir(root), ['exclusive.xlsx']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('separate services racing to create preserve exactly one winner, including Windows case aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-create-race-'));
  const workbook = await createWorkbook();
  try {
    await workbook.activeSheet.setCell('A1', 'first');
    const first = await workbook.toXlsx();
    await workbook.activeSheet.setCell('A1', 'second');
    const second = await workbook.toXlsx();
    for (const names of [['race.xlsx', 'race.xlsx'], ...(process.platform === 'win32' ? [['Mixed.xlsx', 'MIXED.xlsx']] : [])]) {
      const services = [createWorkbookService({ root }), createWorkbookService({ root })];
      const bytes = [first, second];
      const results = await Promise.allSettled(services.map((service, index) => service.save(names[index], bytes[index], 'absent')));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const winner = results.findIndex(result => result.status === 'fulfilled');
      const loser = results[1 - winner];
      assert.ok(loser.status === 'rejected' && loser.reason instanceof WorkbookError && loser.reason.code === 'revision-conflict');
      assert.deepEqual(await readFile(join(root, names[winner])), Buffer.from(bytes[winner]));
    }
  } finally {
    await workbook.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('new workbook route creates a blank native workbook and preserves duplicate bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-new-workbook-'));
  const handler = createBridgeHandler({ root });
  const server = createServer((req, res) => { void handler(req, res, () => res.writeHead(404).end()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbooks`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await post({ name: 'Planning' });
    assert.equal(created.status, 201);
    const result = await created.json();
    assert.equal(result.name, 'Planning.xlsx');
    const service = createWorkbookService({ root });
    const saved = await service.read(result.name);
    assert.equal(result.revision, saved.revision);
    const validation = await service.validate(result.name);
    assert.deepEqual(validation.sheetNames, ['Sheet1']);
    const range = await service.readRange(result.name, 'Sheet1', 'A1:D20');
    assert.equal(range.read.status, 'ok');
    assert.equal(range.read.cells.length, 0);
    const duplicate = await post({ name: 'Planning.xlsx' });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await readFile(join(root, result.name)), Buffer.from(saved.bytes));
    assert.equal((await readdir(root)).filter(name => name.endsWith('.xlsx')).length, 1);
    for (const name of ['', '../escape', 'folder/book', 'folder\\book', 'book:stream', 'CON', 'LPT1.xlsx', '.hidden', 'trailing.', ' space ', 'bad?name', 'x'.repeat(121)]) {
      assert.equal((await post({ name })).status, 400, name);
    }
    assert.equal((await post({ name: null })).status, 400);
    assert.equal((await post({ name: 'x'.repeat(2000) })).status, 413);
    assert.equal((await service.list()).length, 1);
    const simultaneous = await Promise.all([post({ name: 'Concurrent' }), post({ name: 'Concurrent' })]);
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [201, 409]);
    const winner = await simultaneous.find(response => response.status === 201)!.json();
    assert.equal((await service.read(winner.name)).revision, winner.revision);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
