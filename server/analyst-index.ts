import { readAnalysisEntries } from './analysis-archive.ts';
import { parseRange } from './context-bus.ts';
import { attr, parseSharedStrings, sheetParts } from './ooxml-cache.ts';
import { redactionReasonFor } from './redaction.ts';
import { readRangeFromBytes, type RangeCell } from './workbook-profile.ts';
import { buildDependencyGraph, type DependencyGraphResult, type Precedent } from './workbook-graph.ts';
import type { createWorkbookService } from './workbook-service.ts';

const CELL_CAP = 20_000;
const RANGE_CAP = 500;
const BYTE_CAP = 16 * 1024 * 1024;
type Entry = { revision: string; sheets: Map<string, Map<string, RangeCell>>; graph: DependencyGraphResult | null; reason: string | null; unreadable: boolean };
export type AnalystFinding = { kind: 'formula-error' | 'formula-pattern' | 'constant-in-formula-run'; address: string; severity: 'review'; message: string; peers?: string[] };

function validatedRange(sheet: string, ref: string, single = false) {
  if (typeof sheet !== 'string' || !sheet.trim() || sheet.length > 128 || typeof ref !== 'string' || ref.length > 80) throw new Error('A sheet and a bounded A1 range are required.');
  const range = parseRange(ref);
  if (!range || range.sheet || range.endCol > 16384 || range.endRow > 1048576 ||
    (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > RANGE_CAP ||
    (single && (range.startRow !== range.endRow || range.startCol !== range.endCol))) throw new Error(`Use an unqualified A1 ${single ? 'cell' : 'range of at most 500 cells'}.`);
  return range;
}

// Deliberately narrow: only ordinary arithmetic with A1 references and numeric
// literals. Strings, sheet qualifiers, functions and names are not guessed.
function signature(formula: string | null, address: string): string | null {
  if (!formula) return null;
  const origin = parseRange(address)!;
  const source = formula.replace(/^=/, '').replace(/\s+/g, '');
  const tokens = source.match(/\$?[A-Za-z]{1,3}\$?[1-9]\d*|(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|[()+\-*/^%]/g);
  if (!tokens || tokens.join('') !== source) return null;
  return tokens.map(token => {
    const match = token.match(/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)$/);
    if (!match) return token;
    const position = parseRange(`${match[2]}${match[4]}`)!;
    return `R${match[3] ? '=' + position.startRow : position.startRow - origin.startRow}C${match[1] ? '=' + position.startCol : position.startCol - origin.startCol}`;
  }).join('|');
}

export function createAnalystIndex(service: ReturnType<typeof createWorkbookService>) {
  const cache = new Map<string, Entry>();
  async function load(name: string) {
    if (typeof name !== 'string' || !name || name.length > 1024) throw new Error('A workbook path is required.');
    // Always re-check containment and hash current bytes. A cache hit does not
    // mean disk I/O was skipped, and never licenses serving a stale revision.
    const { bytes, revision } = await service.read(name);
    const key = `${name}\0${revision}`;
    const existing = cache.get(key);
    if (existing) { cache.delete(key); cache.set(key, existing); return { entry: existing, hit: true }; }
    const entry: Entry = { revision, sheets: new Map(), graph: null, reason: null, unreadable: false };
    try {
      if (bytes.byteLength > BYTE_CAP) throw new Error('Workbook exceeds the 16 MiB analysis bound.');
      const entries = readAnalysisEntries(bytes);
      const parts = sheetParts(entries);
      const byName = new Map(entries.map(item => [item.name, item]));
      const shared = parseSharedStrings(byName.get('xl/sharedStrings.xml')?.data.toString('utf8') ?? null);
      if (parts.length > 32) throw new Error('Workbook exceeds the 32-sheet analysis bound.');
      let populated = 0;
      for (const part of parts) {
        const sheetXml = byName.get(part.part)?.data.toString('utf8');
        if (!sheetXml) throw new Error('A worksheet part is missing; privacy scope cannot be established.');
        if (/<[^>]+\s[\w:.-]+\s*=\s*'/.test(sheetXml)) throw new Error('Single-quoted worksheet attributes prevent a complete analysis read.');
        let parsedCells = 0;
        for (const cell of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          parsedCells++;
          const tag = `<c ${cell[1]}>`;
          const address = attr(tag, 'r');
          const at = address && /^[A-Za-z]{1,3}[1-9]\d*$/.test(address) ? parseRange(address) : null;
          if (!at || at.endCol > 16384 || at.endRow > 1048576) throw new Error('An invalid cell address prevents a complete privacy-label scan.');
          if (attr(tag, 't') !== 's') continue;
          const raw = (cell[2] ?? '').match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
          const index = Number(raw);
          if (raw === undefined || !Number.isInteger(index) || index < 0 || index >= shared.length) throw new Error('An unresolved shared string prevents a complete privacy-label scan.');
        }
        if (parsedCells !== [...sheetXml.matchAll(/<c\b/g)].length) throw new Error('Malformed cells prevent a complete privacy-label scan.');
        const result = readRangeFromBytes(bytes, part.name, 'A1:XFD1048576', { cellLimit: CELL_CAP + 1 });
        if (result.status !== 'ok') throw new Error(result.reason);
        populated += result.cells.length;
        if (result.truncated || populated > CELL_CAP) throw new Error('Privacy scan exceeds 20,000 populated cells; no partial cell evidence is released.');
        const cells = new Map(result.cells.map(cell => [cell.address.toUpperCase(), cell]));
        entry.sheets.set(part.name, cells);
        for (const cell of result.cells) {
          if (typeof cell.value !== 'string') continue;
          // Scan every saved text cell, not an assumed header row. This catches
          // offset tables and mixed model/data sheets without header alignment.
          const reason = redactionReasonFor(cell.value, [cell.value]);
          if (reason) entry.reason = reason;
        }
      }
      if (!entry.reason) entry.graph = buildDependencyGraph(bytes, { includeSheets: parts.map(part => part.name), nodeCap: CELL_CAP, edgeCap: 40_000 });
    } catch (error) {
      entry.reason = error instanceof Error ? error.message : String(error);
      entry.unreadable = true;
    }
    // Do not retain protected data, or buffers/native workbook instances.
    if (entry.reason) entry.sheets.clear();
    cache.set(key, entry);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    return { entry, hit: false };
  }

  async function prepare(name: string, sheet: string, ref: string, single = false) {
    const range = validatedRange(sheet, ref, single);
    const { entry, hit } = await load(name);
    const graph = entry.graph;
    const limitations = [
      'As-saved values only; unsaved canvas edits and recalculation are not included.',
      'Privacy scan checks all saved text labels and SSN-shaped values within the analysis bound. Unlabelled numeric birthdates cannot be identified.',
      'Dependency references use the existing A1 parser; dynamic references and unsupported shapes are not calculated.',
    ];
    if (entry.reason) limitations.push(entry.reason);
    if (graph?.status === 'unreadable') limitations.push(graph.reason);
    if (graph?.status === 'built') {
      if (graph.truncated) limitations.push(graph.truncationReason ?? 'Dependency graph was truncated.');
      if (graph.unresolved.length) limitations.push(`${graph.unresolved.length} unresolved dependency operands remain.`);
      if (graph.skipped.length) limitations.push(`${graph.skipped.length} sheets were not indexed.`);
    }
    const cells = entry.sheets.get(sheet);
    if (!entry.reason && !cells) throw new Error(`No sheet named ${sheet}.`);
    const base = {
      status: entry.reason ? (entry.unreadable ? 'unreadable' : 'redacted') : 'ok',
      workbook: name, sheet, range: ref.toUpperCase(), revision: entry.revision,
      cache: { hit, entries: cache.size }, provenance: 'Saved workbook bytes; no recalculation or source changes.',
      coverage: { complete: false, limitations },
    };
    return { entry, graph, cells, range, base };
  }

  async function context(name: string, sheet: string, ref: string) {
    const { cells, range, graph, base } = await prepare(name, sheet, ref);
    const selected = [...(cells?.values() ?? [])].filter(cell => {
      const at = parseRange(cell.address)!;
      return at.startRow >= range.startRow && at.startRow <= range.endRow && at.startCol >= range.startCol && at.startCol <= range.endCol;
    });
    const dependencies = graph?.status === 'built' ? selected.filter(cell => cell.formula).map(cell => {
      const precedents = graph.precedentsOf(`${sheet}!${cell.address}`);
      return { address: cell.address, precedents: precedents.slice(0, 100), truncated: precedents.length > 100 };
    }) : [];
    return structuredClone({ ...base, cells: selected, dependencies, limits: { selectedCells: RANGE_CAP, precedentsPerFormula: 100 } });
  }

  async function explain(name: string, sheet: string, address: string) {
    const { entry, cells, graph, base } = await prepare(name, sheet, address, true);
    const canonical = address.replace(/\$/g, '').toUpperCase();
    const node = `${sheet}!${canonical}`;
    const precedents = graph?.status === 'built' ? graph.precedentsOf(node) : [];
    const dependents = graph?.status === 'built' ? graph.dependentsOf(node) : [];
    const evidence = precedents.slice(0, 100).map(ref => ref.kind === 'cell' ? { ...ref, cell: entry.sheets.get(ref.sheet)?.get(ref.address) ?? null } : ref);
    const trace: { node: string; depth: number; formula: string | null; value: RangeCell['value']; precedents: readonly Precedent[] }[] = [];
    const reasons = new Set<string>();
    const visited = new Set<string>();
    const cycles: { from: string; to: string }[] = [];
    let unexpandedRanges = 0;
    if (graph?.status === 'built') {
      const queue = [{ node, sheet, address: canonical, depth: 0, ancestors: [] as string[] }];
      const queued = new Set([node]);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor];
        visited.add(current.node);
        const saved = entry.sheets.get(current.sheet)?.get(current.address);
        const refs = graph.precedentsOf(current.node);
        trace.push({ node: current.node, depth: current.depth, formula: saved?.formula ?? null, value: saved?.value ?? null, precedents: refs.slice(0, 100) });
        if (refs.length > 100) reasons.add('A trace node exceeds 100 direct operands.');
        for (const ref of refs.slice(0, 100)) {
          if (ref.kind === 'range') { unexpandedRanges++; continue; }
          if (ref.node === current.node || current.ancestors.includes(ref.node)) {
            cycles.push({ from: current.node, to: ref.node });
            continue;
          }
          if (queued.has(ref.node)) continue;
          if (current.depth >= 6) { reasons.add('Upstream traversal stopped at six hops.'); continue; }
          if (queue.length >= 100) { reasons.add('Upstream traversal stopped at 100 nodes.'); continue; }
          queued.add(ref.node);
          queue.push({ node: ref.node, sheet: ref.sheet, address: ref.address, depth: current.depth + 1, ancestors: [...current.ancestors, current.node] });
        }
      }
      if (graph.truncated) reasons.add('The underlying dependency graph is truncated.');
    }
    const traceUnresolved = graph?.status === 'built' ? graph.unresolved.filter(item => visited.has(item.at)) : [];
    if (traceUnresolved.length > 100) reasons.add('Trace unresolved operands were capped at 100.');
    return structuredClone({ ...base, target: cells?.get(canonical) ?? null, precedents: evidence, dependents: dependents.slice(0, 100), truncated: precedents.length > 100 || dependents.length > 100 || reasons.size > 0,
      trace, traversal: { maxHops: 6, maxNodes: 100, truncated: reasons.size > 0, reasons: [...reasons], cycles, unexpandedRanges,
        unresolved: traceUnresolved.slice(0, 100), cycleCandidates: graph?.status === 'built' ? graph.cycleNodes.filter(candidate => visited.has(candidate)) : [],
        basis: 'Bounded upstream A1 traversal. Range operands remain unexpanded rectangles; their internal chains are not traced. Repeated nodes are visited once. Cycle edges are detected along discovered paths; this is not an exhaustive cycle proof.' },
      unresolved: graph?.status === 'built' ? graph.unresolved.filter(item => item.at === node).slice(0, 100) : [] });
  }

  async function audit(name: string, sheet: string, ref: string) {
    const { cells, range, base } = await prepare(name, sheet, ref);
    const findings: AnalystFinding[] = [];
    for (const cell of cells?.values() ?? []) {
      const at = parseRange(cell.address)!;
      if (at.startRow < range.startRow || at.startRow > range.endRow || at.startCol < range.startCol || at.startCol > range.endCol) continue;
      if (cell.isError) findings.push({ kind: 'formula-error', address: cell.address, severity: 'review', message: 'The saved cell contains an Excel error. Recalculate and review its inputs.' });
      const column = cell.address.replace(/\d+$/, '');
      const before = cells!.get(`${column}${at.startRow - 1}`);
      const after = cells!.get(`${column}${at.startRow + 1}`);
      const beforePattern = before ? signature(before.formula, before.address) : null;
      const afterPattern = after ? signature(after.formula, after.address) : null;
      if (beforePattern && beforePattern === afterPattern) {
        const current = signature(cell.formula, cell.address);
        if (!cell.formula && typeof cell.value === 'number') findings.push({ kind: 'constant-in-formula-run', address: cell.address, severity: 'review', message: 'A numeric constant interrupts matching formulas immediately above and below. It may be an intentional override.', peers: [before!.address, after!.address] });
        else if (current && current !== beforePattern) findings.push({ kind: 'formula-pattern', address: cell.address, severity: 'review', message: 'This arithmetic formula differs from the matching relative-reference pattern immediately above and below. Review the exception; it is not proof of an error.', peers: [before!.address, after!.address] });
      }
    }
    return structuredClone({ ...base, findings, basis: 'Review leads only. Pattern comparison covers vertical adjacent arithmetic A1 formulas, including absolute and mixed references. Functions, names, cross-sheet references, blanks, and hidden shared-formula followers are not classified.' });
  }
  return { context, explain, audit };
}
