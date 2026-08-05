/**
 * Stage 2a — the cross-sheet consumption index.
 *
 * The cheap answer to "is this data actually read, and from where". One
 * formula-text scan, no graph: for every sheet, which formulas on *other*
 * sheets point at it, and which of its columns they touch.
 *
 * This is what makes depth evidence-proportional. Profiling every column of
 * every sheet to full depth is the expensive habit this pipeline exists to
 * avoid; the column roll-up here is what Stage 3 spends its budget against.
 *
 * The honesty constraint is sharper than it looks. A zero inbound count is
 * reported as *measured* zero, and every reference this scan could not resolve
 * is carried through with its cause — because a structured table reference
 * silently dropped would read downstream as "nobody reads this column", and
 * Stage 3 would skip a column that is in fact consumed. Zero consumption and
 * zero visibility are different findings and are never merged.
 *
 * Engine-free: nothing here may import @mog-sdk.
 */
import { attr, readZipEntries, sheetParts, unescapeXml, type ZipEntry } from './ooxml-cache.ts';
import { parseFormulaRefs, type UnresolvedCause } from './formula-refs.ts';
import { revisionOf } from './workbook-revision.ts';
import { stagesNotRun, type ExtractionStage } from './extraction-stages.ts';

export interface InboundReference {
  /** Sheet the referencing formula lives on. */
  readonly fromSheet: string;
  /** Address of the referencing formula cell on that sheet. */
  readonly fromCell: string;
  /** The referenced address or rectangle, without the sheet qualifier. */
  readonly ref: string;
  readonly kind: 'cell' | 'range';
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface ColumnConsumption {
  readonly column: number;
  readonly letter: string;
  /** Inbound references whose rectangle touches this column. */
  readonly references: number;
  readonly fromSheets: readonly string[];
}

export interface SheetConsumption {
  readonly name: string;
  readonly inbound: readonly InboundReference[];
  readonly totalInbound: number;
  readonly referencingSheets: readonly string[];
  /** Per-column roll-up; columns nothing touches are absent, not zero rows. */
  readonly columns: readonly ColumnConsumption[];
  /**
   * References too wide to be column evidence. A rectangle spanning the sheet
   * says the sheet is consumed; it does not say every column in it is.
   */
  readonly sheetLevelReferences: number;
  readonly basis: string;
}

export interface UnresolvedSummary {
  readonly total: number;
  readonly byCause: Readonly<Partial<Record<UnresolvedCause, number>>>;
  /** What this index therefore cannot see. Empty string when nothing was lost. */
  readonly blindSpot: string;
}

export interface ConsumptionIndexReport {
  readonly status: 'indexed';
  readonly revision: string;
  readonly stagesRun: readonly ExtractionStage[];
  readonly stagesNotRun: readonly ExtractionStage[];
  readonly sheets: readonly SheetConsumption[];
  readonly formulaCellsScanned: number;
  readonly unresolved: UnresolvedSummary;
  /** Sheet names formulas referenced that this workbook does not declare. */
  readonly unknownSheetNames: readonly string[];
  readonly truncated: boolean;
  /** Which cap bit, when one did (R40). */
  readonly truncationReason: string | null;
  readonly elapsedMs: number;
}

export interface UnreadableIndex {
  readonly status: 'unreadable';
  readonly reason: string;
}

export type ConsumptionIndexResult = ConsumptionIndexReport | UnreadableIndex;

export interface ConsumptionIndexOptions {
  readonly referenceCap?: number;
}

/** Inbound references retained across the whole workbook. */
export const REFERENCE_CAP = 20000;

/**
 * A rectangle wider than this is treated as sheet-level evidence rather than
 * evidence about each column it spans. Set above any plausible table width so
 * a normal multi-column range still rolls up per column.
 */
export const WIDE_REFERENCE_COLUMNS = 32;

function columnLetters(col: number): string {
  let letters = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

interface FormulaCell {
  readonly address: string;
  readonly text: string;
}

/** Every formula cell on a sheet, with the address that carries it. */
function formulaCells(sheetXml: string): FormulaCell[] {
  const cells: FormulaCell[] = [];
  for (const match of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, attrs, inner = ''] = match;
    const address = attr(`<c ${attrs}>`, 'r');
    if (!address) continue;
    const text = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
    if (text) cells.push({ address, text: unescapeXml(text) });
  }
  return cells;
}

interface Accumulator {
  readonly inbound: InboundReference[];
  readonly referencingSheets: Set<string>;
  readonly columns: Map<number, { references: number; fromSheets: Set<string> }>;
  sheetLevelReferences: number;
}

function emptyAccumulator(): Accumulator {
  return { inbound: [], referencingSheets: new Set(), columns: new Map(), sheetLevelReferences: 0 };
}

/**
 * Builds the index from saved bytes. Cross-sheet operands only: an unqualified
 * operand is intra-sheet and belongs to the dependency graph, not here.
 */
export function buildConsumptionIndex(
  bytes: Uint8Array,
  options: ConsumptionIndexOptions = {},
): ConsumptionIndexResult {
  const started = performance.now();
  let entries: ZipEntry[];
  let sheets: { name: string; part: string }[];
  try {
    entries = readZipEntries(bytes);
    sheets = sheetParts(entries);
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  const referenceCap = options.referenceCap ?? REFERENCE_CAP;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const targets = new Map(sheets.map((sheet) => [sheet.name, emptyAccumulator()]));
  const byCause = new Map<UnresolvedCause, number>();
  const unknownSheetNames = new Set<string>();
  let formulaCellsScanned = 0;
  let stored = 0;
  let truncated = false;

  for (const { name, part } of sheets) {
    const xml = byName.get(part)?.data.toString('utf8') ?? '';
    for (const { address, text } of formulaCells(xml)) {
      formulaCellsScanned += 1;
      const { operands, unresolved } = parseFormulaRefs(text);
      for (const cause of unresolved) {
        byCause.set(cause.cause, (byCause.get(cause.cause) ?? 0) + 1);
      }
      for (const operand of operands) {
        if (operand.kind === 'name' || operand.sheet === null || operand.sheet === name) continue;
        const target = targets.get(operand.sheet);
        if (!target) {
          unknownSheetNames.add(operand.sheet);
          continue;
        }
        if (stored >= referenceCap) {
          truncated = true;
          continue;
        }
        stored += 1;

        const isRange = operand.kind === 'range';
        target.inbound.push({
          fromSheet: name,
          fromCell: address,
          ref: isRange ? operand.ref : operand.address,
          kind: operand.kind,
          startRow: isRange ? operand.startRow : operand.row,
          startCol: isRange ? operand.startCol : operand.col,
          endRow: isRange ? operand.endRow : operand.row,
          endCol: isRange ? operand.endCol : operand.col,
        });
        target.referencingSheets.add(name);

        const startCol = isRange ? operand.startCol : operand.col;
        const endCol = isRange ? operand.endCol : operand.col;
        if (endCol - startCol + 1 > WIDE_REFERENCE_COLUMNS) {
          target.sheetLevelReferences += 1;
          continue;
        }
        for (let column = startCol; column <= endCol; column += 1) {
          const entry = target.columns.get(column) ?? { references: 0, fromSheets: new Set<string>() };
          entry.references += 1;
          entry.fromSheets.add(name);
          target.columns.set(column, entry);
        }
      }
    }
  }

  const unresolvedTotal = [...byCause.values()].reduce((sum, count) => sum + count, 0);
  const report: ConsumptionIndexReport = {
    status: 'indexed',
    revision: revisionOf(bytes),
    stagesRun: ['stage-2a'],
    stagesNotRun: stagesNotRun(['stage-2a']),
    sheets: sheets.map(({ name }) => {
      const accumulated = targets.get(name) ?? emptyAccumulator();
      return {
        name,
        inbound: accumulated.inbound,
        totalInbound: accumulated.inbound.length,
        referencingSheets: [...accumulated.referencingSheets].sort(),
        columns: [...accumulated.columns.entries()]
          .sort(([a], [b]) => a - b)
          .map(([column, entry]) => ({
            column,
            letter: columnLetters(column),
            references: entry.references,
            fromSheets: [...entry.fromSheets].sort(),
          })),
        sheetLevelReferences: accumulated.sheetLevelReferences,
        basis: sheetBasis(name, accumulated, formulaCellsScanned, unresolvedTotal),
      };
    }),
    formulaCellsScanned,
    unresolved: {
      total: unresolvedTotal,
      byCause: Object.fromEntries(byCause),
      blindSpot: blindSpotOf(byCause),
    },
    unknownSheetNames: [...unknownSheetNames].sort(),
    truncated,
    truncationReason: truncated
      ? `the ${referenceCap}-reference cap bit: inbound references past it were not recorded, ` +
        'so every count below is a floor rather than a total'
      : null,
    elapsedMs: Math.round(performance.now() - started),
  };
  return report;
}

function sheetBasis(
  name: string,
  accumulated: Accumulator,
  formulaCellsScanned: number,
  unresolvedTotal: number,
): string {
  const scope =
    `measured over ${formulaCellsScanned} formula cells across the workbook, ` +
    'counting only operands qualified to another sheet';
  const caveat =
    unresolvedTotal > 0
      ? ` — ${unresolvedTotal} references workbook-wide could not be resolved, so this count is a floor`
      : '';
  if (accumulated.inbound.length === 0) {
    return `no formula on any other sheet references ${name}: zero is measured, not assumed — ${scope}${caveat}`;
  }
  const wide =
    accumulated.sheetLevelReferences > 0
      ? `; ${accumulated.sheetLevelReferences} of them span more than ${WIDE_REFERENCE_COLUMNS} columns and ` +
        'are counted as sheet-level evidence only, not as evidence about each column they cross'
      : '';
  return (
    `${accumulated.inbound.length} inbound references from ` +
    `${[...accumulated.referencingSheets].sort().join(', ')} — ${scope}${wide}${caveat}`
  );
}

function blindSpotOf(byCause: Map<UnresolvedCause, number>): string {
  if (byCause.size === 0) return '';
  const parts = [...byCause.entries()].map(([cause, count]) => `${count} ${cause}`);
  return (
    `${parts.join(', ')} — these references were recognized but not resolved to a sheet and column, ` +
    'so a zero column count here means "not seen", not "not used". Structured table references ' +
    '(Table[Column]) are the common case and are not resolved in this version.'
  );
}
