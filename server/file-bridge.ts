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
 *   GET  /api/profile?path=     -> byte-first shape profile of the saved file
 *        (engine-free; provenance-labeled "as-saved at revision …")
 *   PUT  /api/workbook?path=[&expectedRevision=] -> write xlsx bytes
 *        (previous file kept as .bak; a stale expectedRevision is refused and
 *         the attempted bytes are preserved as a .conflict-*.xlsx sibling)
 *   PUT  /api/screenshot?path=  -> write png bytes
 *   POST /api/validate?path=    -> headless @mog-sdk/sdk read-back of the saved file
 *
 * Flight recorder (read-only evidence):
 *   GET  /api/recovery                 -> typed recovery artifacts in the root
 *   GET  /api/recovery/file?path=      -> bytes of one backup/preserved sibling
 *   GET  /api/receipts                 -> save-receipt summaries
 *   GET  /api/receipt?id=<uuid>        -> one full save receipt
 *
 * Canvas context bus (ephemeral, in-memory):
 *   GET    /api/context?path=          -> latest canvas context or null
 *   POST   /api/context?path=          -> canvas reports presence (epoch/sequence gated)
 *   DELETE /api/context?path=&epoch=   -> canvas teardown
 *   POST   /api/context/reveal?path=   -> queue a navigation-only reveal command
 *   GET    /api/context/commands?path= -> drain pending commands (canvas polls this)
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
    case 'fidelity-mismatch':
    case 'occupied-cell-conflict':
      return 409;
    case 'touched-ranges-required':
      return 422;
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

      if (url.pathname === '/api/profile' && req.method === 'GET') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        // Byte-first shape read: milliseconds, engine-free, truth of the last
        // save. This is what the app renders while the canvas hydrates.
        return sendJson(res, 200, await service.profile(name));
      }

      if (url.pathname === '/api/workbook' && req.method === 'PUT') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const bytes = await readBody(req);
        const expected = url.searchParams.get('expectedRevision') ?? undefined;
        // The dev bridge serves exactly one caller: the human canvas in the dev
        // app. Attribution is fixed here, never taken from the request — query
        // params could claim any actor, and actor identity gates the
        // occupied-cell interlock. Agents save through the MCP or headless
        // lanes, which attribute themselves in trusted process code.
        const saved = await service.save(name, bytes, expected, {
          lane: 'canvas',
          actor: { kind: 'human', id: 'dev-canvas' },
        });
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

      // ---- Flight recorder (read-only) ----

      if (url.pathname === '/api/recovery' && req.method === 'GET') {
        return sendJson(res, 200, { artifacts: await service.listRecoveryArtifacts() });
      }

      if (url.pathname === '/api/recovery/file' && req.method === 'GET') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const { bytes, revision } = await service.readRecoveryArtifact(name);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'cache-control': 'no-store',
          'x-workbook-revision': revision,
        });
        res.end(Buffer.from(bytes));
        return;
      }

      if (url.pathname === '/api/receipts' && req.method === 'GET') {
        return sendJson(res, 200, { receipts: await service.listReceipts() });
      }

      if (url.pathname === '/api/receipt' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) throw new WorkbookError('invalid-path', 'Missing "id" query parameter');
        return sendJson(res, 200, await service.getReceipt(id));
      }

      // ---- Canvas context bus (ephemeral) ----

      if (url.pathname === '/api/context' && req.method === 'GET') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        return sendJson(res, 200, { context: service.context.get(name) });
      }

      if (url.pathname === '/api/context' && req.method === 'POST') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const update = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<
          string,
          unknown
        >;
        if (typeof update.epoch !== 'number' || typeof update.sequence !== 'number') {
          return sendJson(res, 400, { error: 'Context reports need numeric epoch and sequence' });
        }
        const result = service.context.report(name, {
          epoch: update.epoch,
          sequence: update.sequence,
          activeSheet: typeof update.activeSheet === 'string' ? update.activeSheet : null,
          selection: typeof update.selection === 'string' ? update.selection : null,
          occupiedCell: typeof update.occupiedCell === 'string' ? update.occupiedCell : null,
          focused: update.focused === true,
          dirty: update.dirty === true,
        });
        return sendJson(res, result.accepted ? 200 : 409, result);
      }

      if (url.pathname === '/api/context' && req.method === 'DELETE') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const rawEpoch = url.searchParams.get('epoch');
        const epoch = rawEpoch === null || rawEpoch.trim() === '' ? NaN : Number(rawEpoch);
        if (!Number.isFinite(epoch)) {
          // A teardown without a provable epoch could clear a newer canvas's
          // state; refuse it rather than guessing.
          return sendJson(res, 400, {
            error: 'Context teardown needs the owning canvas epoch as a finite "epoch" parameter',
          });
        }
        service.context.clear(name, epoch);
        return sendJson(res, 200, { cleared: true });
      }

      if (url.pathname === '/api/context/reveal' && req.method === 'POST') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<
          string,
          unknown
        >;
        if (typeof body.range !== 'string' || body.range.length === 0) {
          return sendJson(res, 400, { error: 'A reveal needs a "range"' });
        }
        const command = service.context.requestReveal(
          name,
          body.range,
          typeof body.sheet === 'string' ? body.sheet : null,
        );
        return sendJson(res, 200, { command });
      }

      if (url.pathname === '/api/context/commands' && req.method === 'GET') {
        if (!name) throw new WorkbookError('invalid-path', 'Missing "path" query parameter');
        return sendJson(res, 200, { commands: service.context.drainCommands(name) });
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
