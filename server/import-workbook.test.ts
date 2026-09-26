import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbookService } from './workbook-service.ts';
import { createBridgeHandler } from './file-bridge.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('import preserves original bytes and allocates separate copies on collision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-import-'));
  try {
    const bytes = await readFile(new URL('../workbooks/sample.xlsx', import.meta.url));
    const service = createWorkbookService({ root });
    const first = await service.importWorkbook('Planning.xlsx', bytes);
    const second = await service.importWorkbook('Planning.xlsx', bytes);
    assert.equal(first.name, 'Planning.xlsx');
    assert.equal(first.originalName, 'Planning.xlsx');
    assert.equal(second.name, 'Planning (2).xlsx');
    assert.deepEqual(await readFile(join(root, first.name)), bytes);
    assert.deepEqual(await readFile(join(root, second.name)), bytes);
    const races = await Promise.all([service.importWorkbook('Race.xlsx', bytes), createWorkbookService({ root }).importWorkbook('Race.xlsx', bytes)]);
    assert.equal(new Set(races.map(result => result.name)).size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import HTTP endpoint accepts raw XLSX and reports invalid uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-import-http-'));
  const handler = createBridgeHandler({ root });
  const server = createServer((req, res) => { void handler(req, res, () => res.writeHead(404).end()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbooks/import?name=Uploaded.xlsx`;
  try {
    const bytes = await readFile(new URL('../workbooks/sample.xlsx', import.meta.url));
    const response = await fetch(url, { method: 'POST', body: bytes });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.originalName, 'Uploaded.xlsx');
    assert.deepEqual(await readFile(join(root, result.name)), bytes);
    assert.equal((await fetch(url, { method: 'POST', body: 'invalid' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', body: new Uint8Array(50 * 1024 * 1024 + 1) })).status, 413);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('import refuses invalid, unsafe and oversized input before persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-import-invalid-'));
  try {
    const service = createWorkbookService({ root });
    for (const name of ['../bad.xlsx', 'bad.xlsm', 'CON.xlsx', 'bad:stream.xlsx']) {
      await assert.rejects(service.importWorkbook(name, Buffer.from('invalid')), /name|xlsx/i);
    }
    await assert.rejects(service.importWorkbook('Bad.xlsx', Buffer.from('not a zip')), /valid|encrypted|xlsx/i);
    const encrypted = await readFile(new URL('../workbooks/sample.xlsx', import.meta.url));
    const directory = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(directory >= 0);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(directory + 8) | 1, directory + 8);
    await assert.rejects(service.importWorkbook('Encrypted.xlsx', encrypted), /unencrypted/);
    await assert.rejects(service.importWorkbook('Huge.xlsx', new Uint8Array(50 * 1024 * 1024 + 1)), /50 MB/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
