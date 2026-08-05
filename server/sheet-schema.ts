/**
 * Stage 3 — column schema and population statistics, materiality-gated.
 *
 * The expensive stage, and the one that must justify every cell it reads. Depth
 * is proportional to *measured* consumption from Stage 2a: a column forty
 * formulas point at is worth extents and a distinct count; a column nothing
 * references gets its name and type and nothing more. What was not computed is
 * reported as skipped with the threshold that caused it, because a column
 * silently omitted reads downstream as a column that does not exist.
 *
 * Two corrections the naive gate gets wrong, both load-bearing:
 *
 *   - A rectangle spanning the sheet is evidence about the *sheet*, not about
 *     each of the twenty-six columns it crosses. Treating it as per-column
 *     evidence promotes everything to full depth and the gate stops gating.
 *   - Incomplete measurement fails open. When Stage 2a could not resolve some
 *     inbound references, a zero column count means "not seen", not "not used",
 *     so the column is profiled anyway with the blind spot stated.
 *
 * Redaction (R38, in `redaction.ts`) runs before any statistic is attached, on
 * every return path including the zero-consumption one, and no option turns it
 * off. A high-risk column is always *reported* — name, type, row count, null
 * count, `redacted: true`, and the matched reason — never quietly dropped.
 * R39 — no raw values as samples, anywhere — is what keeps a mis-headed date
 * column from leaking a roster regardless.
 *
 * Headers are looked up *by column number*, never by position. Stage 1's label
 * list collapses blank header cells rather than emitting them, so one gap to
 * the left of an SSN column would otherwise shift every later label by one and
 * run the guard against a neighbour's name.
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
import { buildConsumptionIndex, type ConsumptionIndexReport } from './consumption-index.ts';
import { classifySheetRoles, type Box, type SheetRoleReport, type SheetRolesReport } from './sheet-roles.ts';
import { SHAPE_SAMPLE, redactionReasonFor } from './redaction.ts';
import { metadataFromEntries, type WorkbookMetadata } from './workbook-metadata.ts';
import { revisionOf } from './workbook-revision.ts';
import { stagesNotRun, type ExtractionStage } from './extraction-stages.ts';

// ---- Thresholds -------------------------------------------------------------

export const SCHEMA_THRESHOLDS = {
  /** At or above this many inbound references, a column earns full depth. */
  heavyUseReferences: 10,
  /** Above zero but below heavy use: schema plus counts, no extents. */
  minimumUseReferences: 1,
  /** Distinct values counted per column before the count becomes a floor. */
  distinctCap: 1000,
} as const;

export const SCHEMA_BASIS_CAVEAT =
  'uncalibrated thresholds — set from a handful of specimens, not a validated corpus';

/** The tier applied when the only evidence is sheet-level (R25). */
const SHEET_LEVEL_TIER = 'counts' as const;

// ---- Result shape -----------------------------------------------------------

export type ColumnDepth = 'full' | 'counts' | 'summary';

export type ObservedType = 'number' | 'text' | 'boolean' | 'error' | 'blank';

export interface TypeObservation {
  readonly type: ObservedType;
  readonly cells: number;
}

export interface SkippedWork {
  readonly what: 'extents' | 'distinct';
  readonly reason: string;
  readonly threshold: string;
}

export interface ColumnProfile {
  readonly ordinal: number;
  readonly letter: string;
  readonly header: string | null;
  /** `mixed` when the column's cells disagree; never a majority winner. */
  readonly type: ObservedType | 'mixed';
  readonly observedTypes: readonly TypeObservation[];
  readonly depth: ColumnDepth;
  readonly depthBasis: string;
  readonly inboundReferences: number;
  readonly rowCount: number | null;
  readonly nullCount: number | null;
  readonly min: number | null;
  readonly max: number | null;
  /** What min/max are measured over, when they are reported at all. */
  readonly extentsNote: string | null;
  readonly distinctCount: number | null;
  readonly distinctCapped: boolean;
  readonly redacted: boolean;
  readonly redactionReason: string | null;
  readonly skipped: readonly SkippedWork[];
}

export interface GatingReport {
  readonly thresholds: typeof SCHEMA_THRESHOLDS;
  readonly basis: string;
  /** Inbound references that named a column of this sheet. */
  readonly columnEvidence: number;
  /** Inbound references too wide to be column evidence. */
  readonly sheetLevelEvidence: number;
  /** Inbound references workbook-wide the index could not resolve. */
  readonly unresolvedInbound: number;
  /** Set when sheet-level or unresolved evidence changed the default tier. */
  readonly fallbackTier: ColumnDepth | null;
  readonly fallbackReason: string | null;
  readonly blindSpot: string | null;
}

export interface SheetDataDescription {
  readonly status: 'described';
  readonly revision: string;
  readonly stagesRun: readonly ExtractionStage[];
  readonly stagesNotRun: readonly ExtractionStage[];
  readonly sheet: string;
  readonly role: SheetRoleReport['role'];
  readonly roleBasis: string;
  readonly observedBox: Box | null;
  readonly claimedVsObserved: string;
  readonly headerSource: 'detected-row' | 'table-definition' | 'none';
  readonly headerSourceBasis: string;
  readonly columns: readonly ColumnProfile[];
  /** Set when the sheet stopped at box plus headers (R27). */
  readonly statisticsSkipped: string | null;
  readonly gating: GatingReport;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  readonly elapsedMs: number;
}

export interface NoSuchSheet {
  readonly status: 'no-such-sheet';
  readonly reason: string;
  readonly sheets: readonly string[];
}

export interface UnreadableSheetData {
  readonly status: 'unreadable';
  readonly reason: string;
}

export type SheetDataResult = SheetDataDescription | NoSuchSheet | UnreadableSheetData;

export interface DescribeSheetDataOptions {
  /** Run full depth regardless of the gate. Never bypasses redaction (R38). */
  readonly override?: boolean;
  readonly distinctCap?: number;
  /** Stage outputs to reuse instead of recomputing them (R4). */
  readonly roles?: SheetRolesReport;
  readonly consumption?: ConsumptionIndexReport;
  readonly metadata?: WorkbookMetadata;
}

// ---- Cell scan --------------------------------------------------------------

interface ColumnAccumulator {
  populated: number;
  blank: number;
  readonly types: Map<ObservedType, number>;
  min: number | null;
  max: number | null;
  readonly distinct: Set<string>;
  distinctCapped: boolean;
  /** Bounded sample of populated text, for the SSN value-shape rule only. */
  readonly shapeSample: string[];
}

function emptyColumn(): ColumnAccumulator {
  return {
    populated: 0,
    blank: 0,
    types: new Map(),
    min: null,
    max: null,
    distinct: new Set(),
    distinctCapped: false,
    shapeSample: [],
  };
}

function columnLetters(col: number): string {
  let letters = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function colNumber(letters: string): number {
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

interface CellRead {
  readonly row: number;
  readonly col: number;
  readonly type: ObservedType;
  readonly text: string;
  readonly numeric: number | null;
}

/** One pass over the sheet, resolving shared strings the way `read_range` does. */
function* readCells(sheetXml: string, shared: readonly string[]): Generator<CellRead> {
  for (const match of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, attrs, inner = ''] = match;
    const openTag = `<c ${attrs}>`;
    const address = attr(openTag, 'r');
    if (!address) continue;
    const parts = address.match(/^([A-Za-z]+)(\d+)$/);
    if (!parts) continue;
    const cellType = attr(openTag, 't');
    const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    const inlineText = inner.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1];

    let type: ObservedType;
    let text: string;
    if (cellType === 's') {
      type = 'text';
      text = shared[Number(raw)] ?? '';
    } else if (cellType === 'inlineStr') {
      type = 'text';
      text = unescapeXml(inlineText ?? '');
    } else if (cellType === 'str') {
      type = 'text';
      text = unescapeXml(raw ?? '');
    } else if (cellType === 'b') {
      type = 'boolean';
      text = raw === '1' ? 'TRUE' : 'FALSE';
    } else if (cellType === 'e') {
      type = 'error';
      text = unescapeXml(raw ?? '');
    } else if (raw === undefined || raw === '') {
      type = 'blank';
      text = '';
    } else {
      type = 'number';
      text = raw;
    }
    if (type !== 'blank' && text === '') type = 'blank';
    const numeric = type === 'number' ? Number(text) : null;
    yield {
      row: Number(parts[2]),
      col: colNumber(parts[1]),
      type,
      text,
      numeric: numeric !== null && Number.isFinite(numeric) ? numeric : null,
    };
  }
}

// ---- Description ------------------------------------------------------------

export function describeSheetData(
  bytes: Uint8Array,
  sheetName: string,
  options: DescribeSheetDataOptions = {},
): SheetDataResult {
  const started = performance.now();
  let entries: ZipEntry[];
  let parts: { name: string; part: string }[];
  try {
    entries = readZipEntries(bytes);
    parts = sheetParts(entries);
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  const target = parts.find((sheet) => sheet.name === sheetName);
  if (!target) {
    return {
      status: 'no-such-sheet',
      reason: `this workbook has no sheet named "${sheetName}"`,
      sheets: parts.map((sheet) => sheet.name),
    };
  }

  const roles = options.roles ?? classifySheetRoles(bytes);
  if (roles.status === 'unreadable') return roles;
  const consumption = options.consumption ?? buildConsumptionIndex(bytes);
  if (consumption.status === 'unreadable') return consumption;
  const metadata = options.metadata ?? metadataFromEntries(entries, parts);

  const role = roles.sheets.find((sheet) => sheet.name === sheetName);
  const consumed = consumption.sheets.find((sheet) => sheet.name === sheetName);
  const distinctCap = options.distinctCap ?? SCHEMA_THRESHOLDS.distinctCap;
  const override = options.override === true;

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const sheetXml = byName.get(target.part)?.data.toString('utf8') ?? '';
  const shared = parseSharedStrings(byName.get('xl/sharedStrings.xml')?.data.toString('utf8') ?? null);

  // ---- Headers -------------------------------------------------------------
  const table = metadata.tables.find((definition) => definition.sheet === sheetName);
  const detectedRow = role?.header.status === 'detected' ? role.header.row : null;
  let headerSource: SheetDataDescription['headerSource'] = 'none';
  /** Labels paired with the column each was read from — never positional. */
  let headerEntries: { readonly column: number; readonly label: string }[] = [];
  /** The row the labels came from; its cells are labels, not data. */
  let headerRow: number | null = detectedRow;
  if (table && table.columns.length > 0) {
    headerSource = 'table-definition';
    // A table's column list is dense by definition: it declares one entry per
    // column of its own ref, so position and column agree here.
    const tableFirstColumn = colNumber(table.ref.match(/^\$?([A-Za-z]+)/)?.[1] ?? 'A');
    headerEntries = table.columns.map((label, index) => ({ column: tableFirstColumn + index, label }));
    headerRow = detectedRow ?? (Number(table.ref.match(/^\$?[A-Za-z]+\$?(\d+)/)?.[1] ?? '') || null);
  } else if (detectedRow !== null && role?.header.labels.length) {
    headerSource = 'detected-row';
    headerEntries = role.header.labels.map((entry) => ({ column: entry.column, label: entry.label }));
  }
  const headerByColumn = new Map(headerEntries.map((entry) => [entry.column, entry.label]));
  const headerSourceBasis =
    headerSource === 'table-definition'
      ? `headers read from the declared table "${table?.displayName ?? table?.name}" — ` +
        'the file states them, so they are not inferred'
      : headerSource === 'detected-row'
        ? `headers read from detected header row ${headerRow} — ${role?.header.basis ?? ''}`
        : 'no header row was detected and no table declares this region, so columns are unlabeled';

  // ---- Gate ----------------------------------------------------------------
  const columnReferences = new Map<number, number>();
  for (const column of consumed?.columns ?? []) columnReferences.set(column.column, column.references);
  const columnEvidence = [...columnReferences.values()].reduce((sum, count) => sum + count, 0);
  const sheetLevelEvidence = consumed?.sheetLevelReferences ?? 0;
  const unresolvedInbound = consumption.unresolved.total;

  let fallbackTier: ColumnDepth | null = null;
  let fallbackReason: string | null = null;
  let blindSpot: string | null = null;
  if (columnEvidence === 0 && sheetLevelEvidence > 0) {
    fallbackTier = SHEET_LEVEL_TIER;
    fallbackReason =
      `the only inbound evidence for this sheet is ${sheetLevelEvidence} whole-sheet rectangle(s), ` +
      'which says the sheet is consumed and says nothing about any individual column — every column ' +
      `falls back to the ${SHEET_LEVEL_TIER} tier rather than being promoted to full depth`;
  }
  if (columnEvidence === 0 && unresolvedInbound > 0) {
    fallbackTier ??= SHEET_LEVEL_TIER;
    blindSpot =
      `${unresolvedInbound} inbound references workbook-wide could not be resolved to a sheet and ` +
      'column, so a zero column count here means "not seen", not "not used" — schema and counts are ' +
      'computed anyway rather than reporting no consumption as settled';
    fallbackReason ??= blindSpot;
  }

  const gating: GatingReport = {
    thresholds: SCHEMA_THRESHOLDS,
    basis:
      `full depth at ${SCHEMA_THRESHOLDS.heavyUseReferences}+ inbound column references, counts ` +
      `at ${SCHEMA_THRESHOLDS.minimumUseReferences}+, summary at zero — ${SCHEMA_BASIS_CAVEAT}`,
    columnEvidence,
    sheetLevelEvidence,
    unresolvedInbound,
    fallbackTier,
    fallbackReason,
    blindSpot,
  };

  // ---- Zero measured consumption stops at box plus headers (R27) -----------
  const noConsumption = columnEvidence === 0 && sheetLevelEvidence === 0 && unresolvedInbound === 0;
  if (noConsumption && !override) {
    return {
      status: 'described',
      revision: revisionOf(bytes),
      stagesRun: ['stage-0', 'stage-1', 'stage-2a', 'stage-3'],
      stagesNotRun: stagesNotRun(['stage-0', 'stage-1', 'stage-2a', 'stage-3']),
      sheet: sheetName,
      role: role?.role ?? 'indeterminate',
      roleBasis: role?.basis ?? 'sheet was not classified',
      observedBox: role?.observedBox ?? null,
      claimedVsObserved: role?.claimedVsObserved ?? '',
      headerSource,
      headerSourceBasis,
      // The R38 guard runs on this path too. It is the shallowest one and it
      // fires on every dataset sheet nothing references, so hardcoding
      // `redacted: false` here states, falsely, that a taxpayer-ID column was
      // examined and cleared — and a caller trusting that widens on it.
      columns: headerEntries.map((entry, index) => {
        const redactionReason = redactionReasonFor(entry.label, []);
        return {
          ordinal: index + 1,
          letter: columnLetters(entry.column),
          header: entry.label,
          type: 'blank' as const,
          observedTypes: [],
          depth: 'summary' as const,
          depthBasis:
            'no statistics were computed: no formula on any other sheet references this sheet, and ' +
            'the index resolved every reference it saw, so the zero is measured rather than a blind spot',
          inboundReferences: 0,
          rowCount: null,
          nullCount: null,
          min: null,
          max: null,
          extentsNote: null,
          distinctCount: null,
          distinctCapped: false,
          redacted: redactionReason !== null,
          redactionReason,
          skipped: [],
        };
      }),
      statisticsSkipped:
        'stopped at bounding box plus headers — this sheet has zero measured inbound consumption, ' +
        'so profiling its columns would spend the budget on data nothing reads; redaction on this ' +
        'path is header-driven only, because no cell was read for the value-shape rule to see',
      gating,
      truncated: false,
      truncationReason: null,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  // ---- Scan ----------------------------------------------------------------
  const columns = new Map<number, ColumnAccumulator>();
  let distinctCapBit = false;
  for (const cell of readCells(sheetXml, shared)) {
    if (headerRow !== null && cell.row === headerRow) continue;
    const accumulated = columns.get(cell.col) ?? emptyColumn();
    columns.set(cell.col, accumulated);
    accumulated.types.set(cell.type, (accumulated.types.get(cell.type) ?? 0) + 1);
    if (cell.type === 'blank') {
      accumulated.blank += 1;
      continue;
    }
    accumulated.populated += 1;
    if (accumulated.shapeSample.length < SHAPE_SAMPLE) accumulated.shapeSample.push(cell.text);
    if (cell.numeric !== null) {
      accumulated.min = accumulated.min === null ? cell.numeric : Math.min(accumulated.min, cell.numeric);
      accumulated.max = accumulated.max === null ? cell.numeric : Math.max(accumulated.max, cell.numeric);
    }
    if (accumulated.distinct.size < distinctCap) accumulated.distinct.add(cell.text);
    else if (!accumulated.distinct.has(cell.text)) {
      accumulated.distinctCapped = true;
      distinctCapBit = true;
    }
  }

  // ---- Profile per column --------------------------------------------------
  const ordered = [...columns.keys()].sort((a, b) => a - b);
  const profiles: ColumnProfile[] = ordered.map((column, index) => {
    const accumulated = columns.get(column)!;
    const header = headerByColumn.get(column) ?? null;
    const references = columnReferences.get(column) ?? 0;
    const observedTypes = [...accumulated.types.entries()]
      .filter(([type]) => type !== 'blank')
      .sort(([, a], [, b]) => b - a)
      .map(([type, cells]) => ({ type, cells }));
    const type: ColumnProfile['type'] =
      observedTypes.length === 0 ? 'blank' : observedTypes.length === 1 ? observedTypes[0].type : 'mixed';

    const depth = depthFor(references, override, fallbackTier);
    const redactionReason = redactionReasonFor(header, accumulated.shapeSample);
    const base = {
      ordinal: index + 1,
      letter: columnLetters(column),
      header,
      type,
      observedTypes,
      inboundReferences: references,
      rowCount: accumulated.populated + accumulated.blank,
      nullCount: accumulated.blank,
    };

    if (redactionReason) {
      // Redaction runs before any statistic is attached, and `override` does
      // not reach it: the depth tier still describes what was gated, but no
      // extent, distinct count, or value survives into the result.
      return {
        ...base,
        depth,
        depthBasis: depthBasis(references, depth, override, fallbackTier, fallbackReason),
        min: null,
        max: null,
        extentsNote: null,
        distinctCount: null,
        distinctCapped: false,
        redacted: true,
        redactionReason,
        skipped: [
          {
            what: 'extents' as const,
            reason: redactionReason,
            threshold: 'not overridable — R38 redaction precedes the materiality gate',
          },
          {
            what: 'distinct' as const,
            reason: redactionReason,
            threshold: 'not overridable — R38 redaction precedes the materiality gate',
          },
        ],
      };
    }

    if (depth === 'full') {
      const numericObserved = observedTypes.some((observed) => observed.type === 'number');
      return {
        ...base,
        depth,
        depthBasis: depthBasis(references, depth, override, fallbackTier, fallbackReason),
        min: numericObserved ? accumulated.min : null,
        max: numericObserved ? accumulated.max : null,
        extentsNote: numericObserved
          ? 'min and max are raw stored numbers — a date column stores serial numbers, and telling ' +
            'one from a plain number needs styles.xml, which this lane does not read'
          : 'no min or max: extents are reported for numeric columns only, and this column holds no numbers',
        distinctCount: accumulated.distinct.size,
        distinctCapped: accumulated.distinctCapped,
        redacted: false,
        redactionReason: null,
        skipped: [],
      };
    }

    const reason = belowFullDepthReason(references, depth, fallbackReason, blindSpot);
    const threshold = `${SCHEMA_THRESHOLDS.heavyUseReferences} inbound references for full depth — ${SCHEMA_BASIS_CAVEAT}`;
    return {
      ...base,
      depth,
      depthBasis: depthBasis(references, depth, override, fallbackTier, fallbackReason),
      rowCount: depth === 'summary' ? null : base.rowCount,
      nullCount: depth === 'summary' ? null : base.nullCount,
      min: null,
      max: null,
      extentsNote: null,
      distinctCount: null,
      distinctCapped: false,
      redacted: false,
      redactionReason: null,
      skipped: [
        { what: 'extents' as const, reason, threshold },
        { what: 'distinct' as const, reason, threshold },
      ],
    };
  });

  return {
    status: 'described',
    revision: revisionOf(bytes),
    stagesRun: ['stage-0', 'stage-1', 'stage-2a', 'stage-3'],
    stagesNotRun: stagesNotRun(['stage-0', 'stage-1', 'stage-2a', 'stage-3']),
    sheet: sheetName,
    role: role?.role ?? 'indeterminate',
    roleBasis: role?.basis ?? 'sheet was not classified',
    observedBox: role?.observedBox ?? null,
    claimedVsObserved: role?.claimedVsObserved ?? '',
    headerSource,
    headerSourceBasis,
    columns: profiles,
    statisticsSkipped: null,
    gating,
    truncated: distinctCapBit || consumption.truncated,
    truncationReason: distinctCapBit
      ? `the ${distinctCap}-value distinct cap bit: distinct counts on capped columns are a floor, not a total`
      : consumption.truncationReason,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function depthFor(
  references: number,
  override: boolean,
  fallbackTier: ColumnDepth | null,
): ColumnDepth {
  if (override) return 'full';
  if (references >= SCHEMA_THRESHOLDS.heavyUseReferences) return 'full';
  if (references >= SCHEMA_THRESHOLDS.minimumUseReferences) return 'counts';
  return fallbackTier ?? 'summary';
}

function depthBasis(
  references: number,
  depth: ColumnDepth,
  override: boolean,
  fallbackTier: ColumnDepth | null,
  fallbackReason: string | null,
): string {
  if (override) {
    return 'full depth by explicit override — the materiality gate was bypassed on request, ' +
      'though the redaction guard was not and cannot be';
  }
  if (references === 0 && fallbackTier && fallbackReason) {
    return `${depth} tier: ${fallbackReason} — ${SCHEMA_BASIS_CAVEAT}`;
  }
  return (
    `${references} measured inbound column references against a full-depth threshold of ` +
    `${SCHEMA_THRESHOLDS.heavyUseReferences} — ${SCHEMA_BASIS_CAVEAT}`
  );
}

function belowFullDepthReason(
  references: number,
  depth: ColumnDepth,
  fallbackReason: string | null,
  blindSpot: string | null,
): string {
  if (references === 0 && blindSpot) return blindSpot;
  if (references === 0 && fallbackReason) return fallbackReason;
  if (depth === 'summary') {
    return (
      'no formula on another sheet references this column: zero is measured, not assumed, so no ' +
      'statistics were computed for it'
    );
  }
  return (
    `${references} measured inbound references is below the full-depth threshold of ` +
    `${SCHEMA_THRESHOLDS.heavyUseReferences}, so schema and counts were computed and extents and ` +
    'distinct counts were not'
  );
}
