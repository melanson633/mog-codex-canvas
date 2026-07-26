/**
 * MCP protocol check for the Mog Canvas server — no browser involved.
 *
 *   node scripts/mcp-check.mjs
 *
 * Spawns the real server (server/mcp/index.ts) over stdio exactly as a host
 * would, against a disposable copy of the sample workbook, and drives the full
 * tool surface with the official client from @modelcontextprotocol/sdk:
 *
 *   1. initialize + tools/list + resources/list
 *   2. the ui:// resource: media type, MCP Apps CSP metadata, bootstrap HTML
 *   3. the asset host: bundle, wasm, css reachable at the declared origin
 *   4. open -> fetch bytes -> edit (headless engine) -> save -> validate
 *   5. screenshot via tool
 *   6. containment: traversal + absolute-path selectors rejected
 *   7. concurrency: a stale session save is refused and preserved
 *   8. close session
 *
 * Exit code 0 only if every check passes. This proves the protocol surface;
 * it says nothing about any particular host's rendering.
 */
import { mkdtemp, rm, copyFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDist = join(repoRoot, 'plugins', 'mog-canvas', 'ui', 'dist');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error?.stack ?? error}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

/** Tool results carry errors as isError + JSON text, never as exceptions. */
function unwrap(result) {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text')?.text ?? 'tool failed';
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
    const error = new Error(body.message ?? text);
    error.code = body.code;
    error.details = body;
    throw error;
  }
  return result.structuredContent ?? {};
}

async function expectToolError(promise, code) {
  let result;
  try {
    result = await promise;
  } catch (error) {
    throw new Error(`expected isError result with code ${code}, got thrown ${error}`);
  }
  expect(result.isError === true, `expected isError, got ${JSON.stringify(result)}`);
  const body = JSON.parse(result.content.find((c) => c.type === 'text').text);
  expect(body.code === code, `expected code ${code}, got ${body.code}: ${body.message}`);
  return body;
}

// ---- Fixture root -----------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'mog-mcp-check-'));
await copyFile(join(repoRoot, 'workbooks', 'sample.xlsx'), join(root, 'sample.xlsx'));

const client = new Client({ name: 'mcp-check', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, 'server', 'mcp', 'index.ts')],
  env: { ...process.env, MOG_WORKBOOK_DIR: root, MOG_UI_DIST: uiDist },
  stderr: 'pipe',
});
const serverLog = [];
transport.stderr?.on('data', (chunk) => serverLog.push(String(chunk)));

try {
  await check('server starts and completes initialize over stdio', async () => {
    await client.connect(transport);
    const version = client.getServerVersion();
    expect(version?.name === 'mog-canvas', `unexpected server: ${JSON.stringify(version)}`);
    return `server ${version.name}@${version.version}`;
  });

  let assetOrigin;
  await check('ui:// resource is listed with MCP Apps metadata', async () => {
    const { resources } = await client.listResources();
    const ui = resources.find((r) => r.uri === 'ui://mog-canvas/canvas.html');
    expect(ui, 'ui://mog-canvas/canvas.html not in resources/list');
    expect(
      ui.mimeType === 'text/html;profile=mcp-app',
      `mimeType ${ui.mimeType} != text/html;profile=mcp-app`,
    );
    const csp = ui._meta?.ui?.csp;
    expect(csp?.connectDomains?.length === 1, 'connectDomains missing from _meta.ui.csp');
    expect(
      csp.resourceDomains?.[0] === csp.connectDomains[0],
      'resourceDomains should match connectDomains',
    );
    assetOrigin = csp.connectDomains[0];
    expect(
      /^http:\/\/127\.0\.0\.1:\d+$/.test(assetOrigin),
      `asset origin should be loopback, got ${assetOrigin}`,
    );
    return `csp origin ${assetOrigin}`;
  });

  await check('resources/read returns the bootstrap document', async () => {
    const { contents } = await client.readResource({ uri: 'ui://mog-canvas/canvas.html' });
    const [doc] = contents;
    expect(doc.mimeType === 'text/html;profile=mcp-app', `mimeType ${doc.mimeType}`);
    expect(doc._meta?.ui?.csp, 'content item missing _meta.ui.csp');
    expect(doc.text.includes(`${assetOrigin}/ui/mcp-app.js`), 'bootstrap must load mcp-app.js');
    expect(doc.text.includes(`${assetOrigin}/ui/mcp-app.css`), 'bootstrap must link mcp-app.css');
    return `${doc.text.length} chars`;
  });

  await check('asset host serves the production bundle at the declared origin', async () => {
    const js = await fetch(`${assetOrigin}/ui/mcp-app.js`);
    expect(js.ok && (await js.text()).length > 10_000, 'mcp-app.js not served');
    const css = await fetch(`${assetOrigin}/ui/mcp-app.css`);
    expect(css.ok, 'mcp-app.css not served');
    expect(
      (css.headers.get('content-type') ?? '').startsWith('text/css'),
      `css content-type ${css.headers.get('content-type')}`,
    );
    // The wasm the bundle actually references (hashed asset inside dist).
    const escape = await fetch(`${assetOrigin}/ui/../server/index.ts`);
    expect(escape.status === 403 || escape.status === 404, `escape got ${escape.status}`);
    return 'js + css served, traversal refused';
  });

  await check('bundled wasm is served as application/wasm', async () => {
    const listing = await fetch(`${assetOrigin}/ui/mcp-app.js`).then((r) => r.text());
    // Entry or chunk references the hashed wasm; find it on disk instead of parsing.
    const { readdir } = await import('node:fs/promises');
    const assets = await readdir(join(uiDist, 'assets'));
    const wasm = assets.find((f) => f.endsWith('.wasm'));
    expect(wasm, 'no wasm asset in ui dist');
    const res = await fetch(`${assetOrigin}/ui/assets/${wasm}`, { method: 'HEAD' });
    expect(res.ok, `wasm HEAD ${res.status}`);
    expect(
      res.headers.get('content-type') === 'application/wasm',
      `wasm content-type ${res.headers.get('content-type')}`,
    );
    expect(listing.length > 0, 'unreachable');
    return `${wasm} (${res.headers.get('content-length')} bytes)`;
  });

  await check('tools/list exposes the workbook surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const required of [
      'list_workbooks',
      'open_workbook',
      'get_workbook_session',
      'save_workbook',
      'validate_workbook',
      'screenshot_workbook',
      'close_workbook_session',
      'fetch_workbook_bytes',
      'save_screenshot',
    ]) {
      expect(names.includes(required), `missing tool ${required}`);
    }
    const open = tools.find((t) => t.name === 'open_workbook');
    expect(
      open._meta?.ui?.resourceUri === 'ui://mog-canvas/canvas.html',
      'open_workbook must declare its ui resource',
    );
    return names.join(', ');
  });

  let session;
  await check('open_workbook returns a session for the sample workbook', async () => {
    const listed = unwrap(await client.callTool({ name: 'list_workbooks', arguments: {} }));
    expect(
      listed.files.some((f) => f.name === 'sample.xlsx'),
      `sample.xlsx not listed: ${JSON.stringify(listed.files)}`,
    );
    session = unwrap(
      await client.callTool({ name: 'open_workbook', arguments: { name: 'sample.xlsx' } }),
    );
    expect(session.sessionId && session.revision, `bad session ${JSON.stringify(session)}`);
    return `session ${session.sessionId.slice(0, 8)}… rev ${session.revision.slice(0, 12)}…`;
  });

  let editedB64;
  await check('fetch bytes -> headless edit -> save_workbook round-trip', async () => {
    const fetched = unwrap(
      await client.callTool({
        name: 'fetch_workbook_bytes',
        arguments: { sessionId: session.sessionId },
      }),
    );
    expect(fetched.revision === session.revision, 'fetched revision != opened revision');
    const bytes = Buffer.from(fetched.xlsxBase64, 'base64');
    expect(
      createHash('sha256').update(bytes).digest('hex') === fetched.revision,
      'revision is not the sha256 of the bytes',
    );

    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    const wb = await createWorkbook(bytes);
    let edited;
    try {
      await wb.activeSheet.setCell('A1', 'mcp-check was here');
      edited = await wb.toXlsx();
    } finally {
      await wb.dispose();
    }
    editedB64 = Buffer.from(edited).toString('base64');

    const saved = unwrap(
      await client.callTool({
        name: 'save_workbook',
        arguments: { sessionId: session.sessionId, xlsxBase64: editedB64 },
      }),
    );
    expect(saved.revision !== session.revision, 'save did not change the revision');
    expect(saved.backup === 'sample.xlsx.bak', `backup ${saved.backup}`);
    const onDisk = await readFile(join(root, 'sample.xlsx'));
    expect(
      createHash('sha256').update(onDisk).digest('hex') === saved.revision,
      'on-disk bytes do not match the reported revision',
    );
    session.revision = saved.revision;
    return `new rev ${saved.revision.slice(0, 12)}…, backup kept`;
  });

  await check('validate_workbook reopens the saved file headlessly', async () => {
    const report = unwrap(
      await client.callTool({ name: 'validate_workbook', arguments: { name: 'sample.xlsx' } }),
    );
    expect(report.revision === session.revision, 'validated revision mismatch');
    expect(Array.isArray(report.sheetNames) && report.sheetNames.length > 0, 'no sheets');
    expect(report.name === 'sample.xlsx', `report.name ${report.name} is not root-relative`);
    return `sheets: ${report.sheetNames.join(', ')}`;
  });

  await check('screenshot_workbook writes a PNG inside the root', async () => {
    const shot = unwrap(
      await client.callTool({
        name: 'screenshot_workbook',
        arguments: { name: 'sample.xlsx', range: 'A1:D10' },
      }),
    );
    const file = join(root, shot.name);
    const info = await stat(file);
    expect(info.size > 100, `png too small: ${info.size}`);
    const head = (await readFile(file)).subarray(0, 4);
    expect(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'not a PNG signature');
    return `${shot.name} (${info.size} bytes)`;
  });

  await check('outside-root selectors are rejected with invalid-path', async () => {
    for (const name of ['../sample.xlsx', 'C:\\Windows\\win.ini', '..\\..\\x.xlsx', 'a:b.xlsx']) {
      const body = await expectToolError(
        client.callTool({ name: 'open_workbook', arguments: { name } }),
        'invalid-path',
      );
      expect(!JSON.stringify(body).includes(root.replaceAll('\\', '\\\\')), 'error leaks root path');
    }
    return '4 hostile selectors refused';
  });

  await check('a stale session save is refused and preserved, never a silent winner', async () => {
    // Second session at the current revision; a save of *different* bytes
    // through it moves the file's revision out from under the first session.
    const other = unwrap(
      await client.callTool({ name: 'open_workbook', arguments: { name: 'sample.xlsx' } }),
    );
    const before = await readFile(join(root, 'sample.xlsx'));
    const newerB64 = Buffer.from('PK newer version from the other session').toString(
      'base64',
    );
    unwrap(
      await client.callTool({
        name: 'save_workbook',
        arguments: { sessionId: other.sessionId, xlsxBase64: newerB64 },
      }),
    );
    // The original session's revision is now stale.
    const staleBytes = Buffer.from('PK\u0003\u0004 stale attempt').toString('base64');
    const body = await expectToolError(
      client.callTool({
        name: 'save_workbook',
        arguments: { sessionId: session.sessionId, xlsxBase64: staleBytes },
      }),
      'revision-conflict',
    );
    expect(body.conflictFile?.startsWith('sample.conflict-'), `no conflict file: ${body.conflictFile}`);
    const conflict = await readFile(join(root, body.conflictFile));
    expect(conflict.toString().includes('stale attempt'), 'conflict file lost the attempted bytes');
    const after = await readFile(join(root, 'sample.xlsx'));
    expect(!after.equals(Buffer.from(staleBytes, 'base64')), 'stale save overwrote the file');
    expect(before.length > 0 && after.length > 0, 'workbook vanished');
    return `refused; attempt preserved as ${body.conflictFile}`;
  });

  await check('close_workbook_session ends the session', async () => {
    unwrap(
      await client.callTool({
        name: 'close_workbook_session',
        arguments: { sessionId: session.sessionId },
      }),
    );
    await expectToolError(
      client.callTool({
        name: 'get_workbook_session',
        arguments: { sessionId: session.sessionId },
      }),
      'no-such-session',
    );
    return 'closed and no longer resolvable';
  });
} finally {
  await client.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n--- server stderr ---\n' + serverLog.join(''));
  process.exit(1);
}
