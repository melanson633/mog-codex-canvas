/**
 * The hydration briefing — one composed answer an agent can read while the
 * renderer is still hydrating.
 *
 * Two properties make this file worth its own module.
 *
 * **The structure is the authority.** Every finding lives in a section with a
 * stable identifier; the prose summary is *derived* from those sections and
 * carries nothing they do not already state (R34). A later UI renders the
 * structure and never re-derives findings from the sentences.
 *
 * **Presentation is keyed to each sheet's role, never to the workbook.** A
 * mixed workbook — a 3,000-row table feeding a four-sheet cascade — has no
 * correct workbook-level label, so nothing here branches on the shipped
 * `genre` field. It is reported verbatim in the identity section beside its
 * own basis, as one coarse hint among the per-sheet roles, and that is all it
 * does. A dataset-role sheet is presented as columns and types; a model-role
 * sheet as depth, cycles, and candidate inputs and outputs; a `mixed` sheet
 * gets both, dataset first; an `indeterminate` sheet gets its box and a plain
 * account of what did not run.
 *
 * `composeBriefing` is pure over already-computed stage outputs, so it can be
 * tested without bytes and the service can decide separately which stages are
 * worth running. Unknown is never rendered as empty: every stage a sheet did
 * not get is named in its `notRun` block with the reason.
 *
 * Engine-free: nothing here may import @mog-sdk. Every finding is derived from
 * saved bytes alone, so the briefing is complete whether or not the renderer
 * ever becomes ready (R45).
 */
import { profileWorkbook, type ProfileResult } from './workbook-profile.ts';
import { extractWorkbookMetadata, type WorkbookMetadataResult } from './workbook-metadata.ts';
import {
  classifySheetRoles,
  type Box,
  type SheetRole,
  type SheetRoleReport,
  type SheetRolesResult,
} from './sheet-roles.ts';
import {
  buildConsumptionIndex,
  type ConsumptionIndexResult,
  type SheetConsumption,
} from './consumption-index.ts';
import {
  buildDependencyGraph,
  type DependencyGraph,
  type DependencyGraphResult,
  type Precedent,
} from './workbook-graph.ts';
import {
  describeSheetData,
  type ColumnProfile,
  type GatingReport,
  type SheetDataResult,
} from './sheet-schema.ts';
import type { ExtractionStage } from './extraction-stages.ts';

// ---- Trace gating -----------------------------------------------------------

/**
 * A derivation trace earns its place only when there is more than one hop to
 * show. At depth 1 the trace would restate the precedent list the section
 * already carries, so the briefing says so rather than padding itself.
 */
export const TRACE_MIN_DEPTH = 2;

/** How many traced chains a trace section shows — the longest ones found. */
export const TRACE_OUTPUTS = 3;

/**
 * How many candidate outputs are walked before the longest chains are chosen.
 * A cap that bites is reported in the trace basis rather than applied silently
 * (R40).
 */
export const TRACE_CANDIDATE_CAP = 200;

/** How many hops each traced chain follows before it stops and says so. */
export const TRACE_HOPS = 6;

// ---- Sections ---------------------------------------------------------------

export interface NotRunEntry {
  readonly stage: ExtractionStage;
  readonly reason: string;
}

export interface IdentitySection {
  readonly id: 'workbook.identity';
  readonly title: string;
  readonly sheets: number;
  readonly rows: number;
  readonly cells: number;
  readonly formulas: number;
  /**
   * The shipped workbook-level hint, reported verbatim beside its basis and
   * consulted by nothing. Per-sheet role is what this briefing is keyed to.
   */
  readonly genreHint: string | null;
  readonly genreBasis: string | null;
  readonly creator: string | null;
  readonly lastModifiedBy: string | null;
  readonly created: string | null;
  readonly modified: string | null;
  readonly application: string | null;
  /** Why any metadata field above is degraded. Empty when nothing was lost. */
  readonly metadataNotes: readonly string[];
  readonly provenance: string;
}

export interface NamesAndTablesSection {
  readonly id: 'workbook.names-and-tables';
  readonly title: string;
  readonly definedNames: readonly { name: string; reference: string; scope: string | null }[];
  readonly tables: readonly { name: string; sheet: string | null; ref: string; columns: number }[];
  readonly note: string;
}

export interface ConsumptionSection {
  readonly id: 'workbook.consumption';
  readonly title: string;
  readonly sheets: readonly {
    readonly name: string;
    readonly totalInbound: number;
    readonly referencingSheets: readonly string[];
    readonly consumedColumns: readonly string[];
    readonly sheetLevelReferences: number;
    readonly basis: string;
  }[];
  readonly unresolved: number;
  readonly unresolvedByCause: Readonly<Record<string, number>>;
  readonly blindSpot: string;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  /** Set when Stage 2a did not run at all. */
  readonly unavailable: string | null;
}

export interface DatasetView {
  readonly id: string;
  readonly headerSource: 'detected-row' | 'table-definition' | 'none' | 'stage-1-detection';
  readonly headerSourceBasis: string;
  readonly headers: readonly string[];
  readonly columns: readonly ColumnProfile[];
  readonly redactedColumns: readonly string[];
  readonly statisticsSkipped: boolean;
  readonly statisticsSkippedReason: string | null;
  readonly gating: GatingReport | null;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
}

export interface TracedChain {
  readonly output: string;
  /** Node or rectangle labels from the output back toward its inputs. */
  readonly chain: readonly string[];
  readonly stoppedAtHopBound: boolean;
}

export interface TraceView {
  readonly id: string;
  readonly chains: readonly TracedChain[];
  readonly basis: string;
}

export interface ModelView {
  readonly id: string;
  readonly formulaCells: number;
  readonly maxDepth: number;
  readonly medianDepth: number;
  readonly cycles: number;
  readonly cycleNodes: readonly string[];
  readonly candidateInputs: readonly string[];
  readonly candidateInputsBasis: string;
  readonly candidateOutputs: readonly string[];
  readonly candidateOutputsBasis: string;
  readonly trace: TraceView | null;
  /** Why no trace section is here. Null exactly when `trace` is present. */
  readonly traceDeclined: string | null;
}

export interface SheetSection {
  readonly id: string;
  readonly title: string;
  readonly sheet: string;
  readonly role: SheetRole;
  /** The role rule's own account of itself, verbatim from Stage 1. */
  readonly roleBasis: string;
  readonly roleConfident: boolean;
  readonly observedBox: Box | null;
  readonly claimedBox: Box | null;
  readonly claimedBoxBasis: string;
  readonly claimedVsObserved: string;
  /** Present for `dataset` and `mixed` roles. Rendered before `model`. */
  readonly dataset: DatasetView | null;
  /** Present for `model` and `mixed` roles. */
  readonly model: ModelView | null;
  readonly notRun: readonly NotRunEntry[];
}

export type AnomalyKind =
  | 'cached-error'
  | 'cycle'
  | 'unresolved-reference'
  | 'box-divergence'
  | 'redaction'
  | 'cap';

export interface Anomaly {
  readonly id: string;
  readonly kind: AnomalyKind;
  readonly sheet: string | null;
  readonly detail: string;
}

export interface StageTiming {
  readonly stage: ExtractionStage;
  readonly elapsedMs: number;
}

export interface BriefingLatency {
  readonly stages: readonly StageTiming[];
  /** Wall clock for the whole call, when the caller measured it. */
  readonly totalMs: number;
  readonly basis: string;
}

export interface Briefing {
  readonly status: 'briefed';
  readonly revision: string;
  readonly provenance: string;
  readonly identity: IdentitySection;
  readonly namesAndTables: NamesAndTablesSection;
  readonly consumption: ConsumptionSection;
  readonly sheets: readonly SheetSection[];
  readonly anomalies: readonly Anomaly[];
  readonly latency: BriefingLatency;
  /** Derived from the sections above; carries no finding they do not state. */
  readonly summary: string;
}

export interface UnreadableBriefing {
  readonly status: 'unreadable';
  readonly revision: string;
  readonly provenance: string;
  readonly reason: string;
}

export type BriefingResult = Briefing | UnreadableBriefing;

export interface BriefingInputs {
  readonly revision: string;
  readonly provenance: string;
  readonly profile: ProfileResult;
  readonly metadata: WorkbookMetadataResult;
  readonly roles: SheetRolesResult;
  readonly consumption: ConsumptionIndexResult;
  /** Stage 2b output, or null when the workbook had no model-role sheet. */
  readonly graph: DependencyGraphResult | null;
  /** Stage 3 output per sheet. A sheet absent here did not get Stage 3. */
  readonly schemas: Readonly<Record<string, SheetDataResult>>;
  /** Why Stage 3 was not run, per sheet, for the sheets absent above. */
  readonly schemaSkips?: Readonly<Record<string, string>>;
  /** Wall clock the caller measured for the whole call. */
  readonly totalElapsedMs?: number;
}

// ---- Helpers ----------------------------------------------------------------

function roleWantsDataset(role: SheetRole): boolean {
  return role === 'dataset' || role === 'mixed';
}

function roleWantsModel(role: SheetRole): boolean {
  return role === 'model' || role === 'mixed';
}

function precedentLabel(precedent: Precedent): string {
  return precedent.kind === 'cell'
    ? precedent.node
    : `${precedent.sheet}!${precedent.ref} (rectangle)`;
}

/**
 * Walks one candidate output back toward its inputs, taking the first
 * precedent at each hop. A rectangle ends the chain by construction: it is
 * retained as a rectangle, never expanded into the cells inside it (KTD4).
 */
function traceChain(graph: DependencyGraph, output: string): TracedChain {
  const chain: string[] = [output];
  const seen = new Set<string>([output]);
  let node = output;
  for (let hop = 0; hop < TRACE_HOPS; hop += 1) {
    const next = graph.precedentsOf(node)[0];
    if (!next) return { output, chain, stoppedAtHopBound: false };
    chain.push(precedentLabel(next));
    if (next.kind !== 'cell' || seen.has(next.node)) {
      return { output, chain, stoppedAtHopBound: false };
    }
    seen.add(next.node);
    node = next.node;
  }
  return { output, chain, stoppedAtHopBound: true };
}

function onSheet(node: string, sheet: string): boolean {
  return node.startsWith(`${sheet}!`);
}

// ---- Section builders -------------------------------------------------------

function identityOf(inputs: BriefingInputs): IdentitySection {
  const { profile, metadata } = inputs;
  const profiled = profile.status === 'profiled' ? profile : null;
  const extracted = metadata.status === 'extracted' ? metadata : null;
  return {
    id: 'workbook.identity',
    title: 'Identity and shape',
    sheets: profiled?.sheets.length ?? 0,
    rows: profiled?.rows ?? 0,
    cells: profiled?.cells ?? 0,
    formulas: profiled?.formulas ?? 0,
    genreHint: profiled?.genre ?? null,
    genreBasis: profiled?.genreBasis ?? null,
    creator: extracted?.document.creator ?? null,
    lastModifiedBy: extracted?.document.lastModifiedBy ?? null,
    created: extracted?.document.created ?? null,
    modified: extracted?.document.modified ?? null,
    application: extracted?.document.application ?? null,
    metadataNotes: extracted
      ? extracted.notes
      : [`workbook metadata is unavailable: ${metadata.status === 'unreadable' ? metadata.reason : ''}`],
    provenance: inputs.provenance,
  };
}

function namesAndTablesOf(inputs: BriefingInputs): NamesAndTablesSection {
  const metadata = inputs.metadata;
  if (metadata.status !== 'extracted') {
    return {
      id: 'workbook.names-and-tables',
      title: 'Named ranges and tables',
      definedNames: [],
      tables: [],
      note: `not extracted: ${metadata.reason}`,
    };
  }
  return {
    id: 'workbook.names-and-tables',
    title: 'Named ranges and tables',
    definedNames: metadata.definedNames.map((entry) => ({
      name: entry.name,
      reference: entry.reference,
      scope: entry.scope,
    })),
    tables: metadata.tables.map((table) => ({
      name: table.displayName,
      sheet: table.sheet,
      ref: table.ref,
      columns: table.columns.length,
    })),
    note:
      metadata.definedNames.length === 0 && metadata.tables.length === 0
        ? 'this workbook declares no defined names and no table parts — measured, not assumed'
        : 'reference text is reported exactly as the file recorded it, never normalized',
  };
}

function consumptionOf(inputs: BriefingInputs): ConsumptionSection {
  const index = inputs.consumption;
  if (index.status !== 'indexed') {
    return {
      id: 'workbook.consumption',
      title: 'Cross-sheet consumption',
      sheets: [],
      unresolved: 0,
      unresolvedByCause: {},
      blindSpot: '',
      truncated: false,
      truncationReason: null,
      unavailable: `stage 2a did not run: ${index.reason}`,
    };
  }
  return {
    id: 'workbook.consumption',
    title: 'Cross-sheet consumption',
    sheets: index.sheets.map((sheet: SheetConsumption) => ({
      name: sheet.name,
      totalInbound: sheet.totalInbound,
      referencingSheets: sheet.referencingSheets,
      consumedColumns: sheet.columns.map((column) => column.letter),
      sheetLevelReferences: sheet.sheetLevelReferences,
      basis: sheet.basis,
    })),
    unresolved: index.unresolved.total,
    unresolvedByCause: index.unresolved.byCause as Readonly<Record<string, number>>,
    blindSpot: index.unresolved.blindSpot,
    truncated: index.truncated,
    truncationReason: index.truncationReason,
    unavailable: null,
  };
}

function datasetViewOf(
  role: SheetRoleReport,
  schema: SheetDataResult | undefined,
): DatasetView {
  const id = `sheet.${role.name}.columns`;
  if (!schema || schema.status !== 'described') {
    // Stage 1 already knows the box and the header labels, so an unconsumed
    // sheet is still described — just not measured.
    return {
      id,
      headerSource: role.header.status === 'detected' ? 'stage-1-detection' : 'none',
      headerSourceBasis: role.header.basis,
      headers: role.header.labels,
      columns: [],
      redactedColumns: [],
      statisticsSkipped: true,
      statisticsSkippedReason: schema
        ? `stage 3 returned ${schema.status}: ${schema.reason}`
        : 'stage 3 did not run for this sheet',
      gating: null,
      truncated: false,
      truncationReason: null,
    };
  }
  return {
    id,
    headerSource: schema.headerSource,
    headerSourceBasis: schema.headerSourceBasis,
    headers: schema.columns.map((column) => column.header ?? column.letter),
    columns: schema.columns,
    redactedColumns: schema.columns
      .filter((column) => column.redacted)
      .map((column) => column.header ?? column.letter),
    statisticsSkipped: schema.statisticsSkipped !== null,
    statisticsSkippedReason: schema.statisticsSkipped,
    gating: schema.gating,
    truncated: schema.truncated,
    truncationReason: schema.truncationReason,
  };
}

function modelViewOf(role: SheetRoleReport, graph: DependencyGraph | null): ModelView | null {
  const id = `sheet.${role.name}.dependencies`;
  if (!graph || !graph.includedSheets.includes(role.name)) return null;
  const depth = graph.depthBySheet[role.name] ?? { maxDepth: 0, medianDepth: 0, formulaCells: 0 };
  const candidateInputs = graph.candidateInputs.filter((node) => onSheet(node, role.name));
  const candidateOutputs = graph.candidateOutputs.filter((node) => onSheet(node, role.name));
  const cycleNodes = graph.cycleNodes.filter((node) => onSheet(node, role.name));
  const resolvedHere = candidateOutputs.some((node) => graph.precedentsOf(node).length > 0);

  // R32: the trace is gated on *this sheet's* measured depth, not the
  // workbook's. When it declines it says what it measured, so a missing trace
  // never reads as a missing finding.
  let trace: TraceView | null = null;
  let traceDeclined: string | null = null;
  if (depth.maxDepth >= TRACE_MIN_DEPTH && resolvedHere) {
    // The deepest chains, not the first ones in sheet order: a sheet whose top
    // rows are hand-entered totals would otherwise spend the whole trace budget
    // on one-hop outputs and leave the derivation that earned the trace unshown.
    const walked = candidateOutputs.slice(0, TRACE_CANDIDATE_CAP);
    const ranked = walked
      .map((output) => traceChain(graph, output))
      .sort((a, b) => b.chain.length - a.chain.length);
    // Outputs that derive the same way tell a reader one thing, not three: a
    // column of sibling formulas would otherwise fill the trace with copies of
    // one path and hide the second derivation this sheet actually has.
    const chains: TracedChain[] = [];
    const paths = new Set<string>();
    let duplicates = 0;
    for (const candidate of ranked) {
      const path = candidate.chain.slice(1).join(' → ');
      if (paths.has(path)) {
        duplicates += 1;
        continue;
      }
      paths.add(path);
      if (chains.length < TRACE_OUTPUTS) chains.push(candidate);
    }
    const capped = candidateOutputs.length > TRACE_CANDIDATE_CAP;
    trace = {
      id: `sheet.${role.name}.trace`,
      chains,
      basis:
        `traced because this sheet's measured maximum depth is ${depth.maxDepth}, at or above ` +
        `the ${TRACE_MIN_DEPTH}-hop threshold; the ${chains.length} longest distinct chains among ` +
        `${walked.length} candidate outputs are shown, each walked up to ${TRACE_HOPS} hops ` +
        'following one precedent per hop' +
        (duplicates > 0
          ? `; ${duplicates} further output(s) derive by a path already shown and are not repeated`
          : '') +
        (capped
          ? `; capped: this sheet has ${candidateOutputs.length} candidate outputs and only the ` +
            `first ${TRACE_CANDIDATE_CAP} in sheet order were walked`
          : ''),
    };
  } else if (depth.maxDepth < TRACE_MIN_DEPTH) {
    traceDeclined =
      `no derivation trace: this sheet's measured maximum depth is ${depth.maxDepth} across ` +
      `${depth.formulaCells} formula cells, below the ${TRACE_MIN_DEPTH}-hop threshold, so a ` +
      'trace would repeat the one hop the precedent list already states';
  } else {
    traceDeclined =
      `no derivation trace: this sheet's measured maximum depth is ${depth.maxDepth}, but no ` +
      'candidate output on it has a resolved precedent to walk';
  }

  return {
    id,
    formulaCells: depth.formulaCells,
    maxDepth: depth.maxDepth,
    medianDepth: depth.medianDepth,
    cycles: cycleNodes.length > 0 ? graph.cycles : 0,
    cycleNodes,
    candidateInputs,
    candidateInputsBasis: graph.candidateInputsBasis,
    candidateOutputs,
    candidateOutputsBasis: graph.candidateOutputsBasis,
    trace,
    traceDeclined,
  };
}

function notRunOf(
  role: SheetRoleReport,
  graph: DependencyGraphResult | null,
  schema: SheetDataResult | undefined,
  schemaSkips: Readonly<Record<string, string>>,
): NotRunEntry[] {
  const notRun: NotRunEntry[] = [];
  if (!graph || graph.status !== 'built') {
    notRun.push({
      stage: 'stage-2b',
      reason: graph
        ? `the dependency graph could not be built: ${graph.reason}`
        : 'no sheet in this workbook classified as model or mixed, so no graph was built',
    });
  } else if (!graph.includedSheets.includes(role.name)) {
    const skipped = graph.skipped.find((entry) => entry.name === role.name);
    // The skip is a role decision, so the role leads. The Stage 1 basis that
    // produced it is not repeated here — this same section already carries it
    // as `roleBasis`, and quoting it twice makes the prose unreadable.
    notRun.push({
      stage: 'stage-2b',
      reason: skipped
        ? `the dependency graph is built only for model and mixed sheets; this sheet's measured ` +
          `role is ${skipped.role}, on the role basis this section states`
        : `no dependency graph was built for this sheet (role ${role.role})`,
    });
  }
  if (!schema || schema.status !== 'described') {
    notRun.push({
      stage: 'stage-3',
      reason:
        schemaSkips[role.name] ??
        (schema
          ? `stage 3 returned ${schema.status}: ${schema.reason}`
          : `no column statistics were computed for this sheet (role ${role.role})`),
    });
  } else if (schema.statisticsSkipped !== null) {
    notRun.push({ stage: 'stage-3', reason: schema.statisticsSkipped });
  }
  return notRun;
}

function sheetSectionOf(
  role: SheetRoleReport,
  inputs: BriefingInputs,
  graph: DependencyGraph | null,
): SheetSection {
  const schema = inputs.schemas[role.name];
  return {
    id: `sheet.${role.name}`,
    title: `${role.name} — ${role.role}`,
    sheet: role.name,
    role: role.role,
    roleBasis: role.basis,
    roleConfident: role.confident,
    observedBox: role.observedBox,
    claimedBox: role.claimedBox,
    claimedBoxBasis: role.claimedBoxBasis,
    claimedVsObserved: role.claimedVsObserved,
    dataset: roleWantsDataset(role.role) ? datasetViewOf(role, schema) : null,
    model: roleWantsModel(role.role) ? modelViewOf(role, graph) : null,
    notRun: notRunOf(role, inputs.graph, schema, inputs.schemaSkips ?? {}),
  };
}

// ---- Anomalies --------------------------------------------------------------

function anomaliesOf(inputs: BriefingInputs, sheets: readonly SheetSection[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const push = (kind: AnomalyKind, sheet: string | null, detail: string) =>
    anomalies.push({ id: `anomaly.${kind}.${anomalies.length + 1}`, kind, sheet, detail });

  for (const section of sheets) {
    if (section.claimedVsObserved !== 'agrees') {
      push('box-divergence', section.sheet, section.claimedVsObserved);
    }
    if (section.model && section.model.cycleNodes.length > 0) {
      push(
        'cycle',
        section.sheet,
        `${section.model.cycles} circular reference(s) detected, involving ` +
          `${section.model.cycleNodes.join(', ')} — the chain terminates rather than recursing`,
      );
    }
    const dataset = section.dataset;
    if (dataset) {
      for (const column of dataset.columns) {
        if (column.redacted) {
          push(
            'redaction',
            section.sheet,
            `column ${column.header ?? column.letter} is redacted: ${column.redactionReason ?? ''}`,
          );
        }
        // Cached error values are visible where a column's own cells recorded
        // them; the profile counts cells, not their kinds.
        const errors = column.observedTypes.find((observed) => observed.type === 'error');
        if (errors) {
          push(
            'cached-error',
            section.sheet,
            `column ${column.header ?? column.letter} carries ${errors.cells} cached error value(s) as saved`,
          );
        }
        if (column.distinctCapped) {
          push(
            'cap',
            section.sheet,
            `the distinct-value cap bit on column ${column.header ?? column.letter}; its distinct count is a floor`,
          );
        }
      }
      if (dataset.truncated && dataset.truncationReason) {
        push('cap', section.sheet, dataset.truncationReason);
      }
    }
  }

  const index = inputs.consumption;
  if (index.status === 'indexed') {
    if (index.unresolved.total > 0) {
      const causes = Object.entries(index.unresolved.byCause)
        .map(([cause, count]) => `${cause}: ${count}`)
        .join(', ');
      push(
        'unresolved-reference',
        null,
        `${index.unresolved.total} reference(s) counted but not resolved (${causes}). ${index.unresolved.blindSpot}`,
      );
    }
    if (index.truncated && index.truncationReason) push('cap', null, index.truncationReason);
  }
  const graph = inputs.graph;
  if (graph && graph.status === 'built') {
    if (graph.truncated && graph.truncationReason) push('cap', null, graph.truncationReason);
    if (graph.unresolved.length > 0) {
      const causes = Object.entries(graph.unresolvedByCause)
        .map(([cause, count]) => `${cause}: ${count}`)
        .join(', ');
      push(
        'unresolved-reference',
        null,
        `${graph.unresolved.length} graph operand(s) counted but not resolved (${causes}) — ` +
          'every operand count above is therefore a floor',
      );
    }
  }
  return anomalies;
}

// ---- Prose ------------------------------------------------------------------

/** Derived strictly from the sections; states nothing they do not carry. */
function proseOf(briefing: Omit<Briefing, 'summary'>): string {
  const lines: string[] = [];
  const identity = briefing.identity;
  lines.push(
    `${identity.sheets} sheet(s), ${identity.rows} rows, ${identity.cells} cells, ` +
      `${identity.formulas} formulas.` +
      (identity.genreHint
        ? ` Workbook-level genre hint: ${identity.genreHint} (${identity.genreBasis}) — a coarse` +
          ' hint only; every section below is keyed to its own sheet\'s role.'
        : ''),
  );
  lines.push(identity.provenance);
  if (briefing.namesAndTables.definedNames.length > 0 || briefing.namesAndTables.tables.length > 0) {
    lines.push(
      `${briefing.namesAndTables.definedNames.length} defined name(s) and ` +
        `${briefing.namesAndTables.tables.length} table definition(s).`,
    );
  }

  for (const section of briefing.sheets) {
    const parts: string[] = [`${section.sheet} — role ${section.role} (${section.roleBasis}).`];
    if (section.observedBox) parts.push(`Observed box ${section.observedBox.ref}.`);
    if (section.claimedVsObserved !== 'agrees') parts.push(`${section.claimedVsObserved}.`);
    if (section.dataset) {
      parts.push(
        section.dataset.columns.length > 0
          ? `${section.dataset.columns.length} column(s) from ${section.dataset.headerSource}` +
              (section.dataset.redactedColumns.length > 0
                ? `, ${section.dataset.redactedColumns.length} redacted as high-risk personal data`
                : '') +
              '.'
          : `Headers only (${section.dataset.headers.length} label(s)); ` +
              `${section.dataset.statisticsSkippedReason}.`,
      );
    }
    if (section.model) {
      parts.push(
        `Maximum chain depth ${section.model.maxDepth} across ${section.model.formulaCells} ` +
          `formula cell(s), ${section.model.cycles} cycle(s), ` +
          `${section.model.candidateInputs.length} candidate input(s) and ` +
          `${section.model.candidateOutputs.length} candidate output(s).`,
      );
      if (section.model.trace) {
        for (const chain of section.model.trace.chains) {
          parts.push(
            `Trace ${chain.chain.join(' <- ')}` +
              (chain.stoppedAtHopBound ? ' (stopped at the hop bound)' : '') +
              '.',
          );
        }
      } else if (section.model.traceDeclined) {
        parts.push(`${section.model.traceDeclined}.`);
      }
    }
    for (const entry of section.notRun) parts.push(`Not run — ${entry.stage}: ${entry.reason}.`);
    lines.push(parts.join(' '));
  }

  if (briefing.anomalies.length > 0) {
    lines.push(
      `Anomalies (${briefing.anomalies.length}): ` +
        briefing.anomalies.map((anomaly) => anomaly.detail).join(' | '),
    );
  }
  lines.push(
    `Composed in ${briefing.latency.totalMs} ms total. ${briefing.latency.basis}`,
  );
  return lines.join('\n');
}

// ---- Composition ------------------------------------------------------------

export function composeBriefing(inputs: BriefingInputs): BriefingResult {
  if (inputs.profile.status !== 'profiled') {
    return {
      status: 'unreadable',
      revision: inputs.revision,
      provenance: inputs.provenance,
      reason: inputs.profile.reason,
    };
  }

  const graph = inputs.graph && inputs.graph.status === 'built' ? inputs.graph : null;
  const roleReports = inputs.roles.status === 'classified' ? inputs.roles.sheets : [];
  const sheets = roleReports.map((role) => sheetSectionOf(role, inputs, graph));

  const stages: StageTiming[] = [];
  if (inputs.roles.status === 'classified') {
    // Stages 0 and 1 are one scan; the report times them together.
    stages.push({ stage: 'stage-0', elapsedMs: 0 });
    stages.push({ stage: 'stage-1', elapsedMs: inputs.roles.elapsedMs });
  }
  if (inputs.consumption.status === 'indexed') {
    stages.push({ stage: 'stage-2a', elapsedMs: inputs.consumption.elapsedMs });
  }
  if (graph) stages.push({ stage: 'stage-2b', elapsedMs: graph.elapsedMs });
  const stage3 = Object.values(inputs.schemas).reduce(
    (total, schema) => total + (schema.status === 'described' ? schema.elapsedMs : 0),
    0,
  );
  if (stage3 > 0) stages.push({ stage: 'stage-3', elapsedMs: stage3 });

  const withoutSummary: Omit<Briefing, 'summary'> = {
    status: 'briefed',
    revision: inputs.revision,
    provenance: inputs.provenance,
    identity: identityOf(inputs),
    namesAndTables: namesAndTablesOf(inputs),
    consumption: consumptionOf(inputs),
    sheets,
    anomalies: anomaliesOf(inputs, sheets),
    latency: {
      stages,
      totalMs:
        inputs.totalElapsedMs ?? stages.reduce((total, timing) => total + timing.elapsedMs, 0),
      basis:
        'measured on this call; per-stage figures come from each stage\'s own clock, and the ' +
        'total is wall clock for the whole briefing including composition',
    },
  };
  return { ...withoutSummary, summary: proseOf(withoutSummary) };
}

// ---- The auto-run pipeline --------------------------------------------------

/**
 * Runs the stages a briefing is allowed to auto-run over one set of bytes,
 * then composes. Stage 2b runs only where a sheet's role earns it, Stage 3
 * only where the consumption index measured the data being read — and the
 * already-computed stage outputs are handed down rather than recomputed, so
 * the archive is decompressed once per stage that needs it and no more (R4).
 *
 * The gates are here, beside the composition that reports them, so what ran
 * and what each sheet's `notRun` block claims cannot drift apart.
 */
export function briefWorkbook(
  bytes: Uint8Array,
  context: { readonly revision: string; readonly provenance: string },
): BriefingResult {
  const started = performance.now();
  const profile = profileWorkbook(bytes);
  const metadata = extractWorkbookMetadata(bytes);
  const roles = classifySheetRoles(bytes);
  const consumption = buildConsumptionIndex(bytes);
  const reuse = {
    ...(roles.status === 'classified' ? { roles } : {}),
    ...(consumption.status === 'indexed' ? { consumption } : {}),
    ...(metadata.status === 'extracted' ? { metadata } : {}),
  };

  const sheets = roles.status === 'classified' ? roles.sheets : [];
  const wantsGraph = sheets.some((sheet) => roleWantsModel(sheet.role));
  const graph = wantsGraph ? buildDependencyGraph(bytes, reuse) : null;

  const schemas: Record<string, SheetDataResult> = {};
  const schemaSkips: Record<string, string> = {};
  for (const sheet of sheets) {
    if (!roleWantsDataset(sheet.role)) {
      schemaSkips[sheet.name] =
        `stage 3 profiles data-shaped sheets; this sheet's measured role is ${sheet.role}`;
      continue;
    }
    const consumed =
      consumption.status === 'indexed'
        ? consumption.sheets.find((entry) => entry.name === sheet.name)
        : undefined;
    // An unresolved reference anywhere means "not seen", not "not used", so it
    // is enough to earn the scan — the alternative is calling a blind spot zero.
    const measuredUse =
      (consumed?.totalInbound ?? 0) > 0 ||
      (consumption.status === 'indexed' && consumption.unresolved.total > 0);
    if (!measuredUse) {
      schemaSkips[sheet.name] =
        'stage 3 did not run: the consumption index measured zero inbound references to this ' +
        'sheet and saw no unresolved references anywhere, so it stops at its bounding box and ' +
        'headers until something is measured to read it';
      continue;
    }
    schemas[sheet.name] = describeSheetData(bytes, sheet.name, reuse);
  }

  return composeBriefing({
    revision: context.revision,
    provenance: context.provenance,
    profile,
    metadata,
    roles,
    consumption,
    graph,
    schemas,
    schemaSkips,
    totalElapsedMs: Math.round(performance.now() - started),
  });
}
