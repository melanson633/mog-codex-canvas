/**
 * Freshness detection for the MCP Apps bundle.
 *
 *   node --test scripts/ui-bundle.test.mjs
 *
 * These cases exercise the decision, never the build: a real Vite build costs
 * ~30 seconds and proves nothing about whether staleness is *noticed*, which is
 * the part that failed silently. What matters is that the answer follows
 * content — a checkout that rewrites every mtime must stay fresh, and a
 * one-character source edit must go stale.
 *
 * The mutation cases run over a scratch tree shaped like the repo, so nothing
 * here edits a real source file.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bundleFreshness, hashBuildInputs } from './ui-bundle.mjs';

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A scratch tree carrying one file at each kind of build input. */
async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), 'mog-ui-bundle-'));
  roots.push(root);
  await mkdir(join(root, 'src', 'adapters'), { recursive: true });
  await mkdir(join(root, 'plugins', 'mog-canvas', 'ui', 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'adapters', 'mog-embed-adapter.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'plugins', 'mog-canvas', 'ui', 'src', 'mcp-app.ts'), 'import "x";\n');
  await writeFile(join(root, 'vite.mcp-app.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'package-lock.json'), '{}\n');
  return root;
}

test('ui bundle: the input hash is stable across repeated reads', async () => {
  const root = await scratchRepo();
  assert.equal(await hashBuildInputs(root), await hashBuildInputs(root));
});

test('ui bundle: touching a source without changing it leaves the hash alone', async () => {
  // A git checkout rewrites mtimes on files whose bytes never changed. An
  // mtime-based check would call the bundle stale and rebuild on every clone.
  const root = await scratchRepo();
  const before = await hashBuildInputs(root);
  const now = new Date();
  await utimes(join(root, 'src', 'adapters', 'mog-embed-adapter.ts'), now, now);
  assert.equal(await hashBuildInputs(root), before);
});

test('ui bundle: an edit under src/ changes the hash', async () => {
  // The exact case that shipped broken: a change under src/, which the bundle
  // entry imports, with no change to the bundle on disk.
  const root = await scratchRepo();
  const adapter = join(root, 'src', 'adapters', 'mog-embed-adapter.ts');
  const before = await hashBuildInputs(root);
  await writeFile(adapter, 'export const a = 2;\n');
  assert.notEqual(await hashBuildInputs(root), before);
  await writeFile(adapter, 'export const a = 1;\n');
  assert.equal(await hashBuildInputs(root), before);
});

test('ui bundle: a dependency bump counts as an input change', async () => {
  // Nothing under src/ moves when a package version does, but the bundle does.
  const root = await scratchRepo();
  const before = await hashBuildInputs(root);
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  assert.notEqual(await hashBuildInputs(root), before);
});

test('ui bundle: a new source file changes the hash, not just an edited one', async () => {
  const root = await scratchRepo();
  const before = await hashBuildInputs(root);
  await writeFile(join(root, 'src', 'adapters', 'added.ts'), 'export const b = 1;\n');
  assert.notEqual(await hashBuildInputs(root), before);
});

test('ui bundle: freshness is a typed state with a reason when it is not fresh', async () => {
  // Read-only over the real checkout — whichever state this machine is in, the
  // answer has to be one of the three and has to say why when it is not fresh.
  const state = await bundleFreshness();
  assert.ok(['fresh', 'stale', 'missing'].includes(state.status), state.status);
  assert.equal(state.expected.length, 64);
  if (state.status === 'fresh') assert.equal(state.reason, null);
  else assert.ok((state.reason ?? '').length > 0, 'a non-fresh bundle gave no reason');
});
