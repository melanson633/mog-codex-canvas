/**
 * The value-fidelity gate.
 *
 * "Value fidelity" (CONCEPTS.md) is the engine agreeing with the workbook's own
 * recorded results — not with itself. The independent oracle is the cached
 * formula values the file carries (server/ooxml-cache.ts). The one deterministic
 * failure this gate refuses is the high-signal shape of the known SDK defect
 * (docs/solutions/integration-issues/…-calc-error.md): the file recorded a
 * non-error result for a formula, the engine reports an error (#CALC!, #VALUE!,
 * #NAME?, …) for the same cell.
 *
 * Everything short of that deterministic disagreement is `unverified`, never
 * `passed`: unreadable bytes, no cached values to compare, a sheet the engine
 * cannot resolve, an engine that will not open the file. Unverified saves are
 * allowed to proceed — refusing them would turn missing evidence into data
 * loss — but they must be reported as unverified, never as fidelity-verified.
 */
import { createRequire } from 'node:module';
import { extractCachedFormulaValues } from './ooxml-cache.ts';

export type FidelityStatus = 'passed' | 'failed' | 'unverified';

export interface FidelityMismatch {
  readonly sheet: string;
  readonly address: string;
  /** What the file itself recorded for this formula. */
  readonly cachedValue: string | number | boolean;
  /** What the installed engine reports for the same cell. */
  readonly engineValue: unknown;
}

export interface FidelityReport {
  readonly status: FidelityStatus;
  readonly reason: string;
  /** SHA-256 revision of the exact bytes this report describes. */
  readonly revision: string;
  readonly sdkVersion: string;
  readonly checkedCells: number;
  /** True when the file has more cached formula values than the check sampled. */
  readonly truncated: boolean;
  readonly mismatches: readonly FidelityMismatch[];
}

/** Excel/OOXML error literals as the engine returns them from getValue(). */
const ENGINE_ERRORS = new Set([
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#CALC!',
  '#SPILL!',
  '#GETTING_DATA',
]);

export function isEngineError(value: unknown): boolean {
  return typeof value === 'string' && ENGINE_ERRORS.has(value.trim());
}

function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@mog-sdk/sdk/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Default sample bound: enough for real workbooks, bounded for huge ones. */
export const FIDELITY_CELL_LIMIT = 500;

export interface FidelityOptions {
  readonly cellLimit?: number;
  /**
   * An engine workbook already opened from the exact same bytes. Supplying it
   * skips this check's own import — the dominant cost on large workbooks — and
   * leaves disposal to the caller.
   */
  readonly engine?: EngineWorkbook;
}

/**
 * True when a fidelity check of these bytes would actually consult the engine.
 * Bytes with no readable cached formula values are `unverified` without one —
 * and must never be handed to the engine speculatively: createWorkbook() on
 * unopenable bytes rejects but leaves a native thread alive in SDK 0.10.5,
 * which keeps the whole process from exiting.
 */
export function fidelityNeedsEngine(bytes: Uint8Array): boolean {
  try {
    return extractCachedFormulaValues(bytes).cells.length > 0;
  } catch {
    return false;
  }
}

/**
 * Compares the cached formula values inside `bytes` against what the installed
 * engine computes for the same cells. Never throws: every failure to gather
 * evidence is an `unverified` report with its reason.
 */
export async function checkValueFidelity(
  bytes: Uint8Array,
  revision: string,
  options: FidelityOptions = {},
): Promise<FidelityReport> {
  const limit = options.cellLimit ?? FIDELITY_CELL_LIMIT;
  const base = { revision, sdkVersion: sdkVersion() };

  const unverified = (reason: string, checkedCells = 0): FidelityReport => ({
    status: 'unverified',
    reason,
    ...base,
    checkedCells,
    truncated: false,
    mismatches: [],
  });

  let extract;
  try {
    extract = extractCachedFormulaValues(bytes);
  } catch (error) {
    return unverified(
      `cached formula values could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (extract.cells.length === 0) {
    return unverified(
      extract.formulaCells === 0
        ? 'the file contains no formula cells to compare'
        : `the file's ${extract.formulaCells} formula cell(s) carry no readable cached values`,
    );
  }

  const borrowed = options.engine ?? null;
  let wb: EngineWorkbook;
  if (borrowed) {
    wb = borrowed;
  } else {
    // The /node subpath forces the native binding (bare specifier resolves to
    // the browser WASM build under bundler resolution).
    let createWorkbook: (source: Buffer) => Promise<EngineWorkbook>;
    try {
      ({ createWorkbook } = (await import('@mog-sdk/sdk/node')) as unknown as {
        createWorkbook: (source: Buffer) => Promise<EngineWorkbook>;
      });
    } catch (error) {
      return unverified(
        `the headless engine is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      wb = await createWorkbook(Buffer.from(bytes));
    } catch (error) {
      return unverified(
        `the engine could not open the bytes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    const sample = extract.cells.slice(0, limit);
    const truncated = extract.cells.length > sample.length;
    const sheets = new Map<string, EngineWorksheet>();
    const mismatches: FidelityMismatch[] = [];
    let checked = 0;

    for (const cell of sample) {
      let sheet = sheets.get(cell.sheet);
      if (!sheet) {
        if (!wb.sheetNames.includes(cell.sheet)) {
          return unverified(
            `sheet "${cell.sheet}" carries cached values but the engine does not expose it`,
            checked,
          );
        }
        sheet = (await wb.getOrCreateSheet(cell.sheet)).sheet;
        sheets.set(cell.sheet, sheet);
      }

      let engineValue: unknown;
      try {
        engineValue = await sheet.getValue(cell.address);
      } catch (error) {
        return unverified(
          `the engine could not read ${cell.sheet}!${cell.address}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          checked,
        );
      }
      checked += 1;

      // The deterministic defect shape: the file recorded a real result, the
      // engine reports an error for the same formula.
      if (!cell.cachedIsError && isEngineError(engineValue)) {
        mismatches.push({
          sheet: cell.sheet,
          address: cell.address,
          cachedValue: cell.cachedValue,
          engineValue,
        });
      }
    }

    if (mismatches.length > 0) {
      const first = mismatches[0];
      return {
        status: 'failed',
        reason:
          `the engine reports ${String(first.engineValue)} at ${first.sheet}!${first.address} ` +
          `where the file recorded ${JSON.stringify(first.cachedValue)} ` +
          `(${mismatches.length} mismatching cell(s) of ${checked} checked)`,
        ...base,
        checkedCells: checked,
        truncated,
        mismatches,
      };
    }
    return {
      status: 'passed',
      reason: `the engine agrees with all ${checked} cached formula value(s) checked${
        truncated ? ` (sampled ${checked} of ${extract.cells.length})` : ''
      }`,
      ...base,
      checkedCells: checked,
      truncated,
      mismatches: [],
    };
  } finally {
    // dispose() has been observed returning undefined instead of a Promise on
    // some paths in 0.10.5, so never chain onto its return value. A borrowed
    // engine belongs to the caller and is not disposed here.
    if (!borrowed) {
      try {
        await wb.dispose();
      } catch {
        // A cleanup failure must not mask the fidelity result.
      }
    }
  }
}

/** The slice of the engine API this gate touches (verified against 0.10.5). */
export interface EngineWorkbook {
  readonly sheetNames: readonly string[];
  getOrCreateSheet(name: string): Promise<{ sheet: EngineWorksheet }>;
  dispose(): Promise<void>;
}

export interface EngineWorksheet {
  getValue(address: string): Promise<unknown>;
}
