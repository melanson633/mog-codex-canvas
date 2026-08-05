/**
 * Byte-first workbook profiling and range reads.
 *
 * The host can read an .xlsx file's own XML in milliseconds while the canvas
 * renderer may take minutes to hydrate the same bytes
 * (docs/solutions/architecture-patterns/
 * host-side-ooxml-profiling-outruns-engine-readiness.md). This module is that
 * fast path: shape, formula counts, and cell values straight from the saved
 * bytes — the truth of the last save, labeled as such, never the engine's
 * truth of now.
 *
 * Deliberately engine-free: nothing here may import @mog-sdk. Bytes the ZIP
 * reader rejects come back as a typed `unreadable` result — unknown is never
 * reported as empty, and unreadable bytes must never be handed to the engine
 * speculatively (createWorkbook() on unopenable bytes leaks a native thread
 * in SDK 0.10.5).
 */
import {
  attr,
  parseSharedStrings,
  readZipEntries,
  sheetParts,
  unescapeXml,
  type ZipEntry,
} from './ooxml-cache.ts';
import { parseRange } from './context-bus.ts';

// ---- Profile ----------------------------------------------------------------

export interface SheetProfile {
  readonly name: string;
  readonly rows: number;
  readonly cells: number;
  readonly formulas: number;
}

export interface WorkbookProfile {
  readonly status: 'profiled';
  readonly bytes: number;
  readonly sheets: readonly SheetProfile[];
  readonly rows: number;
  readonly cells: number;
  readonly formulas: number;
  /** Formula operands that reference another sheet (SheetName!A1 shapes). */
  readonly crossSheetRefs: number;
  /** crossSheetRefs / formulas; 0 when the workbook has no formulas. */
  readonly crossSheetRatio: number;
  readonly tableParts: number;
  readonly calculatedColumnFormulas: number;
  readonly commentParts: number;
  /** Uncalibrated guess — see genreBasis, which must always accompany it. */
  readonly genre: 'model' | 'dataset';
  /** The honest label for how the guess was made. Shown verbatim in UIs. */
  readonly genreBasis: string;
  readonly elapsedMs: number;
}

export interface UnreadableProfile {
  readonly status: 'unreadable';
  readonly bytes: number;
  readonly reason: string;
}

export type ProfileResult = WorkbookProfile | UnreadableProfile;

/**
 * Threshold from two observed specimens (ratio 0.452 model, 0.000 dataset).
 * Two points do not establish a threshold — the basis string says so wherever
 * the guess travels.
 */
const GENRE_RATIO_THRESHOLD = 0.1;
const GENRE_BASIS =
  `cross-sheet ref ratio vs ${GENRE_RATIO_THRESHOLD} — uncalibrated threshold from two specimens`;

/** Formula element opener: <f>, <f t="shared">, or self-closed <f/>. */
const FORMULA_OPEN = /<f[\s/>]/g;
/** A sheet-qualified operand inside formula text: Data!B1 or 'My Sheet'!A1. */
const CROSS_SHEET_REF = /(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]/g;

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

/** Contents of every non-empty <f>…</f> element, XML-unescaped. */
function formulaTexts(sheetXml: string): string[] {
  const texts: string[] = [];
  for (const match of sheetXml.matchAll(/<f\b[^>]*>([\s\S]*?)<\/f>/g)) {
    if (match[1]) texts.push(unescapeXml(match[1]));
  }
  return texts;
}

export function profileWorkbook(bytes: Uint8Array): ProfileResult {
  const started = performance.now();
  let entries: ZipEntry[];
  let parts: { name: string; part: string }[];
  try {
    entries = readZipEntries(bytes);
    parts = sheetParts(entries);
  } catch (error) {
    return {
      status: 'unreadable',
      bytes: bytes.byteLength,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const sheets: SheetProfile[] = [];
  let crossSheetRefs = 0;
  for (const { name, part } of parts) {
    const xml = byName.get(part)?.data.toString('utf8') ?? '';
    sheets.push({
      name,
      rows: countMatches(xml, /<row\b/g),
      cells: countMatches(xml, /<c\b/g),
      formulas: countMatches(xml, FORMULA_OPEN),
    });
    for (const formula of formulaTexts(xml)) {
      crossSheetRefs += countMatches(formula, CROSS_SHEET_REF);
    }
  }

  let tableParts = 0;
  let calculatedColumnFormulas = 0;
  let commentParts = 0;
  for (const entry of entries) {
    if (/^xl\/tables\/table[^/]*\.xml$/i.test(entry.name)) {
      tableParts += 1;
      calculatedColumnFormulas += countMatches(
        entry.data.toString('utf8'),
        /<calculatedColumnFormula[\s>]/g,
      );
    } else if (/^xl\/(?:threadedComments\/)?(?:threadedC|c)omments[^/]*\.xml$/i.test(entry.name)) {
      commentParts += 1;
    }
  }

  const formulas = sheets.reduce((sum, sheet) => sum + sheet.formulas, 0);
  const crossSheetRatio = formulas > 0 ? crossSheetRefs / formulas : 0;

  return {
    status: 'profiled',
    bytes: bytes.byteLength,
    sheets,
    rows: sheets.reduce((sum, sheet) => sum + sheet.rows, 0),
    cells: sheets.reduce((sum, sheet) => sum + sheet.cells, 0),
    formulas,
    crossSheetRefs,
    crossSheetRatio,
    tableParts,
    calculatedColumnFormulas,
    commentParts,
    genre: crossSheetRatio > GENRE_RATIO_THRESHOLD ? 'model' : 'dataset',
    genreBasis: GENRE_BASIS,
    elapsedMs: Math.round(performance.now() - started),
  };
}

// ---- Range read -------------------------------------------------------------

export interface RangeCell {
  readonly address: string;
  /** The cached value as saved; null when the cell recorded none. */
  readonly value: string | number | boolean | null;
  /** Formula text as saved; null for plain values and shared-formula stubs. */
  readonly formula: string | null;
  /** True when the file itself recorded an error value (t="e"). */
  readonly isError: boolean;
}

export interface RangeRead {
  readonly status: 'ok';
  readonly sheet: string;
  readonly range: string;
  readonly cells: readonly RangeCell[];
  /** True when the cell cap cut the result short. */
  readonly truncated: boolean;
}

export interface RangeReadFailure {
  readonly status: 'unreadable' | 'no-such-sheet' | 'bad-range';
  readonly reason: string;
}

export type RangeReadResult = RangeRead | RangeReadFailure;

export interface RangeReadOptions {
  /** Maximum populated cells returned. Default RANGE_CELL_LIMIT. */
  readonly cellLimit?: number;
}

export const RANGE_CELL_LIMIT = 2000;

/** "BC" -> 55. Mirrors context-bus column math for cell addresses. */
function colNumber(letters: string): number {
  let value = 0;
  for (const ch of letters.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value;
}

/**
 * Reads the populated cells of one sheet range straight from saved bytes:
 * cached values and formula text, exactly as the file recorded them at its
 * last save. Never opens the engine; never sees unsaved canvas edits.
 */
export function readRangeFromBytes(
  bytes: Uint8Array,
  sheetName: string,
  rangeRef: string,
  options: RangeReadOptions = {},
): RangeReadResult {
  const range = parseRange(rangeRef);
  if (!range) {
    return { status: 'bad-range', reason: `Not an A1 range: ${rangeRef}` };
  }

  let entries: ZipEntry[];
  let parts: { name: string; part: string }[];
  try {
    entries = readZipEntries(bytes);
    parts = sheetParts(entries);
  } catch (error) {
    return {
      status: 'unreadable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const target = parts.find((sheet) => sheet.name === sheetName);
  if (!target) {
    return {
      status: 'no-such-sheet',
      reason: `No sheet named ${sheetName}. Sheets: ${parts.map((s) => s.name).join(', ')}`,
    };
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const sheetXml = byName.get(target.part)?.data.toString('utf8') ?? '';
  const shared = parseSharedStrings(byName.get('xl/sharedStrings.xml')?.data.toString('utf8') ?? null);
  const cellLimit = options.cellLimit ?? RANGE_CELL_LIMIT;

  const cells: RangeCell[] = [];
  let truncated = false;
  for (const match of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, attrs, inner = ''] = match;
    const tag = `<c ${attrs}>`;
    const address = attr(tag, 'r');
    if (!address) continue;
    const cellMatch = address.match(/^([A-Za-z]+)(\d+)$/);
    if (!cellMatch) continue;
    const col = colNumber(cellMatch[1]);
    const row = Number(cellMatch[2]);
    if (row < range.startRow || row > range.endRow || col < range.startCol || col > range.endCol) {
      continue;
    }
    if (cells.length >= cellLimit) {
      truncated = true;
      break;
    }

    const type = attr(tag, 't') ?? 'n';
    const formulaMatch = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
    const formula = formulaMatch?.[1] ? unescapeXml(formulaMatch[1]) : null;

    let value: string | number | boolean | null = null;
    let isError = false;
    if (type === 'inlineStr') {
      let text = '';
      for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
      value = text;
    } else {
      const valueMatch = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      if (valueMatch) {
        const raw = unescapeXml(valueMatch[1]);
        if (type === 'e') {
          value = raw;
          isError = true;
        } else if (type === 's') {
          const index = Number(raw);
          value = Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : null;
        } else if (type === 'str') {
          value = raw;
        } else if (type === 'b') {
          value = raw === '1';
        } else {
          const numeric = Number(raw);
          value = Number.isFinite(numeric) ? numeric : null;
        }
      }
    }
    cells.push({ address, value, formula, isError });
  }

  return { status: 'ok', sheet: sheetName, range: rangeRef, cells, truncated };
}
