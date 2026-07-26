/**
 * The adapter boundary.
 *
 * Everything the app knows about "a live spreadsheet canvas" is this file.
 * The React shell talks only to these types, so the concrete engine behind the
 * canvas can be swapped (or reported as missing) without touching the UI.
 *
 * Implementations:
 *   - mog-embed-adapter.ts  — real Mog canvas via @mog-sdk/spreadsheet-app
 *   - unavailable-adapter.ts — honest no-op used when that package cannot load
 */

export type AdapterId = 'mog-embed' | 'unavailable';

export type ColorScheme = 'light' | 'dark' | 'system';

export interface AdapterCapabilities {
  /** A real, interactive grid is rendered (not a placeholder). */
  readonly liveCanvas: boolean;
  /** The user can type into cells and formulas recalculate. */
  readonly edit: boolean;
  /** Edited bytes can be handed back to the host for writing to disk. */
  readonly saveToDisk: boolean;
  /** A PNG of a range can be captured from the rendered canvas. */
  readonly screenshot: boolean;
}

export interface AdapterProbe {
  readonly id: AdapterId;
  readonly label: string;
  readonly available: boolean;
  readonly capabilities: AdapterCapabilities;
  /** Human-readable reason, shown verbatim in the UI. Never hand-waved. */
  readonly detail: string;
}

export interface OpenRequest {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly colorScheme: ColorScheme;
  /**
   * Base URL the engine loads its wasm/fonts/static files from. Defaults to
   * "/mog/" on the document origin (the dev server). The MCP Apps component
   * overrides it with an absolute URL because its document lives on a
   * host-chosen sandbox origin while the assets live on the loopback host.
   */
  readonly assetBase?: string;
}

/** What the canvas is allowed to ask the host (this app) to do. */
export interface HostServices {
  /**
   * Write workbook bytes to disk. Called whenever the canvas saves — the canvas
   * itself has no disk access. Returns the host's version id for the write.
   */
  persist(bytes: Uint8Array): Promise<{ readonly versionId?: string }>;
  onDirtyChange(dirty: boolean): void;
  onStatus(status: string): void;
  onError(error: unknown): void;
}

export interface CanvasSession {
  /** Ask the canvas to flush current state through HostServices.persist. */
  save(): Promise<void>;
  exportXlsx(): Promise<Uint8Array>;
  /** PNG bytes for a range on the active sheet, e.g. "A1:H30". */
  screenshot(range: string): Promise<Uint8Array>;
  /** Name of the sheet currently in view, when the engine exposes it. */
  activeSheetName(): string | undefined;
  dispose(): Promise<void>;
}

export interface CanvasAdapter {
  readonly probe: AdapterProbe;
  open(
    container: HTMLElement,
    request: OpenRequest,
    host: HostServices,
  ): Promise<CanvasSession>;
}
