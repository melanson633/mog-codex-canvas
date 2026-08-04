/**
 * The Mog Canvas MCP server: tools + MCP Apps UI resource.
 *
 * This is the product surface of the Claude Code plugin. Every tool is a thin,
 * structured wrapper over the shared workbook service (../workbook-service),
 * which owns containment, staged writes, revision identity, and validation —
 * the MCP lane gets exactly the same guarantees as the dev app and the
 * headless scripts, because it is the same code.
 *
 * The UI resource (`ui://mog-canvas/canvas.html`) is a small bootstrap
 * document; the real component bundle, the Mog embed runtime, its WASM and
 * fonts are served by the loopback asset host (./asset-host) whose origin is
 * declared in the resource's CSP metadata. Workbook bytes never travel over
 * that HTTP server — they move exclusively through MCP tools as base64.
 *
 * Tool errors are returned as isError results whose text is a JSON object
 * `{ code, message, ...details }` from WorkbookError, so callers (model or
 * component) can act on the failure instead of parsing prose.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WorkbookError, type WorkbookService } from '../workbook-service.ts';

export const UI_RESOURCE_URI = 'ui://mog-canvas/canvas.html';

export interface MogCanvasServerOptions {
  readonly service: WorkbookService;
  /** Origin of the loopback asset host, e.g. "http://127.0.0.1:52731". */
  readonly assetOrigin: string;
  readonly version?: string;
}

function fail(error: unknown): CallToolResult {
  const body =
    error instanceof WorkbookError
      ? { code: error.code, message: error.message, ...error.details }
      : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function ok(structured: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** Wraps a tool body so every WorkbookError comes back structured, never thrown. */
function guarded<Args extends unknown[]>(
  body: (...args: Args) => Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await body(...args);
    } catch (error) {
      return fail(error);
    }
  };
}

export function createMogCanvasServer(options: MogCanvasServerOptions): McpServer {
  const { service, assetOrigin } = options;
  const server = new McpServer({ name: 'mog-canvas', version: options.version ?? '0.1.0' });

  // ---- UI resource -------------------------------------------------------
  // The CSP declaration is the load-bearing part: the component may connect
  // to (wasm fetch, module loading) and load static assets from the loopback
  // asset host, and nowhere else.
  const cspMeta = {
    ui: {
      csp: {
        connectDomains: [assetOrigin],
        resourceDomains: [assetOrigin],
      },
      prefersBorder: false,
    },
  };

  registerAppResource(
    server,
    'Mog Spreadsheet Canvas',
    UI_RESOURCE_URI,
    { description: 'Interactive Mog spreadsheet canvas for authorized XLSX workbooks', _meta: cspMeta },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: [
            '<!doctype html>',
            '<html>',
            '<head>',
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            `<link rel="stylesheet" href="${assetOrigin}/ui/mcp-app.css">`,
            '<title>Mog Canvas</title>',
            '</head>',
            '<body>',
            '<div id="root"></div>',
            `<script type="module" src="${assetOrigin}/ui/mcp-app.js"></script>`,
            '</body>',
            '</html>',
          ].join('\n'),
          _meta: cspMeta,
        },
      ],
    }),
  );

  // ---- Model-facing tools ------------------------------------------------

  server.registerTool(
    'list_workbooks',
    {
      title: 'List workbooks',
      description:
        'List the .xlsx workbooks in the authorized workbook root. Names are relative selectors for the other tools; no other filesystem paths are accepted anywhere.',
      inputSchema: {},
    },
    guarded(async () => ok({ root: service.root, files: await service.list() })),
  );

  registerAppTool(
    server,
    'open_workbook',
    {
      title: 'Open workbook canvas',
      description:
        'Open an authorized workbook in the interactive Mog spreadsheet canvas. Returns a session whose revision protects later saves from silently overwriting concurrent changes.',
      inputSchema: { name: z.string().describe('Workbook name relative to the authorized root, e.g. "sample.xlsx"') },
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URI },
        // ChatGPT Apps SDK compatibility alias for the same declaration.
        'openai/outputTemplate': UI_RESOURCE_URI,
      },
    },
    guarded(async ({ name }: { name: string }) => {
      const opened = await service.openSession(name);
      return ok(
        {
          sessionId: opened.sessionId,
          name: opened.name,
          size: opened.size,
          modified: opened.modified,
          revision: opened.revision,
        },
        `Opened ${opened.name} (${opened.size} bytes) in the Mog canvas. Session ${opened.sessionId}.`,
      );
    }),
  );

  server.registerTool(
    'get_workbook_session',
    {
      title: 'Get workbook session',
      description:
        'Report an open session and whether its revision still matches the file on disk (inSync=false means the workbook changed since it was opened).',
      inputSchema: { sessionId: z.string() },
    },
    guarded(async ({ sessionId }: { sessionId: string }) => {
      const session = service.getSession(sessionId);
      const current = await service.read(session.name);
      return ok({ ...session, diskRevision: current.revision, inSync: current.revision === session.revision });
    }),
  );

  server.registerTool(
    'save_workbook',
    {
      title: 'Save workbook',
      description:
        'Save edited workbook bytes (base64 xlsx) through an open session. Refused with code "revision-conflict" if the file changed on disk since the session opened; the attempted bytes are then preserved as a .conflict-*.xlsx sibling and nothing is overwritten.',
      inputSchema: {
        sessionId: z.string(),
        xlsxBase64: z.string().describe('The full workbook as base64-encoded .xlsx bytes'),
      },
    },
    guarded(async ({ sessionId, xlsxBase64 }: { sessionId: string; xlsxBase64: string }) => {
      const bytes = Buffer.from(xlsxBase64, 'base64');
      const saved = await service.saveSession(sessionId, bytes);
      return ok(
        { ...saved },
        `Saved ${saved.name} (${saved.bytes} bytes, revision ${saved.revision.slice(0, 12)}…). Previous version kept as ${saved.backup ?? 'n/a'}.`,
      );
    }),
  );

  server.registerTool(
    'validate_workbook',
    {
      title: 'Validate workbook',
      description:
        'Reopen a saved workbook with the headless Mog engine and read it back: sheet names, used ranges, and the current on-disk revision. This is the proof a save produced a loadable file.',
      inputSchema: { name: z.string() },
    },
    guarded(async ({ name }: { name: string }) => {
      const report = await service.validate(name);
      return ok({ ...report });
    }),
  );

  server.registerTool(
    'screenshot_workbook',
    {
      title: 'Screenshot workbook',
      description:
        'Render a PNG of a saved workbook range with the headless Mog engine and write it next to the workbook (or to outName, a .png name inside the root).',
      inputSchema: {
        name: z.string(),
        range: z.string().optional().describe('Cell range, default A1:H30'),
        outName: z.string().optional().describe('Target .png name relative to the root'),
      },
    },
    guarded(async ({ name, range, outName }: { name: string; range?: string; outName?: string }) => {
      const shot = await service.captureScreenshot(name, range, outName);
      return ok({ ...shot });
    }),
  );

  server.registerTool(
    'close_workbook_session',
    {
      title: 'Close workbook session',
      description: 'Close an open workbook session. Unsaved canvas changes are discarded.',
      inputSchema: { sessionId: z.string() },
    },
    guarded(async ({ sessionId }: { sessionId: string }) => {
      service.closeSession(sessionId);
      return ok({ closed: sessionId });
    }),
  );

  // ---- Component-only tools (visibility: app) ----------------------------
  // The canvas iframe fetches and persists workbook bytes through these; they
  // are not offered to the model, whose lane is the tools above.

  registerAppTool(
    server,
    'fetch_workbook_bytes',
    {
      title: 'Fetch workbook bytes (canvas)',
      description: 'Internal: the canvas component fetches the bytes of an open session.',
      inputSchema: { sessionId: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    guarded(async ({ sessionId }: { sessionId: string }) => {
      const session = service.getSession(sessionId);
      const { bytes, revision } = await service.read(session.name);
      return ok({
        name: session.name,
        revision,
        sessionRevision: session.revision,
        xlsxBase64: Buffer.from(bytes).toString('base64'),
      });
    }),
  );

  registerAppTool(
    server,
    'save_screenshot',
    {
      title: 'Save canvas screenshot (canvas)',
      description: 'Internal: the canvas component writes a PNG it captured to the workbook root.',
      inputSchema: { name: z.string(), pngBase64: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    guarded(async ({ name, pngBase64 }: { name: string; pngBase64: string }) => {
      const saved = await service.writeScreenshot(name, Buffer.from(pngBase64, 'base64'));
      return ok({ ...saved });
    }),
  );

  return server;
}
