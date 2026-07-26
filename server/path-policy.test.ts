/**
 * Containment tests for the file bridge's path policy.
 *
 *   node --test server/path-policy.test.ts
 *
 * The junction cases are the reason this module exists: a lexical
 * resolve-then-prefix check passes them, and they escape the root anyway.
 * Directory junctions are used rather than symlinks because Windows creates
 * them without elevation, so the escape is reachable in a normal dev session.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  SCREENSHOT_EXTENSION,
  WORKBOOK_EXTENSION,
  canonicalizeRoot,
  resolveReadTarget,
  resolveSaveTarget,
} from './path-policy.ts'; // explicit extension: this test runs under `node --test`, not a bundler

let base = '';
let root = '';
let outside = '';

/** Directory link that Windows allows without elevation; a plain symlink elsewhere. */
async function linkDir(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

async function rejects(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  await assert.rejects(fn, match);
}

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mog-path-policy-')));
  root = join(base, 'workbooks');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'book.xlsx'), 'book');
  await writeFile(join(root, 'sub', 'nested.xlsx'), 'nested');
  await writeFile(join(root, 'shot.png'), 'shot');
  await writeFile(join(outside, 'secret.xlsx'), 'secret');
  await linkDir(outside, join(root, 'escape'));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('canonicalizeRoot', () => {
  it('returns the canonical root', () => {
    assert.equal(canonicalizeRoot(root), root);
  });

  it('resolves a junction to the directory it points at', async () => {
    assert.equal(canonicalizeRoot(join(root, 'escape')), outside);
  });

  it('refuses a root that does not exist', () => {
    assert.throws(() => canonicalizeRoot(join(base, 'missing')), /Workbook root does not exist/);
  });

  // Targets are canonicalized with fsPromises.realpath (native semantics), so
  // the root must be too. The difference is visible on Windows when the
  // configured root contains an 8.3 short name (e.g. %TEMP% under
  // C:\Users\MARKME~1\...): only the native call expands it, and a short-form
  // root makes every expanded target look like an escape.
  it('agrees with the native realpath used for targets', async () => {
    const raw = await mkdtemp(join(tmpdir(), 'mog-root-form-'));
    try {
      assert.equal(canonicalizeRoot(raw), await realpath(raw));
    } finally {
      await rm(raw, { recursive: true, force: true });
    }
  });
});

describe('resolveReadTarget', () => {
  it('accepts a workbook in the root', async () => {
    assert.equal(await resolveReadTarget(root, 'book.xlsx', 'workbook'), join(root, 'book.xlsx'));
  });

  it('accepts a workbook in a subdirectory', async () => {
    assert.equal(
      await resolveReadTarget(root, 'sub/nested.xlsx', 'workbook'),
      join(root, 'sub', 'nested.xlsx'),
    );
  });

  it('accepts a png for the screenshot kind', async () => {
    assert.equal(await resolveReadTarget(root, 'shot.png', 'screenshot'), join(root, 'shot.png'));
  });

  it('rejects a target reached through a junction that leaves the root', async () => {
    await rejects(
      () => resolveReadTarget(root, 'escape/secret.xlsx', 'workbook'),
      /escapes the workbook root/,
    );
  });

  it('rejects traversal above the root', async () => {
    await rejects(
      () => resolveReadTarget(root, '../outside/secret.xlsx', 'workbook'),
      /escapes the workbook root/,
    );
  });

  it('rejects traversal that dips into a subdirectory first', async () => {
    await rejects(
      () => resolveReadTarget(root, 'sub/../../outside/secret.xlsx', 'workbook'),
      /escapes the workbook root/,
    );
  });

  it('rejects an absolute path', async () => {
    await rejects(
      () => resolveReadTarget(root, join(outside, 'secret.xlsx'), 'workbook'),
      /Absolute paths are not accepted/,
    );
  });

  it('rejects a posix-rooted path', async () => {
    await rejects(() => resolveReadTarget(root, '/etc/passwd.xlsx', 'workbook'), /Absolute paths/);
  });

  it('rejects a drive-relative path', async () => {
    await rejects(() => resolveReadTarget(root, 'C:secret.xlsx', 'workbook'), /Absolute paths/);
  });

  it('rejects a UNC path', async () => {
    await rejects(
      () => resolveReadTarget(root, '\\\\host\\share\\secret.xlsx', 'workbook'),
      /Absolute paths/,
    );
    await rejects(() => resolveReadTarget(root, '//host/share/secret.xlsx', 'workbook'), /Absolute paths/);
  });

  it('rejects an extension the bridge does not serve', async () => {
    await writeFile(join(root, 'notes.txt'), 'notes');
    await rejects(
      () => resolveReadTarget(root, 'notes.txt', 'workbook'),
      new RegExp(`must end in \\${WORKBOOK_EXTENSION}`),
    );
    await rejects(
      () => resolveReadTarget(root, 'book.xlsx', 'screenshot'),
      new RegExp(`must end in \\${SCREENSHOT_EXTENSION}`),
    );
  });

  it('rejects a directory that carries the right extension', async () => {
    await mkdir(join(root, 'folder.xlsx'), { recursive: true });
    await rejects(() => resolveReadTarget(root, 'folder.xlsx', 'workbook'), /Not a regular file/);
  });

  it('rejects a missing file', async () => {
    await rejects(() => resolveReadTarget(root, 'nope.xlsx', 'workbook'), /No such file/);
  });

  it('rejects a missing or empty path parameter', async () => {
    await rejects(() => resolveReadTarget(root, null, 'workbook'), /Missing "path"/);
    await rejects(() => resolveReadTarget(root, '', 'workbook'), /Missing "path"/);
  });

  it('rejects a null byte', async () => {
    await rejects(() => resolveReadTarget(root, 'book.xlsx\0.png', 'workbook'), /null byte/);
  });

  // `notes.txt:book.xlsx` names a stream hanging off notes.txt, not a workbook.
  // It canonicalizes inside the root, so containment holds either way — but the
  // extension check reads the part after the colon, which is how a .txt ends up
  // served through a lane that is supposed to serve only .xlsx.
  it('rejects an alternate data stream', async () => {
    await rejects(() => resolveReadTarget(root, 'notes.txt:book.xlsx', 'workbook'), /data stream/);
  });
});

describe('resolveSaveTarget', () => {
  it('accepts a new workbook in the root', async () => {
    assert.equal(await resolveSaveTarget(root, 'fresh.xlsx', 'workbook'), join(root, 'fresh.xlsx'));
  });

  it('accepts a new screenshot beside an existing workbook', async () => {
    assert.equal(await resolveSaveTarget(root, 'book.png', 'screenshot'), join(root, 'book.png'));
  });

  it('accepts a new file in an existing subdirectory', async () => {
    assert.equal(
      await resolveSaveTarget(root, 'sub/fresh.xlsx', 'workbook'),
      join(root, 'sub', 'fresh.xlsx'),
    );
  });

  it('rejects an alternate data stream on a name it would otherwise accept', async () => {
    await rejects(() => resolveSaveTarget(root, 'book.xlsx:hidden.xlsx', 'workbook'), /data stream/);
  });

  it('overwrites an existing workbook at its canonical path', async () => {
    assert.equal(await resolveSaveTarget(root, 'book.xlsx', 'workbook'), join(root, 'book.xlsx'));
  });

  it('rejects a new file whose parent junction leaves the root', async () => {
    await rejects(
      () => resolveSaveTarget(root, 'escape/planted.xlsx', 'workbook'),
      /escapes the workbook root/,
    );
  });

  it('rejects an existing file reached through a junction', async () => {
    await rejects(
      () => resolveSaveTarget(root, 'escape/secret.xlsx', 'workbook'),
      /escapes the workbook root/,
    );
  });

  it('rejects traversal above the root', async () => {
    await rejects(
      () => resolveSaveTarget(root, '../outside/planted.xlsx', 'workbook'),
      /escapes the workbook root/,
    );
  });

  it('rejects a parent directory that does not exist', async () => {
    await rejects(
      () => resolveSaveTarget(root, 'missing/fresh.xlsx', 'workbook'),
      /Parent directory does not exist/,
    );
  });

  it('rejects a parent that is a file', async () => {
    await rejects(
      () => resolveSaveTarget(root, 'book.xlsx/fresh.xlsx', 'workbook'),
      /Parent is not a directory/,
    );
  });

  it('rejects a dangling link rather than following it', async () => {
    const link = join(root, 'dangling.xlsx');
    // File symlinks need elevation or developer mode on Windows; skip if unavailable.
    const created = await symlink(join(outside, 'gone.xlsx'), link, 'file').then(
      () => true,
      () => false,
    );
    if (!created) return;
    await rejects(() => resolveSaveTarget(root, 'dangling.xlsx', 'workbook'), /could not be resolved/);
    await rejects(() => resolveReadTarget(root, 'dangling.xlsx', 'workbook'), /could not be resolved/);
  });

  it('rejects the root itself', async () => {
    await rejects(() => resolveSaveTarget(root, `.${sep}`, 'workbook'), /must end in/);
  });
});
