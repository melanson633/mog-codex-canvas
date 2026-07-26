/**
 * Local HTTP file bridge for the Mog canvas dev app.
 *
 * The Mog embed runs in the browser and never touches disk itself: it hands the
 * host XLSX bytes on save (`onSaveRequest`) and expects the host to persist them.
 * This Vite middleware is that host — a thin HTTP skin over the shared
 * workbook service in ./workbook-service, which owns containment, staged
 * writes, revision identity, and validation for every lane (dev app, MCP
 * server, headless scripts). Nothing here may touch disk on its own.
 *
 * Endpoints (all under /api, bound to 127.0.0.1 by the dev server):
 *   GET  /api/config            -> { root, files }
 *   GET  /api/workbook?path=    -> raw xlsx bytes (+ x-workbook-revision header)
 *   PUT  /api/workbook?path=[&expectedRevision=] -> write xlsx bytes
 *        (previous file kept as .bak; a stale expectedRevision is refused and
 *         the attempted bytes are preserved as a .conflict-*.xlsx sibling)
 *   PUT  /api/screenshot?path=  -> write png bytes
 *   POST /api/validate?path=    -> headless @mog-sdk/sdk read-back of the saved file
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  WorkbookError,
  createWorkbookService,
} from './workbook-service.ts'; // explicit extension: the bridge is loaded by `node --test` as well as by Vite

export { replaceFile, type ReplaceOptions, type ReplaceResult } from './workbook-service.ts';
export type { WorkbookEntry } from './workbook-service.ts';

export interface FileBridgeOptions {
  /** Directory that holds the workbooks the canvas may open and save. */
  readonly root: string;
}

function statusFor(error: unknown): number {
  if (!(error instanceof WorkbookError)) return 400;
  switch (error.code) {
    case 'not-found':
      return 404;
    case 'revision-conflict':
      return 409;
    case 'write-failed':
    case 'validation-failed':
      return 500;
    default:
      return 400;
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

/** Connect-style middleware, so the endpoints can be driven without a Vite server. */
export type BridgeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => Promise<void>;

/**
 * Builds the /api handler over one workbook root. The shared service
 * canonicalizes the root at construction: without a resolvable root there is
 * no containment boundary, and the bridge must not come up at all.
 */
export function createBridgeHandler(options: FileBridgeOptions): BridgeHandler {
  const service = createWorkbookService({ root: options.root });

  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    const name = url.searchParams.get('path');

    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { root: service.root, files: await service.list() });
      }

      if (url.pathname === '/api/workbook' && req.method === 'GET') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const { bytes, revision } = await service.read(name);
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-length': String(bytes.byteLength),
          'cache-control': 'no-store',
          'x-workbook-revision': revision,
        });
        res.end(Buffer.from(bytes));
        return;
      }

      if (url.pathname === '/api/workbook' && req.method === 'PUT') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const bytes = await readBody(req);
        const expected = url.searchParams.get('expectedRevision') ?? undefined;
        const saved = await service.save(name, bytes, expected);
        // versionId doubles as the revision the canvas should base its next save on.
        return sendJson(res, 200, { ...saved, file: saved.name, versionId: saved.revision });
      }

      if (url.pathname === '/api/screenshot' && req.method === 'PUT') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const saved = await service.writeScreenshot(name, await readBody(req));
        return sendJson(res, 200, saved);
      }

      if (url.pathname === '/api/validate' && req.method === 'POST') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        return sendJson(res, 200, await service.validate(name));
      }

      return sendJson(res, 404, { error: `No such endpoint: ${req.method} ${url.pathname}` });
    } catch (error) {
      const body =
        error instanceof WorkbookError
          ? { error: error.message, code: error.code, ...error.details }
          : { error: error instanceof Error ? error.message : String(error) };
      return sendJson(res, statusFor(error), body);
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
