/**
 * Real Mog canvas adapter.
 *
 * Uses the public, published embed API of @mog-sdk/spreadsheet-app:
 *   createSpreadsheetRuntime() + mountSpreadsheetApp()
 *
 * Host policy here mirrors Mog's own VS Code integration
 * (integrations/vscode/mog-xlsx-editor/webview/index.ts), which is the
 * reference implementation for embedding this package in a non-Mog host:
 * the host owns file open/save/export, the canvas owns editing and compute.
 */
import type {
  MogSpreadsheetAppProps,
  SpreadsheetAppAttachmentHandle,
  SpreadsheetAppEvent,
  SpreadsheetCommandRequest,
  SpreadsheetCommandResult,
  SpreadsheetRuntime,
  SpreadsheetSaveRequest,
  SpreadsheetSaveResult,
  SpreadsheetWorkbookSession,
} from '@mog-sdk/spreadsheet-app';
import type {
  AdapterProbe,
  CanvasAdapter,
  CanvasSession,
  HostServices,
  OpenRequest,
} from './types';

export type EmbedModule = typeof import('@mog-sdk/spreadsheet-app');

/**
 * Engine asset locations relative to one base URL. The default "/mog/" is the
 * dev server's mount (server/mog-assets.ts); the MCP component passes an
 * absolute loopback URL instead. The layout under the base is identical.
 */
function assetsFor(base: string = '/mog/') {
  return {
    wasmBaseUrl: base,
    fontBaseUrl: `${base}assets/`,
    staticBaseUrl: base,
  } as const;
}

const SCREENSHOT_ACTOR = {
  actorId: 'codex-companion-user',
  kind: 'user',
  displayName: 'Companion',
} as const;

export const MOG_EMBED_PROBE: AdapterProbe = {
  id: 'mog-embed',
  label: 'Mog embed (@mog-sdk/spreadsheet-app)',
  available: true,
  capabilities: { liveCanvas: true, edit: true, saveToDisk: true, screenshot: true },
  detail:
    'Public embed API resolved: createSpreadsheetRuntime + mountSpreadsheetApp. ' +
    'Same engine and UI as the Mog VS Code/Cursor extension.',
};

/**
 * Built only from an embed module that resolveCanvasAdapter() has already
 * loaded and shape-checked, alongside the embed's stylesheet — so by the time
 * open() runs, both are known good and the grid cannot paint unstyled.
 */
export function createMogEmbedAdapter(embed: EmbedModule): CanvasAdapter {
  return {
    probe: MOG_EMBED_PROBE,

    async open(container, request, host): Promise<CanvasSession> {
      const tracker = createContextTracker(host);
      const runtime = await embed.createSpreadsheetRuntime({
        assets: assetsFor(request.assetBase),
        host: {
          // The host holds the file; the canvas keeps no copy of its own.
          persistenceMode: 'host-owned-ephemeral',
          // Localhost + hot reload: the browser's leave-site prompt is noise here.
          beforeUnloadPrompt: false,
        },
        onSaveRequest: (saveRequest) => persistThroughHost(saveRequest, host),
        onCommandRequest: (commandRequest) => routeCommand(commandRequest, host),
        onEvent: (event) => {
          if (event.type === 'error') host.onError(event.payload);
          tracker.handle(event);
        },
      });

      const workbook = await openWorkbook(runtime, request);
      const stopDirty = workbook.onDirtyChange((state) =>
        host.onDirtyChange(state.status === 'dirty'),
      );

      host.onStatus('mounting canvas');
      const attachment = embed.mountSpreadsheetApp(container, appProps(runtime, workbook, request, host));
      await attachment.ready;
      host.onStatus('ready');
      // The events above only fire on change; seed the initial presence from
      // the mounted view so the bus knows about the canvas before any click.
      tracker.seed(attachment);

      return session(runtime, workbook, attachment, stopDirty, tracker);
    },
  };
}

/**
 * Presence tracking for the context bus: the adapter stamps its own mount
 * epoch and monotonic sequence, so the host (and the bus behind it) can reject
 * reports from a torn-down canvas. Sheet ids are translated to names as the
 * embed reports them; the occupied cell is the selection's active cell.
 */
interface ContextTracker {
  handle(event: SpreadsheetAppEvent): void;
  seed(attachment: SpreadsheetAppAttachmentHandle): void;
  /**
   * Runs a programmatic navigation (an agent-issued reveal) with position
   * events suppressed: the occupied cell on the bus is the *human's* signal,
   * and a reveal must never overwrite it with an agent-chosen position.
   * Events the embed dispatches after the awaited action resolves are not
   * covered — a known, narrow limitation.
   */
  suppress<T>(action: () => Promise<T>): Promise<T>;
}

function createContextTracker(host: HostServices): ContextTracker {
  const onContext = host.onContext?.bind(host);
  if (!onContext) {
    return { handle: () => undefined, seed: () => undefined, suppress: (action) => action() };
  }

  const epoch = Date.now();
  let sequence = 0;
  let programmatic = 0;
  const sheetNames = new Map<string, string>();
  const state = {
    activeSheet: null as string | null,
    selection: null as string | null,
    occupiedCell: null as string | null,
    focused: false,
    dirty: false,
  };
  const emit = () => onContext({ epoch, sequence: ++sequence, ...state });

  return {
    handle(event) {
      switch (event.type) {
        case 'selection-change':
          // Position events raised by an agent reveal are not human presence.
          if (programmatic > 0) return;
          state.selection = event.payload.selectedRanges[0] ?? null;
          state.occupiedCell = event.payload.activeCell?.address ?? null;
          if (event.payload.activeCell) {
            const name = sheetNames.get(event.payload.activeCell.sheetId);
            if (name) state.activeSheet = name;
          }
          break;
        case 'active-sheet-change':
          // Keep the id->name mapping current even during a reveal; only the
          // human-position state stays untouched.
          if (event.payload.sheetName) sheetNames.set(event.payload.sheetId, event.payload.sheetName);
          if (programmatic > 0) return;
          state.activeSheet = event.payload.sheetName ?? state.activeSheet;
          break;
        case 'focus-change':
          state.focused = event.payload.focused;
          break;
        case 'dirty-change':
          state.dirty = event.payload.status === 'dirty';
          break;
        default:
          return;
      }
      emit();
    },

    seed(attachment) {
      try {
        const view = attachment.view();
        const active = view.getActiveSheet();
        if (active.sheetName) sheetNames.set(active.sheetId, active.sheetName);
        state.activeSheet = active.sheetName ?? null;
        const selection = view.getSelection();
        state.selection = selection.selectedRanges[0] ?? null;
        state.occupiedCell = selection.activeCell?.address ?? null;
      } catch {
        // A view that cannot report yet is fine — events will catch up.
      }
      emit();
    },

    async suppress(action) {
      programmatic += 1;
      try {
        return await action();
      } finally {
        programmatic -= 1;
      }
    },
  };
}

function appProps(
  runtime: SpreadsheetRuntime,
  workbook: SpreadsheetWorkbookSession,
  request: OpenRequest,
  host: HostServices,
): MogSpreadsheetAppProps {
  return {
    runtime,
    workbook,
    workspace: {
      mode: 'single-document',
      fileExplorer: false,
      appSwitcher: false,
      settings: true,
    },
    chrome: {
      commandBar: true,
      // This app owns file open/save, so Mog's own File menu would lie.
      fileMenu: false,
      formulaBar: true,
      sheetTabs: true,
      statusBar: true,
    },
    commands: {
      save: 'host',
      open: 'host',
      import: 'host',
      export: 'host',
      print: 'disabled',
      share: 'disabled',
    },
    theme: { uiChrome: { colorScheme: request.colorScheme } },
    editModel: { user: 'write', agents: 'none', automation: 'none' },
    loadingFallback: 'Opening workbook…',
    onError: (error) => host.onError(error),
  };
}

async function openWorkbook(
  runtime: SpreadsheetRuntime,
  request: OpenRequest,
): Promise<SpreadsheetWorkbookSession> {
  const workbook = await runtime.openWorkbook({
    workbookId: request.fileName,
    displayName: request.fileName,
    source: { kind: 'xlsx-bytes', bytes: request.bytes, fileName: request.fileName },
  });
  await workbook.whenReady();
  return workbook;
}

/** Every canvas save funnels through here and lands on disk via the file bridge. */
async function persistThroughHost(
  request: SpreadsheetSaveRequest,
  host: HostServices,
): Promise<SpreadsheetSaveResult> {
  const common = {
    workbookId: request.workbookId,
    epoch: request.epoch,
    dirtyEpoch: request.dirtyEpoch,
    changeSequence: request.changeSequence,
    saveRequestId: request.saveRequestId,
    baseVersionId: request.baseVersionId,
    bytesHash: request.bytesHash,
  };

  try {
    host.onStatus('saving to disk');
    const { versionId } = await host.persist(request.bytes);
    host.onStatus('saved');
    return { status: 'saved', ...common, versionId };
  } catch (error) {
    host.onError(error);
    return {
      status: 'failed',
      ...common,
      error: {
        code: 'host-save-failed',
        message: error instanceof Error ? error.message : String(error),
      } as SpreadsheetAppErrorLike,
    };
  }
}

/** Minimal shape of SpreadsheetAppError we can construct from a host failure. */
type SpreadsheetAppErrorLike = Extract<SpreadsheetSaveResult, { status: 'failed' }>['error'];

function routeCommand(
  request: SpreadsheetCommandRequest,
  host: HostServices,
): SpreadsheetCommandResult | Promise<SpreadsheetCommandResult> {
  if (request.command === 'save' && request.save) {
    return persistThroughHost(request.save, host).then((result) => ({
      status: 'handled' as const,
      command: 'save' as const,
      result,
    }));
  }

  if (request.command === 'open' || request.command === 'import') {
    return {
      status: 'denied',
      command: request.command,
      reason: 'The companion app owns file open/import — use the workbook picker in the header.',
    };
  }

  return {
    status: 'denied',
    command: request.command,
    reason: `${request.command} is not enabled in this host.`,
  };
}

function session(
  runtime: SpreadsheetRuntime,
  workbook: SpreadsheetWorkbookSession,
  attachment: SpreadsheetAppAttachmentHandle,
  stopDirty: () => void,
  tracker: ContextTracker,
): CanvasSession {
  return {
    async save() {
      const result = await workbook.requestSave();
      if (result.status !== 'saved') {
        throw new Error(`Save ${result.status}: ${result.error.message}`);
      }
    },

    exportXlsx: () => workbook.exportXlsx(),

    screenshot(range) {
      const sheet = attachment.view().getActiveSheet();
      // A `kind: "user"` actor resolves without a host authority adapter;
      // privileged kinds ("host", "agent", …) are refused unless one is
      // registered, and this shell does not register one.
      return workbook.captureScreenshot(SCREENSHOT_ACTOR, sheet.sheetName ?? sheet.sheetId, range);
    },

    activeSheetName() {
      return attachment.view().getActiveSheet().sheetName;
    },

    // Navigation only: switch sheet, select, scroll. No cell is edited — the
    // view handle's edit entry points are never called from here.
    async reveal(range, sheet) {
      // Suppressed: the position changes below are agent navigation, and must
      // not replace the human's occupied cell on the context bus.
      await tracker.suppress(async () => {
        const view = attachment.view();
        if (sheet) await view.setActiveSheet(sheet);
        await view.select(sheet ? { sheet, range } : { range });
        await view.scrollTo(sheet ? { sheet, range } : { range });
      });
    },

    async dispose() {
      stopDirty();
      try {
        await attachment.detach();
      } finally {
        await runtime.dispose();
      }
    },
  };
}
