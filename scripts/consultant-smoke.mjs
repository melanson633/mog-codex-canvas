/** Synthetic user release gate. Creates the financial example and a uniquely named blank workbook; never edits other workbooks. */
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
const sensitivity = await analyze('sensitivity', { rowInput: 'B3', rowValues: [0, 0.1, 0.2], colInput: 'B4', colValues: [0.5, 0.6, 0.7], output: 'B8' });
check('entire joint sensitivity grid matches independent arithmetic', sensitivity.matrix.every((row, r) => row.every((value, c) => Math.abs(value - (1000000 * (1 + r / 10) * (0.5 + c / 10) - 300000)) < 1e-6)));
const drivers = await analyze('drivers', { inputs: [{ cell: 'B3', low: 0, high: 0.2 }, { cell: 'B4', low: 0.5, high: 0.7 }], output: 'B8' });
check('driver ranking identifies margin before growth with correct spreads', drivers.drivers[0].cell === 'B4' && Math.abs(drivers.drivers[0].span - 220000) < 1e-6 && Math.abs(drivers.drivers[1].span - 120000) < 1e-6);
const goal = await analyze('goalSeek', { input: 'B3', output: 'B8', target: 420000, lower: 0, upper: 1, tolerance: 0.01 });
check('goal seek reaches 420000 with approximately 20 percent growth', goal.status === 'converged' && Math.abs(goal.solution - 0.2) < 1e-6 && Math.abs(goal.residual) <= 0.01);
const variance = await analyze('variance', { baseline: 'B11:B13', comparison: 'D11:D13' });
check('positional bridge explains offsetting components and reconciles', variance.difference === 0 && variance.residual === 0 && JSON.stringify(variance.rows.map(row => row.difference)) === JSON.stringify([100000, -250000, 150000]));
const checks = await analyze('checks', { checks: [{ label: 'Funding', range: 'B11:B13', operator: 'equals', compareRange: 'D11:D13' }, { label: 'EBITDA floor', range: 'B8', operator: 'at-least', target: 300000 }] });
check('explicit check pack passes both known controls', checks.status === 'passed' && checks.passed === 2 && checks.failed === 0);
const failedCheck = await analyze('checks', { checks: [{ label: 'Deliberate failure', range: 'B8', operator: 'at-most', target: 300000 }] });
check('failed business control is clearly reported as a failed check', failedCheck.status === 'failed' && failedCheck.failed === 1);
check('new analysis evidence retains exact requests and source revision', [sensitivity, drivers, goal, variance, checks].every(result => result.revision === context.revision && result.evidence.request.action === result.action && result.sourceUnchanged === true));
check('all decision tools preserve source bytes', before.equals(await getBytes()));
for (const [fields, reason] of [
  [{ action: 'sensitivity', rowInput: 'B3', rowValues: [0], colInput: '$b$3', colValues: [1], output: 'B8' }, 'Select distinct input cells'],
  [{ action: 'goalSeek', input: 'B3', output: 'B8', target: 99999999, lower: 0, upper: 1 }, 'target is not bracketed'],
  [{ action: 'checks', checks: [{ label: 'Invalid', range: 'A1', operator: 'equals', target: 0 }] }, 'require numeric cells'],
  [{ action: 'variance', baseline: 'B11:B13', comparison: 'D11:D12' }, 'same shape'],
]) {
  const response = await fetch(origin + '/api/analyst', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, sheet: 'Model', ...fields }) });
  check(`${fields.action} rejects an invalid analysis for the expected reason`, response.status === 400 && (await response.text()).includes(reason));
}
const rejected = await fetch(origin + '/api/analyst', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scenario', name, sheet: 'Model', input: 'B8', values: [1], outputs: ['B8'] }) });
check('formula cells cannot be overwritten as scenario assumptions', rejected.status === 400 && (await rejected.text()).includes('saved numeric constant, not a formula'));
await writeFile(join(output, 'analysis-evidence.json'), JSON.stringify({ context, warm, explain, audit, tie, mismatch, scenario, sensitivity, drivers, goal, variance, checks, failedCheck }, null, 2));

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
  await until(() => evaluate(`!!document.querySelector('[role="tabpanel"]:not([hidden])')`));
  await evaluate(`window.activeDesk = () => document.querySelector('[role="tabpanel"]:not([hidden])')`);
  await until(() => evaluate(`!!window.activeDesk().querySelector('[data-testid="load-example"]')`));
  check('new workbook is available in the toolbar and empty state', await evaluate(`!!window.activeDesk().querySelector('[data-testid="new-workbook"]') && !!window.activeDesk().querySelector('[data-testid="empty-new-workbook"]')`));
  const blankName = `Release blank ${Date.now()}.xlsx`;
  const fillWorkbookName = value => evaluate(`(() => { const field = window.activeDesk().querySelector('[data-testid$="-new-workbook-name"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`window.activeDesk().querySelector('[data-testid="empty-new-workbook"]').click()`);
  await until(() => evaluate(`window.activeDesk().querySelector('.new-workbook-dialog').open`));
  await fillWorkbookName(blankName);
  const newDialogShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'new-workbook-dialog.png'), Buffer.from(newDialogShot.data, 'base64'));
  await evaluate(`window.activeDesk().querySelector('[data-testid="create-workbook"]').click()`);
  await until(() => evaluate(`!window.activeDesk().querySelector('.new-workbook-dialog').open && window.activeDesk().querySelector('select[id$="-workbook"]').value === ${JSON.stringify(blankName)} && window.activeDesk().querySelector('iframe')?.contentDocument?.querySelector('.status')?.textContent === 'renderer ready'`), 180000);
  const blankContext = await json('/api/analyst', { action: 'context', name: blankName, sheet: 'Sheet1', range: 'A1:D20' });
  check('named blank workbook opens a real empty Sheet1 canvas', blankContext.cells.length === 0 && await evaluate(`window.activeDesk().querySelector('iframe').contentDocument.querySelector('.canvas canvas') !== null`));
  const blankBefore = Buffer.from(await (await fetch(`${origin}/api/workbook?path=${encodeURIComponent(blankName)}`)).arrayBuffer());
  await evaluate(`window.activeDesk().querySelector('[data-testid="new-workbook"]').click()`);
  await fillWorkbookName(blankName);
  await evaluate(`window.activeDesk().querySelector('[data-testid="create-workbook"]').click()`);
  await until(() => evaluate(`window.activeDesk().querySelector('[data-testid="create-workbook-error"]')?.textContent.includes('already exists')`));
  check('duplicate creation shows a useful error and preserves the existing workbook', blankBefore.equals(Buffer.from(await (await fetch(`${origin}/api/workbook?path=${encodeURIComponent(blankName)}`)).arrayBuffer())));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check('new workbook dialog fits a mobile viewport', await evaluate(`window.activeDesk().querySelector('.new-workbook-dialog').getBoundingClientRect().width <= window.innerWidth && window.activeDesk().querySelector('.new-workbook-dialog').scrollWidth <= window.activeDesk().querySelector('.new-workbook-dialog').clientWidth`));
  await evaluate(`Array.from(window.activeDesk().querySelectorAll('.new-workbook-dialog button')).find(button => button.textContent === 'Cancel').click()`);
  check('cancel preserves the selected workbook', await evaluate(`!window.activeDesk().querySelector('.new-workbook-dialog').open && window.activeDesk().querySelector('select[id$="-workbook"]').value === ${JSON.stringify(blankName)}`));
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`window.activeDesk().querySelector('[data-testid="load-example"]').click()`);
  await until(() => evaluate(`window.activeDesk().querySelector('select[id$="-workbook"]').value === ${JSON.stringify(name)} && window.activeDesk().querySelector('iframe')?.contentDocument?.querySelector('.picker')?.value === ${JSON.stringify(name)} && window.activeDesk().querySelector('iframe')?.contentDocument?.querySelector('.status')?.textContent === 'renderer ready' && !window.activeDesk().querySelector('[data-testid="run-analysis"]').disabled`), 180000);
  check('production real Mog canvas reaches renderer ready', true);
  check('canvas renders actual spreadsheet elements', await evaluate(`window.activeDesk().querySelector('iframe').contentDocument.querySelector('.canvas').querySelectorAll('*').length > 50`));
  check('canvas remains mounted after renderer readiness without a React DOM removal error', await evaluate(`window.activeDesk().querySelector('iframe').contentDocument.querySelector('.canvas').querySelectorAll('*').length > 50`) && !errors.some(error => /NotFoundError|removeChild/i.test(error)));
  check('embedded canvas cannot diverge from selected workbook', await evaluate(`window.activeDesk().querySelector('iframe').contentDocument.querySelector('.picker').disabled && window.activeDesk().querySelector('iframe').contentDocument.querySelector('.picker').value === window.activeDesk().querySelector('select[id$="-workbook"]').value`));
  async function exerciseControls(viewport) {
   for (const [label, expected] of [['Inspect', '360000'], ['Explain', 'B7'], ['Review', 'D19'], ['Tie out', '1,000,000'], ['Scenarios', '420,000'], ['Sensitivity', '360,000'], ['Drivers', '360,000'], ['Goal seek', 'Target reached within tolerance'], ['Variance', '33.3333%'], ['Check packs', '2 passed']]) {
    await evaluate(`Array.from(window.activeDesk().querySelectorAll('.mode-tabs button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
    await evaluate(`window.activeDesk().querySelector('[data-testid="run-analysis"]').click()`);
    await until(() => evaluate(`!!window.activeDesk().querySelector('[data-testid="analysis-result"]') || !!window.activeDesk().querySelector('.analysis-content > .failure[role="alert"]')`));
    const error = await evaluate(`window.activeDesk().querySelector('.analysis-content > .failure[role="alert"]')?.textContent ?? ''`);
    check(`${viewport} ${label} runs through the browser controls`, !error && await evaluate(`window.activeDesk().querySelector('[data-testid="analysis-result"]').textContent.includes(${JSON.stringify(expected)})`));
    if (label === 'Goal seek') check(`${viewport} goal-seek input preserves reproducible precision`, await evaluate(`window.activeDesk().querySelector('.solution-value').textContent === ${JSON.stringify(`Input ${goal.solution}`)}`));
    if (label === 'Check packs') check(`${viewport} check outcomes show comparison and effective tolerance`, await evaluate(`['Equals', 'At least', '0.01', 'tolerance'].every(value => window.activeDesk().querySelector('[data-testid="checks-result"]').textContent.includes(value))`));
    if (viewport === 'desktop' && ['Sensitivity', 'Drivers', 'Goal seek', 'Variance', 'Check packs'].includes(label)) await evaluate(`window.activeDesk().querySelector('[data-testid="pin-evidence"]').click()`);
    if (viewport === 'desktop' && ['Sensitivity', 'Drivers', 'Goal seek', 'Variance'].includes(label)) {
      await evaluate(`window.activeDesk().querySelector('[data-testid="analysis-result"]').scrollIntoView({block:'center'})`);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(output, `${label.toLowerCase().replaceAll(' ', '-')}.png`), Buffer.from(shot.data, 'base64'));
    }
   }
  }
  await exerciseControls('desktop');
  await evaluate(`window.activeDesk().querySelector('[data-testid="analysis-result"]').scrollIntoView({block:'end'})`);
  const desktop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  check('mobile layout has no horizontal overflow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
  check('mobile analysis controls remain visible', await evaluate(`window.activeDesk().querySelector('[data-testid="run-analysis"]').getBoundingClientRect().width > 200`));
  await exerciseControls('mobile');
  await evaluate(`window.activeDesk().querySelector('[data-testid="analysis-result"]').scrollIntoView({block:'end'})`);
  const mobile = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'mobile.png'), Buffer.from(mobile.data, 'base64'));
  const downloads = join(profile, 'downloads');
  await mkdir(downloads);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await evaluate(`Array.from(window.activeDesk().querySelectorAll('.evidence-footer button')).find(button => button.textContent.includes('Export evidence')).click()`);
  const exported = await until(async () => JSON.parse(await readFile(join(downloads, 'mog-checks-evidence.json'), 'utf8')));
  check('downloaded evidence retains checks and saved revision', exported.action === 'checks' && exported.revision === context.revision && exported.checks.length === 2);
  await evaluate(`window.activeDesk().querySelector('[data-testid="export-notebook"]').click(); window.activeDesk().querySelector('[data-testid="export-brief"]').click(); Array.from(window.activeDesk().querySelectorAll('.pack-toolbar button')).find(button => button.textContent.includes('Download')).click()`);
  const notebook = await until(async () => JSON.parse(await readFile(join(downloads, 'mog-decision-evidence.json'), 'utf8')));
  check('notebook exports all five pinned decision results from one revision', notebook.entries.length === 5 && notebook.entries.every(entry => entry.result.revision === context.revision && entry.assumptions.action === entry.result.action));
  const brief = await until(async () => readFile(join(downloads, 'mog-decision-brief.html'), 'utf8'));
  check('printable brief contains source revision and analysis evidence', brief.includes(context.revision) && brief.includes('420') && brief.includes('Decision evidence'));
  await writeFile(join(output, 'decision-brief.html'), brief);
  await writeFile(join(output, 'decision-notebook.json'), JSON.stringify(notebook, null, 2));
  const packPath = join(downloads, 'mog-check-pack.json');
  const pack = await until(async () => JSON.parse(await readFile(packPath, 'utf8')));
  check('check pack exports reusable rules', pack.version === 1 && pack.checks.length === 2);
  await evaluate(`window.activeDesk().querySelector('[data-testid="add-check"]').click()`);
  const documentNode = await send('DOM.getDocument');
  const fileNode = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[role="tabpanel"]:not([hidden]) [data-testid="import-check-pack"]' });
  await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [packPath] });
  await until(() => evaluate(`window.activeDesk().querySelector('[data-testid="add-check"]').textContent.includes('2/8')`));
  check('imported check pack restores the draft without running it', await evaluate(`!window.activeDesk().querySelector('[data-testid="analysis-result"]')`));
  for (const [label, content] of [
    ['malformed JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 2, checks: pack.checks })],
    ['invalid rule', JSON.stringify({ version: 1, checks: [{ label: 'Invalid', range: 'B8', operator: 'equals', target: 'not a number' }] })],
    ['oversized file', ' '.repeat(32769)],
  ]) {
    const invalidPath = join(downloads, 'invalid-pack.json');
    await writeFile(invalidPath, content);
    await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [invalidPath] });
    await until(() => evaluate(`!!window.activeDesk().querySelector('.analysis-content > .failure[role="alert"]')`));
    check(`check-pack import rejects ${label} and preserves the draft`, await evaluate(`window.activeDesk().querySelector('[data-testid="add-check"]').textContent.includes('2/8') && Array.from(window.activeDesk().querySelectorAll('.rule-card input')).some(input => input.value === 'Amounts agree')`));
    // A valid import clears the prior error before probing the next failure.
    await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [packPath] });
    await until(() => evaluate(`!window.activeDesk().querySelector('.analysis-content > .failure[role="alert"]')`));
  }
  const firstPack = join(downloads, 'slow-first.json'), secondPack = join(downloads, 'slow-second.json');
  await writeFile(firstPack, JSON.stringify({ version: 1, checks: [{ ...pack.checks[0], label: 'Earlier import' }] }));
  await writeFile(secondPack, JSON.stringify({ version: 1, checks: [{ ...pack.checks[0], label: 'Later import' }] }));
  await evaluate(`(() => {
    const original = File.prototype.text; window.pendingPackReads = {};
    window.restorePackReads = () => { File.prototype.text = original; };
    File.prototype.text = function() {
      const content = original.call(this);
      return this.name.startsWith('slow-') ? new Promise(resolve => { window.pendingPackReads[this.name] = async () => resolve(await content); }) : content;
    };
  })()`);
  await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [firstPack] });
  await until(() => evaluate(`!!window.pendingPackReads['slow-first.json']`));
  await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [secondPack] });
  await until(() => evaluate(`!!window.pendingPackReads['slow-second.json']`));
  await evaluate(`window.pendingPackReads['slow-second.json']()`);
  await until(() => evaluate(`window.activeDesk().querySelector('.rule-card input')?.value === 'Later import'`));
  await evaluate(`window.pendingPackReads['slow-first.json']()`);
  await pause(100);
  check('a slower earlier check-pack import cannot overwrite a later import', await evaluate(`window.activeDesk().querySelector('.rule-card input').value === 'Later import'`));
  await evaluate(`delete window.pendingPackReads['slow-first.json']`);
  await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [firstPack] });
  await until(() => evaluate(`!!window.pendingPackReads['slow-first.json']`));
  await evaluate(`window.activeDesk().querySelector('[data-testid="add-check"]').click(); window.pendingPackReads['slow-first.json']()`);
  await pause(100);
  check('a pending check-pack import cannot overwrite manual draft edits', await evaluate(`window.activeDesk().querySelector('[data-testid="add-check"]').textContent.includes('2/8') && window.activeDesk().querySelector('.rule-card input').value === 'Later import'`));
  await evaluate(`window.restorePackReads()`);
  await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [packPath] });
  await until(() => evaluate(`window.activeDesk().querySelector('.rule-card input')?.value === 'Amounts agree'`));
  await evaluate(`window.activeDesk().querySelector('[data-testid="run-analysis"]').click()`);
  await until(() => evaluate(`window.activeDesk().querySelector('[data-testid="checks-result"]')?.textContent.includes('2 passed')`));
  check('imported example check pack executes successfully', true);
  await evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url) === '/api/analyst') {
        window.fetch = original;
        const response = await original(url, options);
        const result = await response.json(); result.revision = 'synthetic-different-revision';
        return new Response(JSON.stringify(result), { status: response.status });
      }
      return original(url, options);
    };
    window.activeDesk().querySelector('[data-testid="run-analysis"]').click();
  })()`);
  await until(() => evaluate(`window.activeDesk().querySelector('.evidence-footer span')?.title === 'synthetic-different-revision'`));
  await evaluate(`window.activeDesk().querySelector('[data-testid="pin-evidence"]').click()`);
  check('notebook refuses evidence from a different revision', await evaluate(`window.activeDesk().querySelector('.analysis-content > .failure[role="alert"]')?.textContent.includes('another workbook or saved revision') && window.activeDesk().querySelectorAll('[data-testid="evidence-notebook"] li').length === 5`));
  await evaluate(`Array.from(window.activeDesk().querySelectorAll('.mode-tabs button')).find(button => button.textContent === 'Inspect').click()`);
  await evaluate(`window.activeDesk().querySelector('[data-testid="run-analysis"]').click()`);
  await until(() => evaluate(`!!window.activeDesk().querySelector('[data-testid="analysis-result"] .cell-link')`));
  await evaluate(`(() => { const sibling = document.createElement('iframe'); sibling.id = 'competing-canvas'; sibling.style.cssText = 'position:fixed;left:-2000px;width:900px;height:600px'; sibling.src = '/index.html?wb=' + encodeURIComponent(${JSON.stringify(name)}) + '&compact=1&embedded=1'; document.body.append(sibling); })()`);
  await until(() => evaluate(`document.querySelector('#competing-canvas').contentDocument?.querySelector('.status')?.textContent === 'renderer ready'`));
  const siblingInputs = await evaluate(`Array.from(document.querySelector('#competing-canvas').contentDocument.querySelectorAll('.canvas input')).map(input => input.value)`);
  await evaluate(`Array.from(window.activeDesk().querySelectorAll('.cell-link')).find(button => button.textContent === 'B8').click()`);
  // Navigation deliberately preserves the human context bus; verify the real
  // formula bar instead of mistaking the last human selection for view state.
  try {
    await until(() => evaluate(`Array.from(window.activeDesk().querySelector('iframe').contentDocument.querySelectorAll('.canvas input')).some(input => input.value.replace(/^=/, '') === 'B7-B5')`));
  } catch (error) {
    const navigation = await evaluate(`(() => { const frame = window.activeDesk().querySelector('iframe').contentDocument; return { parentError: window.activeDesk().querySelector('.analysis-content > .failure[role="alert"]')?.textContent, frameError: frame.querySelector('.error')?.textContent, status: frame.querySelector('.status')?.textContent, inputs: Array.from(frame.querySelectorAll('input')).map(input => ({ value: input.value, placeholder: input.placeholder })), text: frame.body.textContent.slice(-2500) }; })()`);
    await writeFile(join(output, 'navigation-failure.json'), JSON.stringify(navigation, null, 2));
    throw new Error(`Cell navigation failed: ${JSON.stringify(navigation)}`, { cause: error });
  }
  check('cell evidence navigates the live canvas to B8', true);
  check('evidence navigation targets its own canvas with a competing workbook view open', await evaluate(`window.activeDesk().querySelector('iframe').contentDocument.querySelector('[data-testid="reveal-status"]')?.dataset.revealStatus === 'applied' && JSON.stringify(Array.from(document.querySelector('#competing-canvas').contentDocument.querySelectorAll('.canvas input')).map(input => input.value)) === ${JSON.stringify(JSON.stringify(siblingInputs))}`));
  await evaluate(`document.querySelector('#competing-canvas').remove()`);
  const selection = await json(`/api/context?path=${name}`);
  for (const label of ['Scenarios', 'Tie out']) {
    await evaluate(`Array.from(window.activeDesk().querySelectorAll('.mode-tabs button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
    await evaluate(`window.activeDesk().querySelector('.selection-button').click()`);
    const expected = label === 'Scenarios' ? selection.context.selection.split(':')[0] : selection.context.selection;
    await until(() => evaluate(`window.activeDesk().querySelector('fieldset input').value === ${JSON.stringify(expected)}`));
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
    window.activeDesk().querySelector('.selection-button').click();
    Array.from(window.activeDesk().querySelectorAll('.mode-tabs button')).find(button => button.textContent === 'Explain').click();
  })()`);
  await pause(100);
  await evaluate(`window.releaseSelectionProbe()`);
  await pause(100);
  check('late selection response cannot overwrite a different analysis mode', await evaluate(`window.activeDesk().querySelector('fieldset select').value === 'Model' && window.activeDesk().querySelector('fieldset input').value === 'B8'`));
  check('no browser runtime exceptions', errors.length === 0);
  check('browser workflows did not change saved source', before.equals(await getBytes()));
  await send('Page.navigate', { url: `${origin}/index.html?wb=missing-release-probe.xlsx&embedded=1` });
  await until(() => evaluate(`document.querySelector('.status')?.textContent === 'workbook unavailable'`));
  check('an unavailable pinned workbook never falls back to another canvas', await evaluate(`document.querySelector('.error')?.textContent.includes('requested workbook') && !document.querySelector('.canvas canvas')`));
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: new URL(`file:///${join(output, 'decision-brief.html').replaceAll('\\', '/')}`).href });
  await until(() => evaluate(`document.querySelector('h1')?.textContent === 'Decision evidence'`));
  const outcomes = await evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('section')).map(section => {
    const heading = Array.from(section.querySelectorAll('h3')).find(node => node.textContent === 'Outcome');
    const parts = []; let node = heading?.nextElementSibling;
    while (node && node.tagName !== 'H3' && node.tagName !== 'DETAILS') { parts.push(node.textContent); node = node.nextElementSibling; }
    return [section.querySelector('h2').textContent.replace(/^\\d+\\. /, ''), parts.join(' ')];
  }))`);
  const expectedOutcomes = {
    sensitivity: ['Output:', 'B8', 'B3', 'B4', '360,000'],
    drivers: ['Baseline output:', '360,000', 'Low output', 'High output', 'B4', 'B3'],
    goalSeek: ['Target reached within tolerance', 'Candidate input', String(notebook.entries.find(entry => entry.result.action === 'goalSeek').result.solution)],
    variance: ['Baseline 1,000,000', 'Comparison source', '100,000', '-250,000', '150,000'],
    checks: ['2 passed; 0 failed', 'Comparison', 'Effective tolerance', '0.01', 'Passed'],
  };
  check('downloaded client brief renders all five readable analysis outcomes', Object.keys(outcomes).length === 5 && Object.entries(expectedOutcomes).every(([action, values]) => values.every(value => outcomes[action]?.includes(value))) && await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  const briefShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'decision-brief.png'), Buffer.from(briefShot.data, 'base64'));
  evidence.browserExceptions = errors;
} finally {
  socket?.close(); browser.kill();
  await pause(500);
  // Only the unique temporary browser profile created above is removed.
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await writeFile(join(output, 'release-checks.json'), JSON.stringify(evidence, null, 2));
}
console.log(`${evidence.checks.length} release checks passed; evidence: ${output}`);
