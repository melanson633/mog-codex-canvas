/**
 * Stage 2b — the intra-workbook dependency graph.
 *
 * Built only for sheets whose Stage 1 role is `model` or `mixed`. A 12,000-row
 * table of per-row formulas produces 12,000 near-identical edges that answer
 * nothing anyone asked; the consumption index (Stage 2a) already reports
 * whether that table is read. Sheets skipped for role reasons are listed with
 * the role and basis that caused it, so a caller can tell "no dependencies" from
 * "not examined" (R15).
 *
 * Range operands stay rectangles (KTD4). `Data!B2:B10` is stored once, not
 * expanded into nine nodes, and `dependentsOf('Data!B5')` resolves against the
 * stored rectangles at query time. Expansion is what turns a whole-column
 * reference into a million-node graph.
 *
 * What cannot be resolved is named, not dropped: shared-formula followers
 * carrying no text, defined names with no definition, and the structured and
 * external shapes the operand parser already reports. `operandsResolved`
 * counts only what genuinely resolved.
 *
 * Engine-free: nothing here may import @mog-sdk.
 */
import { attr, readZipEntries, sheetParts, unescapeXml, type ZipEntry } from './ooxml-cache.ts';
import {
  parseFormulaRefs,
  type CellOperand,
  type RangeOperand,
  type UnresolvedCause,
} from './formula-refs.ts';
import { metadataFromEntries, type WorkbookMetadata } from './workbook-metadata.ts';
import { classifySheetRoles, type SheetRole, type SheetRolesReport } from './sheet-roles.ts';
import { revisionOf } from './workbook-revision.ts';
import { stagesNotRun, type ExtractionStage } from './extraction-stages.ts';

// ---- Result shape -----------------------------------------------------------

export type GraphUnresolvedCause = UnresolvedCause | 'shared-follower' | 'unknown-name';

export interface CellPrecedent {
  readonly kind: 'cell';
  /** `Sheet!ADDRESS`. */
  readonly node: string;
  readonly sheet: string;
  readonly address: string;
}

export interface RangePrecedent {
  readonly kind: 'range';
  readonly sheet: string;
  readonly ref: string;
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export type Precedent = CellPrecedent | RangePrecedent;

export interface UnresolvedOperand {
  readonly cause: GraphUnresolvedCause;
  readonly text: string;
  /** The formula cell the operand appeared in. */
  readonly at: string;
}

export interface SkippedSheet {
  readonly name: string;
  readonly role: SheetRole;
  readonly basis: string;
}

export interface DepthStats {
  readonly maxDepth: number;
  readonly medianDepth: number;
  readonly formulaCells: number;
}

export interface ReachedNode {
  readonly node: string;
  readonly hops: number;
}

export interface TransitiveDependents {
  readonly reached: readonly ReachedNode[];
  readonly truncated: boolean;
  /** Which bound stopped the walk, when one did. */
  readonly truncationReason: string | null;
}

export interface DependencyGraph {
  readonly status: 'built';
  readonly revision: string;
  readonly stagesRun: readonly ExtractionStage[];
  readonly stagesNotRun: readonly ExtractionStage[];
  readonly includedSheets: readonly string[];
  readonly skipped: readonly SkippedSheet[];
  readonly nodes: number;
  readonly edges: number;
  readonly formulaCells: number;
  readonly operandsResolved: number;
  readonly unresolved: readonly UnresolvedOperand[];
  readonly unresolvedByCause: Readonly<Partial<Record<GraphUnresolvedCause, number>>>;
  readonly depth: DepthStats;
  readonly depthBySheet: Readonly<Record<string, DepthStats>>;
  readonly cycles: number;
  /** One node from each detected cycle, so a caller can go look. */
  readonly cycleNodes: readonly string[];
  readonly candidateInputs: readonly string[];
  readonly candidateInputsBasis: string;
  readonly candidateOutputs: readonly string[];
  readonly candidateOutputsBasis: string;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  readonly elapsedMs: number;
  precedentsOf(node: string): readonly Precedent[];
  dependentsOf(node: string): readonly string[];
  transitiveDependentsOf(node: string, maxHops: number): TransitiveDependents;
}

export interface UnreadableGraph {
  readonly status: 'unreadable';
  readonly reason: string;
}

export type DependencyGraphResult = DependencyGraph | UnreadableGraph;

export interface DependencyGraphOptions {
  /** Sheets to build regardless of role, for on-demand deep calls (R5). */
  readonly includeSheets?: readonly string[];
  readonly nodeCap?: number;
  readonly edgeCap?: number;
  /** Stage 1 output to reuse instead of recomputing it (R4). */
  readonly roles?: SheetRolesReport;
  /** U1 output to reuse instead of recomputing it (R4). */
  readonly metadata?: WorkbookMetadata;
}

export interface GraphTargetAnswer {
  readonly node: string;
  readonly precedents: readonly Precedent[];
  readonly dependents: readonly string[];
  /** Present only when a hop bound was asked for. */
  readonly transitiveDependents: TransitiveDependents | null;
}

/**
 * The graph as plain data. The query methods answer from indexes that only
 * exist in memory, so anything crossing a tool boundary carries the figures
 * plus the answers actually asked for, never the closures.
 */
export type GraphPayload = Omit<
  DependencyGraph,
  'precedentsOf' | 'dependentsOf' | 'transitiveDependentsOf'
> & { readonly target: GraphTargetAnswer | null };

export interface GraphPayloadOptions {
  /** `Sheet!Address` to answer precedent and dependent questions about. */
  readonly target?: string;
  readonly maxHops?: number;
}

export function toGraphPayload(
  graph: DependencyGraph,
  options: GraphPayloadOptions = {},
): GraphPayload {
  const { precedentsOf, dependentsOf, transitiveDependentsOf, ...data } = graph;
  const target = options.target
    ? {
        node: options.target,
        precedents: precedentsOf(options.target),
        dependents: dependentsOf(options.target),
        transitiveDependents:
          options.maxHops === undefined
            ? null
            : transitiveDependentsOf(options.target, options.maxHops),
      }
    : null;
  return { ...data, target };
}

export const NODE_CAP = 200000;
export const EDGE_CAP = 400000;

const INPUT_BASIS =
  'candidate input: a cell some formula reads that carries no formula of its own — ' +
  'derived from resolved cell operands only, so a cell reached only through a range ' +
  'rectangle is not listed here; uncalibrated';

const OUTPUT_BASIS =
  'candidate output: a formula cell nothing else reads, by cell reference or by an ' +
  'enclosing range rectangle — uncalibrated, and only over the sheets this graph included';

// ---- Cell scan --------------------------------------------------------------

interface ScannedFormula {
  readonly address: string;
  readonly text: string | null;
  /** A shared-formula follower: `<f t="shared" si=…/>` with no text of its own. */
  readonly sharedFollower: boolean;
}

function scanFormulas(sheetXml: string): ScannedFormula[] {
  const found: ScannedFormula[] = [];
  for (const match of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, attrs, inner = ''] = match;
    const address = attr(`<c ${attrs}>`, 'r');
    if (!address) continue;
    const open = inner.match(/<f\b[^>]*\/?>/)?.[0];
    if (!open) continue;
    const text = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
    if (text) {
      found.push({ address, text: unescapeXml(text), sharedFollower: false });
    } else {
      found.push({ address, text: null, sharedFollower: attr(open, 't') === 'shared' });
    }
  }
  return found;
}

function parseAddress(address: string): { row: number; col: number } | null {
  const parts = address.match(/^\$?([A-Za-z]+)\$?(\d+)$/);
  if (!parts) return null;
  let col = 0;
  for (const ch of parts[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(parts[2]), col };
}

interface Box {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

interface Rectangle extends Box {
  /** The formula cell that reads this rectangle. */
  readonly dependent: string;
}

function contains(box: Box, row: number, col: number): boolean {
  return row >= box.startRow && row <= box.endRow && col >= box.startCol && col <= box.endCol;
}

// ---- Build ------------------------------------------------------------------

export function buildDependencyGraph(
  bytes: Uint8Array,
  options: DependencyGraphOptions = {},
): DependencyGraphResult {
  const started = performance.now();
  let entries: ZipEntry[];
  let parts: { name: string; part: string }[];
  try {
    entries = readZipEntries(bytes);
    parts = sheetParts(entries);
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  const roles = options.roles ?? classifySheetRoles(bytes);
  if (roles.status === 'unreadable') return roles;
  const metadata = options.metadata ?? metadataFromEntries(entries, parts);

  const nodeCap = options.nodeCap ?? NODE_CAP;
  const edgeCap = options.edgeCap ?? EDGE_CAP;
  const forced = new Set(options.includeSheets ?? []);
  const roleByName = new Map(roles.sheets.map((sheet) => [sheet.name, sheet]));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  const included: string[] = [];
  const skipped: SkippedSheet[] = [];
  for (const { name } of parts) {
    const role = roleByName.get(name);
    const build = forced.has(name) || role === undefined || role.role === 'model' || role.role === 'mixed';
    if (build) included.push(name);
    else skipped.push({ name, role: role.role, basis: role.basis });
  }

  const precedents = new Map<string, Precedent[]>();
  const dependents = new Map<string, Set<string>>();
  const rectanglesBySheet = new Map<string, Rectangle[]>();
  const formulaNodesBySheet = new Map<string, { node: string; row: number; col: number }[]>();
  const unresolved: UnresolvedOperand[] = [];
  const byCause = new Map<GraphUnresolvedCause, number>();
  let formulaCells = 0;
  let edges = 0;
  let operandsResolved = 0;
  let truncated = false;
  let truncationReason: string | null = null;

  const note = (cause: GraphUnresolvedCause, text: string, at: string) => {
    unresolved.push({ cause, text, at });
    byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
  };

  /** Defined names, sheet-scoped taking precedence over the global one. */
  const definedName = (name: string, onSheet: string): string | null => {
    const scoped = metadata.definedNames.find((entry) => entry.name === name && entry.scope === onSheet);
    const global = metadata.definedNames.find((entry) => entry.name === name && entry.scope === null);
    return (scoped ?? global)?.reference ?? null;
  };

  const addPrecedent = (node: string, precedent: Precedent) => {
    const list = precedents.get(node);
    if (list) list.push(precedent);
    else precedents.set(node, [precedent]);
    edges += 1;
    operandsResolved += 1;
    if (precedent.kind === 'cell') {
      const back = dependents.get(precedent.node);
      if (back) back.add(node);
      else dependents.set(precedent.node, new Set([node]));
    } else {
      const rects = rectanglesBySheet.get(precedent.sheet);
      const rect: Rectangle = {
        startRow: precedent.startRow,
        startCol: precedent.startCol,
        endRow: precedent.endRow,
        endCol: precedent.endCol,
        dependent: node,
      };
      if (rects) rects.push(rect);
      else rectanglesBySheet.set(precedent.sheet, [rect]);
    }
  };

  outer: for (const name of included) {
    const part = parts.find((sheet) => sheet.name === name)?.part;
    const xml = part ? (byName.get(part)?.data.toString('utf8') ?? '') : '';
    const nodesHere: { node: string; row: number; col: number }[] = [];
    formulaNodesBySheet.set(name, nodesHere);

    for (const scanned of scanFormulas(xml)) {
      const node = `${name}!${scanned.address}`;
      if (scanned.text === null) {
        if (scanned.sharedFollower) {
          note('shared-follower', scanned.address, node);
        }
        continue;
      }
      formulaCells += 1;
      // Registered before any operand resolves, so a formula with no resolvable
      // precedent is still a node — it has a depth and can be a candidate output.
      precedents.set(node, []);
      const position = parseAddress(scanned.address);
      if (position) nodesHere.push({ node, row: position.row, col: position.col });
      if (formulaCells > nodeCap) {
        truncated = true;
        truncationReason =
          `the ${nodeCap}-node cap bit: formula cells past it were not added, so every ` +
          'count and depth below is a floor rather than a total';
        break outer;
      }

      const { operands, unresolved: unparsed, capped } = parseFormulaRefs(scanned.text);
      for (const item of unparsed) note(item.cause, item.text, node);
      if (capped) {
        truncated = true;
        truncationReason ??=
          'the per-formula operand cap bit: operands past it were not read, so edge counts are a floor';
      }

      for (const operand of operands) {
        if (edges >= edgeCap) {
          truncated = true;
          truncationReason ??=
            `the ${edgeCap}-edge cap bit: edges past it were not recorded, so every count and ` +
            'depth below is a floor rather than a total';
          break outer;
        }
        if (operand.kind === 'name') {
          const reference = definedName(operand.name, name);
          const resolved = reference ? parseFormulaRefs(reference).operands[0] : undefined;
          if (!resolved || resolved.kind === 'name') {
            note('unknown-name', operand.name, node);
            continue;
          }
          addPrecedent(node, toPrecedent(resolved, name));
          continue;
        }
        addPrecedent(node, toPrecedent(operand, name));
      }
    }
  }

  const graph = finish({
    started,
    bytes,
    included,
    skipped,
    precedents,
    dependents,
    rectanglesBySheet,
    formulaNodesBySheet,
    unresolved,
    byCause,
    formulaCells,
    edges,
    operandsResolved,
    truncated,
    truncationReason,
  });
  return graph;
}

/** An unqualified operand belongs to the sheet whose formula stated it. */
function toPrecedent(operand: CellOperand | RangeOperand, ownSheet: string): Precedent {
  const sheet = operand.sheet ?? ownSheet;
  if (operand.kind === 'cell') {
    return { kind: 'cell', node: `${sheet}!${operand.address}`, sheet, address: operand.address };
  }
  return {
    kind: 'range',
    sheet,
    ref: operand.ref,
    startRow: operand.startRow,
    startCol: operand.startCol,
    endRow: operand.endRow,
    endCol: operand.endCol,
  };
}

// ---- Queries and derived figures -------------------------------------------

interface FinishInput {
  started: number;
  bytes: Uint8Array;
  included: string[];
  skipped: SkippedSheet[];
  precedents: Map<string, Precedent[]>;
  dependents: Map<string, Set<string>>;
  rectanglesBySheet: Map<string, Rectangle[]>;
  formulaNodesBySheet: Map<string, { node: string; row: number; col: number }[]>;
  unresolved: UnresolvedOperand[];
  byCause: Map<GraphUnresolvedCause, number>;
  formulaCells: number;
  edges: number;
  operandsResolved: number;
  truncated: boolean;
  truncationReason: string | null;
}

function finish(input: FinishInput): DependencyGraph {
  const {
    precedents,
    dependents,
    rectanglesBySheet,
    formulaNodesBySheet,
  } = input;

  const sheetOf = (node: string) => node.slice(0, node.indexOf('!'));

  /** Formula nodes inside a rectangle. Memoized — one range is read many times. */
  const containedCache = new Map<string, string[]>();
  const containedNodes = (precedent: RangePrecedent): string[] => {
    const key = `${precedent.sheet}!${precedent.ref}`;
    const cached = containedCache.get(key);
    if (cached) return cached;
    const nodes = (formulaNodesBySheet.get(precedent.sheet) ?? [])
      .filter((entry) => contains(precedent, entry.row, entry.col))
      .map((entry) => entry.node);
    containedCache.set(key, nodes);
    return nodes;
  };

  const precedentsOf = (node: string): readonly Precedent[] => precedents.get(node) ?? [];

  const dependentsOf = (node: string): readonly string[] => {
    const direct = dependents.get(node);
    const found = new Set<string>(direct ?? []);
    const separator = node.indexOf('!');
    if (separator > 0) {
      const position = parseAddress(node.slice(separator + 1));
      if (position) {
        for (const rect of rectanglesBySheet.get(node.slice(0, separator)) ?? []) {
          if (contains(rect, position.row, position.col)) found.add(rect.dependent);
        }
      }
    }
    return [...found];
  };

  const transitiveDependentsOf = (node: string, maxHops: number): TransitiveDependents => {
    const reached: ReachedNode[] = [];
    const seen = new Set<string>([node]);
    let frontier = [node];
    let truncatedWalk = false;
    let reason: string | null = null;
    for (let hop = 1; hop <= maxHops; hop += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const dependent of dependentsOf(current)) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          reached.push({ node: dependent, hops: hop });
          next.push(dependent);
        }
      }
      if (next.length === 0) return { reached, truncated: false, truncationReason: null };
      frontier = next;
    }
    // The frontier is still growing at the hop bound: more lies beyond it.
    for (const current of frontier) {
      if (dependentsOf(current).some((dependent) => !seen.has(dependent))) {
        truncatedWalk = true;
        reason = `stopped at the ${maxHops}-hop bound with dependents still unvisited`;
        break;
      }
    }
    return { reached, truncated: truncatedWalk, truncationReason: reason };
  };

  // ---- Depth, by iterative DFS with an explicit stack -----------------------
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const cycleEdges = new Set<string>();
  const cycleNodes = new Set<string>();

  const precedentNodesOf = (node: string): string[] => {
    const found: string[] = [];
    for (const precedent of precedentsOf(node)) {
      if (precedent.kind === 'cell') {
        if (precedents.has(precedent.node)) found.push(precedent.node);
      } else {
        for (const contained of containedNodes(precedent)) {
          if (contained !== node) found.push(contained);
        }
      }
    }
    return found;
  };

  for (const root of precedents.keys()) {
    if (depths.has(root)) continue;
    const stack: { node: string; expanded: boolean }[] = [{ node: root, expanded: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.expanded) {
        stack.pop();
        visiting.delete(frame.node);
        // Depth counts reference hops, not formula-to-formula hops: a cell that
        // reads a hand-entered value sits at depth 1, and the cell that reads
        // *it* at depth 2. A precedent whose own depth is unknown — a plain cell,
        // a sheet this graph skipped, or the far side of a cycle — contributes 0.
        const parents = precedentNodesOf(frame.node);
        let depth = precedentsOf(frame.node).length === 0 ? 0 : 1;
        for (const parent of parents) {
          const parentDepth = depths.get(parent);
          if (parentDepth !== undefined) depth = Math.max(depth, parentDepth + 1);
        }
        depths.set(frame.node, depth);
        continue;
      }
      frame.expanded = true;
      visiting.add(frame.node);
      for (const parent of precedentNodesOf(frame.node)) {
        if (depths.has(parent)) continue;
        if (visiting.has(parent)) {
          // A back edge. Record it and stop the branch rather than following it.
          const edge = `${frame.node}->${parent}`;
          if (!cycleEdges.has(edge)) {
            cycleEdges.add(edge);
            cycleNodes.add(parent);
          }
          continue;
        }
        stack.push({ node: parent, expanded: false });
      }
    }
  }

  const statsFor = (nodes: readonly string[]): DepthStats => {
    const values = nodes.map((node) => depths.get(node) ?? 0).sort((a, b) => a - b);
    if (values.length === 0) return { maxDepth: 0, medianDepth: 0, formulaCells: 0 };
    const middle = Math.floor(values.length / 2);
    return {
      maxDepth: values[values.length - 1],
      medianDepth:
        values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      formulaCells: values.length,
    };
  };

  const allNodes = [...precedents.keys()];
  const depthBySheet: Record<string, DepthStats> = {};
  for (const name of input.included) {
    depthBySheet[name] = statsFor(allNodes.filter((node) => sheetOf(node) === name));
  }

  // ---- Candidate inputs and outputs ----------------------------------------
  const candidateInputs = new Set<string>();
  for (const list of precedents.values()) {
    for (const precedent of list) {
      if (precedent.kind === 'cell' && !precedents.has(precedent.node)) {
        candidateInputs.add(precedent.node);
      }
    }
  }
  const candidateOutputs = allNodes.filter((node) => dependentsOf(node).length === 0);

  return {
    status: 'built',
    revision: revisionOf(input.bytes),
    stagesRun: ['stage-0', 'stage-1', 'stage-2b'],
    stagesNotRun: stagesNotRun(['stage-0', 'stage-1', 'stage-2b']),
    includedSheets: input.included,
    skipped: input.skipped,
    nodes: new Set([...allNodes, ...candidateInputs]).size,
    edges: input.edges,
    formulaCells: input.formulaCells,
    operandsResolved: input.operandsResolved,
    unresolved: input.unresolved,
    unresolvedByCause: Object.fromEntries(input.byCause),
    depth: statsFor(allNodes),
    depthBySheet,
    cycles: cycleEdges.size,
    cycleNodes: [...cycleNodes],
    candidateInputs: [...candidateInputs].sort(),
    candidateInputsBasis: INPUT_BASIS,
    candidateOutputs: candidateOutputs.sort(),
    candidateOutputsBasis: OUTPUT_BASIS,
    truncated: input.truncated,
    truncationReason: input.truncationReason,
    elapsedMs: Math.round(performance.now() - input.started),
    precedentsOf,
    dependentsOf,
    transitiveDependentsOf,
  };
}
