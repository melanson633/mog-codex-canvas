/**
 * The workbook flight recorder: typed recovery/audit artifacts for every save.
 *
 * Everything the save path already preserves — backups (.bak), refused
 * conflicts (.conflict-*.xlsx), fidelity-refused bytes
 * (.fidelity-refused-*.xlsx) — becomes listable here as a closed set of typed
 * artifact kinds, and every successful save additionally writes one immutable
 * receipt under `<root>/.audit/receipts/<transactionId>.json`.
 *
 * Nothing here weakens containment: receipts and artifacts live inside the
 * authorized workbook root, resolved through the same path policy as every
 * other target, and receipt IDs are validated as UUIDs before they ever touch
 * a path. Evidence is retained by default — this module deletes nothing.
 *
 * Errors are thrown as plain Errors; the workbook service wraps calls in its
 * policy() classifier so callers still see stable WorkbookError codes.
 */
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveReadTarget, resolveSaveTarget } from './path-policy.ts';
import type { FidelityReport } from './value-fidelity.ts';
import { looksLikeWorkbook } from './ooxml-cache.ts';
import { parseRange } from './context-bus.ts';

export interface SaveActor {
  readonly kind: 'human' | 'agent';
  readonly id: string;
}

export type SaveLane = 'canvas' | 'bridge' | 'mcp' | 'headless';

export interface CoordinationOutcome {
  /**
   * - not-applicable: human save; no touched ranges are declared for it
   * - no-live-canvas: agent save with no canvas context reported for the workbook
   * - disjoint: agent save whose touched ranges avoid the human's occupied cell
   */
  readonly status: 'not-applicable' | 'no-live-canvas' | 'disjoint';
  readonly occupiedCell: string | null;
}

export interface TraceCell {
  readonly sheet: string;
  readonly address: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly changed: boolean;
}

export type DependencyTrace =
  | {
      readonly status: 'traced';
      readonly seeds: readonly string[];
      readonly cells: readonly TraceCell[];
      readonly visited: number;
      readonly cap: number;
      readonly truncated: boolean;
      readonly limitations: readonly string[];
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface SaveReceipt {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly workbook: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string;
  readonly timestamp: string;
  readonly lane: SaveLane;
  readonly actor: SaveActor;
  /** Declared by agent transactions; humans edit live and declare nothing. */
  readonly intent: string | null;
  readonly touchedRanges: readonly string[] | null;
  readonly fidelity: FidelityReport;
  readonly coordination: CoordinationOutcome;
  /** Root-relative name of the .bak holding the replaced version, if one exists. */
  readonly backup: string | null;
  readonly dependencyTrace: DependencyTrace | null;
}

export interface ReceiptSummary {
  readonly transactionId: string;
  readonly workbook: string;
  readonly timestamp: string;
  readonly lane: SaveLane;
  readonly actor: SaveActor;
  readonly afterRevision: string;
  readonly fidelityStatus: FidelityReport['status'];
}

export type RecoveryArtifactKind = 'backup' | 'conflict' | 'fidelity-refused' | 'receipt';

export interface RecoveryArtifact {
  readonly kind: RecoveryArtifactKind;
  /** Root-relative name; readable through the workbook service, never a path. */
  readonly name: string;
  readonly size: number;
  readonly modified: string;
}

const RECEIPT_DIR = '.audit/receipts';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function receiptName(transactionId: string): string {
  if (!UUID_RE.test(transactionId)) {
    throw new Error(`Not a receipt transaction id: ${transactionId}`);
  }
  return `${RECEIPT_DIR}/${transactionId.toLowerCase()}.json`;
}

/** Writes one receipt, immutably: an existing file with the same id is an error. */
export async function writeReceipt(root: string, receipt: SaveReceipt): Promise<void> {
  await mkdir(join(root, RECEIPT_DIR), { recursive: true });
  const file = await resolveSaveTarget(root, receiptName(receipt.transactionId), 'receipt');
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(receipt, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readReceipt(root: string, transactionId: string): Promise<SaveReceipt> {
  const file = await resolveReadTarget(root, receiptName(transactionId), 'receipt');
  return JSON.parse(await readFile(file, 'utf8')) as SaveReceipt;
}

export async function listReceipts(root: string): Promise<ReceiptSummary[]> {
  const dir = join(root, RECEIPT_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const summaries: ReceiptSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const receipt = JSON.parse(await readFile(join(dir, name), 'utf8')) as SaveReceipt;
      summaries.push({
        transactionId: receipt.transactionId,
        workbook: receipt.workbook,
        timestamp: receipt.timestamp,
        lane: receipt.lane,
        actor: receipt.actor,
        afterRevision: receipt.afterRevision,
        fidelityStatus: receipt.fidelity?.status ?? 'unverified',
      });
    } catch {
      // An unreadable receipt is skipped from the summary, never deleted.
    }
  }
  return summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

const CONFLICT_RE = /\.conflict-[^.]+\.xlsx$/i;
const FIDELITY_REFUSED_RE = /\.fidelity-refused-[^.]+\.xlsx$/i;

/** Lists the recovery artifacts in the root: backups, conflicts, refused bytes, receipts. */
export async function listRecoveryArtifacts(root: string): Promise<RecoveryArtifact[]> {
  const artifacts: RecoveryArtifact[] = [];

  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    let kind: RecoveryArtifactKind | null = null;
    if (name.toLowerCase().endsWith('.bak')) kind = 'backup';
    else if (CONFLICT_RE.test(name)) kind = 'conflict';
    else if (FIDELITY_REFUSED_RE.test(name)) kind = 'fidelity-refused';
    if (!kind) continue;
    const info = await stat(join(root, name)).catch(() => null);
    if (!info?.isFile()) continue;
    artifacts.push({ kind, name, size: info.size, modified: info.mtime.toISOString() });
  }

  const receiptDir = join(root, RECEIPT_DIR);
  for (const name of await readdir(receiptDir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const info = await stat(join(receiptDir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    artifacts.push({
      kind: 'receipt',
      name: `${RECEIPT_DIR}/${name}`,
      size: info.size,
      modified: info.mtime.toISOString(),
    });
  }

  return artifacts.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
}

// ---- Dependency trace -------------------------------------------------------

/** Per-range and total expansion caps keep the cascade bounded. */
const SEED_CELL_CAP = 64;
export const TRACE_CELL_CAP = 200;

export interface TraceInput {
  /** Exact bytes of the prior admitted revision; null when the file is new. */
  readonly beforeBytes: Uint8Array | null;
  /** Exact bytes of the revision being admitted. */
  readonly afterBytes: Uint8Array;
  readonly touchedRanges: readonly string[];
  readonly cellCap?: number;
  /**
   * An engine workbook already opened from `afterBytes`. Supplying it skips
   * this trace's own import of the admitted bytes — the dominant cost on large
   * workbooks — and leaves disposal to the caller.
   */
  readonly afterWorkbook?: EngineWorkbook;
}

export interface EngineWorkbook {
  readonly sheetNames: readonly string[];
  readonly activeSheet: EngineWorksheet;
  getOrCreateSheet(name: string): Promise<{ sheet: EngineWorksheet }>;
  dispose(): Promise<void>;
}

export interface EngineWorksheet {
  readonly name?: string;
  getValue(address: string): Promise<unknown>;
  getDependents(address: string): Promise<readonly string[]>;
}

function cellAddress(row: number, col: number): string {
  let letters = '';
  let c = col;
  while (c > 0) {
    const rem = (c - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return `${letters}${row}`;
}

/**
 * Old-vs-new cascade from the declared touched ranges: which cells the change
 * reached, per the installed engine's own dependency graph.
 *
 * The engine's precedent/dependent support is verified at runtime on the exact
 * bytes being traced — if the installed SDK refuses it, the trace is a typed
 * `unavailable` recording that verified limitation, never a fabrication.
 * Dependent addresses come back without sheet qualifiers in SDK 0.10.5, so the
 * cascade is confined to each seed's own sheet, and says so.
 */
export async function traceDependencies(input: TraceInput): Promise<DependencyTrace> {
  const cap = input.cellCap ?? TRACE_CELL_CAP;
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const { createWorkbook } = (await import('@mog-sdk/sdk/node')) as unknown as {
    createWorkbook: (source?: Buffer) => Promise<EngineWorkbook>;
  };

  const borrowedAfter = input.afterWorkbook ?? null;
  let after: EngineWorkbook;
  if (borrowedAfter) {
    after = borrowedAfter;
  } else {
    // Pre-flight before the native engine: createWorkbook() on unopenable
    // bytes rejects but leaks a native thread in SDK 0.10.5.
    if (!looksLikeWorkbook(input.afterBytes)) {
      return { status: 'unavailable', reason: 'the admitted bytes are not a readable XLSX workbook' };
    }
    try {
      after = await createWorkbook(Buffer.from(input.afterBytes));
    } catch (error) {
      return { status: 'unavailable', reason: `the admitted bytes could not be reopened: ${message(error)}` };
    }
  }

  let before: EngineWorkbook | null = null;
  try {
    if (input.beforeBytes && looksLikeWorkbook(input.beforeBytes)) {
      try {
        before = await createWorkbook(Buffer.from(input.beforeBytes));
      } catch {
        before = null; // recorded below as a limitation, not a failure
      }
    }

    // Expand the declared ranges into seed cells, each on a resolved sheet.
    const defaultSheet = after.sheetNames[0] ?? null;
    const seeds: { sheet: string; address: string }[] = [];
    for (const ref of input.touchedRanges) {
      const parsed = parseRange(ref);
      if (!parsed) {
        return { status: 'unavailable', reason: `touched range could not be parsed: ${ref}` };
      }
      const sheet = parsed.sheet ?? defaultSheet;
      if (!sheet || !after.sheetNames.includes(sheet)) {
        return { status: 'unavailable', reason: `touched range names an unknown sheet: ${ref}` };
      }
      let expanded = 0;
      for (let row = parsed.startRow; row <= parsed.endRow && expanded < SEED_CELL_CAP; row += 1) {
        for (let col = parsed.startCol; col <= parsed.endCol && expanded < SEED_CELL_CAP; col += 1) {
          seeds.push({ sheet, address: cellAddress(row, col) });
          expanded += 1;
        }
      }
    }
    if (seeds.length === 0) {
      return { status: 'unavailable', reason: 'the declared touched ranges contain no cells' };
    }

    // Runtime capability check on the installed SDK before trusting the graph.
    const afterSheets = new Map<string, EngineWorksheet>();
    const sheetOf = async (wb: EngineWorkbook, name: string, cache: Map<string, EngineWorksheet>) => {
      let sheet = cache.get(name);
      if (!sheet) {
        sheet = (await wb.getOrCreateSheet(name)).sheet;
        cache.set(name, sheet);
      }
      return sheet;
    };
    try {
      await (await sheetOf(after, seeds[0].sheet, afterSheets)).getDependents(seeds[0].address);
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `the installed SDK does not support dependency traversal here: ${message(error)}`,
      };
    }

    const beforeSheets = new Map<string, EngineWorksheet>();
    const limitations = [
      'dependent addresses are not sheet-qualified in this SDK; the cascade is confined to each seed’s sheet',
    ];
    if (input.beforeBytes && !before) {
      limitations.push('the prior revision could not be reopened; before-values are unavailable');
    } else if (!input.beforeBytes) {
      limitations.push('no prior revision exists; before-values are unavailable');
    }

    // Cycle-aware bounded BFS over the admitted revision's dependency graph.
    const visited = new Set<string>();
    const queue = [...seeds];
    const cells: TraceCell[] = [];
    let truncated = false;

    while (queue.length > 0) {
      const { sheet, address } = queue.shift()!;
      const key = `${sheet}!${address}`.toLowerCase();
      if (visited.has(key)) continue;
      if (visited.size >= cap) {
        truncated = true;
        break;
      }
      visited.add(key);

      const afterSheet = await sheetOf(after, sheet, afterSheets);
      const afterValue = await afterSheet.getValue(address);
      let beforeValue: unknown = null;
      if (before && before.sheetNames.includes(sheet)) {
        beforeValue = await (await sheetOf(before, sheet, beforeSheets)).getValue(address);
      }
      cells.push({
        sheet,
        address,
        before: beforeValue,
        after: afterValue,
        changed: JSON.stringify(beforeValue) !== JSON.stringify(afterValue),
      });

      for (const dependent of await afterSheet.getDependents(address)) {
        queue.push({ sheet, address: dependent });
      }
    }
    if (queue.length > 0) truncated = true;

    return {
      status: 'traced',
      seeds: seeds.map((seed) => `${seed.sheet}!${seed.address}`),
      cells,
      visited: visited.size,
      cap,
      truncated,
      limitations,
    };
  } catch (error) {
    return { status: 'unavailable', reason: `dependency trace aborted: ${message(error)}` };
  } finally {
    // dispose() has been observed returning undefined instead of a Promise on
    // some paths in 0.10.5, so never chain onto its return value. A borrowed
    // after-workbook belongs to the caller and is not disposed here.
    if (!borrowedAfter) {
      try {
        await after.dispose();
      } catch {
        // Cleanup failures must not mask the trace result.
      }
    }
    try {
      await before?.dispose();
    } catch {
      // Cleanup failures must not mask the trace result.
    }
  }
}
