/**
 * Loopback static asset host for the MCP Apps canvas.
 *
 * The Mog embed is far too large to inline into the MCP Apps HTML resource
 * (~19 MB JS + ~41 MB WASM + fonts), so the MCP server runs this sibling HTTP
 * server on 127.0.0.1 and declares its origin in the resource's CSP metadata
 * (`connectDomains` + `resourceDomains`). It serves exactly two trees, both
 * read-only and both public npm-package content — never workbook data, which
 * flows only through MCP tools:
 *
 *   /ui/...   the production-built canvas component (dist of vite.mcp-app)
 *   /mog/...  the embed runtime out of node_modules (wasm, fonts)
 *
 * Plus one special case: any path ending in /compute_core_wasm_bg.wasm is the
 * wasm-bindgen loader resolving against its own import.meta.url; answer it
 * from the embed dist no matter which directory it thinks it lives in.
 *
 * CORS is wide open (`*`) by design: the component's iframe runs on a
 * host-chosen sandbox origin that cannot be known in advance, module scripts
 * and wasm fetches are CORS-gated, and nothing served here is private.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const WASM_FILE = 'compute_core_wasm_bg.wasm';

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** dist/ of the installed @mog-sdk/spreadsheet-app (./package.json is not exported). */
export function resolveEmbedDist(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@mog-sdk/spreadsheet-app/styles.css'));
}

function containedJoin(root: string, requestPath: string): string | null {
  const target = resolve(root, requestPath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) return null;
  return target;
}

export interface AssetHost {
  /** e.g. "http://127.0.0.1:52731" — allocate-on-listen, never a fixed port. */
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface AssetHostOptions {
  /** Directory holding the built canvas component (mcp-app.js / mcp-app.css). */
  readonly uiDist: string;
}

export async function startAssetHost(options: AssetHostOptions): Promise<AssetHost> {
  const uiDist = resolve(options.uiDist);
  const embedDist = resolveEmbedDist();

  const server: Server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    let file: string | null = null;
    if (pathname.endsWith(`/${WASM_FILE}`)) {
      file = join(embedDist, WASM_FILE);
    } else if (pathname.startsWith('/ui/')) {
      file = containedJoin(uiDist, pathname.slice('/ui/'.length));
    } else if (pathname.startsWith('/mog/')) {
      file = containedJoin(embedDist, pathname.slice('/mog/'.length));
    }

    if (!file) {
      res.writeHead(pathname.startsWith('/ui/') || pathname.startsWith('/mog/') ? 403 : 404, {
        'access-control-allow-origin': '*',
      });
      res.end();
      return;
    }

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }

    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok()))),
  };
}
