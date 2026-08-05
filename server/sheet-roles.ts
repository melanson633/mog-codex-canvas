/**
 * Stage 0 and Stage 1 — per-sheet extent and role hypothesis.
 *
 * The shipped workbook-level `genre` field answers "is this file a model or a
 * dataset", and for a mixed workbook that question has no correct answer: one
 * label is necessarily wrong for at least one sheet. Role is therefore
 * per sheet, and nothing downstream branches on `genre`.
 *
 * Two extents are reported, never conflated. The **claimed** box is whatever
 * `<dimension ref=…>` declares — producers write stale and oversized
 * dimensions routinely, so it is labeled claimed-not-verified wherever it
 * travels. The **observed** box is computed from the cell addresses actually
 * scanned. Their disagreement is a finding about the file, not an error.
 *
 * Every threshold lives in `ROLE_THRESHOLDS` with its basis string beside it,
 * in the `genreBasis` idiom: a guess that travels with an honest account of
 * how it was made. They are uncalibrated — two hand-authored specimens and one
 * real workbook cannot establish a threshold, and the basis says so rather
 * than letting a number pass for a measurement.
 *
 * Engine-free: nothing here may import @mog-sdk.
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
import { revisionOf } from './workbook-revision.ts';
import { stagesNotRun, type ExtractionStage } from './extraction-stages.ts';

// ---- Shared shapes ----------------------------------------------------------

export interface Box {
  readonly ref: string;
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface UnreadableSheets {
  readonly status: 'unreadable';
  readonly reason: string;
}

// ---- Thresholds -------------------------------------------------------------

/**
 * Every number the role rule consults, with the reasoning that produced it.
 * Q3 in the plan defers calibration; when a specimen corpus exists this block
 * is the single place it lands.
 */
export const ROLE_THRESHOLDS = {
  /** At or above this formula density a sheet reads as a model. */
  modelFormulaDensity: 0.3,
  /**
   * At or below this density a sheet may still read as a dataset. Set above
   * 1/9 on purpose: a table with one calculated column among roughly eight
   * data columns is a dataset with a calculated column, not a hybrid.
   */
  datasetFormulaDensity: 0.15,
  /** A dataset claim also needs this many observed rows. */
  datasetMinRows: 10,
  /** Below this many populated cells no role is claimed at all. */
  minPopulatedCells: 8,
  /** Share of a candidate row's cells that must be non-numeric to be a header. */
  headerLabelShare: 0.8,
  /** Share of non-numeric cells the rows beneath must stay under. */
  bodyLabelShare: 0.5,
  /** Header share at or above which the detection is called confident. */
  headerConfidentShare: 0.95,
} as const;

export const ROLE_BASIS_CAVEAT =
  'uncalibrated thresholds — set from a handful of specimens, not a validated corpus';

/** Populated rows below the header candidate that the detector inspects. */
const HEADER_BODY_ROWS = 20;

// ---- Stage 0 ----------------------------------------------------------------

export interface SheetExtent {
  readonly name: string;
  /** Shipped shape counts, unchanged in meaning (R7). */
  readonly rows: number;
  readonly cells: number;
  readonly formulas: number;
  /** The box `<dimension>` declares — claimed, never verified here. */
  readonly claimedBox: Box | null;
  readonly claimedBoxBasis: string;
}

export interface SheetExtentsReport {
  readonly status: 'extracted';
  readonly revision: string;
  readonly stagesRun: readonly ExtractionStage[];
  readonly stagesNotRun: readonly ExtractionStage[];
  readonly sheets: readonly SheetExtent[];
  readonly elapsedMs: number;
}

export type SheetExtentsResult = SheetExtentsReport | UnreadableSheets;

// ---- Stage 1 ----------------------------------------------------------------

export type SheetRole = 'dataset' | 'model' | 'mixed' | 'indeterminate';

export interface HeaderDetection {
  readonly status: 'detected' | 'none';
  /** 1-based row index of the header, or null when none was found. */
  readonly row: number | null;
  /** Labels in column order; empty when no header was detected. */
  readonly labels: readonly string[];
  readonly confident: boolean;
  readonly basis: string;
}

export interface SheetRoleReport {
  readonly name: string;
  readonly role: SheetRole;
  readonly confident: boolean;
  readonly basis: string;
  readonly populatedCells: number;
  readonly formulaCells: number;
  readonly formulaDensity: number;
  readonly observedRows: number;
  readonly observedBox: Box | null;
  readonly claimedBox: Box | null;
  readonly claimedBoxBasis: string;
  /** 'agrees', or a sentence describing how the two boxes differ (R10). */
  readonly claimedVsObserved: string;
  readonly header: HeaderDetection;
}

export interface SheetRolesReport {
  readonly status: 'classified';
  readonly revision: string;
  readonly stagesRun: readonly ExtractionStage[];
  readonly stagesNotRun: readonly ExtractionStage[];
  readonly sheets: readonly SheetRoleReport[];
  readonly elapsedMs: number;
}

export type SheetRolesResult = SheetRolesReport | UnreadableSheets;

// ---- Address helpers --------------------------------------------------------

/** "BC" -> 55. Mirrors the column math in workbook-profile and context-bus. */
function colNumber(letters: string): number {
  let value = 0;
  for (const ch of letters.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value;
}

/** 55 -> "BC". */
function columnLetters(col: number): string {
  let letters = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function box(startRow: number, startCol: number, endRow: number, endCol: number): Box {
  return {
    ref: `${columnLetters(startCol)}${startRow}:${columnLetters(endCol)}${endRow}`,
    startRow,
    startCol,
    endRow,
    endCol,
  };
}

// ---- Archive reading --------------------------------------------------------

interface OpenedWorkbook {
  readonly entries: readonly ZipEntry[];
  readonly sheets: readonly { name: string; part: string }[];
  readonly byName: Map<string, ZipEntry>;
  readonly shared: readonly string[];
}

function openWorkbook(bytes: Uint8Array): OpenedWorkbook | UnreadableSheets {
  try {
    const entries = readZipEntries(bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return {
      entries,
      sheets: sheetParts(entries),
      byName,
      shared: parseSharedStrings(byName.get('xl/sharedStrings.xml')?.data.toString('utf8') ?? null),
    };
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

const NO_DIMENSION_BASIS =
  'no <dimension ref=…> element on this sheet — the claimed extent is unknown, not empty';

const CLAIMED_BOX_BASIS =
  'from the sheet\'s <dimension ref=…> element — claimed by the producing application, ' +
  'not verified against the cells present';

function claimedBoxOf(sheetXml: string): { claimedBox: Box | null; claimedBoxBasis: string } {
  const open = sheetXml.match(/<dimension\b[^>]*\/?>/)?.[0];
  const ref = open ? attr(open, 'ref') : null;
  if (!ref) return { claimedBox: null, claimedBoxBasis: NO_DIMENSION_BASIS };
  const parsed = parseRange(ref);
  if (!parsed) {
    return {
      claimedBox: null,
      claimedBoxBasis: `<dimension ref="${ref}"> is not an A1 range this reader parses — the claimed extent is unknown`,
    };
  }
  return {
    claimedBox: box(parsed.startRow, parsed.startCol, parsed.endRow, parsed.endCol),
    claimedBoxBasis: CLAIMED_BOX_BASIS,
  };
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

/**
 * Stage 0: shape counts plus the extent each sheet claims for itself. Cheap —
 * regex counts and one `<dimension>` read per sheet, no cell-level pass.
 */
export function readSheetExtents(bytes: Uint8Array): SheetExtentsResult {
  const started = performance.now();
  const opened = openWorkbook(bytes);
  if ('status' in opened) return opened;

  const sheets = opened.sheets.map(({ name, part }) => {
    const xml = opened.byName.get(part)?.data.toString('utf8') ?? '';
    return {
      name,
      rows: countMatches(xml, /<row\b/g),
      cells: countMatches(xml, /<c\b/g),
      formulas: countMatches(xml, /<f[\s/>]/g),
      ...claimedBoxOf(xml),
    };
  });

  const stagesRun: ExtractionStage[] = ['stage-0'];
  return {
    status: 'extracted',
    revision: revisionOf(bytes),
    stagesRun,
    stagesNotRun: stagesNotRun(stagesRun),
    sheets,
    elapsedMs: Math.round(performance.now() - started),
  };
}

// ---- Cell pass --------------------------------------------------------------

interface ScannedCell {
  readonly col: number;
  /** Text content when the cell holds a string; null when it holds a number. */
  readonly text: string | null;
}

interface SheetScan {
  readonly populatedCells: number;
  readonly formulaCells: number;
  readonly observedBox: Box | null;
  /** The lowest-numbered populated rows, for header detection. */
  readonly topRows: Map<number, ScannedCell[]>;
}

/**
 * One cell-level pass per sheet: observed box, population and formula counts,
 * and a bounded buffer of the topmost populated rows for header detection.
 *
 * The buffer is capped rather than the whole sheet retained — a 12,000-row
 * specimen would otherwise be held in memory to inspect its first row.
 */
function scanSheet(sheetXml: string, shared: readonly string[]): SheetScan {
  let populatedCells = 0;
  let formulaCells = 0;
  let minRow = Number.POSITIVE_INFINITY;
  let minCol = Number.POSITIVE_INFINITY;
  let maxRow = 0;
  let maxCol = 0;
  const topRows = new Map<number, ScannedCell[]>();
  const bufferedRows = HEADER_BODY_ROWS + 1;

  for (const match of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, attrs, inner = ''] = match;
    const tag = `<c ${attrs}>`;
    const address = attr(tag, 'r');
    const parts = address?.match(/^([A-Za-z]+)(\d+)$/);
    if (!parts) continue;
    const col = colNumber(parts[1]);
    const row = Number(parts[2]);

    const type = attr(tag, 't') ?? 'n';
    const hasFormula = /<f[\s/>]/.test(inner);
    const text = textOf(type, inner, shared);
    // A cell element with neither a value nor a formula is a style carrier.
    if (text === null && !hasFormula && !/<v\b/.test(inner)) continue;

    populatedCells += 1;
    if (hasFormula) formulaCells += 1;
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;

    const existing = topRows.get(row);
    if (existing) {
      existing.push({ col, text });
    } else {
      topRows.set(row, [{ col, text }]);
      if (topRows.size > bufferedRows) {
        let highest = -1;
        for (const key of topRows.keys()) if (key > highest) highest = key;
        topRows.delete(highest);
      }
    }
  }

  return {
    populatedCells,
    formulaCells,
    observedBox: populatedCells > 0 ? box(minRow, minCol, maxRow, maxCol) : null,
    topRows,
  };
}

/** The cell's string content, or null when it is numeric, boolean, or an error. */
function textOf(type: string, inner: string, shared: readonly string[]): string | null {
  if (type === 'inlineStr') {
    let text = '';
    for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
    return text;
  }
  const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return null;
  if (type === 's') {
    const index = Number(unescapeXml(raw));
    return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : null;
  }
  if (type === 'str') return unescapeXml(raw);
  return null;
}

// ---- Header detection -------------------------------------------------------

function labelShare(cells: readonly ScannedCell[]): number {
  if (cells.length === 0) return 0;
  return cells.filter((c) => c.text !== null && c.text.trim() !== '').length / cells.length;
}

function detectHeader(scan: SheetScan): HeaderDetection {
  const rows = [...scan.topRows.keys()].sort((a, b) => a - b);
  if (rows.length === 0) {
    return { status: 'none', row: null, labels: [], confident: false, basis: 'the sheet has no populated cells' };
  }

  const candidateRow = rows[0];
  const candidate = scan.topRows.get(candidateRow) ?? [];
  const candidateShare = labelShare(candidate);
  const body = rows.slice(1, HEADER_BODY_ROWS + 1).flatMap((row) => scan.topRows.get(row) ?? []);
  const bodyShare = labelShare(body);
  const measured =
    `row ${candidateRow} is ${(candidateShare * 100).toFixed(0)}% non-numeric labels ` +
    `(threshold ${ROLE_THRESHOLDS.headerLabelShare}), the ${body.length} cells beneath it are ` +
    `${(bodyShare * 100).toFixed(0)}% (threshold ${ROLE_THRESHOLDS.bodyLabelShare}) — ${ROLE_BASIS_CAVEAT}`;

  if (candidateShare < ROLE_THRESHOLDS.headerLabelShare) {
    return {
      status: 'none',
      row: null,
      labels: [],
      confident: false,
      basis: `no header row found: ${measured}`,
    };
  }
  if (body.length > 0 && bodyShare > ROLE_THRESHOLDS.bodyLabelShare) {
    return {
      status: 'none',
      row: null,
      labels: [],
      confident: false,
      basis: `no header row found — the rows beneath read like labels too: ${measured}`,
    };
  }

  const labels = [...candidate]
    .sort((a, b) => a.col - b.col)
    .map((c) => c.text ?? '');
  const confident = candidateShare >= ROLE_THRESHOLDS.headerConfidentShare && body.length > 0;
  const why = confident
    ? measured
    : body.length === 0
      ? `${measured}; no rows beneath it to contrast against`
      : `${measured}; the candidate row mixes labels and numbers`;
  return { status: 'detected', row: candidateRow, labels, confident, basis: why };
}

// ---- Role rule --------------------------------------------------------------

function describeDivergence(claimed: Box | null, observed: Box | null): string {
  if (!claimed) return 'no claimed box to compare against';
  if (!observed) {
    return `the sheet declares ${claimed.ref} but no populated cells were found in it`;
  }
  if (
    claimed.startRow === observed.startRow &&
    claimed.startCol === observed.startCol &&
    claimed.endRow === observed.endRow &&
    claimed.endCol === observed.endCol
  ) {
    return 'agrees';
  }
  const rowGap = claimed.endRow - observed.endRow;
  const colGap = claimed.endCol - observed.endCol;
  const parts: string[] = [];
  if (rowGap !== 0) parts.push(`${Math.abs(rowGap)} rows ${rowGap > 0 ? 'beyond' : 'short of'} the cells present`);
  if (colGap !== 0) {
    parts.push(`${Math.abs(colGap)} columns ${colGap > 0 ? 'beyond' : 'short of'} the cells present`);
  }
  const gap = parts.length > 0 ? `, ${parts.join(' and ')}` : '';
  return `declared ${claimed.ref} but cells were found only in ${observed.ref}${gap}`;
}

interface RoleVerdict {
  readonly role: SheetRole;
  readonly confident: boolean;
  readonly basis: string;
}

function classify(scan: SheetScan, header: HeaderDetection): RoleVerdict {
  const density = scan.populatedCells > 0 ? scan.formulaCells / scan.populatedCells : 0;
  const observedRows = scan.observedBox ? scan.observedBox.endRow - scan.observedBox.startRow + 1 : 0;
  const evidence =
    `formula density ${density.toFixed(3)} (${scan.formulaCells} of ${scan.populatedCells} populated cells), ` +
    `${observedRows} observed rows, header ${header.status === 'detected' ? `row ${header.row}` : 'none'}`;
  const thresholds =
    `thresholds: model at density >= ${ROLE_THRESHOLDS.modelFormulaDensity}, ` +
    `dataset at density <= ${ROLE_THRESHOLDS.datasetFormulaDensity} with a header row and ` +
    `>= ${ROLE_THRESHOLDS.datasetMinRows} rows, no role below ` +
    `${ROLE_THRESHOLDS.minPopulatedCells} populated cells`;

  if (scan.populatedCells < ROLE_THRESHOLDS.minPopulatedCells) {
    return {
      role: 'indeterminate',
      confident: false,
      basis:
        `too small to judge: ${scan.populatedCells} populated cells is below the ` +
        `${ROLE_THRESHOLDS.minPopulatedCells}-cell floor — ${evidence}; ${thresholds}; ${ROLE_BASIS_CAVEAT}`,
    };
  }
  if (density >= ROLE_THRESHOLDS.modelFormulaDensity) {
    return { role: 'model', confident: true, basis: `${evidence}; ${thresholds}; ${ROLE_BASIS_CAVEAT}` };
  }
  if (
    density <= ROLE_THRESHOLDS.datasetFormulaDensity &&
    header.status === 'detected' &&
    observedRows >= ROLE_THRESHOLDS.datasetMinRows
  ) {
    return { role: 'dataset', confident: true, basis: `${evidence}; ${thresholds}; ${ROLE_BASIS_CAVEAT}` };
  }
  return {
    role: 'mixed',
    confident: false,
    basis:
      `neither rule matched cleanly, so both presentations are offered and neither is asserted — ` +
      `${evidence}; ${thresholds}; no region boxes are reported because intra-sheet segmentation ` +
      `is not attempted; ${ROLE_BASIS_CAVEAT}`,
  };
}

/**
 * Stage 1: one cell pass per sheet producing the observed box, the header
 * finding, and a role hypothesis that states every threshold it consulted.
 *
 * `mixed` is a coarse fallback, not a segmentation result — it means the sheet
 * reads cleanly as neither, and it deliberately carries no region boxes.
 */
export function classifySheetRoles(bytes: Uint8Array): SheetRolesResult {
  const started = performance.now();
  const opened = openWorkbook(bytes);
  if ('status' in opened) return opened;

  const sheets = opened.sheets.map(({ name, part }) => {
    const xml = opened.byName.get(part)?.data.toString('utf8') ?? '';
    const { claimedBox, claimedBoxBasis } = claimedBoxOf(xml);
    const scan = scanSheet(xml, opened.shared);
    const header = detectHeader(scan);
    const verdict = classify(scan, header);
    return {
      name,
      role: verdict.role,
      confident: verdict.confident,
      basis: verdict.basis,
      populatedCells: scan.populatedCells,
      formulaCells: scan.formulaCells,
      formulaDensity: scan.populatedCells > 0 ? scan.formulaCells / scan.populatedCells : 0,
      observedRows: scan.observedBox ? scan.observedBox.endRow - scan.observedBox.startRow + 1 : 0,
      observedBox: scan.observedBox,
      claimedBox,
      claimedBoxBasis,
      claimedVsObserved: describeDivergence(claimedBox, scan.observedBox),
      header,
    };
  });

  const stagesRun: ExtractionStage[] = ['stage-0', 'stage-1'];
  return {
    status: 'classified',
    revision: revisionOf(bytes),
    stagesRun,
    stagesNotRun: stagesNotRun(stagesRun),
    sheets,
    elapsedMs: Math.round(performance.now() - started),
  };
}
