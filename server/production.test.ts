import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createProductionServer } from './production.ts';

test('production serves built UI, protects API origin and hides files outside dist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mog-production-'));
  const dist = join(root, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'analyst.html'), '<html>Consultant</html>');
  await writeFile(join(root, 'secret.txt'), 'outside');
  const server = createProductionServer({ root, dist, release: 'test-release' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(await (await fetch(origin)).text(), '<html>Consultant</html>');
    assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { status: 'ok', mode: 'production', release: 'test-release' });
    assert.equal((await fetch(`${origin}/api/config`)).status, 200);
    assert.equal((await fetch(`${origin}/api/config`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      get(`${origin}/health`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(`${origin}/%2e%2e%2fsecret.txt`)).status, 403);
    assert.equal((await fetch(`${origin}/server/production.ts`)).status, 404);
    assert.equal((await fetch(`${origin}/mog/compute_core_wasm_bg.wasm`, { method: 'HEAD' })).headers.get('content-type'), 'application/wasm');
    assert.equal((await fetch(`${origin}/`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
