/**
 * The shared workbook service: one policy, one persistence path, every lane.
 *
 * The HTTP file bridge (dev app), the MCP server (Codex plugin), and the
 * headless scripts all operate on the same workbook root with the same
 * guarantees. This module is where those guarantees live, so no lane can
 * drift from the others:
 *
 *   - containment: every client-supplied name goes through ./path-policy
 *   - durability: every write goes through replaceFile (staged + backup)
 *   - identity: a workbook's revision is the SHA-256 of its bytes on disk,
 *     and a save that names a stale revision is refused — the attempted
 *     bytes are preserved as a recoverable .conflict-*.xlsx sibling instead
 *     of silently overwriting the newer file
 *   - validation: a saved file is only trusted after the headless engine
 *     reopens it and reads it back
 *
 * Errors thrown here are WorkbookError with a stable machine-readable code,
 * so both the HTTP bridge and the MCP tools can return structured,
 * actionable failures without inventing their own taxonomy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  WORKBOOK_EXTENSION,
  canonicalizeRoot,
  resolveReadTarget,
  resolveSaveTarget,
} from './path-policy.ts';

export type WorkbookErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'empty-write'
  | 'revision-conflict'
  | 'no-such-session'
  | 'write-failed'
  | 'validation-failed';

export class WorkbookError extends Error {
  readonly code: WorkbookErrorCode;
  /** Structured, safe-to-show context (never contains bytes). */
  readonly details: Record<string, unknown>;

  constructor(code: WorkbookErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkbookError';
    this.code = code;
    this.details = details;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Policy errors are thrown as plain Errors; give them a stable code here. */
async function policy<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    const message = reason(error);
    throw new WorkbookError(/No such file/.test(message) ? 'not-found' : 'invalid-path', message);
  }
}

export function revisionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface WorkbookEntry {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
}

export interface SheetSummary {
  readonly name: string;
  readonly summary: string;
}

export interface ValidationReport {
  /** Root-relative name of the validated workbook — never an absolute path. */
  readonly name: string;
  readonly bytes: number;
  readonly modified: string;
  readonly revision: string;
  readonly sheetNames: readonly string[];
  readonly sheets: readonly SheetSummary[];
}

export interface OpenResult {
  readonly sessionId: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly modified: string;
  readonly revision: string;
}

export interface SaveResult {
  readonly name: string;
  readonly bytes: number;
  readonly revision: string;
  readonly backup: string | null;
}

export interface SaveConflict {
  readonly expectedRevision: string;
  readonly actualRevision: string;
  /** Root-relative name of the file holding the refused bytes. */
  readonly conflictFile: string;
}

export interface ScreenshotResult {
  /** Root-relative name of the written PNG — never an absolute path. */
  readonly name: string;
  readonly bytes: number;
}

interface SessionState {
  readonly sessionId: string;
  readonly name: string;
  revision: string;
  readonly openedAt: string;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly name: string;
  readonly revision: string;
  readonly openedAt: string;
}

export interface ReplaceResult {
  readonly file: string;
  readonly bytes: number;
  readonly backup: string | null;
}

export interface ReplaceOptions {
  /** Copy the version being replaced to `<file>.bak` before promoting the new one. */
  readonly backup: boolean;
  /**
   * The promotion step. Only overridden by tests, which cannot make a real
   * rename fail on demand, and a failed promotion is the case that decides
   * whether a workbook survives a bad save.
   */
  readonly promote?: (from: string, to: string) => Promise<void>;
}

/** Unique within a process; the pid keeps two servers on one root apart. */
let stagedCount = 0;

/**
 * Replaces `file` with `bytes` without ever leaving the target path missing.
 *
 * The bytes land in a staged sibling first and are flushed to disk before
 * anything at the target moves, so a crash mid-write costs only the staged
 * file. The previous version is *copied* aside rather than renamed away — a
 * rename would open a window where the workbook exists only as a `.bak` — and
 * the staged file is then promoted with a single rename, which replaces the
 * target atomically. If that promotion fails, the original is still the file it
 * always was, and the staged copy is removed.
 */
export async function replaceFile(
  file: string,
  bytes: Buffer,
  { backup, promote = rename }: ReplaceOptions,
): Promise<ReplaceResult> {
  const staged = `${file}.${process.pid}.${stagedCount++}.staged`;
  const handle = await open(staged, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const existed = (await stat(file).catch(() => null)) !== null;
  try {
    const previous = backup && existed ? `${file}.bak` : null;
    if (previous) {
      // Clear the backup path before copying onto it. It is derived from the
      // target rather than resolved by the policy, and a copy follows a link
      // sitting there — a symlink planted at `<workbook>.bak` would send the
      // previous version outside the root. Unlink removes the link itself.
      await rm(previous, { force: true });
      await copyFile(file, previous);
    }
    await promote(staged, file);
    return { file, bytes: bytes.byteLength, backup: previous };
  } catch (error) {
    await rm(staged, { force: true });
    const present = (await stat(file).catch(() => null)) !== null;
    // basename only: this error travels out through the bridge and MCP tools,
    // which never disclose absolute paths.
    throw new WorkbookError(
      'write-failed',
      `Could not write ${basename(file)}: ${reason(error)}. ` +
        (present ? 'The file on disk was not changed by this save.' : 'No file was written.'),
      { file: basename(file), preserved: present },
    );
  }
}

export interface WorkbookServiceOptions {
  /** Directory that holds the workbooks this service may open and save. */
  readonly root: string;
}

export interface WorkbookService {
  /** Canonical workbook root this service is confined to. */
  readonly root: string;

  list(): Promise<WorkbookEntry[]>;

  /** Read current bytes without creating a session (dev-bridge GET). */
  read(name: string): Promise<{ bytes: Uint8Array; revision: string }>;

  /** Open a tracked session: bytes + the revision saves must be based on. */
  openSession(name: string): Promise<OpenResult>;

  getSession(sessionId: string): SessionInfo;
  listSessions(): SessionInfo[];
  closeSession(sessionId: string): void;

  /**
   * Save through a session with stale-revision protection. The session's
   * revision advances on success.
   */
  saveSession(sessionId: string, bytes: Uint8Array): Promise<SaveResult>;

  /**
   * Save by name. When `expectedRevision` is given and the file on disk no
   * longer matches it, the save is refused: the attempted bytes are preserved
   * as a `.conflict-<stamp>.xlsx` sibling and a revision-conflict error is
   * thrown naming both revisions and the preserved file. Passing no
   * expectedRevision is an explicit "last write wins" (headless lane).
   */
  save(name: string, bytes: Uint8Array, expectedRevision?: string): Promise<SaveResult>;

  /** Reopen a saved workbook with the headless engine and read it back. */
  validate(name: string): Promise<ValidationReport>;

  /** Write PNG bytes to a contained .png path. */
  writeScreenshot(name: string, bytes: Uint8Array): Promise<ScreenshotResult>;

  /**
   * Render a PNG of a saved workbook with the headless engine — no browser —
   * and write it next to the workbook (or to `outName`).
   */
  captureScreenshot(name: string, range?: string, outName?: string): Promise<ScreenshotResult>;
}

export function createWorkbookService(options: WorkbookServiceOptions): WorkbookService {
  // Canonicalized at construction: without a resolvable root there is no
  // containment boundary, and the service must not come up at all.
  const root = canonicalizeRoot(options.root);
  const sessions = new Map<string, SessionState>();

  async function list(): Promise<WorkbookEntry[]> {
    const names = await readdir(root).catch(() => [] as string[]);
    const entries: WorkbookEntry[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith(WORKBOOK_EXTENSION) || name.startsWith('~$')) continue;
      const info = await stat(join(root, name));
      entries.push({ name, size: info.size, modified: info.mtime.toISOString() });
    }
    return entries.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async function read(name: string): Promise<{ bytes: Uint8Array; revision: string }> {
    const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
    const bytes = await readFile(file);
    return { bytes, revision: revisionOf(bytes) };
  }

  function requireSession(sessionId: string): SessionState {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new WorkbookError('no-such-session', `No open session: ${sessionId}`, { sessionId });
    }
    return session;
  }

  async function save(
    name: string,
    bytes: Uint8Array,
    expectedRevision?: string,
  ): Promise<SaveResult> {
    if (bytes.byteLength === 0) {
      throw new WorkbookError('empty-write', 'Refusing to write an empty workbook', { name });
    }
    const file = await policy(() => resolveSaveTarget(root, name, 'workbook'));

    if (expectedRevision !== undefined) {
      const current = await readFile(file).catch(() => null);
      const actualRevision = current ? revisionOf(current) : 'absent';
      if (actualRevision !== expectedRevision) {
        // The workbook changed underneath this save. Refuse it, but do not
        // discard the caller's work: park the refused bytes beside the target.
        const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
        const conflictName = name.replace(/\.xlsx$/i, `.conflict-${stamp}.xlsx`);
        const conflictFile = await policy(() => resolveSaveTarget(root, conflictName, 'workbook'));
        await replaceFile(conflictFile, Buffer.from(bytes), { backup: false });
        throw new WorkbookError(
          'revision-conflict',
          `${name} changed on disk after it was opened (expected revision ` +
            `${expectedRevision.slice(0, 12)}…, found ${actualRevision.slice(0, 12)}…). ` +
            `Nothing was overwritten; your version was preserved as ${basename(conflictFile)}. ` +
            'Reopen the workbook to pick up the newer file, then reapply or merge from the preserved copy.',
          {
            expectedRevision,
            actualRevision,
            conflictFile: basename(conflictFile),
          } satisfies SaveConflict & Record<string, unknown>,
        );
      }
    }

    const saved = await replaceFile(file, Buffer.from(bytes), { backup: true });
    return {
      name,
      bytes: saved.bytes,
      revision: revisionOf(bytes),
      backup: saved.backup ? basename(saved.backup) : null,
    };
  }

  async function validate(name: string): Promise<ValidationReport> {
    const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
    // The /node subpath forces the native binding; the bare specifier resolves
    // to the browser WASM build under bundler resolution, which has no
    // file-path API.
    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    let wb: Awaited<ReturnType<typeof createWorkbook>>;
    try {
      wb = await createWorkbook(file);
    } catch (error) {
      throw new WorkbookError('validation-failed', `${name} could not be reopened: ${reason(error)}`, {
        name,
      });
    }
    try {
      const sheets: SheetSummary[] = [];
      for (const sheetName of wb.sheetNames) {
        const { sheet } = await wb.getOrCreateSheet(sheetName);
        sheets.push({ name: sheetName, summary: await sheet.summarize() });
      }
      const [info, bytes] = await Promise.all([stat(file), readFile(file)]);
      return {
        name,
        bytes: info.size,
        modified: info.mtime.toISOString(),
        revision: revisionOf(bytes),
        sheetNames: wb.sheetNames,
        sheets,
      };
    } finally {
      await wb.dispose();
    }
  }

  async function writeScreenshot(name: string, bytes: Uint8Array): Promise<ScreenshotResult> {
    const file = await policy(() => resolveSaveTarget(root, name, 'screenshot'));
    const saved = await replaceFile(file, Buffer.from(bytes), { backup: false });
    return { name, bytes: saved.bytes };
  }

  async function captureScreenshot(
    name: string,
    range = 'A1:H30',
    outName?: string,
  ): Promise<ScreenshotResult> {
    const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    const wb = await createWorkbook(file);
    let png: Uint8Array;
    try {
      png = await wb.captureScreenshot(wb.activeSheet, range, { dpr: 1 });
    } finally {
      await wb.dispose();
    }
    return writeScreenshot(outName ?? name.replace(/\.xlsx$/i, '.png'), png);
  }

  return {
    root,
    list,
    read,

    async openSession(name) {
      const { bytes, revision } = await read(name);
      const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
      const info = await stat(file);
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        sessionId,
        name,
        revision,
        openedAt: new Date().toISOString(),
      });
      return {
        sessionId,
        name,
        bytes,
        size: info.size,
        modified: info.mtime.toISOString(),
        revision,
      };
    },

    getSession(sessionId) {
      const { name, revision, openedAt } = requireSession(sessionId);
      return { sessionId, name, revision, openedAt };
    },

    listSessions() {
      return [...sessions.values()].map(({ sessionId, name, revision, openedAt }) => ({
        sessionId,
        name,
        revision,
        openedAt,
      }));
    },

    closeSession(sessionId) {
      requireSession(sessionId);
      sessions.delete(sessionId);
    },

    async saveSession(sessionId, bytes) {
      const session = requireSession(sessionId);
      const saved = await save(session.name, bytes, session.revision);
      session.revision = saved.revision;
      return saved;
    },

    save,
    validate,
    writeScreenshot,
    captureScreenshot,
  };
}
