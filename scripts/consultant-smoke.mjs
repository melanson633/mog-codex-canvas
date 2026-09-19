/** Synthetic user release gate. Only creates the fixed financial example; never edits other workbooks. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveBrowserExecutable } from './browser-executable.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:5276';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Use an explicit loopback production origin.');
const output = resolve(process.argv[3] ?? 'artifacts/consultant-release');
await mkdir(output, { recursive: true });
const evidence = { origin, checkedAt: new Date().toISOString(), checks: [], timings: {} };
const check = (label, condition) => { assert.ok(condition, label); evidence.checks.push(label); console.log(`PASS ${label}`); };
async function json(path, body) {
  const response = await fetch(origin + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value)); return value;
}
const health = await json('/health');
check('production runtime identifies the release', health.mode === 'production' && health.status === 'ok');
const expectedRelease = process.argv[4];
if (expectedRelease) check('runtime matches the expected release identity', health.release === expectedRelease);
evidence.release = health.release;
const example = await json('/api/analyst/example', {});
check('example matches its verified contract', example.exampleMatches === true);
const name = example.name;
const getBytes = async () => Buffer.from(await (await fetch(`${origin}/api/workbook?path=${name}`)).arrayBuffer());
const before = await getBytes();
async function analyze(action, fields) { return json('/api/analyst', { action, name, sheet: 'Model', ...fields }); }
const context = await analyze('context', { range: 'A1:D20' });
check('saved context contains EBITDA 360000', context.cells.some(cell => cell.address === 'B8' && Math.abs(cell.value - 360000) < 1e-6));
const warm = await analyze('context', { range: 'A1:D20' });
check('second context query reuses revision index', warm.cache.hit && warm.revision === context.revision);
evidence.timings.contextInitialQueryMs = context.elapsedMs; evidence.timings.contextRepeatedQueryMs = warm.elapsedMs;
const explain = await analyze('explain', { address: 'B8' });
check('EBITDA cites gross profit and costs', ['B7', 'B5'].every(address => explain.precedents.some(item => item.address === address)));
const audit = await analyze('audit', { range: 'A1:D20' });
check('review catches the seeded D19 formula issue', audit.findings.some(item => item.address === 'D19' && item.kind === 'formula-pattern'));
const tie = await analyze('reconcile', { left: 'B11:B13', right: 'D11:D13', tolerance: 0.01 });
check('asset/funding tie-out balances at one million', tie.status === 'balanced' && tie.left.sum === 1000000 && tie.right.sum === 1000000);
const mismatch = await analyze('reconcile', { left: 'B11:B12', right: 'D11:D13', tolerance: 0.01 });
check('tie-out reports an actual difference', mismatch.status === 'difference' && mismatch.difference === -200000);
const scenario = await analyze('scenario', { input: 'B3', values: [0, 0.1, 0.2], outputs: ['B8'], expectedRevision: context.revision });
check('three growth scenarios match known answers', scenario.cases.every((item, index) => Math.abs(item.outputs.B8 - [300000, 360000, 420000][index]) < 1e-6));
check('scenario source bytes remain identical', before.equals(await getBytes()));
const rejected = await fetch(origin + '/api/analyst', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scenario', name, sheet: 'Model', input: 'B8', values: [1], outputs: ['B8'] }) });
check('formula cells cannot be overwritten as scenario assumptions', rejected.status === 400);
await writeFile(join(output, 'analysis-evidence.json'), JSON.stringify({ context, warm, explain, audit, tie, mismatch, scenario }, null, 2));

const profile = await mkdtemp(join(tmpdir(), 'mog-consultant-browser-'));
const port = 9400 + Math.floor(Math.random() * 500);
const browser = spawn(resolveBrowserExecutable(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', origin], { stdio: 'ignore', windowsHide: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch {} await pause(300); } throw new Error(`Timed out: ${String(last)}`); }
let socket;
try {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith(origin)));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(); const errors = [];
  socket.addEventListener('message', event => { const msg = JSON.parse(event.data); if (msg.id) { const callbacks = pending.get(msg.id); if (callbacks) { clearTimeout(callbacks.timer); pending.delete(msg.id); msg.error ? callbacks.reject(new Error(msg.error.message)) : callbacks.resolve(msg.result); } } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout ${method}`)); }, 30000); pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`!!document.querySelector('[data-testid="load-example"]')`));
  await evaluate(`document.querySelector('[data-testid="load-example"]').click()`);
  await until(() => evaluate(`document.querySelector('iframe')?.contentDocument?.querySelector('.status')?.textContent === 'renderer ready'`), 180000);
  check('production real Mog canvas reaches renderer ready', true);
  check('canvas renders actual spreadsheet elements', await evaluate(`document.querySelector('iframe').contentDocument.querySelector('.canvas').querySelectorAll('*').length > 50`));
  check('embedded canvas cannot diverge from selected workbook', await evaluate(`document.querySelector('iframe').contentDocument.querySelector('.picker').disabled && document.querySelector('iframe').contentDocument.querySelector('.picker').value === document.querySelector('#workbook').value`));
  async function exerciseControls(viewport) {
   for (const [label, expected] of [['Inspect', '360000'], ['Explain', 'B7'], ['Review', 'D19'], ['Tie out', '1,000,000'], ['Scenarios', '420,000']]) {
    await evaluate(`Array.from(document.querySelectorAll('.mode-tabs button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
    await evaluate(`document.querySelector('[data-testid="run-analysis"]').click()`);
    await until(() => evaluate(`!!document.querySelector('[data-testid="analysis-result"]') || !!document.querySelector('[role="alert"]')`));
    const error = await evaluate(`document.querySelector('[role="alert"]')?.textContent ?? ''`);
    check(`${viewport} ${label} runs through the browser controls`, !error && await evaluate(`document.querySelector('[data-testid="analysis-result"]').textContent.includes(${JSON.stringify(expected)})`));
   }
  }
  await exerciseControls('desktop');
  await evaluate(`document.querySelector('[data-testid="analysis-result"]').scrollIntoView({block:'end'})`);
  const desktop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  check('mobile layout has no horizontal overflow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
  check('mobile analysis controls remain visible', await evaluate(`document.querySelector('[data-testid="run-analysis"]').getBoundingClientRect().width > 200`));
  await exerciseControls('mobile');
  await evaluate(`document.querySelector('[data-testid="analysis-result"]').scrollIntoView({block:'end'})`);
  const mobile = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'mobile.png'), Buffer.from(mobile.data, 'base64'));
  const downloads = join(profile, 'downloads');
  await mkdir(downloads);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await evaluate(`document.querySelector('.evidence-footer button').click()`);
  const exported = await until(async () => JSON.parse(await readFile(join(downloads, 'mog-scenario-evidence.json'), 'utf8')));
  check('downloaded evidence retains the scenario and saved revision', exported.action === 'scenario' && exported.revision === context.revision && exported.cases.length === 3);
  await evaluate(`Array.from(document.querySelectorAll('.mode-tabs button')).find(button => button.textContent === 'Inspect').click()`);
  await evaluate(`document.querySelector('[data-testid="run-analysis"]').click()`);
  await until(() => evaluate(`!!document.querySelector('[data-testid="analysis-result"] .cell-link')`));
  await evaluate(`Array.from(document.querySelectorAll('.cell-link')).find(button => button.textContent === 'B8').click()`);
  // Navigation deliberately preserves the human context bus; verify the real
  // formula bar instead of mistaking the last human selection for view state.
  await until(() => evaluate(`Array.from(document.querySelector('iframe').contentDocument.querySelectorAll('.canvas input')).some(input => input.value.replace(/^=/, '') === 'B7-B5')`));
  check('cell evidence navigates the live canvas to B8', true);
  const selection = await json(`/api/context?path=${name}`);
  for (const label of ['Scenarios', 'Tie out']) {
    await evaluate(`Array.from(document.querySelectorAll('.mode-tabs button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
    await evaluate(`document.querySelector('.selection-button').click()`);
    const expected = label === 'Scenarios' ? selection.context.selection.split(':')[0] : selection.context.selection;
    await until(() => evaluate(`document.querySelector('fieldset input').value === ${JSON.stringify(expected)}`));
    check(`${label} uses the live canvas selection in its active input`, true);
  }
  await evaluate(`(() => {
    const original = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).startsWith('/api/context?')) {
        window.fetch = original;
        return new Promise(resolve => { window.releaseSelectionProbe = () => resolve(new Response(JSON.stringify({ context: { activeSheet: 'StaleSheet', selection: 'Z99' } }), { status: 200 })); });
      }
      return original(url, options);
    };
    document.querySelector('.selection-button').click();
    Array.from(document.querySelectorAll('.mode-tabs button')).find(button => button.textContent === 'Explain').click();
  })()`);
  await pause(100);
  await evaluate(`window.releaseSelectionProbe()`);
  await pause(100);
  check('late selection response cannot overwrite a different analysis mode', await evaluate(`document.querySelector('fieldset select').value === 'Model' && document.querySelector('fieldset input').value === 'B8'`));
  check('no browser runtime exceptions', errors.length === 0);
  check('browser workflows did not change saved source', before.equals(await getBytes()));
  await send('Page.navigate', { url: `${origin}/index.html?wb=missing-release-probe.xlsx&embedded=1` });
  await until(() => evaluate(`document.querySelector('.status')?.textContent === 'workbook unavailable'`));
  check('an unavailable pinned workbook never falls back to another canvas', await evaluate(`document.querySelector('.error')?.textContent.includes('requested workbook') && !document.querySelector('.canvas canvas')`));
  evidence.browserExceptions = errors;
} finally {
  socket?.close(); browser.kill();
  await pause(500);
  // Only the unique temporary browser profile created above is removed.
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await writeFile(join(output, 'release-checks.json'), JSON.stringify(evidence, null, 2));
}
console.log(`${evidence.checks.length} release checks passed; evidence: ${output}`);
