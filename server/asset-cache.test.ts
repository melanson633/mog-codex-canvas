import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionServer } from './production.ts';

test('production revalidates the Mog WASM asset without sending its body again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-asset-cache-'));
  const dist = join(root, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'analyst.html'), '<html>Consultant</html>');
  const server = createProductionServer({ root, dist });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const first = await fetch(`${origin}/mog/compute_core_wasm_bg.wasm`, { method: 'HEAD' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    assert.match(first.headers.get('etag') ?? '', /^W\/\"[0-9a-f]+-[0-9a-f]+\"$/);
    assert.ok(first.headers.get('last-modified'));

    const revalidated = await fetch(`${origin}/mog/compute_core_wasm_bg.wasm`, {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('etag'), first.headers.get('etag'));
    assert.equal(await revalidated.arrayBuffer().then((body) => body.byteLength), 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
