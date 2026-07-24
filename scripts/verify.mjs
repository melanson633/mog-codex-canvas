/**
 * End-to-end check of the host half of the app, without a browser.
 *
 *   1. headless engine: formula compute, save, reopen, read-back, screenshot
 *   2. dev server: runtime assets on both wasm URL shapes
 *   3. file bridge: config / read / write / validate
 *
 *   node scripts/verify.mjs
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbook } from '@mog-sdk/sdk';
import { createServer } from 'vite';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(projectRoot, 'workbooks/.verify');
const scratchFile = resolve(scratch, 'verify.xlsx');

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

// 1. headless engine round-trip
await mkdir(scratch, { recursive: true });
const wb = await createWorkbook();
try {
  const ws = wb.activeSheet;
  await ws.setCell('A1', 10);
  await ws.setCell('A2', 32);
  await ws.setCell('A3', '=SUM(A1:A2)');
  check('headless formula compute', (await ws.getValue('A3')) === 42, 'A3 = SUM(10,32)');
  await wb.save(scratchFile);
} finally {
  await wb.dispose();
}

const reopened = await createWorkbook(scratchFile);
try {
  check('saved workbook reopens', reopened.sheetNames.length > 0, reopened.sheetNames.join(','));
  check(
    'value survives xlsx round-trip',
    (await reopened.activeSheet.getValue('A3')) === 42,
  );
  const png = await reopened.captureScreenshot(reopened.activeSheet, 'A1:A3', { dpr: 1 });
  const isPng = Buffer.from(png.slice(0, 4)).toString('hex') === '89504e47';
  check('headless screenshot returns PNG', isPng, `${png.length} bytes`);
} finally {
  await reopened.dispose();
}

// 2 + 3. runtime assets and file bridge over the real dev server
const server = await createServer({
  root: projectRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5274, strictPort: true },
  // Only the /api endpoints are under test here. Dependency pre-bundling would
  // still be scanning the 19 MB embed when this script closes the server.
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  await server.listen();
  const base = 'http://127.0.0.1:5274';

  // Both URL shapes must return real wasm. The second one is the trap: the
  // bundled wasm-bindgen loader asks for it next to the bundle, and without the
  // mog-assets plugin Vite's SPA fallback answers 200 text/html, which the
  // browser reports as "expected magic word".
  for (const path of [
    '/mog/compute_core_wasm_bg.wasm',
    '/node_modules/.vite/deps/compute_core_wasm_bg.wasm',
  ]) {
    const head = await fetch(`${base}${path}`, { method: 'HEAD' });
    check(
      `wasm served at ${path}`,
      head.status === 200 && head.headers.get('content-type') === 'application/wasm',
      `${head.status} ${head.headers.get('content-type')} ${head.headers.get('content-length')} bytes`,
    );
  }

  const font = await fetch(`${base}/mog/assets/Carlito-Regular.ttf`, { method: 'HEAD' });
  check('embed font served', font.status === 200, `status ${font.status}`);

  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  check('GET /api/config', typeof config.root === 'string' && Array.isArray(config.files));

  const escape = await fetch(`${base}/api/workbook?path=${encodeURIComponent('../package.json')}`);
  check('path traversal rejected', escape.status === 400, `status ${escape.status}`);

  const bytes = await createXlsxBytes();
  const written = await fetch(`${base}/api/workbook?path=.verify/bridge.xlsx`, {
    method: 'PUT',
    body: bytes,
  }).then((r) => r.json());
  check('PUT /api/workbook writes bytes', written.bytes === bytes.byteLength, `${written.bytes} bytes`);

  const readBack = await fetch(`${base}/api/workbook?path=.verify/bridge.xlsx`);
  const readBytes = new Uint8Array(await readBack.arrayBuffer());
  check('GET /api/workbook returns same size', readBytes.byteLength === bytes.byteLength);

  const report = await fetch(`${base}/api/validate?path=.verify/bridge.xlsx`, {
    method: 'POST',
  }).then((r) => r.json());
  check(
    'POST /api/validate reads the saved file',
    Array.isArray(report.sheetNames) && report.sheets?.[0]?.summary?.includes('Used Range'),
    report.sheetNames?.join(','),
  );
} finally {
  await server.close();
}

await rm(scratch, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

async function createXlsxBytes() {
  const book = await createWorkbook();
  try {
    await book.activeSheet.setCell('A1', 'bridge');
    return await book.toXlsx();
  } finally {
    await book.dispose();
  }
}
