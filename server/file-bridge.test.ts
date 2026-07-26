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
import { execFile } from 'node:child_process';
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

/**
 * The cases the happy-path tests above cannot reach: a process that dies rather
 * than rejects, two writers on one workbook, a planted link on the backup path,
 * and a client that hangs up mid-upload. Each one is a way the primary workbook
 * could plausibly be lost, so each asserts the workbook is not merely present
 * but still loadable by the engine.
 */
describe('replaceFile under duress', () => {
  it('survives the process being killed at the moment of promotion', async () => {
    const file = join(root, 'killed.xlsx');
    const original = await xlsxBytes('A1', 'original');
    await writeFile(file, original);

    // A rejected promise is a polite failure; this is the impolite one. The
    // child dies inside promote(), after the bytes are staged and the backup is
    // taken — precisely where the previous save had already emptied the target.
    const fixture = join(base, 'kill-mid-save.mjs');
    await writeFile(
      fixture,
      [
        `import { replaceFile } from ${JSON.stringify(new URL('./file-bridge.ts', import.meta.url).href)};`,
        `const [target, payload] = process.argv.slice(2);`,
        `await replaceFile(target, Buffer.from(payload, 'base64'), {`,
        `  backup: true,`,
        `  promote: () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); },`,
        `});`,
      ].join('\n'),
    );
    const replacement = await xlsxBytes('A1', 'replacement');
    const died = await new Promise<Error | null>((resolve) => {
      execFile(process.execPath, [fixture, file, replacement.toString('base64')], resolve);
    });
    assert.ok(died, 'the child was supposed to die mid-save');

    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    const survivor = await createWorkbook(file);
    try {
      assert.equal(await survivor.activeSheet.getValue('A1'), 'original');
    } finally {
      await survivor.dispose();
    }
    assert.equal(Buffer.compare(await readFile(`${file}.bak`), original), 0);
    // The whole cost of the crash: one staged file nobody will promote. It is
    // gitignored and the next save writes its own, so nothing cleans it up.
    assert.equal(
      (await readdir(root)).filter((name) => name.startsWith('killed.xlsx.') && name.endsWith('.staged'))
        .length,
      1,
    );
  });

  it('does not write through a .bak that links outside the root', async () => {
    const file = join(root, 'linked-backup.xlsx');
    await writeFile(file, 'previous version');
    const treasure = join(outside, 'treasure.txt');
    await writeFile(treasure, 'do not overwrite');
    // File symlinks need developer mode or elevation on Windows; skip if unavailable.
    const planted = await symlink(treasure, `${file}.bak`, 'file').then(
      () => true,
      () => false,
    );
    if (!planted) return;

    await replaceFile(file, Buffer.from('new version'), { backup: true });

    assert.equal(await readFile(treasure, 'utf8'), 'do not overwrite');
    assert.equal(await readFile(`${file}.bak`, 'utf8'), 'previous version');
    assert.equal(await readFile(file, 'utf8'), 'new version');
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
    assert.equal(written.backup, 'written.xlsx.bak');
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

  // The canvas and the agent lane write the same root, so two saves landing on
  // one workbook is a real sequence, not a synthetic one. A loser may lose its
  // edit and must be told so; what must never happen is a workbook that is half
  // of one save and half of another, or a save reported failed that in fact won.
  it('leaves one whole workbook when four saves race for it', async () => {
    const writers = await Promise.all(
      [0, 1, 2, 3].map((n) => xlsxBytes('A1', `writer-${n}`)),
    );
    const responses = await Promise.all(
      writers.map((bytes) =>
        fetch(`${origin}/api/workbook?path=contended.xlsx`, {
          method: 'PUT',
          body: new Uint8Array(bytes),
        }),
      ),
    );
    const statuses = responses.map((res) => res.status);
    assert.ok(statuses.includes(200), `no save succeeded: ${statuses.join()}`);
    for (const [n, res] of responses.entries()) {
      if (res.status === 200) continue;
      assert.equal(res.status, 500, `writer-${n} failed with ${res.status}`);
      assert.match((await res.json()).error, /was not changed by this save/);
    }

    const onDisk = await readFile(join(root, 'contended.xlsx'));
    const winner = writers.findIndex((bytes) => Buffer.compare(bytes, onDisk) === 0);
    assert.notEqual(winner, -1, 'the file on disk matches no single writer — it is torn');
    assert.equal(statuses[winner], 200, `writer-${winner} won the race but was told it failed`);

    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    const book = await createWorkbook(join(root, 'contended.xlsx'));
    try {
      assert.equal(await book.activeSheet.getValue('A1'), `writer-${winner}`);
    } finally {
      await book.dispose();
    }
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('contended.xlsx.')),
      ['contended.xlsx.bak'],
    );
  });

  it('writes nothing when the client hangs up mid-upload', async () => {
    const target = join(root, 'aborted.xlsx');
    const controller = new AbortController();
    const body = new ReadableStream({
      start(controllerStream) {
        // A first chunk and then silence: the request is open, the body never ends.
        controllerStream.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      },
    });
    const init = {
      method: 'PUT',
      body,
      signal: controller.signal,
      duplex: 'half',
    } as unknown as RequestInit;

    const request = fetch(`${origin}/api/workbook?path=aborted.xlsx`, init).catch(
      (error: Error) => error,
    );
    const outcome = await new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
      controller.abort();
      return request;
    });
    assert.ok(outcome instanceof Error, 'the aborted request should not resolve');

    assert.equal(await readFile(target, 'utf8').catch(() => null), null);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('aborted')),
      [],
    );
  });
});
