/**
 * Containment tests for the agent lane.
 *
 *   node --test scripts/headless-edit.test.mjs
 *
 * The browser lane is confined to the workbook root by the file bridge; this
 * script is the other lane onto the same disk, and nothing upstream of it
 * validates the selector an agent passes. Each case runs the real script as its
 * own process — the way an agent invokes it — and the negative cases assert both
 * that it fails and that it wrote nothing outside the root.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const script = fileURLToPath(new URL('./headless-edit.mjs', import.meta.url));

let base = '';
let root = '';
let outside = '';

/** Directory link that Windows allows without elevation; a plain symlink elsewhere. */
async function linkDir(target, path) {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Runs the script the way an agent would: a fresh process over one workbook root. */
function runHeadless(selector) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      selector === undefined ? [script] : [script, selector],
      { env: { ...process.env, MOG_WORKBOOK_DIR: root } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mog-headless-')));
  root = join(base, 'workbooks');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.xlsx'), 'secret');
  await linkDir(outside, join(root, 'escape'));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('headless-edit', () => {
  it('creates the default workbook and its screenshot inside the root', async () => {
    const run = await runHeadless(undefined);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /created sample\.xlsx/);
    assert.match(run.stdout, /\[validate\] sheets:/);
    const entries = await readdir(root);
    assert.ok(entries.includes('sample.xlsx'), entries.join());
    assert.ok(entries.includes('sample.headless.png'), entries.join());
  });

  it('stamps an existing workbook on a later run', async () => {
    const run = await runHeadless('sample.xlsx');
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /edited sample\.xlsx/);
  });

  it('rejects an absolute selector', async () => {
    const run = await runHeadless(join(outside, 'secret.xlsx'));
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Absolute paths are not accepted/);
  });

  it('rejects a traversal selector', async () => {
    const run = await runHeadless('../outside/secret.xlsx');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /escapes the workbook root/);
  });

  it('rejects a selector that leaves the root through a junction', async () => {
    const run = await runHeadless('escape/secret.xlsx');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /escapes the workbook root/);
  });

  it('rejects a selector that is not an .xlsx', async () => {
    const run = await runHeadless('notes.txt');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /must end in \.xlsx/);
  });

  // The screenshot path is derived from the selector, not supplied, so it is the
  // one target an agent cannot see being checked. A link planted there sends the
  // image outside the root — and because both targets are authorized before the
  // engine loads, the refusal has to come before the workbook is opened at all,
  // not after it has already been stamped and saved.
  it('refuses before editing when the derived screenshot path leaves the root', async () => {
    const book = join(root, 'linked.xlsx');
    const decoy = join(outside, 'planted.png');
    await writeFile(decoy, 'planted');
    // File symlinks need developer mode or elevation on Windows; skip if unavailable.
    const planted = await symlink(decoy, join(root, 'linked.headless.png'), 'file').then(
      () => true,
      () => false,
    );
    if (!planted) return;

    const seeded = await runHeadless('linked.xlsx');
    assert.equal(seeded.code, 1, seeded.stdout);
    assert.match(seeded.stderr, /escapes the workbook root/);
    assert.equal(existsSync(book), false, 'the workbook was created before the check ran');
    assert.equal(await readFile(decoy, 'utf8'), 'planted');
  });

  it('writes nothing outside the root while being refused', async () => {
    assert.deepEqual((await readdir(outside)).sort(), ['planted.png', 'secret.xlsx']);
  });
});
