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

export interface ValidationReport {
  readonly name: string;
  readonly bytes: number;
  readonly modified: string;
  readonly sheetNames: readonly string[];
  readonly sheets: readonly SheetSummary[];
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
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
): Promise<{ versionId: string; backup: string | null }> {
  const expected = expectedRevision
    ? `&expectedRevision=${encodeURIComponent(expectedRevision)}`
    : '';
  return fetch(`/api/workbook?path=${encodeURIComponent(name)}${expected}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as BodyInit,
  }).then((response) => unwrap<{ versionId: string; backup: string | null }>(response));
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
