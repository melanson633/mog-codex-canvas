/**
 * Serves the Mog embed's runtime assets straight out of node_modules.
 *
 * The embed needs its compute-core WASM (~41 MB) and bundled fonts over HTTP.
 * It asks for them two different ways, and both have to work:
 *
 *   1. `/mog/...` — the URLs we declare via the runtime `assets` policy.
 *   2. `<wherever the bundle lives>/compute_core_wasm_bg.wasm` — the wasm-bindgen
 *      loader inside the bundle resolves this against its own `import.meta.url`,
 *      ignoring the asset policy. Under Vite that lands on
 *      `/node_modules/.vite/deps/compute_core_wasm_bg.wasm`, which would
 *      otherwise hit the SPA fallback and return index.html with status 200 —
 *      surfacing as "WebAssembly.instantiate(): expected magic word".
 *
 * Upstream's VS Code integration never hits case 2 because its build copies the
 * wasm next to the bundle, making both paths the same directory. A Vite dev
 * server has no such coincidence, so this plugin answers both.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const WASM_FILE = 'compute_core_wasm_bg.wasm';

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** dist/ of the installed @mog-sdk/spreadsheet-app (./package.json is not exported). */
function resolveEmbedDist(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@mog-sdk/spreadsheet-app/styles.css'));
}

export function mogAssets(): Plugin {
  const dist = resolveEmbedDist();

  return {
    name: 'mog-runtime-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

        let file: string | null = null;
        if (pathname.endsWith(`/${WASM_FILE}`)) {
          file = join(dist, WASM_FILE);
        } else if (pathname.startsWith('/mog/')) {
          const target = resolve(dist, pathname.slice('/mog/'.length));
          const rel = relative(dist, target);
          if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
            res.writeHead(403).end('Forbidden');
            return;
          }
          file = target;
        }

        if (!file) return next();

        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return next();

        res.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
          'content-length': String(info.size),
          'cache-control': 'no-cache',
        });
        createReadStream(file).pipe(res);
      });
    },
  };
}
