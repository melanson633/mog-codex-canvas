/**
 * The canvas context bus: a narrow, ephemeral channel between the live human
 * canvas and the headless agent lane.
 *
 * It carries presence, not data: where the human is (active sheet, selection,
 * occupied cell, focus, dirty state) and navigation-only commands back to the
 * canvas (reveal a range). It holds only the latest state per workbook —
 * durable evidence belongs to the flight recorder, so this module keeps no
 * history and never touches disk. It cannot edit cells: the only command kind
 * is `reveal`, and the canvas decides how to honor it.
 *
 * Ordering: the canvas stamps every report with its mount epoch and a
 * monotonic sequence. A report from an older epoch, or out of order within the
 * current epoch, is rejected — a torn-down canvas can never overwrite the
 * state of the one that replaced it.
 */
import { randomUUID } from 'node:crypto';

export interface CanvasContextUpdate {
  /** Canvas mount epoch (host-generated, larger = newer canvas). */
  readonly epoch: number;
  /** Monotonic within an epoch. */
  readonly sequence: number;
  readonly activeSheet: string | null;
  /** A1-style range list head, e.g. "B2:D4". */
  readonly selection: string | null;
  /** The cell the human is on, e.g. "B2" (on activeSheet). */
  readonly occupiedCell: string | null;
  readonly focused: boolean;
  readonly dirty: boolean;
}

export interface CanvasContext extends CanvasContextUpdate {
  readonly workbook: string;
  readonly updatedAt: string;
}

export interface CanvasCommand {
  readonly id: string;
  readonly kind: 'reveal';
  readonly sheet: string | null;
  readonly range: string;
  readonly issuedAt: string;
}

export type ReportResult = { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

/** Commands queue up while the canvas is between polls; beyond this the oldest drop. */
const COMMAND_QUEUE_LIMIT = 16;

export interface ContextBus {
  report(workbook: string, update: CanvasContextUpdate): ReportResult;
  get(workbook: string): CanvasContext | null;
  /** Teardown: clears state unless a newer epoch has already replaced it. */
  clear(workbook: string, epoch: number): void;
  requestReveal(workbook: string, range: string, sheet?: string | null): CanvasCommand;
  /** Returns and removes all pending commands for the workbook. */
  drainCommands(workbook: string): CanvasCommand[];
}

export function createContextBus(): ContextBus {
  const contexts = new Map<string, CanvasContext>();
  const queues = new Map<string, CanvasCommand[]>();

  return {
    report(workbook, update) {
      // Malformed ordering fields make stale-vs-fresh undecidable; reject them
      // rather than letting NaN comparisons quietly accept everything.
      if (!Number.isFinite(update.epoch) || !Number.isFinite(update.sequence)) {
        return {
          accepted: false,
          reason: `epoch and sequence must be finite numbers (got epoch=${update.epoch}, sequence=${update.sequence})`,
        };
      }
      const current = contexts.get(workbook);
      if (current) {
        if (update.epoch < current.epoch) {
          return { accepted: false, reason: `stale epoch ${update.epoch} (current ${current.epoch})` };
        }
        if (update.epoch === current.epoch && update.sequence <= current.sequence) {
          return {
            accepted: false,
            reason: `out-of-order sequence ${update.sequence} (current ${current.sequence})`,
          };
        }
      }
      // Latest-state-only: each accepted report replaces the previous one.
      contexts.set(workbook, { ...update, workbook, updatedAt: new Date().toISOString() });
      return { accepted: true };
    },

    get(workbook) {
      return contexts.get(workbook) ?? null;
    },

    clear(workbook, epoch) {
      // A malformed epoch proves ownership of nothing; NaN comparisons below
      // would already be a no-op, but Infinity would clear another session's
      // state — refuse both shapes outright.
      if (!Number.isFinite(epoch)) return;
      const current = contexts.get(workbook);
      if (current && current.epoch <= epoch) contexts.delete(workbook);
      if (!contexts.has(workbook)) queues.delete(workbook);
    },

    requestReveal(workbook, range, sheet = null) {
      const command: CanvasCommand = {
        id: randomUUID(),
        kind: 'reveal',
        sheet,
        range,
        issuedAt: new Date().toISOString(),
      };
      const queue = queues.get(workbook) ?? [];
      queue.push(command);
      while (queue.length > COMMAND_QUEUE_LIMIT) queue.shift();
      queues.set(workbook, queue);
      return command;
    },

    drainCommands(workbook) {
      const queue = queues.get(workbook) ?? [];
      queues.delete(workbook);
      return queue;
    },
  };
}

// ---- A1 range arithmetic (used by the occupied-cell interlock) --------------

export interface ParsedRange {
  readonly sheet: string | null;
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const RANGE_RE = /^(?:(?:'([^']+)'|([A-Za-z0-9_ .-]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/;

/** Parses "B4", "A1:C9", "Sheet1!A1:C9", "'My Sheet'!B2". Returns null when unsupported. */
export function parseRange(ref: string): ParsedRange | null {
  const match = ref.trim().match(RANGE_RE);
  if (!match) return null;
  const [, quoted, bare, startColL, startRowS, endColL, endRowS] = match;
  const startCol = colNumber(startColL);
  const startRow = Number(startRowS);
  const endCol = endColL ? colNumber(endColL) : startCol;
  const endRow = endRowS ? Number(endRowS) : startRow;
  if (startRow < 1 || endRow < 1) return null;
  return {
    sheet: quoted ?? bare ?? null,
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}

/**
 * Does `range` cover the human's occupied cell? A range with no sheet
 * qualifier is treated as possibly-on-the-occupied-sheet (conservative: the
 * interlock refuses when it cannot prove disjointness).
 */
export function rangeCoversCell(
  range: ParsedRange,
  cell: ParsedRange,
  occupiedSheet: string | null,
): boolean {
  if (range.sheet && occupiedSheet && range.sheet.toLowerCase() !== occupiedSheet.toLowerCase()) {
    return false;
  }
  return (
    cell.startRow >= range.startRow &&
    cell.startRow <= range.endRow &&
    cell.startCol >= range.startCol &&
    cell.startCol <= range.endCol
  );
}
