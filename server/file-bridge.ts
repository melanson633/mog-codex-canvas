/**
 * Local file bridge for the Mog canvas.
 *
 * The Mog embed runs in the browser and never touches disk itself: it hands the
 * host XLSX bytes on save (`onSaveRequest`) and expects the host to persist them.
 * This Vite middleware is that host — it is the only component with disk access,
 * and it is confined to a single workbook root directory. Every client-supplied
 * path goes through the containment policy in ./path-policy, which is
 * load-bearing: these endpoints serve real local disk.
 *
 * Writes are staged rather than overwritten in place (see `replaceFile` below),
 * so a save that dies partway through cannot leave the workbook truncated or
 * missing — the file at the target path is always a complete workbook.
 *
 * Endpoints (all under /api, bound to 127.0.0.1 by the dev server):
 *   GET  /api/config            -> { root, files }
 *   GET  /api/workbook?path=    -> raw xlsx bytes
 *   PUT  /api/workbook?path=    -> write xlsx bytes (previous file kept as .bak)
 *   PUT  /api/screenshot?path=  -> write png bytes
 *   POST /api/validate?path=    -> headless @mog-sdk/sdk read-back of the saved file
 */
import { copyFile, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  WORKBOOK_EXTENSION,
  canonicalizeRoot,
  resolveReadTarget,
  resolveSaveTarget,
} from './path-policy.ts'; // explicit extension: the bridge is loaded by `node --test` as well as by Vite

export interface FileBridgeOptions {
  /** Directory that holds the workbooks the canvas may open and save. */
  readonly root: string;
}

export interface WorkbookEntry {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
}

interface SheetSummary {
  readonly name: string;
  readonly summary: string;
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

export interface ReplaceResult {
  readonly file: string;
  readonly bytes: number;
  readonly backup: string | null;
}

/** Unique within a process; the pid keeps two dev servers on one root apart. */
let stagedCount = 0;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    throw new Error(
      `Could not write ${file}: ${reason(error)}. ` +
        (present ? 'The file on disk was not changed by this save.' : 'No file was written.'),
    );
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listWorkbooks(root: string): Promise<WorkbookEntry[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const entries: WorkbookEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(WORKBOOK_EXTENSION) || name.startsWith('~$')) continue;
    const info = await stat(join(root, name));
    entries.push({ name, size: info.size, modified: info.mtime.toISOString() });
  }
  return entries.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Reopens a saved workbook with the headless engine and reads it back.
 * This is the same verification lane the CLI/agent side uses, exposed to the UI
 * so a canvas save can be confirmed against the file that actually landed.
 */
async function validateWorkbook(file: string): Promise<unknown> {
  // The /node subpath forces the native binding; the bare specifier resolves to
  // the browser WASM build under bundler resolution, which has no file-path API.
  const { createWorkbook } = await import('@mog-sdk/sdk/node');
  const wb = await createWorkbook(file);
  try {
    const sheets: SheetSummary[] = [];
    for (const name of wb.sheetNames) {
      const { sheet } = await wb.getOrCreateSheet(name);
      sheets.push({ name, summary: await sheet.summarize() });
    }
    const info = await stat(file);
    return {
      file,
      bytes: info.size,
      modified: info.mtime.toISOString(),
      sheetNames: wb.sheetNames,
      sheets,
    };
  } finally {
    await wb.dispose();
  }
}

/** Connect-style middleware, so the endpoints can be driven without a Vite server. */
export type BridgeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => Promise<void>;

/**
 * Builds the /api handler over one workbook root. The root is canonicalized
 * here, at construction: without a resolvable root there is no containment
 * boundary, and the bridge must not come up at all.
 */
export function createBridgeHandler(options: FileBridgeOptions): BridgeHandler {
  const root = canonicalizeRoot(options.root);

  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();

    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { root, files: await listWorkbooks(root) });
      }

      if (url.pathname === '/api/workbook' && req.method === 'GET') {
        const file = await resolveReadTarget(root, url.searchParams.get('path'), 'workbook');
        const bytes = await readFile(file);
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-length': String(bytes.byteLength),
          'cache-control': 'no-store',
        });
        res.end(bytes);
        return;
      }

      if (url.pathname === '/api/workbook' && req.method === 'PUT') {
        const file = await resolveSaveTarget(root, url.searchParams.get('path'), 'workbook');
        const bytes = await readBody(req);
        if (bytes.byteLength === 0) throw new Error('Refusing to write an empty workbook');
        const saved = await replaceFile(file, bytes, { backup: true });
        return sendJson(res, 200, { ...saved, versionId: new Date().toISOString() });
      }

      if (url.pathname === '/api/screenshot' && req.method === 'PUT') {
        const file = await resolveSaveTarget(root, url.searchParams.get('path'), 'screenshot');
        const saved = await replaceFile(file, await readBody(req), { backup: false });
        return sendJson(res, 200, { file: saved.file, bytes: saved.bytes });
      }

      if (url.pathname === '/api/validate' && req.method === 'POST') {
        const file = await resolveReadTarget(root, url.searchParams.get('path'), 'workbook');
        return sendJson(res, 200, await validateWorkbook(file));
      }

      return sendJson(res, 404, { error: `No such endpoint: ${req.method} ${url.pathname}` });
    } catch (error) {
      return sendJson(res, 400, { error: reason(error) });
    }
  };
}

export function fileBridge(options: FileBridgeOptions): Plugin {
  const handler = createBridgeHandler(options);
  return {
    name: 'mog-companion-file-bridge',
    configureServer(server) {
      server.middlewares.use(handler);
    },
  };
}
