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
  error: document.getElementById('error') as HTMLSpanElement,
};

function setStatus(text: string): void {
  el.status.textContent = text;
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
    let body: { code?: string; message?: string };
    try {
      body = JSON.parse(text) as { code?: string; message?: string };
    } catch {
      body = { message: text };
    }
    const error = new Error(body.message ?? text);
    (error as Error & { code?: string }).code = body.code;
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
      await current.session.dispose().catch(() => undefined);
      current = null;
      el.canvas.replaceChildren();
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
          const saved = await callTool<{ revision: string }>('save_workbook', {
            sessionId: info.sessionId,
            xlsxBase64: toBase64(bytes),
          });
          return { versionId: saved.revision };
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
      },
    );

    current = { info, session };
    el.save.disabled = false;
    el.shot.disabled = false;
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
