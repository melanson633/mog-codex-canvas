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

  // The last context epoch each canvas session reported. Session teardown may
  // clear only the context its own canvas owns — a blanket clear would erase
  // the presence of a second session sharing the same workbook.
  const sessionEpochs = new Map<string, number>();

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

  server.registerTool(
    'profile_workbook',
    {
      title: 'Profile workbook (byte-first)',
      description:
        'Read a workbook\'s shape straight from its saved OOXML bytes in milliseconds, without opening the Mog engine: per-sheet rows/cells/formulas, cross-sheet reference ratio, table and comment parts, and a labeled genre guess. The provenance string travels with the numbers: this is the truth of the last save on disk, never unsaved canvas edits. Unreadable bytes come back as a typed "unreadable" profile with the reason — unknown is never reported as empty. Use this to orient and plan while the canvas renderer is still hydrating.',
      inputSchema: { name: z.string().describe('Workbook name relative to the authorized root') },
    },
    guarded(async ({ name }: { name: string }) => {
      const result = await service.profile(name);
      const summary =
        result.profile.status === 'profiled'
          ? `${result.name}: ${result.profile.sheets.length} sheet(s), ${result.profile.rows} rows, ` +
            `${result.profile.cells} cells, ${result.profile.formulas} formulas — profiled in ` +
            `${result.profile.elapsedMs} ms. Genre guess: ${result.profile.genre} ` +
            `(${result.profile.genreBasis}). ${result.provenance}`
          : `${result.name} is not readable as .xlsx: ${result.profile.reason}`;
      return ok({ ...result }, summary);
    }),
  );

  server.registerTool(
    'read_range',
    {
      title: 'Read range (byte-first)',
      description:
        'Read the populated cells of one sheet range straight from the saved bytes: cached values and formula text exactly as the file recorded them at its last save. Engine-free and fast — but the provenance string is load-bearing: these are as-saved values, never unsaved canvas edits, and cached formula values are only as trustworthy as the attached fidelity verdict (null means no verdict exists for this revision). Failures are typed: unreadable, no-such-sheet, or bad-range.',
      inputSchema: {
        name: z.string().describe('Workbook name relative to the authorized root'),
        sheet: z.string().describe('Sheet name, e.g. "Sheet1"'),
        range: z.string().describe('A1 range, e.g. "A1:D20"'),
      },
    },
    guarded(async ({ name, sheet, range }: { name: string; sheet: string; range: string }) => {
      const result = await service.readRange(name, sheet, range);
      const summary =
        result.read.status === 'ok'
          ? `${result.name} ${sheet}!${range}: ${result.read.cells.length} populated cell(s)` +
            `${result.read.truncated ? ' (truncated at the cell cap)' : ''}. ${result.provenance}`
          : `${result.name} ${sheet}!${range}: ${result.read.status} — ${result.read.reason}`;
      return ok({ ...result }, summary);
    }),
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
        'Save edited workbook bytes (base64 xlsx) through an open session. This is the agent lane: the save is always attributed as an agent transaction, must declare the touched ranges, and passes the occupied-cell interlock against the live canvas. Refused with code "revision-conflict" if the file changed on disk since the session opened, and with code "fidelity-mismatch" if the engine\'s values deterministically contradict the file\'s own cached formula values; in both cases the attempted bytes are preserved as a recoverable sibling and nothing is overwritten. Every successful save writes an immutable receipt and reports its value-fidelity status (passed / failed / unverified — unverified means the check had no evidence, not that the file is verified).',
      inputSchema: {
        sessionId: z.string(),
        xlsxBase64: z.string().describe('The full workbook as base64-encoded .xlsx bytes'),
        actorId: z.string().optional().describe('Stable identifier for the agent (recorded in the receipt)'),
        intent: z.string().optional().describe('What this transaction set out to do (recorded in the receipt)'),
        touchedRanges: z
          .array(z.string())
          .min(1)
          .describe('A1 ranges the edit touched, e.g. ["Sheet1!A1:C3"]. Required: the occupied-cell interlock proves them disjoint from the live canvas.'),
      },
    },
    guarded(
      async ({
        sessionId,
        xlsxBase64,
        actorId,
        intent,
        touchedRanges,
      }: {
        sessionId: string;
        xlsxBase64: string;
        actorId?: string;
        intent?: string;
        touchedRanges: string[];
      }) => {
        const bytes = Buffer.from(xlsxBase64, 'base64');
        // Actor identity is decided here, not by the caller: everything that
        // reaches this tool is the model, and the model is an agent. Human
        // canvas saves travel through save_workbook_canvas below.
        const saved = await service.saveSession(sessionId, bytes, {
          lane: 'mcp',
          actor: { kind: 'agent', id: actorId ?? 'model' },
          intent,
          touchedRanges,
        });
        return ok(
          { ...saved },
          `Saved ${saved.name} (${saved.bytes} bytes, revision ${saved.revision.slice(0, 12)}…). ` +
            `Previous version kept as ${saved.backup ?? 'n/a'}. ` +
            `Value fidelity: ${saved.fidelity.status} (${saved.fidelity.reason}). ` +
            `Receipt ${saved.transactionId ?? 'unavailable'}.`,
        );
      },
    ),
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
      const session = service.getSession(sessionId);
      service.closeSession(sessionId);
      // Clear only the context this session's canvas owns (its last reported
      // epoch). A session whose canvas never reported owns nothing to clear —
      // and must not erase another session's live presence on the same workbook.
      const epoch = sessionEpochs.get(sessionId);
      sessionEpochs.delete(sessionId);
      if (epoch !== undefined) service.context.clear(session.name, epoch);
      return ok({ closed: sessionId });
    }),
  );

  // ---- Flight recorder (read-only evidence) ------------------------------

  server.registerTool(
    'list_recovery_artifacts',
    {
      title: 'List recovery artifacts',
      description:
        'List the typed recovery artifacts in the workbook root: .bak backups, refused .conflict-*.xlsx and .fidelity-refused-*.xlsx siblings, and save receipts. Evidence is retained by default; nothing here deletes anything.',
      inputSchema: {},
    },
    guarded(async () => ok({ artifacts: await service.listRecoveryArtifacts() })),
  );

  server.registerTool(
    'list_save_receipts',
    {
      title: 'List save receipts',
      description:
        'List flight-recorder receipt summaries: one immutable receipt per successful save, newest first, with lane, actor, and fidelity status.',
      inputSchema: {},
    },
    guarded(async () => ok({ receipts: await service.listReceipts() })),
  );

  server.registerTool(
    'get_save_receipt',
    {
      title: 'Get save receipt',
      description:
        'Retrieve one full save receipt by transaction id: workbook identity, before/after revisions, actor, lane, fidelity result, coordination outcome, and the dependency trace (or its typed unavailability) for agent transactions.',
      inputSchema: { transactionId: z.string() },
    },
    guarded(async ({ transactionId }: { transactionId: string }) =>
      ok({ ...(await service.getReceipt(transactionId)) }),
    ),
  );

  // ---- Canvas context bus (ephemeral) ------------------------------------

  server.registerTool(
    'get_canvas_context',
    {
      title: 'Get canvas context',
      description:
        'Read the live canvas context for a workbook: active sheet, selection, occupied cell, focus and dirty state. Null when no canvas is reporting. Ephemeral presence only — durable evidence lives in save receipts.',
      inputSchema: { name: z.string() },
    },
    guarded(async ({ name }: { name: string }) => ok({ context: service.context.get(name) })),
  );

  server.registerTool(
    'reveal_range',
    {
      title: 'Reveal range on canvas',
      description:
        'Ask the live canvas to navigate to (scroll to and select) a range. Navigation only — this cannot edit cells. The command is queued until the canvas polls; it is dropped if no canvas is open.',
      inputSchema: {
        name: z.string(),
        range: z.string().describe('A1 range to reveal, e.g. "B2:D4"'),
        sheet: z.string().optional().describe('Sheet to activate first'),
      },
    },
    guarded(async ({ name, range, sheet }: { name: string; range: string; sheet?: string }) =>
      ok({ command: service.context.requestReveal(name, range, sheet ?? null) }),
    ),
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
    'save_workbook_canvas',
    {
      title: 'Save workbook (canvas)',
      description:
        'Internal: the canvas component persists the human\'s edits through its open session. Human-attributed in trusted process code — the component cannot claim any other identity, and the model never sees this tool.',
      inputSchema: {
        sessionId: z.string(),
        xlsxBase64: z.string().describe('The full workbook as base64-encoded .xlsx bytes'),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    guarded(async ({ sessionId, xlsxBase64 }: { sessionId: string; xlsxBase64: string }) => {
      const bytes = Buffer.from(xlsxBase64, 'base64');
      const saved = await service.saveSession(sessionId, bytes, {
        lane: 'canvas',
        actor: { kind: 'human', id: 'mcp-canvas' },
      });
      return ok({ ...saved });
    }),
  );

  registerAppTool(
    server,
    'report_canvas_context',
    {
      title: 'Report canvas context (canvas)',
      description:
        'Internal: the canvas component reports its presence (epoch/sequence gated; stale or out-of-order reports are rejected).',
      inputSchema: {
        sessionId: z.string(),
        epoch: z.number(),
        sequence: z.number(),
        activeSheet: z.string().nullable().optional(),
        selection: z.string().nullable().optional(),
        occupiedCell: z.string().nullable().optional(),
        focused: z.boolean().optional(),
        dirty: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    guarded(
      async ({
        sessionId,
        epoch,
        sequence,
        activeSheet,
        selection,
        occupiedCell,
        focused,
        dirty,
      }: {
        sessionId: string;
        epoch: number;
        sequence: number;
        activeSheet?: string | null;
        selection?: string | null;
        occupiedCell?: string | null;
        focused?: boolean;
        dirty?: boolean;
      }) => {
        const session = service.getSession(sessionId);
        const result = service.context.report(session.name, {
          epoch,
          sequence,
          activeSheet: activeSheet ?? null,
          selection: selection ?? null,
          occupiedCell: occupiedCell ?? null,
          focused: focused === true,
          dirty: dirty === true,
        });
        // Accepted reports establish which epoch this session's canvas owns,
        // so close_workbook_session can scope its teardown to exactly that.
        if (result.accepted) sessionEpochs.set(sessionId, epoch);
        return ok({ ...result });
      },
    ),
  );

  registerAppTool(
    server,
    'poll_canvas_commands',
    {
      title: 'Poll canvas commands (canvas)',
      description:
        'Internal: the canvas component drains pending navigation-only commands (reveal a range).',
      inputSchema: { sessionId: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    guarded(async ({ sessionId }: { sessionId: string }) => {
      const session = service.getSession(sessionId);
      return ok({ commands: service.context.drainCommands(session.name) });
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
