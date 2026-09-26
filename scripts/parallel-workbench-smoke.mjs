/**
 * Isolated browser regression for the parallel financial workbench.
 *
 * Imports a disposable local XLSX, opens a second workbook tab, proves the
 * inactive iframe and saved note survive tab switches, then runs two real
 * agent notes on separate workbooks. One proposal is applied only to B2 in a
 * synthetic blank workbook. The temporary browser profile and upload are
 * removed afterward; server-side workbooks and agent receipts remain release
 * evidence by design.
 *
 *   node scripts/parallel-workbench-smoke.mjs http://127.0.0.1:5280 artifacts/parallel-workbench
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserExecutable } from './browser-executable.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:5276';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Use an explicit loopback origin.');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[3] ?? 'artifacts/parallel-workbench');
await mkdir(output, { recursive: true });
const evidence = { origin, checkedAt: new Date().toISOString(), checks: [], timings: {} };
const health = await (await fetch(origin + '/health')).json();
evidence.release = health.release;
if (process.argv[4]) assert.equal(health.release, process.argv[4]);
const check = (label, ok) => { assert.ok(ok, label); evidence.checks.push(label); console.log(`PASS ${label}`); };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const profile = await mkdtemp(join(tmpdir(), 'mog-parallel-browser-'));
const uploadDir = await mkdtemp(join(tmpdir(), 'mog-parallel-upload-'));
const importedSource = join(uploadDir, `Imported synthetic ${Date.now()}.xlsx`);
await copyFile(join(project, 'workbooks', 'sample.xlsx'), importedSource);
const port = 10_000 + Math.floor(Math.random() * 2_000);
const browser = spawn(resolveBrowserExecutable(), [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', origin,
], { stdio: 'ignore', windowsHide: true });

async function until(fn, label, timeout = 180_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${String(last)}`);
}

let socket;
try {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page' && item.url.startsWith(origin)), 'browser page', 60_000);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('[role="tabpanel"]:not([hidden])')`), 'initial active tab');
  await evaluate(`window.activeDesk = () => document.querySelector('[role="tabpanel"]:not([hidden])')`);
  const active = (selector) => `window.activeDesk().querySelector(${JSON.stringify(selector)})`;
  const activeAll = (selector) => `window.activeDesk().querySelectorAll(${JSON.stringify(selector)})`;
  const clickAgent = label => evaluate(`Array.from(${activeAll('[data-testid="agent-desk"] button')}).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const shot = async name => { const image = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name), Buffer.from(image.data, 'base64')); };

  // File-picker import is the user-facing local-file path, not an API shortcut.
  const documentNode = await send('DOM.getDocument');
  const inputNode = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[role="tabpanel"]:not([hidden]) input[type="file"][aria-label="Choose local workbooks"]' });
  await send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [importedSource] });
  await until(() => evaluate(`${active('select[id$="-workbook"]')}?.value.endsWith('.xlsx') && ${active('iframe')}?.contentDocument?.querySelector('.status')?.textContent === 'renderer ready'`), 'imported workbook canvas');
  const importedName = await evaluate(`${active('select[id$="-workbook"]')}.value`);
  const firstFrameIdentity = await evaluate(`window.firstFrameIdentity = ${active('iframe')}; true`);
  check('local XLSX import opens a live workbook tab', !!importedName && firstFrameIdentity);
  const originalBytes = await readFile(importedSource);
  check('local picker imports an exact working copy', originalBytes.equals(Buffer.from(await (await fetch(`${origin}/api/workbook?path=${encodeURIComponent(importedName)}`)).arrayBuffer())));

  // A saved note is deliberately outside the analysis form; it must survive a
  // tab switch and a page reload because its state is server-persisted.
  await evaluate(`(() => { const desk = ${active('[data-testid="agent-desk"]')}; desk.open = true; const field = desk.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Keep this synthetic imported-workbook note for persistence verification.'); field.dispatchEvent(new Event('input', { bubbles: true }));  })()`);
  await clickAgent('Save note');
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Note saved on this computer.')`), 'saved note');
  check('note saves outside the analysis form', await evaluate(`${active('[data-testid="agent-desk"]')}.textContent.includes('Keep this synthetic imported-workbook note')`));
  await evaluate(`(() => { const field = ${active('[data-testid="agent-desk"] textarea')}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Unsaved note draft stays with this workbook.'); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  const blankName = `Parallel agent blank ${Date.now()}.xlsx`;
  await evaluate(`${active('[data-testid="new-workbook"]')}.click()`);
  await until(() => evaluate(`${active('.new-workbook-dialog')}?.open`), 'new workbook dialog');
  await evaluate(`(() => { const field = ${active('[data-testid$="-new-workbook-name"]')}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(blankName)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`${active('[data-testid="create-workbook"]')}.click()`);
  await until(() => evaluate(`${active('select[id$="-workbook"]')}?.value === ${JSON.stringify(blankName)} && ${active('iframe')}?.contentDocument?.querySelector('.status')?.textContent === 'renderer ready'`), 'second workbook tab');
  check('creating from an open workbook creates and activates a second tab', await evaluate(`document.querySelectorAll('[role="tab"]').length === 2`));
  await evaluate(`document.querySelector('[role="tab"][aria-selected="false"]').click()`);
  await until(() => evaluate(`${active('select[id$="-workbook"]')}?.value === ${JSON.stringify(importedName)}`), 'return to imported tab');
  check('inactive workbook retains its iframe identity', await evaluate(`${active('iframe')} === window.firstFrameIdentity`));
  check('saved note survives a tab switch', await evaluate(`${active('[data-testid="agent-desk"]')}.textContent.includes('Keep this synthetic imported-workbook note')`));
  check('unsaved note draft survives a tab switch', await evaluate(`${active('[data-testid="agent-desk"] textarea')}.value === 'Unsaved note draft stays with this workbook.'`));

  const expansion = await evaluate(`(async () => { const frame = ${active('iframe')}; const button = ${active('[data-testid="full-canvas"]')}; const started = performance.now(); button.click(); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); return { elapsedMs: performance.now() - started, sameFrame: ${active('iframe')} === frame, expanded: button.getAttribute('aria-pressed') }; })()`);
  evidence.timings.fullCanvasToggleMs = expansion.elapsedMs;
  check('full canvas expands the existing iframe without reloading', expansion.sameFrame && expansion.expanded === 'true');
  await shot('full-canvas.png');
  await evaluate(`${active('[data-testid="full-canvas"]')}.click()`);

  // Run a read-only job on the imported tab, then a B2-only proposal on the
  // blank tab. Separate workbook names let the two-slot worker run in parallel.
  await clickAgent('New note');
  await evaluate(`(() => { const desk = ${active('[data-testid="agent-desk"]')}; desk.open = true; const field = desk.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Briefly summarize the saved evidence in this scope. Do not propose any workbook changes; return changes as an empty list.'); field.dispatchEvent(new Event('input', { bubbles: true }));  })()`);
  await clickAgent('Save & run');
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Task queued.')`), 'imported agent task queued');
  await evaluate(`document.querySelector('[role="tab"][aria-selected="false"]').click()`);
  await until(() => evaluate(`${active('select[id$="-workbook"]')}?.value === ${JSON.stringify(blankName)}`), 'blank agent tab');
  await evaluate(`(() => { const desk = ${active('[data-testid="agent-desk"]')}; desk.open = true; const inputs = desk.querySelectorAll('input'); const range = Array.from(inputs).find(input => input.closest('label')?.textContent.includes('Task range')); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, 'B2'); range.dispatchEvent(new Event('input', { bubbles: true })); const field = desk.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Propose exactly one safe literal workbook edit: set Sheet1!B2 to numeric 42. Return that proposed change and no other changes.'); field.dispatchEvent(new Event('input', { bubbles: true }));  })()`);
  await clickAgent('Save & run');
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Task queued.')`), 'blank agent task queued');
  const readJobs = async () => Promise.all([importedName, blankName].map(name => fetch(`${origin}/api/agent-tasks?name=${encodeURIComponent(name)}`).then(response => response.json())));
  const concurrent = await until(async () => { const state = await readJobs(); return state.every(item => item.jobs.some(job => job.status === 'running')) && state; }, 'two real jobs running at the same time', 15000);
  check('two actual model jobs run concurrently on distinct workbooks', !!concurrent);
  evidence.concurrentJobs = concurrent.map(item => item.jobs.filter(job => job.status === 'running').map(job => ({ id: job.id, name: job.note.name, status: job.status })));
  await until(async () => {
    const [imported, blank] = await Promise.all([
      fetch(`${origin}/api/agent-tasks?name=${encodeURIComponent(importedName)}`).then(response => response.json()),
      fetch(`${origin}/api/agent-tasks?name=${encodeURIComponent(blankName)}`).then(response => response.json()),
    ]);
    return imported.jobs.some(job => job.status === 'completed') && blank.jobs.some(job => job.status === 'completed');
  }, 'two real agent jobs to complete', 300_000);
  check('two agent jobs complete across separate workbook tabs', true);
  evidence.agentResults = await readJobs();
  await writeFile(join(output, 'agent-results.json'), JSON.stringify(evidence.agentResults, null, 2));
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Preview')`), 'B2 proposal preview');
  check('agent proposal preview is limited to synthetic blank B2', await evaluate(`(() => { const desk = ${active('[data-testid="agent-desk"]')}; return desk.textContent.includes('Sheet1!B2') && !desk.textContent.includes('Sheet1!A1'); })()`));
  await evaluate(`Array.from(${activeAll('[data-testid="agent-desk"] summary')}).find(summary => summary.textContent.startsWith('Preview')).click()`);
  await evaluate(`Array.from(${activeAll('[data-testid="agent-desk"] button')}).find(button => button.textContent.trim() === 'Apply these changes').scrollIntoView({block:'center'})`);
  await shot('agent-proposal.png');
  await clickAgent('Apply these changes');
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Changes saved')`), 'agent proposal apply');
  const b2 = await fetch(`${origin}/api/analyst`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context', name: blankName, sheet: 'Sheet1', range: 'B2' }) }).then(response => response.json());
  check('applied agent proposal writes only the reviewed B2 value', b2.cells?.length === 1 && b2.cells[0].address === 'B2' && b2.cells[0].value === 42);
  const savedJobs = await readJobs();
  check('applied proposal includes a save receipt and screenshot evidence', savedJobs[1].jobs.some(job => job.status === 'applied' && job.applyResult?.transactionId && job.applyResult?.screenshots?.length));
  check('local source file remains unchanged after workbench activity', originalBytes.equals(await readFile(importedSource)));
  await evaluate(`document.querySelector('[role="tab"][aria-selected="false"]').click()`);
  await until(() => evaluate(`${active('select[id$="-workbook"]')}?.value === ${JSON.stringify(importedName)}`), 'imported workbook before human edit');
  const point = await evaluate(`(() => { const frame = ${active('iframe')}; frame.scrollIntoView({block:'start'}); const outside = frame.getBoundingClientRect(); const inside = frame.contentDocument.querySelector('.canvas canvas').getBoundingClientRect(); return {x:outside.left + inside.left + 60,y:outside.top + inside.top + 60}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {type, ...point, button:'left', clickCount:1});
  const key = async params => { await send('Input.dispatchKeyEvent', {type:'rawKeyDown', ...params}); await send('Input.dispatchKeyEvent', {type:'keyUp', ...params}); };
  await key({key:'Home',code:'Home',windowsVirtualKeyCode:36,modifiers:2});
  for (let row = 0; row < 5; row++) await key({key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  for (const char of '777') { await send('Input.dispatchKeyEvent', {type:'keyDown',text:char,key:char}); await send('Input.dispatchKeyEvent', {type:'keyUp',key:char}); }
  await key({key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(() => evaluate(`!!${active('iframe')}.contentDocument.querySelector('.dot.dirty')`), 'human edit becomes dirty', 20000);
  await evaluate(`document.querySelector('[role="tab"][aria-selected="false"]').click()`);
  await evaluate(`document.querySelector('[role="tab"][aria-selected="false"]').click()`);
  check('unsaved human edits survive switching workbook tabs', await evaluate(`${active('iframe')} === window.firstFrameIdentity && !!${active('iframe')}.contentDocument.querySelector('.dot.dirty')`));
  await evaluate(`Array.from(${active('iframe')}.contentDocument.querySelectorAll('button')).find(button=>button.textContent.trim()==='Save').click()`);
  await until(async () => { const result = await fetch(origin+'/api/analyst',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'context',name:importedName,sheet:'Sheet1',range:'A6'})}).then(response=>response.json()); return result.cells?.some(cell=>cell.address==='A6' && String(cell.value)==='777'); }, 'preserved human edit saves to working copy');
  check('preserved human edit saves correctly after tab switching', true);
  await shot('desktop.png');

  await send('Page.navigate', { url: `${origin}/?wb=${encodeURIComponent(importedName)}` });
  await until(() => evaluate(`!!document.querySelector('[role="tabpanel"]:not([hidden])')`), 'reloaded workbench');
  await evaluate(`window.activeDesk = () => document.querySelector('[role="tabpanel"]:not([hidden])')`);
  await until(() => evaluate(`${active('select[id$="-workbook"]')}?.value === ${JSON.stringify(importedName)}`), 'reloaded imported selection');
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Keep this synthetic imported-workbook note')`), 'persisted note after reload');
  check('saved notes persist after a full page reload', true);
  await evaluate(`${active('[data-testid="agent-desk"]')}.open = true`);
  const beforeArchive = await fetch(`${origin}/api/agent-tasks?name=${encodeURIComponent(importedName)}`).then(response => response.json());
  check('completed synthetic request is available to archive', beforeArchive.jobs.some(job => job.status === 'completed'));
  await clickAgent('Archive finished requests');
  await until(() => evaluate(`${active('[data-testid="agent-desk"]')}?.textContent.includes('Archived 1 completed request')`), 'durable request archive');
  const afterArchive = await fetch(`${origin}/api/agent-tasks?name=${encodeURIComponent(importedName)}`).then(response => response.json());
  check('archiving finished requests preserves saved notes', afterArchive.jobs.length === 0 && afterArchive.notes.length === beforeArchive.notes.length);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  check('mobile parallel workbench has no horizontal overflow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
  await shot('mobile.png');
  check('no browser runtime exceptions', errors.length === 0);
  evidence.completed = true;
  await writeFile(join(output, 'parallel-workbench-checks.json'), JSON.stringify(evidence, null, 2));
} finally {
  await writeFile(join(output, 'parallel-workbench-checks.json'), JSON.stringify(evidence, null, 2));
  socket?.close();
  browser.kill();
  await pause(300);
  for (const path of [profile, uploadDir]) { const within = relative(resolve(tmpdir()), resolve(path)); if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Temporary cleanup containment failed.'); }
  await Promise.allSettled([rm(profile, { recursive: true, force: true }), rm(uploadDir, { recursive: true, force: true })]);
}
console.log(`${evidence.checks.length} parallel workbench checks passed; evidence: ${output}`);
