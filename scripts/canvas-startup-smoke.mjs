/**
 * Measure a direct canvas cold start and same-profile warm start.
 *
 * Uses an isolated headless browser profile and reads only the rendered page.
 * It never opens the user's browser or writes a workbook.
 *
 *   node scripts/canvas-startup-smoke.mjs http://127.0.0.1:5278/index.html?wb=test.xlsx
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrowserExecutable } from './browser-executable.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:5276/index.html?wb=test.xlsx';
const parsed = new URL(url);
if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Canvas startup smoke accepts a loopback http URL only.');
}
const debugPort = 19_000 + Math.floor(Math.random() * 10_000);
const profile = await mkdtemp(join(tmpdir(), 'mog-canvas-startup-'));
const executable = resolveBrowserExecutable();
const browser = spawn(executable, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1200,800',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function removeProfile() {
  // Chromium's Crashpad child can briefly retain its metrics file after the
  // browser process exits. Retry cleanup so a successful measurement does not
  // become a false failure on Windows.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); return; }
    catch { await sleep(250); }
  }
}
async function poll(path, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const body = await fetch(`http://127.0.0.1:${debugPort}${path}`).then((response) => response.json());
      const found = predicate(body);
      if (found) return found;
    } catch { /* Chrome is still starting. */ }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let ws;
try {
  const target = await poll('/json/list', (targets) => targets.find((item) => item.type === 'page'), 'a page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const wasmResponses = [];
  const wasmRequests = new Map();
  const runtimeErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === 'Network.responseReceived' && /compute_core_wasm_bg(?:-[^/]+)?\.wasm$/.test(message.params.response.url)) {
      const record = { status: message.params.response.status, fromDiskCache: message.params.response.fromDiskCache, encodedDataLength: null };
      wasmResponses.push(record);
      wasmRequests.set(message.params.requestId, record);
    }
    if (message.method === 'Network.loadingFinished' && wasmRequests.has(message.params.requestId)) {
      wasmRequests.get(message.params.requestId).encodedDataLength = message.params.encodedDataLength;
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      runtimeErrors.push(message.params.args.map((item) => item.value ?? item.description ?? '').join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');

  async function run(label) {
    const responseOffset = wasmResponses.length;
    const started = Date.now();
    await send('Page.navigate', { url });
    const deadline = Date.now() + 180_000;
    let state;
    while (Date.now() < deadline) {
      state = await evaluate(`(() => ({
        status: document.querySelector('.status')?.textContent ?? '',
        error: document.querySelector('.error')?.textContent ?? null,
        phase: document.querySelector('.canvas')?.dataset.startupPhase ?? '',
        ready: document.querySelector('.canvas')?.dataset.canvasReady ?? '',
        canvasElements: document.querySelector('.canvas')?.querySelectorAll('*').length ?? 0,
        engineResources: performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => name.toLowerCase().includes('wasm') || name.includes('/mog/')),
        marks: performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith('mog-canvas:')).map((entry) => ({ name: entry.name, startTime: entry.startTime }))
      }))()`);
      if (state.status === 'renderer ready' || state.error) break;
      await sleep(250);
    }
    const elapsedMs = Date.now() - started;
    await sleep(50);
    const ready = state?.status === 'renderer ready';
    if (!ready) throw new Error(`${label} did not reach renderer ready in ${elapsedMs} ms (status=${state?.status ?? 'none'}, error=${state?.error ?? 'none'})`);
    if (state.canvasElements <= 50 || runtimeErrors.some((error) => /NotFoundError|removeChild/i.test(error))) {
      throw new Error(`${label} reached a status but did not retain a live canvas (elements=${state.canvasElements}, errors=${runtimeErrors.join(' | ')})`);
    }
    const open = state.marks.find((entry) => entry.name === 'mog-canvas:open-start');
    const renderer = state.marks.findLast((entry) => entry.name === 'mog-canvas:renderer ready');
    return {
      label,
      rendererReadyMs: elapsedMs,
      appOpenToRendererMs: open && renderer ? Math.round(renderer.startTime - open.startTime) : null,
      phase: state.phase,
      canvasElements: state.canvasElements,
      runtimeErrors,
      engineResources: state.engineResources,
      wasm: wasmResponses.slice(responseOffset),
    };
  }

  const results = [await run('cold'), await run('warm')];
  console.log(JSON.stringify({ url, results }, null, 2));
} finally {
  ws?.close();
  browser.kill();
  await removeProfile();
}
