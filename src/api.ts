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
  readonly file: string;
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

export async function readWorkbook(name: string): Promise<Uint8Array> {
  const response = await fetch(`/api/workbook?path=${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Could not read ${name} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export function writeWorkbook(
  name: string,
  bytes: Uint8Array,
): Promise<{ versionId?: string; backup: string | null }> {
  return fetch(`/api/workbook?path=${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as BodyInit,
  }).then((response) => unwrap<{ versionId?: string; backup: string | null }>(response));
}

export function writeScreenshot(name: string, bytes: Uint8Array): Promise<{ file: string }> {
  return fetch(`/api/screenshot?path=${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: bytes as BodyInit,
  }).then((response) => unwrap<{ file: string }>(response));
}

export function validateWorkbook(name: string): Promise<ValidationReport> {
  return fetch(`/api/validate?path=${encodeURIComponent(name)}`, { method: 'POST' }).then(
    (response) => unwrap<ValidationReport>(response),
  );
}
