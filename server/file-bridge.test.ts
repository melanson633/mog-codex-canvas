/**
 * Persistence and endpoint tests for the file bridge.
 *
 *   node --test server/file-bridge.test.ts
 *
 * Two concerns live here. `replaceFile` is the crash-safe write itself: bytes go
 * to a staged sibling first, the previous version is copied aside, and only then
 * is the staged file promoted over the target — so an interrupted or failed save
 * can never leave the primary path missing. The endpoint block drives the real
 * middleware over a real HTTP server to prove every route goes through the
 * containment policy, including the junction escape that lexical checks miss.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createBridgeHandler, replaceFile } from './file-bridge.ts'; // explicit extension: `node --test`, not a bundler

let base = '';
let root = '';
let outside = '';
let server: Server;
let origin = '';

/** Directory link that Windows allows without elevation; a plain symlink elsewhere. */
async function linkDir(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Real xlsx bytes from the headless engine — the same shape the canvas sends. */
async function xlsxBytes(cell: string, value: string): Promise<Buffer> {
  const { createWorkbook } = await import('@mog-sdk/sdk/node');
  const book = await createWorkbook();
  try {
    await book.activeSheet.setCell(cell, value);
    return Buffer.from(await book.toXlsx());
  } finally {
    await book.dispose();
  }
}

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mog-file-bridge-')));
  root = join(base, 'workbooks');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'book.xlsx'), 'book');
  await writeFile(join(outside, 'secret.xlsx'), 'secret');
  await linkDir(outside, join(root, 'escape'));

  const handler = createBridgeHandler({ root });
  server = createServer((req, res) => {
    handler(req, res, () => {
      res.writeHead(418).end('fell through');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(base, { recursive: true, force: true });
});

describe('replaceFile', () => {
  it('writes a new file and reports no backup', async () => {
    const file = join(root, 'fresh.bin');
    const result = await replaceFile(file, Buffer.from('fresh'), { backup: true });
    assert.equal(result.backup, null);
    assert.equal(result.bytes, 5);
    assert.equal(await readFile(file, 'utf8'), 'fresh');
  });

  it('keeps the previous version as .bak when replacing a file', async () => {
    const file = join(root, 'rotated.bin');
    await writeFile(file, 'first');
    const result = await replaceFile(file, Buffer.from('second'), { backup: true });
    assert.equal(result.backup, `${file}.bak`);
    assert.equal(await readFile(file, 'utf8'), 'second');
    assert.equal(await readFile(`${file}.bak`, 'utf8'), 'first');
  });

  it('leaves no staged file behind after a successful save', async () => {
    const dir = join(root, 'staging');
    await mkdir(dir, { recursive: true });
    await replaceFile(join(dir, 'clean.bin'), Buffer.from('clean'), { backup: true });
    assert.deepEqual(await readdir(dir), ['clean.bin']);
  });

  it('skips the backup when the caller does not ask for one', async () => {
    const file = join(root, 'unbacked.bin');
    await writeFile(file, 'first');
    const result = await replaceFile(file, Buffer.from('second'), { backup: false });
    assert.equal(result.backup, null);
    assert.equal(await readFile(file, 'utf8'), 'second');
    assert.equal(await readFile(`${file}.bak`, 'utf8').catch(() => null), null);
  });

  it('leaves the original file readable when promotion fails', async () => {
    const file = join(root, 'promotion.bin');
    await writeFile(file, 'original');
    await assert.rejects(
      () =>
        replaceFile(file, Buffer.from('replacement'), {
          backup: true,
          promote: () => Promise.reject(new Error('device is busy')),
        }),
      /device is busy/,
    );
    assert.equal(await readFile(file, 'utf8'), 'original');
    assert.equal(await readFile(`${file}.bak`, 'utf8'), 'original');
  });

  it('removes the staged file when promotion fails', async () => {
    const dir = join(root, 'failed-staging');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'promotion.bin');
    await writeFile(file, 'original');
    await assert.rejects(() =>
      replaceFile(file, Buffer.from('replacement'), {
        backup: false,
        promote: () => Promise.reject(new Error('device is busy')),
      }),
    );
    assert.deepEqual(await readdir(dir), ['promotion.bin']);
  });
});

describe('bridge endpoints', () => {
  it('GET /api/config lists workbooks in the root', async () => {
    const config = await fetch(`${origin}/api/config`).then((r) => r.json());
    assert.equal(config.root, root);
    assert.ok(config.files.some((entry: { name: string }) => entry.name === 'book.xlsx'));
  });

  it('GET /api/workbook returns the file bytes', async () => {
    const res = await fetch(`${origin}/api/workbook?path=book.xlsx`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'book');
  });

  it('PUT /api/workbook saves bytes that read back identically', async () => {
    const bytes = await xlsxBytes('A1', 'bridge');
    const written = await fetch(`${origin}/api/workbook?path=written.xlsx`, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    }).then((r) => r.json());
    assert.equal(written.bytes, bytes.byteLength);
    const readBack = await fetch(`${origin}/api/workbook?path=written.xlsx`);
    assert.equal(Buffer.compare(Buffer.from(await readBack.arrayBuffer()), bytes), 0);
  });

  it('POST /api/validate re-opens the workbook that landed on disk', async () => {
    const report = await fetch(`${origin}/api/validate?path=written.xlsx`, {
      method: 'POST',
    }).then((r) => r.json());
    assert.ok(Array.isArray(report.sheetNames) && report.sheetNames.length > 0);
    assert.match(report.sheets[0].summary, /Used Range/);
  });

  it('PUT /api/workbook keeps the previous version as .bak', async () => {
    const replacement = await xlsxBytes('A1', 'replacement');
    const written = await fetch(`${origin}/api/workbook?path=written.xlsx`, {
      method: 'PUT',
      body: new Uint8Array(replacement),
    }).then((r) => r.json());
    assert.equal(written.backup, join(root, 'written.xlsx.bak'));
    assert.equal((await readFile(join(root, 'written.xlsx'))).byteLength, replacement.byteLength);
  });

  it('PUT /api/workbook refuses an empty body', async () => {
    const res = await fetch(`${origin}/api/workbook?path=empty.xlsx`, { method: 'PUT' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /empty workbook/);
    assert.equal(await readFile(join(root, 'empty.xlsx'), 'utf8').catch(() => null), null);
  });

  it('PUT /api/screenshot writes the image bytes', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const res = await fetch(`${origin}/api/screenshot?path=shot.png`, {
      method: 'PUT',
      body: new Uint8Array(png),
    });
    assert.equal(res.status, 200);
    assert.equal(Buffer.compare(await readFile(join(root, 'shot.png')), png), 0);
  });

  it('rejects a workbook read that leaves the root through a junction', async () => {
    const res = await fetch(`${origin}/api/workbook?path=escape/secret.xlsx`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /escapes the workbook root/);
  });

  it('rejects a workbook write that leaves the root through a junction', async () => {
    const res = await fetch(`${origin}/api/workbook?path=escape/planted.xlsx`, {
      method: 'PUT',
      body: 'planted',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /escapes the workbook root/);
    assert.equal(await readFile(join(outside, 'planted.xlsx'), 'utf8').catch(() => null), null);
  });

  it('rejects a validate that leaves the root through a junction', async () => {
    const res = await fetch(`${origin}/api/validate?path=escape/secret.xlsx`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /escapes the workbook root/);
  });

  it('rejects a screenshot write that leaves the root through a junction', async () => {
    const res = await fetch(`${origin}/api/screenshot?path=escape/planted.png`, {
      method: 'PUT',
      body: 'planted',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /escapes the workbook root/);
    assert.equal(await readFile(join(outside, 'planted.png'), 'utf8').catch(() => null), null);
  });

  it('rejects a workbook path that is not an .xlsx', async () => {
    const res = await fetch(`${origin}/api/workbook?path=notes.txt`, { method: 'PUT', body: 'x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /must end in \.xlsx/);
  });

  it('rejects a screenshot path that is not a .png', async () => {
    const res = await fetch(`${origin}/api/screenshot?path=book.xlsx`, { method: 'PUT', body: 'x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /must end in \.png/);
  });

  it('answers 404 for an unknown /api endpoint', async () => {
    const res = await fetch(`${origin}/api/nope`);
    assert.equal(res.status, 404);
  });

  it('passes a non-/api request to the next middleware', async () => {
    const res = await fetch(`${origin}/index.html`);
    assert.equal(res.status, 418);
  });
});
