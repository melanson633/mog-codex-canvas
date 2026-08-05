/**
 * MCP Apps in-iframe smoke test — the Phase 1 host gate.
 *
 *   node scripts/mcp-app-smoke.mjs
 *
 * mcp-check.mjs proves the protocol surface; this proves the part no protocol
 * check can: that the real @mog-sdk/spreadsheet-app canvas renders, edits, and
 * saves *inside a sandboxed iframe under the MCP Apps resource + CSP model*.
 *
 * The harness plays the host role exactly as SEP-1865 describes it:
 *
 *   - spawns the real MCP server over stdio against a disposable workbook root
 *   - reads the ui:// resource and embeds its HTML in an iframe with
 *     sandbox="allow-scripts" (opaque origin, like a real host)
 *   - enforces a spec-shaped Content-Security-Policy via an injected meta tag,
 *     built only from the resource's declared csp domains — first WITHOUT
 *     'wasm-unsafe-eval' (the spec does not grant it), and only if that fails,
 *     again WITH it, reporting both outcomes
 *   - answers ui/initialize, sends ui/notifications/tool-result with the real
 *     open_workbook result, and proxies the app's tools/call requests to the
 *     server — plain JSON-RPC over postMessage, same as ext-apps' transport
 *
 * A probe script injected into the frame (allowed by the same 'unsafe-inline'
 * the spec CSP grants) relays DOM state and CSP violations to the host page,
 * so every assertion runs against the main frame even if the sandboxed iframe
 * is isolated into its own process. Input (cell click, typing) is dispatched
 * through CDP, which routes through the browser's real input pipeline.
 *
 * What a pass here still does NOT prove: rendering inside a real host. That
 * requires installing the plugin, which is a separate, user-approved step —
 * see the host test procedure in docs/CLAUDE-CODE-PLUGIN.md.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbook } from '@mog-sdk/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveBrowserExecutable } from './browser-executable.mjs';
import { ensureFreshBundle } from './ui-bundle.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDist = join(repoRoot, 'plugins', 'mog-canvas', 'ui', 'dist');
const shotPath = join(repoRoot, 'workbooks', 'mcp-app-smoke.png');

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

function unwrap(result) {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text')?.text ?? 'tool failed';
    throw new Error(`tool error: ${text}`);
  }
  return result.structuredContent ?? {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Preflight: what is already listening? ----------------------------------
// Everything this harness talks to is spawned by this run and verified by
// content (the asset origin must serve byte-identical files to this worktree's
// dist). The listener survey is context for the log: it shows what else was
// live, so a port collision or a stray dev server is visible in the evidence.
if (process.platform === 'win32') {
  try {
    const { stdout } = await promisify(execFile)('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
    });
    const listeners = stdout
      .split(/\r?\n/)
      .filter((line) => line.includes('LISTENING') && line.includes('127.0.0.1'));
    console.log(`preflight: ${listeners.length} loopback TCP listeners before start`);
  } catch {
    console.log('preflight: netstat unavailable, skipping listener survey');
  }
}

// ---- Preflight: is the bundle this run drives the current source? ------------
// The dist is a gitignored artifact, so a clone has none and a pull that touches
// src/ leaves a stale one. Driving it would make this harness report on code
// that is not the code in the checkout — and the symptom is a four-minute
// timeout naming the CSP frame, not the bundle.
await ensureFreshBundle();

// ---- Fixture: disposable copy of the sample workbook -------------------------

const root = await mkdtemp(join(tmpdir(), 'mog-app-smoke-'));
await copyFile(join(repoRoot, 'workbooks', 'sample.xlsx'), join(root, 'sample.xlsx'));

async function readA6() {
  const book = await createWorkbook(join(root, 'sample.xlsx'));
  try {
    return await book.activeSheet.getValue('A6');
  } finally {
    await book.dispose();
  }
}
const before = await readA6();
const typed = String(before) === '4242' ? '1337' : '4242';

// ---- Real MCP server over stdio ----------------------------------------------

const client = new Client({ name: 'mcp-app-smoke', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, 'server', 'mcp', 'index.ts')],
  env: { ...process.env, MOG_WORKBOOK_DIR: root, MOG_UI_DIST: uiDist },
  stderr: 'pipe',
});
const serverLog = [];
transport.stderr?.on('data', (chunk) => serverLog.push(String(chunk)));

let harness;
let browser;
let ws;
const profile = await mkdtemp(join(tmpdir(), 'mog-app-smoke-profile-'));

try {
  await client.connect(transport);

  const { contents } = await client.readResource({ uri: 'ui://mog-canvas/canvas.html' });
  const resource = contents[0];
  const bootstrapHtml = resource.text;
  const assetOrigin = resource._meta?.ui?.csp?.connectDomains?.[0];
  expect(/^http:\/\/127\.0\.0\.1:\d+$/.test(assetOrigin ?? ''), `bad asset origin: ${assetOrigin}`);

  await check('asset origin belongs to this run (serves this worktree dist byte-for-byte)', async () => {
    const served = Buffer.from(await fetch(`${assetOrigin}/ui/mcp-app.js`).then((r) => r.arrayBuffer()));
    const onDisk = await readFile(join(uiDist, 'mcp-app.js'));
    const a = createHash('sha256').update(served).digest('hex');
    const b = createHash('sha256').update(onDisk).digest('hex');
    expect(a === b, `served bundle sha256 ${a} != dist ${b}`);
    return `${assetOrigin}, sha256 ${a.slice(0, 12)}…`;
  });

  // ---- Spec-shaped CSP, built only from the declared domains ------------------
  // SEP-1865 grants inline script/style plus the declared connect/resource
  // domains. It does not grant 'wasm-unsafe-eval' — whether the engine's wasm
  // compiles without it is exactly what this run must find out. 'relaxed' adds
  // the wasm grant (and blob: workers, which engines commonly need) so the run
  // can still complete the render/edit/save proof and report both outcomes.
  const SCRIPT_EXTRA = { strict: '', wasm: " 'wasm-unsafe-eval'", eval: " 'unsafe-eval'" };
  const cspFor = (mode) =>
    [
      `default-src 'none'`,
      `script-src 'unsafe-inline' ${assetOrigin}${SCRIPT_EXTRA[mode]}`,
      `style-src 'unsafe-inline' ${assetOrigin}`,
      `font-src ${assetOrigin}`,
      `img-src data: blob: ${assetOrigin}`,
      `connect-src ${assetOrigin}`,
      ...(mode === 'strict' ? [] : [`worker-src blob: ${assetOrigin}`]),
    ].join('; ');

  // Runs inside the sandboxed frame under the frame CSP ('unsafe-inline' is part
  // of the policy under test). Relays DOM state + CSP violations to the parent;
  // accepts click commands for the component's buttons. The ext-apps transport
  // ignores non-JSON-RPC messages, so this shares the channel safely.
  const probeScript = `<script>(function () {
    var violations = [];
    var errors = [];
    window.addEventListener('securitypolicyviolation', function (e) {
      violations.push(e.violatedDirective + ' blocked ' + (e.blockedURI || '(inline)'));
    });
    window.addEventListener('error', function (e) {
      errors.push(String((e.error && e.error.message) || e.message));
    });
    window.addEventListener('unhandledrejection', function (e) {
      errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason));
    });
    window.addEventListener('message', function (e) {
      var cmd = e.data && e.data.__cmd;
      if (cmd === 'save' || cmd === 'shot') {
        var b = document.getElementById(cmd === 'save' ? 'save' : 'shot');
        if (b) b.click();
      }
    });
    setInterval(function () {
      var q = function (s) { return document.querySelector(s); };
      var canvas = q('#canvas');
      parent.postMessage({ __probe: {
        status: (q('#status') || {}).textContent || '',
        error: (q('#error') || {}).textContent || '',
        name: (q('#wb-name') || {}).textContent || '',
        dirty: !((q('#dirty') || { hidden: true }).hidden),
        canvasElements: canvas ? canvas.querySelectorAll('*').length : 0,
        gridCanvases: document.querySelectorAll('#canvas canvas').length,
        inputs: Array.prototype.slice.call(document.querySelectorAll('#canvas input'))
          .map(function (n) { return n.value; })
          .filter(Boolean).slice(0, 10),
        sheetTab: /Sheet1/.test(canvas ? canvas.innerText : ''),
        violations: violations.slice(0, 20),
        errors: errors.slice(0, 10)
      } }, '*');
    }, 400);
  })()</script>`;

  const frameHtml = (mode) =>
    bootstrapHtml.replace(
      '<head>',
      `<head>\n<meta http-equiv="Content-Security-Policy" content="${cspFor(mode ?? 'strict')}">\n${probeScript}`,
    );
  const KNOWN_MODES = new Set(['strict', 'wasm', 'eval']);

  // ---- Harness host page + tool proxy -----------------------------------------

  let openResult = null; // last open_workbook CallToolResult, node-side copy
  const toolCalls = []; // every tools/call proxied for the app, in order

  harness = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(hostPage());
      } else if (req.method === 'GET' && url.pathname === '/frame') {
        const mode = url.searchParams.get('mode');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(frameHtml(KNOWN_MODES.has(mode) ? mode : 'strict'));
      } else if (req.method === 'POST' && url.pathname === '/rpc') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        toolCalls.push(params.name);
        const result = await client.callTool(params);
        if (params.name === 'open_workbook' && !result.isError) openResult = result;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ harnessError: String(error?.message ?? error) }));
    }
  });
  await new Promise((ok) => harness.listen(0, '127.0.0.1', ok));
  const harnessPort = harness.address().port;

  // The host page: not sandboxed, same origin as /rpc. Implements the SEP-1865
  // host half of the handshake and keeps a log + the latest frame probe where
  // CDP can read them from the main frame.
  function hostPage() {
    return `<!doctype html><html><head><meta charset="utf-8"><title>mcp-app-smoke host</title>
<style>body{margin:0;font:12px monospace}iframe{display:block;border:0;width:520px;height:760px}</style>
</head><body>
<iframe id="frame" src="/frame?mode=strict" sandbox="allow-scripts"></iframe>
<script>
  const frame = document.getElementById('frame');
  window.__hostLog = [];
  window.__frame = null;
  window.__mode = 'strict';
  window.__reload = (mode) => { window.__mode = mode; window.__frame = null; frame.src = '/frame?mode=' + mode; };
  window.__send = (cmd) => frame.contentWindow.postMessage({ __cmd: cmd }, '*');
  const rpc = (params) => fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  }).then((r) => r.json());
  window.addEventListener('message', async (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const msg = ev.data;
    if (msg && msg.__probe) { window.__frame = msg.__probe; return; }
    if (!msg || msg.jsonrpc !== '2.0') return;
    const post = (m) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...m }, '*');
    if (msg.method === 'ui/initialize' && msg.id !== undefined) {
      window.__hostLog.push('ui/initialize from ' + msg.params.appInfo.name + '@' + msg.params.appInfo.version);
      post({ id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        hostInfo: { name: 'mcp-app-smoke-host', version: '0.0.1' },
        hostCapabilities: { serverTools: {} },
        hostContext: { theme: 'light', displayMode: 'inline' },
      } });
      return;
    }
    if (msg.method === 'ui/notifications/initialized') {
      window.__hostLog.push('ui/notifications/initialized');
      const result = await rpc({ name: 'open_workbook', arguments: { name: 'sample.xlsx' } });
      post({ method: 'ui/notifications/tool-result', params: result });
      window.__hostLog.push('tool-result delivered');
      return;
    }
    if (msg.method === 'tools/call' && msg.id !== undefined) {
      window.__hostLog.push('tools/call ' + msg.params.name);
      try {
        post({ id: msg.id, result: await rpc(msg.params) });
      } catch (error) {
        post({ id: msg.id, error: { code: -32000, message: String(error) } });
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      window.__hostLog.push('unhandled request ' + msg.method);
      post({ id: msg.id, error: { code: -32601, message: 'not implemented in smoke host: ' + msg.method } });
    }
  });
</script></body></html>`;
  }

  // ---- Browser + CDP -----------------------------------------------------------

  const cdpPort = 9337;
  const executable = resolveBrowserExecutable();
  console.log(`browser: ${executable}`);
  browser = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=560,860',
      `http://127.0.0.1:${harnessPort}/`,
    ],
    { stdio: 'ignore' },
  );

  const target = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
        const page = list.find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${harnessPort}`));
        if (page) return page;
      } catch {
        /* not listening yet */
      }
      await sleep(500);
    }
    throw new Error('timed out waiting for the harness page target');
  })();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error('CDP socket failed')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const messageId = ++id;
      pending.set(messageId, (message) =>
        message.error ? fail(new Error(message.error.message)) : ok(message.result),
      );
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');

  const probe = () => evaluate('({ log: window.__hostLog, frame: window.__frame, mode: window.__mode })');
  const waitFor = async (label, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await probe();
      const hit = predicate(last);
      if (hit) return last;
      await sleep(500);
    }
    throw new Error(
      `timed out waiting for ${label}; last state: ${JSON.stringify(last).slice(0, 600)}`,
    );
  };

  // ---- 1. Handshake -------------------------------------------------------------

  await check('app completed the MCP Apps handshake inside the sandboxed iframe', async () => {
    const state = await waitFor(
      'ui/initialize + initialized',
      (s) => s.log.some((l) => l.startsWith('ui/initialize')) && s.log.includes('ui/notifications/initialized'),
      30_000,
    );
    return state.log.filter((l) => !l.startsWith('tools/call')).join(' | ');
  });

  // ---- 2. The CSP question -------------------------------------------------------

  // The adapter's terminal status: reported only when the embed's own
  // getStatus() says ready AND the view answers a query. The old bare "ready"
  // fired at mount wiring, long before the renderer could paint.
  const rendererReady = (status) => status === 'renderer ready';

  const settled = (s) =>
    s.frame &&
    (rendererReady(s.frame.status) ||
      s.frame.status === 'open failed' ||
      s.frame.violations.length > 0);

  // Climb the grant ladder and record every rung's outcome. "Settled but not
  // ready" means blocked at that grant level; only then is the next grant
  // tried, so the run finds the *minimal* CSP the engine needs.
  const outcomes = {};
  let state;
  for (const mode of ['strict', 'wasm', 'eval']) {
    if (mode !== 'strict') {
      console.log(`  csp[${mode === 'wasm' ? 'strict' : 'wasm'}] blocked — retrying with ${mode === 'wasm' ? "'wasm-unsafe-eval' + worker-src blob:" : "'unsafe-eval'"}`);
      await evaluate(`window.__reload('${mode}')`);
    }
    state = await waitFor(
      `the ${mode}-CSP frame to settle`,
      (s) => s.mode === mode && settled(s),
      240_000,
    );
    // Give late violations a moment to surface before judging the rung.
    await sleep(2_000);
    state = await probe();
    outcomes[mode] = rendererReady(state.frame.status)
      ? `ready (violations=[${state.frame.violations.join('; ')}])`
      : `blocked: violations=[${state.frame.violations.join('; ')}] errors=[${state.frame.errors.join('; ')}] status="${state.frame.status}"`;
    if (rendererReady(state.frame.status)) break;
  }

  await check('CSP requirement measured (spec-literal policy first, grants added only on failure)', async () => {
    // This check reports the finding; the render checks below are the gate.
    return Object.entries(outcomes)
      .map(([mode, outcome]) => `${mode}: ${outcome}`)
      .join('  ||  ');
  });

  await check('real Mog canvas reached ready inside the sandboxed iframe', async () => {
    expect(
      rendererReady(state.frame.status),
      `status="${state.frame.status}" error="${state.frame.error}" violations=[${state.frame.violations.join('; ')}] errors=[${state.frame.errors.join('; ')}]`,
    );
    return `status="${state.frame.status}" under ${state.mode} CSP`;
  });

  await check('embed rendered a real DOM tree + grid canvas', async () => {
    expect(state.frame.canvasElements > 50, `only ${state.frame.canvasElements} elements`);
    expect(state.frame.gridCanvases > 0, 'no <canvas> in the grid');
    return `${state.frame.canvasElements} elements, ${state.frame.gridCanvases} grid canvas(es)`;
  });

  await check('workbook data reached the formula bar (via MCP tools, not HTTP)', async () => {
    expect(
      state.frame.inputs.includes('Line item'),
      `inputs=[${state.frame.inputs.join(' | ')}]`,
    );
    expect(state.frame.sheetTab, 'Sheet1 tab not rendered');
    expect(
      toolCalls.includes('fetch_workbook_bytes'),
      `bytes did not travel through the tool proxy: ${toolCalls.join(',')}`,
    );
    return `formula bar shows "Line item"; app tool calls: ${toolCalls.join(', ')}`;
  });

  // ---- 3. Edit -> Save -> disk ----------------------------------------------------

  // Click into the grid (page coords are frame coords: the iframe sits at 0,0),
  // then navigate by key — Ctrl+Home to A1, five rows down to A6.
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: 60, y: 400, button: 'left', clickCount: 1 });
  }
  const key = async (params) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  };
  await key({ key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, modifiers: 2 });
  for (let row = 1; row < 6; row += 1) {
    await key({ key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  }
  for (const char of typed) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
  }
  await key({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

  await check('cell edit made the session dirty', async () => {
    const s = await waitFor('the dirty marker', (x) => x.frame?.dirty === true, 15_000);
    return `dirty=${s.frame.dirty}`;
  });

  await check('Save button persisted through save_workbook_canvas to the fixture on disk', async () => {
    await evaluate(`window.__send('save')`);
    const s = await waitFor(
      'save to settle',
      (x) => x.frame?.status === 'saved to disk' || x.frame?.status.includes('failed'),
      60_000,
    );
    expect(s.frame.status === 'saved to disk', `status="${s.frame.status}" error="${s.frame.error}"`);
    const after = await readA6();
    expect(
      String(after) === typed,
      `A6 was ${JSON.stringify(before)}, now ${JSON.stringify(after)}, expected ${typed}`,
    );
    await stat(join(root, 'sample.xlsx.bak'));
    // The component is the human's canvas: its save must travel through the
    // trusted human lane, never the model-visible agent tool.
    expect(toolCalls.includes('save_workbook_canvas'), `save did not travel through tools: ${toolCalls.join(',')}`);
    expect(!toolCalls.includes('save_workbook'), `a canvas save must not use the agent lane: ${toolCalls.join(',')}`);
    return `A6: ${JSON.stringify(before)} -> ${JSON.stringify(after)}, backup sample.xlsx.bak present`;
  });

  await check('server-side session revision advanced past the open revision', async () => {
    const opened = unwrap(openResult);
    const now = unwrap(await client.callTool({ name: 'get_workbook_session', arguments: { sessionId: opened.sessionId } }));
    expect(now.revision !== opened.revision, `revision did not move: ${now.revision}`);
    return `${opened.revision.slice(0, 12)}… -> ${now.revision.slice(0, 12)}…`;
  });

  // ---- 4. Screenshot through the component -----------------------------------------

  await check('Screenshot button produced a PNG via save_screenshot', async () => {
    await evaluate(`window.__send('shot')`);
    const s = await waitFor(
      'screenshot to settle',
      (x) => x.frame?.status.startsWith('screenshot saved') || x.frame?.status.includes('failed'),
      60_000,
    );
    expect(s.frame.status.startsWith('screenshot saved'), `status="${s.frame.status}" error="${s.frame.error}"`);
    const png = await readFile(join(root, 'sample.png'));
    expect(png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'not a PNG');
    return `sample.png, ${png.length} bytes`;
  });

  await check('no page errors, and no CSP violations beyond caught eval probes', async () => {
    const s = await probe();
    // Below the 'eval' grant the engine's startup eval attempts are refused and
    // logged as violations; if the canvas still reached ready they were caught
    // feature probes, not load-bearing eval. Anything else is a failure.
    const unexpected = s.frame.violations.filter((v) => v !== 'script-src blocked eval');
    expect(unexpected.length === 0, `violations: ${unexpected.join('; ')}`);
    expect(s.frame.errors.length === 0, `errors: ${s.frame.errors.join('; ')}`);
    return `mode=${s.mode}, caught eval probes: ${s.frame.violations.length}`;
  });

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`\nevidence screenshot: ${shotPath}`);
  console.log('CSP ladder outcomes:');
  for (const [mode, outcome] of Object.entries(outcomes)) console.log(`  ${mode}: ${outcome}`);
} catch (error) {
  failed += 1;
  console.log(`FAIL  harness error\n      ${error?.stack ?? error}`);
} finally {
  ws?.close();
  browser?.kill();
  harness?.close();
  await client.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

if (serverLog.length > 0 && failed > 0) {
  console.log('\nserver stderr:');
  console.log(serverLog.join('').slice(0, 4000));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
