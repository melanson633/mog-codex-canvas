/**
 * Browser smoke test: does the Mog canvas actually mount and render?
 *
 * Launches an isolated headless Chrome against a already-running dev server,
 * waits for the embed to report ready, then asserts on the live DOM and writes
 * a screenshot. Uses its own temp profile, so the user's Chrome is untouched.
 *
 *   npm run dev            # in one shell
 *   node scripts/browser-smoke.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbook } from '@mog-sdk/sdk';

const url = process.argv[2] ?? 'http://127.0.0.1:5273';
const port = 9333;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotPath = join(projectRoot, 'workbooks', 'browser-smoke.png');
const samplePath = join(projectRoot, 'workbooks', 'sample.xlsx');

/** Read A6 up front so the value we type is guaranteed to differ from what is
 *  already on disk — otherwise a silently failing save would look like a pass. */
async function readA6() {
  const book = await createWorkbook(samplePath);
  try {
    return await book.activeSheet.getValue('A6');
  } finally {
    await book.dispose();
  }
}

const before = await readA6();
const typed = String(before) === '4242' ? '1337' : '4242';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const profile = await mkdtemp(join(tmpdir(), 'mog-smoke-'));
const chrome = spawn(
  CHROME_CANDIDATES[0],
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=520,900',
    url,
  ],
  { stdio: 'ignore' },
);

/** Poll a CDP HTTP endpoint until it answers or the deadline passes. */
async function poll(path, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const body = await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());
      const hit = predicate(body);
      if (hit) return hit;
    } catch {
      /* browser not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let ws;
try {
  const target = await poll(
    '/json/list',
    (list) => list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1')),
    60_000,
    'the page target',
  );

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error('CDP socket failed')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const badResponses = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    // A wasm/font URL that silently falls back to index.html is the failure mode
    // this app is most likely to hit, so surface every non-2xx and every asset
    // that came back as HTML.
    if (message.method === 'Network.responseReceived') {
      const { status, url: responseUrl, mimeType } = message.params.response;
      const looksWrong =
        status >= 400 ||
        (/\.(wasm|ttf)$/i.test(responseUrl) && mimeType === 'text/html');
      if (looksWrong) badResponses.push(`${status} ${mimeType} ${responseUrl}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
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
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await send('Runtime.enable');
  await send('Network.enable');

  // The embed pulls a ~41 MB wasm binary on first load; allow real time for it.
  const state = await (async () => {
    const deadline = Date.now() + 180_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await evaluate(`(() => {
        const status = document.querySelector('.status')?.textContent ?? '';
        const badge = document.querySelector('.badge')?.textContent ?? '';
        const canvas = document.querySelector('.canvas');
        return {
          status,
          badge,
          error: document.querySelector('.error')?.textContent ?? null,
          canvasChildren: canvas ? canvas.children.length : 0,
          canvasHtmlBytes: canvas ? canvas.innerHTML.length : 0,
          canvasElements: canvas ? canvas.querySelectorAll('*').length : 0,
          gridCanvases: document.querySelectorAll('.canvas canvas').length,
          sheetTabText: Array.from(document.querySelectorAll('.canvas [class*="sheet" i]'))
            .map((n) => n.textContent?.trim())
            .filter(Boolean)
            .slice(0, 6),
        };
      })()`);
      if (last.status === 'ready' || last.error) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return last;
  })();

  console.log(`\nstatus="${state.status}"  adapter="${state.badge}"`);
  if (state.error) console.log(`page error: ${state.error}`);

  check('adapter resolved to the real Mog embed', state.badge.includes('@mog-sdk/spreadsheet-app'));
  check('canvas host reported ready', state.status === 'ready', `status="${state.status}"`);
  check('no page-level error surfaced', !state.error, state.error ?? '');
  check(
    'embed rendered a real DOM tree into the canvas',
    state.canvasElements > 50,
    `${state.canvasElements} elements, ${state.canvasHtmlBytes} bytes of html`,
  );
  check('grid <canvas> element present', state.gridCanvases > 0, `${state.gridCanvases} found`);

  // The grid itself is painted to <canvas>, so cell text never reaches the DOM.
  // The formula bar is a real <input>, and it mirrors the selected cell — that
  // is the only DOM-observable proof the workbook's data reached the UI.
  const cellProbe = await evaluate(`(() => {
    const values = Array.from(document.querySelectorAll('.canvas input'))
      .map((n) => n.value)
      .filter(Boolean);
    return {
      values,
      hasSheetTab: /Sheet1/.test(document.querySelector('.canvas')?.innerText ?? ''),
    };
  })()`);
  check(
    'sample.xlsx cell data reached the formula bar',
    cellProbe.values.includes('Line item'),
    `inputs=[${cellProbe.values.join(' | ')}]`,
  );
  check('sheet tab rendered', cellProbe.hasSheetTab);

  // Edit -> save -> disk, driven entirely through the live canvas: click a cell,
  // type into the grid, hit the host's Save button, then read the file back with
  // the headless engine. This is the only check that exercises the embed's
  // onSaveRequest -> host.persist -> PUT /api/workbook chain.
  // Click anywhere in the grid to take focus, then navigate by key: pixel math
  // against a canvas-painted grid is off-by-one-row at the slightest layout change.
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: 60, y: 346, button: 'left', clickCount: 1 });
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

  const saveStatus = await (async () => {
    await evaluate(`(() => {
      const save = Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent.trim() === 'Save');
      save.click();
    })()`);
    const deadline = Date.now() + 60_000;
    let status = '';
    while (Date.now() < deadline) {
      status = await evaluate(`document.querySelector('.status')?.textContent ?? ''`);
      if (status === 'saved to disk' || status.includes('failed')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return status;
  })();
  check('Save button reported a completed save', saveStatus === 'saved to disk', saveStatus);

  const after = await readA6();
  check(
    'cell typed in the canvas landed in the .xlsx on disk',
    String(after) === typed,
    `A6 was ${JSON.stringify(before)}, now ${JSON.stringify(after)}, expected ${typed}`,
  );

  if (badResponses.length > 0) {
    console.log(`\nbad/misrouted responses (${badResponses.length}):`);
    for (const line of new Set(badResponses)) console.log(`  ${line}`);
  }

  if (consoleErrors.length > 0) {
    console.log(`\nconsole errors (${consoleErrors.length}):`);
    for (const line of consoleErrors.slice(0, 5)) console.log(`  ${line.slice(0, 300)}`);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot: ${shotPath}`);
} finally {
  ws?.close();
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures === 0 ? '\nBrowser smoke passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
