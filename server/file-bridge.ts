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
 * Endpoints (all under /api, bound to 127.0.0.1 by the dev server):
 *   GET  /api/config            -> { root, files }
 *   GET  /api/workbook?path=    -> raw xlsx bytes
 *   PUT  /api/workbook?path=    -> write xlsx bytes (previous file kept as .bak)
 *   PUT  /api/screenshot?path=  -> write png bytes
 *   POST /api/validate?path=    -> headless @mog-sdk/sdk read-back of the saved file
 */
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  WORKBOOK_EXTENSION,
  canonicalizeRoot,
  resolveReadTarget,
  resolveSaveTarget,
} from './path-policy';

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

export function fileBridge(options: FileBridgeOptions): Plugin {
  const root = canonicalizeRoot(options.root);

  return {
    name: 'mog-companion-file-bridge',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
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
            return res.end(bytes);
          }

          if (url.pathname === '/api/workbook' && req.method === 'PUT') {
            const file = await resolveSaveTarget(root, url.searchParams.get('path'), 'workbook');
            const bytes = await readBody(req);
            if (bytes.byteLength === 0) throw new Error('Refusing to write an empty workbook');
            const previous = await stat(file).catch(() => null);
            if (previous) await rename(file, `${file}.bak`);
            await writeFile(file, bytes);
            return sendJson(res, 200, {
              file,
              bytes: bytes.byteLength,
              backup: previous ? `${file}.bak` : null,
              versionId: new Date().toISOString(),
            });
          }

          if (url.pathname === '/api/screenshot' && req.method === 'PUT') {
            const file = await resolveSaveTarget(root, url.searchParams.get('path'), 'screenshot');
            const bytes = await readBody(req);
            await writeFile(file, bytes);
            return sendJson(res, 200, { file, bytes: bytes.byteLength });
          }

          if (url.pathname === '/api/validate' && req.method === 'POST') {
            const file = await resolveReadTarget(root, url.searchParams.get('path'), 'workbook');
            return sendJson(res, 200, await validateWorkbook(file));
          }

          return sendJson(res, 404, { error: `No such endpoint: ${req.method} ${url.pathname}` });
        } catch (error) {
          return sendJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
