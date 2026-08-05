/**
 * The Mog Canvas MCP Apps component.
 *
 * Runs inside the host's sandboxed iframe, loaded by the bootstrap HTML that
 * server/mcp/mog-canvas-server.ts serves as the ui:// resource. Talks to the
 * host over postMessage via @modelcontextprotocol/ext-apps' App class, and to
 * the MCP server only through tools proxied by the host:
 *
 *   open_workbook result  -> arrives as a tool-result notification (sessionId)
 *   fetch_workbook_bytes  -> workbook bytes in, as base64
 *   save_workbook         -> edited bytes out; refused on revision conflict
 *   save_screenshot       -> PNG of the current view, written next to the file
 *
 * The canvas is the real @mog-sdk/spreadsheet-app, mounted through the same
 * adapter the dev app uses (src/adapters). Engine assets (wasm, fonts) load
 * from the loopback asset host — this bundle's own origin — which the server
 * declared in the resource's CSP metadata. Workbook bytes never touch HTTP.
 */
import './mcp-app.css';
import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  resolveCanvasAdapter,
  type CanvasContextSnapshot,
  type CanvasSession,
  type ColorScheme,
} from '../../../../src/adapters';

// MCP Apps hosts render this document in a sandboxed iframe, typically without
// allow-same-origin, so the document has an opaque origin and merely touching
// window.localStorage throws a SecurityError. The engine reads web storage
// during startup, so install an in-memory stand-in before the engine module
// loads. State then lives per iframe instance — the most a sandboxed app can
// offer, and fine here: the workbook itself is persisted through MCP tools.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const accessible = (() => {
    try {
      return window[name] != null;
    } catch {
      return false;
    }
  })();
  if (!accessible) {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    };
    try {
      Object.defineProperty(window, name, { value: storage, configurable: true });
    } catch {
      // If the property cannot be replaced the engine's own error surfaces.
    }
  }
}

// This module is served from `${assetOrigin}/ui/mcp-app.js`, so its own origin
// is the asset host. The engine's wasm/fonts live under /mog/ on that origin.
const ASSET_ORIGIN = new URL(import.meta.url).origin;
const ASSET_BASE = `${ASSET_ORIGIN}/mog/`;
const SCREENSHOT_RANGE = 'A1:H30';

interface OpenInfo {
  sessionId: string;
  name: string;
  revision: string;
}

// ---- Minimal chrome ---------------------------------------------------------

const root = document.getElementById('root');
if (!root) throw new Error('mcp-app: #root missing from bootstrap document');
root.innerHTML = `
  <div class="shell">
    <header class="bar">
      <span id="wb-name" class="name">Mog Canvas</span>
      <span id="dirty" class="dirty" hidden title="Unsaved changes">●</span>
      <span class="spacer"></span>
      <button id="save" disabled>Save</button>
      <button id="shot" disabled>Screenshot</button>
    </header>
    <div id="canvas" class="canvas"></div>
    <footer class="bar">
      <span id="status">connecting to host…</span>
      <span id="fidelity" class="warn"></span>
      <span id="coord" class="warn"></span>
      <span id="error" class="error"></span>
    </footer>
  </div>`;

const el = {
  name: document.getElementById('wb-name') as HTMLSpanElement,
  dirty: document.getElementById('dirty') as HTMLSpanElement,
  save: document.getElementById('save') as HTMLButtonElement,
  shot: document.getElementById('shot') as HTMLButtonElement,
  canvas: document.getElementById('canvas') as HTMLDivElement,
  status: document.getElementById('status') as HTMLSpanElement,
  fidelity: document.getElementById('fidelity') as HTMLSpanElement,
  coord: document.getElementById('coord') as HTMLSpanElement,
  error: document.getElementById('error') as HTMLSpanElement,
};

interface FidelityLike {
  status: 'passed' | 'failed' | 'unverified';
  reason: string;
  checkedCells: number;
}

/** Persistent, never concealed: anything short of `passed` stays on screen. */
function setFidelity(fidelity: FidelityLike | null): void {
  if (!fidelity) {
    el.fidelity.textContent = '';
    return;
  }
  el.fidelity.textContent =
    fidelity.status === 'passed'
      ? `fidelity: passed (${fidelity.checkedCells} cells)`
      : `Value fidelity ${fidelity.status}: ${fidelity.reason}`;
  el.fidelity.classList.toggle('ok', fidelity.status === 'passed');
}

function setStatus(text: string): void {
  el.status.textContent = text;
}

/** Presence-coordination health: while set, agents cannot see where the human is. */
function setCoordinationWarning(text: string | null): void {
  el.coord.textContent = text ?? '';
}

function setError(error: unknown): void {
  el.error.textContent =
    error == null ? '' : error instanceof Error ? error.message : String(error);
}

// ---- Tool-call plumbing -----------------------------------------------------

/** Unwrap a tool result: structuredContent on success, a thrown Error (with
 * the server's structured code preserved) on isError. */
function payload<T>(result: CallToolResult): T {
  if (result.isError) {
    const text =
      result.content?.find(
        (item): item is { type: 'text'; text: string } => item.type === 'text',
      )?.text ?? 'Tool call failed';
    let body: { code?: string; message?: string } & Record<string, unknown>;
    try {
      body = JSON.parse(text) as { code?: string; message?: string } & Record<string, unknown>;
    } catch {
      body = { message: text };
    }
    const error = new Error(body.message ?? text);
    // The full structured body travels with the error: a fidelity refusal
    // carries the report that must replace any stale "passed" on screen.
    Object.assign(error, { code: body.code, details: body });
    throw error;
  }
  return (result.structuredContent ?? {}) as T;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- App lifecycle ----------------------------------------------------------

const app = new App({ name: 'mog-canvas', version: '0.1.0' });

let current: { info: OpenInfo; session: CanvasSession } | null = null;
let opening = false;

/** Coalesced presence reporting + command polling timers for the open canvas. */
const CONTEXT_THROTTLE_MS = 300;
const COMMAND_POLL_MS = 1500;
let contextTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pending: CanvasContextSnapshot | null = null;

function stopContextTimers(): void {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function hostColorScheme(): ColorScheme {
  const theme = app.getHostContext()?.theme;
  return theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
}

function applyTheme(): void {
  const theme = app.getHostContext()?.theme;
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.style.colorScheme = theme;
    document.documentElement.dataset.theme = theme;
  }
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return payload<T>(await app.callServerTool({ name, arguments: args }));
}

/** One open_workbook result → one live canvas. A newer open replaces the
 * previous session cleanly; a mid-open duplicate is ignored. */
async function openFromToolResult(result: CallToolResult): Promise<void> {
  if (opening) return;
  opening = true;
  setError(null);
  try {
    const info = payload<OpenInfo>(result);
    setStatus(`loading ${info.name}…`);
    el.name.textContent = info.name;

    if (current) {
      stopContextTimers();
      await current.session.dispose().catch(() => undefined);
      current = null;
      el.canvas.replaceChildren();
      setFidelity(null);
      setCoordinationWarning(null);
    }

    const fetched = await callTool<{ xlsxBase64: string; revision: string }>(
      'fetch_workbook_bytes',
      { sessionId: info.sessionId },
    );

    const adapter = await resolveCanvasAdapter();
    if (!adapter.probe.available) throw new Error(adapter.probe.detail);

    const session = await adapter.open(
      el.canvas,
      {
        fileName: info.name,
        bytes: fromBase64(fetched.xlsxBase64),
        colorScheme: hostColorScheme(),
        assetBase: ASSET_BASE,
      },
      {
        async persist(bytes) {
          // The component-only human lane: attribution happens server-side.
          try {
            const saved = await callTool<{ revision: string; fidelity?: FidelityLike }>(
              'save_workbook_canvas',
              {
                sessionId: info.sessionId,
                xlsxBase64: toBase64(bytes),
              },
            );
            setFidelity(saved.fidelity ?? null);
            return { versionId: saved.revision };
          } catch (error) {
            // A refused save must replace any stale "passed" on screen: show
            // the refusal's own fidelity report, or nothing, never the old one.
            const details = (error as { details?: { fidelity?: FidelityLike } }).details;
            setFidelity(details?.fidelity ?? null);
            throw error;
          }
        },
        onDirtyChange(dirty) {
          el.dirty.hidden = !dirty;
        },
        onStatus(status) {
          setStatus(status);
        },
        onError(error) {
          setError(error);
        },
        onContext(snapshot) {
          // Coalesce: keep only the newest snapshot per throttle window. The
          // bus is latest-state-only, so dropped intermediates lose nothing.
          pending = snapshot;
          contextTimer ??= setTimeout(() => {
            contextTimer = null;
            const next = pending;
            pending = null;
            if (!next || current?.info.sessionId !== info.sessionId) return;
            void callTool<{ accepted: boolean; reason?: string }>('report_canvas_context', {
              sessionId: info.sessionId,
              ...next,
            }).then(
              (result) => {
                // A rejected report means agents are coordinating against
                // presence this canvas no longer owns — say so, don't hide it.
                setCoordinationWarning(
                  result.accepted ? null : `presence not accepted: ${result.reason ?? 'rejected'}`,
                );
              },
              (error) => {
                setCoordinationWarning(
                  `presence reporting failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              },
            );
          }, CONTEXT_THROTTLE_MS);
        },
      },
    );

    current = { info, session };
    el.save.disabled = false;
    el.shot.disabled = false;

    // Navigation-only command channel: agents queue reveals, the canvas polls.
    pollTimer = setInterval(() => {
      if (current?.info.sessionId !== info.sessionId) return;
      void callTool<{ commands: { range: string; sheet: string | null }[] }>(
        'poll_canvas_commands',
        { sessionId: info.sessionId },
      )
        .then(async ({ commands }) => {
          const live = current;
          if (!live?.session.reveal || commands.length === 0) return;
          const last = commands[commands.length - 1];
          await live.session.reveal(last.range, last.sheet);
        })
        .catch(() => undefined);
    }, COMMAND_POLL_MS);

    setStatus(`ready — ${info.name}`);
  } catch (error) {
    setError(error);
    setStatus('open failed');
  } finally {
    opening = false;
  }
}

el.save.addEventListener('click', () => {
  if (!current) return;
  setError(null);
  current.session.save().then(
    () => setStatus('saved to disk'),
    (error) => {
      setError(error);
      setStatus('save failed — the file on disk was not replaced');
    },
  );
});

el.shot.addEventListener('click', () => {
  if (!current) return;
  const { info, session } = current;
  setError(null);
  setStatus('capturing screenshot…');
  session
    .screenshot(SCREENSHOT_RANGE)
    .then((png) =>
      callTool<{ name: string }>('save_screenshot', {
        name: info.name.replace(/\.xlsx$/i, '.png'),
        pngBase64: toBase64(png),
      }),
    )
    .then(
      (saved) => setStatus(`screenshot saved as ${saved.name}`),
      (error) => {
        setError(error);
        setStatus('screenshot failed');
      },
    );
});

// Handlers are registered before connect() so a tool result delivered right
// after the handshake is never dropped.
app.ontoolresult = (result) => void openFromToolResult(result);
app.onhostcontextchanged = () => applyTheme();

await app.connect();
applyTheme();
setStatus('connected — waiting for a workbook…');
