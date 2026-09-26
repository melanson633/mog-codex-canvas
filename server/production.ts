import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeHandler } from './file-bridge.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
export interface ProductionOptions { root: string; dist?: string; release?: string }

/** Loopback-only production HTTP host. Workbook I/O belongs to the shared bridge. */
export function createProductionServer(options: ProductionOptions) {
  const bridge = createBridgeHandler({ root: options.root });
  const dist = resolve(options.dist ?? resolve(project, 'dist'));
  const embed = dirname(createRequire(import.meta.url).resolve('@mog-sdk/spreadsheet-app/styles.css'));
  return createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    const address = req.socket.localAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') { res.writeHead(403).end('Loopback only'); return; }
    const port = req.socket.localPort;
    const validHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const host = req.headers.host ?? '';
    if (!validHosts.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)
      || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end('Origin rejected'); return; }
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok', mode: 'production', release: options.release ?? 'local' })); return;
      }
      if (url.pathname.startsWith('/api/')) {
        await bridge(req, res, () => { res.writeHead(404).end('Not found'); }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.includes(':')) { res.writeHead(403).end('Forbidden'); return; }
      let root = dist;
      let target = pathname === '/' ? 'analyst.html' : pathname.slice(1);
      if (pathname.endsWith('/compute_core_wasm_bg.wasm')) { root = embed; target = 'compute_core_wasm_bg.wasm'; }
      else if (pathname.startsWith('/mog/')) { root = embed; target = pathname.slice(5); }
      const candidate = resolve(root, target);
      const canonicalRoot = await realpath(root);
      const canonical = await realpath(candidate).catch(() => null);
      if (!canonical) { res.writeHead(404).end('Not found'); return; }
      const rel = relative(canonicalRoot, canonical);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403).end('Forbidden'); return; }
      const info = await stat(canonical);
      if (!info.isFile()) { res.writeHead(404).end('Not found'); return; }
      // Engine assets include a large WASM binary. Keep no-cache semantics so
      // an SDK update at the stable /mog/ URL is never used stale, but give
      // browsers a validator so a warm open costs a 304 instead of 41 MB.
      const etag = `W/\"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}\"`;
      const lastModified = info.mtime.toUTCString();
      const notModified = matchesValidator(req.headers, etag, info.mtimeMs);
      const headers = {
        'content-type': types[extname(canonical)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': root === dist && /[.-][A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(target) ? 'public, max-age=31536000, immutable' : 'no-cache',
        etag,
        'last-modified': lastModified,
      };
      if (notModified) { res.writeHead(304, headers).end(); return; }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else createReadStream(canonical).on('error', () => res.destroy()).pipe(res);
    } catch { if (!res.headersSent) res.writeHead(400).end('Invalid request'); else res.destroy(); }
  });
}

/** RFC 9110 validators for static bytes. If-None-Match takes precedence. */
function matchesValidator(headers: Record<string, string | string[] | undefined>, etag: string, mtimeMs: number) {
  const noneMatch = headers['if-none-match'];
  if (typeof noneMatch === 'string') {
    return noneMatch.split(',').some((value) => value.trim() === '*' || value.trim() === etag);
  }
  const modifiedSince = headers['if-modified-since'];
  if (typeof modifiedSince !== 'string') return false;
  const timestamp = Date.parse(modifiedSince);
  return Number.isFinite(timestamp) && Math.floor(mtimeMs / 1_000) <= Math.floor(timestamp / 1_000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5276);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createProductionServer({ root: process.env.MOG_WORKBOOK_DIR ?? resolve(project, 'workbooks'), dist: process.env.MOG_DIST_DIR, release: process.env.MOG_RELEASE });
  server.listen(port, '127.0.0.1', () => console.log(`Mog production: http://127.0.0.1:${port}`));
}
