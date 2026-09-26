import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAnalysisEntries } from './analysis-archive.ts';
import type { WorkbookService } from './workbook-service.ts';
import { parseRange } from './context-bus.ts';
import { readRangeFromBytes, profileWorkbook } from './workbook-profile.ts';
import { parseSharedStrings, unescapeXml, attr } from './ooxml-cache.ts';
import { redactionReasonFor } from './redaction.ts';
import { buildDependencyGraph } from './workbook-graph.ts';

export interface ReconcileRequest {
  sheet: string; left: string; right: string; tolerance?: number;
  blankPolicy?: 'reject' | 'zero'; expectedRevision?: string;
}
export interface ScenarioRequest {
  sheet: string; input: string; values: number[]; outputs: string[]; expectedRevision?: string;
}

function boundedRange(ref: string, single = false) {
  if (typeof ref !== 'string') throw new Error('An A1 address is required.');
  const range = parseRange(ref);
  if (!range || range.sheet || range.endCol > 16384 || range.endRow > 1048576 ||
      (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > (single ? 1 : 2000)) {
    throw new Error(single ? 'Use one unqualified cell address.' : 'Use an unqualified range of at most 2,000 cells.');
  }
  return range;
}

function guard(bytes: Uint8Array) {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('The financial lab accepts workbooks up to 8 MB.');
  const entries = readAnalysisEntries(bytes);
  const shared = parseSharedStrings(entries.find(e => e.name === 'xl/sharedStrings.xml')?.data.toString('utf8') ?? null);
  const texts = [...shared];
  let cellCount = 0;
  for (const entry of entries) {
    if (!/^xl\/worksheets\/.*\.xml$/.test(entry.name)) continue;
    const xml = entry.data.toString('utf8');
    // The shared byte-reader supports double-quoted attributes only. Reject a
    // different XML spelling rather than letting it silently hide cell types.
    if (/<[^>]+\s[\w:.-]+\s*=\s*'/.test(xml)) throw new Error('Single-quoted worksheet attributes are unsupported for a complete financial-lab read.');
    const expectedCells = [...xml.matchAll(/<c\b/g)].length;
    let seen = 0;
    for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (++cellCount > 20000) throw new Error('A complete privacy scan is limited to 20,000 worksheet cells.');
      seen++;
      const type = attr(`<c ${match[1]}>`, 't');
      const inner = match[2] ?? '';
      const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      if (type === 's') {
        const index = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
        if (!Number.isInteger(index) || index < 0 || index >= shared.length) throw new Error('An unresolved shared string prevents a complete privacy-label scan.');
        texts.push(shared[index]);
      } else if (type === 'inlineStr') {
        texts.push([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => unescapeXml(t[1])).join(''));
      } else if (raw !== undefined) {
        texts.push(unescapeXml(raw));
      }
    }
    if (seen !== expectedCells) throw new Error('Malformed cells prevent a complete privacy-label scan.');
  }
  for (const text of texts) {
    if (redactionReasonFor(text, [text])) throw new Error('High-risk personal data is present and redacted (R38). Financial statistics and scenarios are unavailable for this workbook.');
  }
}

function cells(bytes: Uint8Array, sheet: string, ref: string) {
  const result = readRangeFromBytes(bytes, sheet, ref);
  if (result.status !== 'ok') throw new Error(result.reason);
  if (result.truncated) throw new Error('The selected range exceeded the complete-read limit.');
  return result.cells;
}

function numericSum(bytes: Uint8Array, sheet: string, ref: string, blankPolicy: 'reject' | 'zero') {
  const range = boundedRange(ref);
  const selected = cells(bytes, sheet, ref);
  return numericSumCells(ref, range, selected, blankPolicy);
}

function numericSumCells(ref: string, range: ReturnType<typeof boundedRange>, selected: ReturnType<typeof cells>, blankPolicy: 'reject' | 'zero') {
  const area = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  let sum = 0, compensation = 0, count = 0;
  for (const cell of selected) {
    if (cell.isError || (cell.formula && cell.value === null)) throw new Error('A selected cell has an error or a missing formula cache. Recalculate and save the workbook first.');
    if (cell.value === null || cell.value === '') continue;
    if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) throw new Error('Tie-outs require numeric cells; text and boolean values are not silently ignored.');
    const adjusted = cell.value - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next; count++;
  }
  const blankCount = area - count;
  if (blankCount && blankPolicy === 'reject') throw new Error('The range contains blanks. Choose the explicit zero policy or select a fully populated range.');
  if (!Number.isFinite(sum)) throw new Error('The total exceeds finite numeric precision.');
  return { range: ref, sum, count, blankCount };
}

function runScenario<T>(bytes: Uint8Array, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/scenario-worker.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Scenario calculation exceeded the 30-second limit. Source workbook was not changed.')); }, 30_000);
    child.on('error', error => finish(error));
    child.stdin.on('error', () => { /* exit handler owns error reporting */ });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 65536) { child.kill(); finish(new Error('Scenario response exceeded its output limit.')); }
    });
    child.stderr.resume();
    child.on('close', code => {
      if (code !== 0) return finish(new Error('The isolated engine could not calculate this scenario. Source workbook was not changed.'));
      try { const result = JSON.parse(output); if (result.error) finish(new Error(result.error)); else finish(undefined, result); } catch { finish(new Error('Invalid response from the isolated scenario engine.')); }
    });
    child.stdin.end(JSON.stringify({ bytes: Buffer.from(bytes).toString('base64'), request }));
  });
}

export { guard as assertFinancialPrivacy, numericSum as financialNumericSum, numericSumCells as financialNumericSumCells, boundedRange as validateFinancialRange, cells as readFinancialCells };
function modelPreflight(bytes: Uint8Array, sheet: string) {
      const profile = profileWorkbook(bytes);
      if (profile.status !== 'profiled' || profile.cells > 10000 || profile.formulas > 2000 || profile.sheets.length !== 1) throw new Error('Scenarios support one-sheet models with at most 10,000 populated cells and 2,000 formulas.');
      const all = readRangeFromBytes(bytes, sheet, 'A1:XFD1048576', { cellLimit: 10001 });
      if (all.status !== 'ok' || all.truncated) throw new Error('The model could not be read completely.');
      // Restrict to reproducible local arithmetic; never run volatile, external, named,
      // dynamic-array or data-access functions in this initial scenario contract.
      for (const cell of all.cells) {
        if (!cell.formula) continue;
        const stripped = cell.formula.replace(/\$?[A-Z]{1,3}\$?\d+/gi, '').replace(/\b(?:SUM|MIN|MAX|AVERAGE|ABS|ROUND|IF)\s*(?=\()/gi, '');
        if (!/^[\d\s.,:()+\-*/^%=<>]*$/.test(stripped)) throw new Error('This scenario contains unsupported formulas. Supported: local arithmetic, SUM, MIN, MAX, AVERAGE, ABS, ROUND and IF.');
      }
      const graph = buildDependencyGraph(bytes, { includeSheets: [sheet], nodeCap: 15000, edgeCap: 30000 });
      if (graph.status !== 'built' || graph.truncated || graph.unresolved.length || graph.cycles) throw new Error('Scenario dependencies must be complete, resolved, and free of cycles.');
      return new Map(all.cells.map(cell => [cell.address.toUpperCase(), cell]));
}
interface DecisionBase { sheet: string; output: string; expectedRevision?: string }
export interface SensitivityRequest extends DecisionBase { rowInput: string; rowValues: number[]; colInput: string; colValues: number[] }
export interface DriversRequest extends DecisionBase { inputs: { cell: string; low: number; high: number }[] }
export interface GoalSeekRequest extends DecisionBase { input: string; target: number; lower: number; upper: number; tolerance?: number }
interface DecisionCase { inputs: Record<string, number>; output: number }
interface GoalResult { status: 'converged' | 'not-converged'; solution: number; value: number; residual: number; iterations: number; cases: { input: number; value: number; residual: number }[] }
function address(ref: string) {
  const range = boundedRange(ref, true);
  let column = range.startCol, letters = '';
  while (column) { column--; letters = String.fromCharCode(65 + column % 26) + letters; column = Math.floor(column / 26); }
  return `${letters}${range.startRow}`;
}
function finite(value: number) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Provide finite numeric values.'); return value; }
function decisionRequest(request: DecisionBase) {
 if (!request || typeof request !== 'object' || typeof request.sheet !== 'string' || !request.sheet.trim()) throw new Error('A sheet is required.');
 if (request.expectedRevision !== undefined && typeof request.expectedRevision !== 'string') throw new Error('Expected revision must be a string.');
 address(request.output);
}
function distinct(refs: string[]) { if (new Set(refs).size !== refs.length) throw new Error('Select distinct input cells.'); }
function values(items: number[]) { if (!Array.isArray(items) || !items.length || items.length > 5) throw new Error('Provide 1 to 5 values per axis.'); items.forEach(finite); }
export function createFinancialLab(service: Pick<WorkbookService, 'read'>) {
  let active = false;
  async function source(name: string, expectedRevision?: string) {
    const read = await service.read(name);
    if (expectedRevision !== undefined && expectedRevision !== read.revision) throw new Error('The workbook revision changed. Refresh before running this analysis.');
    guard(read.bytes);
    return read;
  }
  async function decision<T>(name: string, request: DecisionBase, inputs: string[], work: unknown) {
    if (active) throw new Error('A scenario is already calculating. Please retry after it finishes.');
    const { bytes, revision } = await source(name, request.expectedRevision);
    const modelCells = modelPreflight(bytes, request.sheet);
    const baselineInputs: Record<string, number> = {};
    for (const ref of inputs) {
      const cell = modelCells.get(ref.toUpperCase());
      if (!cell || cell.formula || cell.isError || typeof cell.value !== 'number' || !Number.isFinite(cell.value)) throw new Error('The scenario input must be a saved numeric constant, not a formula.');
      baselineInputs[ref] = cell.value;
    }
    const output = modelCells.get(address(request.output).toUpperCase());
    if (!output || output.isError || typeof output.value !== 'number' || !Number.isFinite(output.value)) throw new Error('Each output must have a saved numeric value.');
    if (active) throw new Error('A scenario is already calculating. Please retry after it finishes.');
    active = true;
    try {
      const result = await runScenario<T>(bytes, work);
      if ((await service.read(name)).revision !== revision) throw new Error('The source changed during calculation. Refresh and run again.');
      return { result, baselineInputs, meta: { revision, sheet: request.sheet, sourceUnchanged: true as const, basis: 'disposable-engine' as const } };
    } finally { active = false; }
  }
  return {
    async sensitivity(name: string, request: SensitivityRequest) {
      decisionRequest(request); values(request.rowValues); values(request.colValues);
      const rowInput = address(request.rowInput), colInput = address(request.colInput), output = address(request.output);
      distinct([rowInput, colInput]);
      const cases = request.rowValues.flatMap(rowValue => request.colValues.map(colValue => ({ [rowInput]: rowValue, [colInput]: colValue })));
      const {result,meta} = await decision<{cases: DecisionCase[]}>(name, request, [rowInput,colInput], {kind:'cases',sheet:request.sheet,output,cases});
      const evaluated = result.cases.map(c => ({rowValue:c.inputs[rowInput],colValue:c.inputs[colInput],output:c.output}));
      return {...meta,status:'calculated' as const,rowInput,colInput,output,rowValues:request.rowValues,colValues:request.colValues,cases:evaluated,matrix:request.rowValues.map((_,r)=>evaluated.slice(r*request.colValues.length,(r+1)*request.colValues.length).map(c=>c.output)),coverage:{complete:true,limitations:['Only the listed row and column combinations were tested; untested cases are outside this evidence.','Supported models are single-sheet and limited to local arithmetic plus SUM, MIN, MAX, AVERAGE, ABS, ROUND and IF.','Sensitivity results describe tested assumptions only; they are not forecasts and do not establish causation.']}};
    },
    async drivers(name: string, request: DriversRequest) {
      decisionRequest(request);
      if (!Array.isArray(request.inputs) || !request.inputs.length || request.inputs.length > 6) throw new Error('Select 1 to 6 drivers.');
      const inputs = request.inputs.map(i=>{ if (!i || typeof i !== 'object') throw new Error('A driver is required.'); const cell=address(i.cell); finite(i.low); finite(i.high); if(i.low>=i.high) throw new Error('Driver low must be below high.'); return {...i,cell}; });
      distinct(inputs.map(i=>i.cell)); const output=address(request.output);
      const cases=[{},...inputs.flatMap(i=>[{[i.cell]:i.low},{[i.cell]:i.high}])];
      const {result,meta,baselineInputs}=await decision<{cases:DecisionCase[]}>(name,request,inputs.map(i=>i.cell),{kind:'cases',sheet:request.sheet,output,cases});
      const baseline=result.cases[0].output;
      const drivers=inputs.map((i,index)=>{const lowOutput=result.cases[1+index*2].output,highOutput=result.cases[2+index*2].output;return {...i,baselineInput:baselineInputs[i.cell],lowOutput,highOutput,lowDelta:finite(lowOutput-baseline),highDelta:finite(highOutput-baseline),span:finite(Math.abs(highOutput-lowOutput))};}).sort((a,b)=>b.span-a.span);
      return {...meta,status:'calculated' as const,output,baseline,drivers,cases:result.cases,coverage:{complete:true,limitations:['Only the listed low and high case for each driver was tested, with one input changed at a time.','Supported models are single-sheet and limited to local arithmetic plus SUM, MIN, MAX, AVERAGE, ABS, ROUND and IF.','Driver results describe tested assumptions only; they are not forecasts and do not establish causation.']}};
    },
    async goalSeek(name: string, request: GoalSeekRequest) {
      decisionRequest(request); const input=address(request.input),output=address(request.output);
      finite(request.target); finite(request.lower); finite(request.upper); const tolerance=finite(request.tolerance??0.000001);
      if(request.lower>=request.upper || tolerance<=0) throw new Error('Use an increasing bracket and positive tolerance.');
      const {result,meta}=await decision<GoalResult>(name,request,[input],{...request,input,output,tolerance,kind:'goal'});
      return {...meta,...result,input,output,target:request.target,lower:request.lower,upper:request.upper,tolerance,method:'bracketed-bisection' as const,scope:'local-bracket' as const,coverage:{complete:result.status==='converged',limitations:['Only points evaluated inside the supplied bracket were tested; behavior outside that bracket is unknown.','Supported models are single-sheet and limited to local arithmetic plus SUM, MIN, MAX, AVERAGE, ABS, ROUND and IF.','A local bracket can contain multiple solutions or cross a discontinuity; convergence does not prove uniqueness or continuity.','The solution describes this saved model and tested assumptions only; it is not a forecast and does not establish causation.']}};
    },
    async reconcile(name: string, request: ReconcileRequest) {
      const tolerance = request.tolerance ?? 0.01;
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) throw new Error('Tolerance must be a finite, nonnegative number.');
      const blankPolicy = request.blankPolicy ?? 'reject';
      if (blankPolicy !== 'reject' && blankPolicy !== 'zero') throw new Error('Blank policy must be reject or zero.');
      const { bytes, revision } = await source(name, request.expectedRevision);
      const left = numericSum(bytes, request.sheet, request.left, blankPolicy);
      const right = numericSum(bytes, request.sheet, request.right, blankPolicy);
      const difference = left.sum - right.sum;
      if (!Number.isFinite(difference)) throw new Error('The difference exceeds finite numeric precision.');
      return { status: Math.abs(difference) <= tolerance ? 'balanced' as const : 'difference' as const,
        revision, sheet: request.sheet, left, right, difference, tolerance, blankPolicy,
        basis: 'saved-cached-values' as const, sourceUnchanged: true as const };
    },
    async scenario(name: string, request: ScenarioRequest) {
      boundedRange(request.input, true);
      if (!Array.isArray(request.values) || !request.values.length || request.values.length > 9 || request.values.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Provide 1 to 9 finite scenario values.');
      if (!Array.isArray(request.outputs) || !request.outputs.length || request.outputs.length > 6) throw new Error('Select 1 to 6 output cells.');
      request.outputs.forEach(ref => boundedRange(ref, true));
      if (active) throw new Error('A scenario is already calculating. Please retry after it finishes.');
      const { bytes, revision } = await source(name, request.expectedRevision);
      const modelCells = modelPreflight(bytes, request.sheet);
      const input = modelCells.get(address(request.input).toUpperCase());
      if (!input || input.formula || input.isError || typeof input.value !== 'number' || !Number.isFinite(input.value)) throw new Error('The scenario input must be a saved numeric constant, not a formula.');
      for (const output of request.outputs) {
        const cell = modelCells.get(address(output).toUpperCase());
        if (!cell || cell.isError || typeof cell.value !== 'number') throw new Error('Each output must have a saved numeric value.');
      }
      // Source reads yield, so two requests can pass the early busy check together.
      if (active) throw new Error('A scenario is already calculating. Please retry after it finishes.');
      active = true;
      try {
        const result = await runScenario<{ cases: { input: number; outputs: Record<string, number> }[] }>(bytes, request);
        const current = await service.read(name);
        if (current.revision !== revision) throw new Error('The source changed during calculation. Refresh and run again.');
        return { status: 'calculated' as const, revision, sheet: request.sheet, input: request.input,
          baseline: input.value, outputs: request.outputs, cases: result.cases,
          sourceUnchanged: true as const, basis: 'disposable-engine' as const };
      } finally { active = false; }
    },
  };
}
