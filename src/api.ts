/** Client for the local file bridge in server/file-bridge.ts. */

export interface WorkbookEntry {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
}

export interface BridgeConfig {
  readonly root: string;
  readonly files: readonly WorkbookEntry[];
}

export interface SheetSummary {
  readonly name: string;
  readonly summary: string;
}

export interface FidelityReport {
  readonly status: 'passed' | 'failed' | 'unverified';
  readonly reason: string;
  readonly revision: string;
  readonly sdkVersion: string;
  readonly checkedCells: number;
  readonly truncated: boolean;
  readonly mismatches: readonly {
    readonly sheet: string;
    readonly address: string;
    readonly cachedValue: string | number | boolean;
    readonly engineValue: unknown;
  }[];
}

export interface ValidationReport {
  readonly name: string;
  readonly bytes: number;
  readonly modified: string;
  readonly sheetNames: readonly string[];
  readonly sheets: readonly SheetSummary[];
  readonly fidelity?: FidelityReport;
}

export interface SaveResponse {
  readonly versionId: string;
  readonly backup: string | null;
  readonly fidelity?: FidelityReport;
  readonly transactionId?: string | null;
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed (${response.status})`);
    // Callers act on the structured refusal, not the prose: a fidelity
    // refusal carries the report that must replace stale UI state.
    Object.assign(error, { code: body?.code, details: body });
    throw error;
  }
  return body as T;
}

export function getConfig(): Promise<BridgeConfig> {
  return fetch('/api/config').then((response) => unwrap<BridgeConfig>(response));
}

export async function readWorkbook(
  name: string,
): Promise<{ bytes: Uint8Array; revision: string }> {
  const response = await fetch(`/api/workbook?path=${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Could not read ${name} (${response.status})`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    revision: response.headers.get('x-workbook-revision') ?? '',
  };
}

/**
 * Saves against the revision the caller last saw. A stale revision is refused
 * by the bridge (409, code "revision-conflict") and the attempted bytes are
 * preserved server-side — the caller decides what to do, never the bridge.
 */
export function writeWorkbook(
  name: string,
  bytes: Uint8Array,
  expectedRevision?: string,
): Promise<SaveResponse> {
  const expected = expectedRevision
    ? `&expectedRevision=${encodeURIComponent(expectedRevision)}`
    : '';
  return fetch(`/api/workbook?path=${encodeURIComponent(name)}${expected}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as BodyInit,
  }).then((response) => unwrap<SaveResponse>(response));
}

// ---- Canvas context bus (ephemeral presence + navigation commands) ----------

export interface ContextSnapshot {
  readonly epoch: number;
  readonly sequence: number;
  readonly activeSheet: string | null;
  readonly selection: string | null;
  readonly occupiedCell: string | null;
  readonly focused: boolean;
  readonly dirty: boolean;
}

export interface CanvasCommand {
  readonly id: string;
  readonly kind: 'reveal';
  readonly sheet: string | null;
  readonly range: string;
}

export interface ContextReportResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

/** Presence report. A 409 means the bus rejected it (stale epoch / out of
 * order) — the caller decides whether that is worth warning about. */
export async function reportContext(
  name: string,
  snapshot: ContextSnapshot,
): Promise<ContextReportResult> {
  const response = await fetch(`/api/context?path=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  const body = (await response.json().catch(() => null)) as {
    accepted?: boolean;
    reason?: string;
    error?: string;
  } | null;
  if (response.ok) return { accepted: body?.accepted !== false };
  return {
    accepted: false,
    reason: body?.reason ?? body?.error ?? `Report failed (${response.status})`,
  };
}

export function clearContext(name: string, epoch: number): Promise<void> {
  return fetch(`/api/context?path=${encodeURIComponent(name)}&epoch=${epoch}`, {
    method: 'DELETE',
  }).then(() => undefined);
}

export function fetchCanvasCommands(name: string): Promise<CanvasCommand[]> {
  return fetch(`/api/context/commands?path=${encodeURIComponent(name)}`)
    .then((response) => unwrap<{ commands: CanvasCommand[] }>(response))
    .then((body) => body.commands);
}

export function writeScreenshot(name: string, bytes: Uint8Array): Promise<{ name: string }> {
  return fetch(`/api/screenshot?path=${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: bytes as BodyInit,
  }).then((response) => unwrap<{ name: string }>(response));
}

export function validateWorkbook(name: string): Promise<ValidationReport> {
  return fetch(`/api/validate?path=${encodeURIComponent(name)}`, { method: 'POST' }).then(
    (response) => unwrap<ValidationReport>(response),
  );
}
