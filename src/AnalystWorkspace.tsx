import { useEffect, useRef, useState } from 'react';

import { DecisionFields, DecisionResults, decisionModes, decisionPayload, initialRules, type CheckRule, type DecisionAction } from './DecisionDesk';
import { downloadFile, evidenceBrief, type EvidenceEntry } from './evidence-brief';
type Action = DecisionAction | 'context' | 'explain' | 'audit' | 'reconcile' | 'scenario';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Result {
  action: Action; status: string; revision: string; elapsedMs: number; workbook: string;
  cache?: { hit: boolean; entries: number }; coverage?: { complete: boolean; limitations: string[] };
  provenance?: string; findings?: { kind: string; address?: string; message?: string; [key: string]: Json | undefined }[];
  cells?: { address: string; value?: Json; formula?: string | null }[];
  difference?: number; tolerance?: number; left?: { sum: number; range: string }; right?: { sum: number; range: string };
  input?: string; outputs?: string[]; cases?: { input: number; outputs: Record<string, number> }[];
  [key: string]: unknown;
}
const modes: { id: Action; label: string; description: string }[] = [
  { id: 'context', label: 'Inspect', description: 'A compact view of saved cells, formulas and their source addresses.' },
  { id: 'explain', label: 'Explain', description: 'Follow the inputs behind a number and see what depends on it.' },
  { id: 'audit', label: 'Review', description: 'Find formula errors and breaks in repeated patterns. Findings are review leads.' },
  { id: 'reconcile', label: 'Tie out', description: 'Compare two explicit numeric ranges with a stated tolerance.' },
  { id: 'scenario', label: 'Scenarios', description: 'Change one assumption in a disposable copy. The saved workbook stays unchanged.' },
];
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? value.error ?? `Request failed (${response.status})`);
  return value as T;
}
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const number = (value: number) => numberFormat.format(value);

const decisionDefaults = { rowInput: 'B3', rowValues: '0, 0.1, 0.2', colInput: 'B4', colValues: '0.5, 0.6, 0.7', output: 'B8', driver1: 'B3', low1: '0', high1: '0.2', driver2: 'B4', low2: '0.5', high2: '0.7', goalInput: 'B3', target: '420000', lower: '0', upper: '1', goalTolerance: '0.01', baseline: 'B11:B13', comparison: 'D11:D13' };
const decisionSelectionTargets: Partial<Record<Action, { key: string; useRange: boolean }>> = {
  sensitivity: { key: 'rowInput', useRange: false }, drivers: { key: 'driver1', useRange: false },
  goalSeek: { key: 'goalInput', useRange: false }, variance: { key: 'baseline', useRange: true },
};
const pinnableStatuses = new Set(['ok', 'calculated', 'balanced', 'difference', 'converged', 'not-converged', 'passed', 'failed']);

function resultTitle(result: Result, decisionLabel?: string) {
  if (decisionLabel) return `${decisionLabel} results`;
  if (result.action === 'reconcile') return result.status === 'balanced' ? 'Balances agree' : 'Difference to investigate';
  if (result.action === 'scenario') return 'Scenario results';
  if (result.action === 'audit') return 'Review findings';
  if (result.action === 'explain') return 'Calculation trail';
  return 'Saved range context';
}

export function AnalystWorkspace() {
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState(new URLSearchParams(location.search).get('wb') ?? '');
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState('Model');
  const [mode, setMode] = useState<Action>('context');
  const [range, setRange] = useState('A1:D20');
  const [address, setAddress] = useState('B8');
  const [left, setLeft] = useState('B11:B13');
  const [right, setRight] = useState('D11:D13');
  const [tolerance, setTolerance] = useState('0.01');
  const [input, setInput] = useState('B3');
  const [values, setValues] = useState('0, 0.1, 0.2');
  const [outputs, setOutputs] = useState('B8');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [example, setExample] = useState(false);
  const newWorkbookDialog = useRef<HTMLDialogElement>(null);
  const [newName, setNewName] = useState('Untitled.xlsx');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [decision, setDecision] = useState<Record<string, string>>(decisionDefaults);
  const [rules, setRules] = useState<CheckRule[]>(initialRules);
  const [notebook, setNotebook] = useState<EvidenceEntry[]>([]);
  const [assumptions, setAssumptions] = useState<Record<string, unknown>>({});
  const requestId = useRef(0);
  const canvasFrame = useRef<HTMLIFrameElement>(null);
  const revealRequestId = useRef(0);
  const pendingRevealId = useRef<string | null>(null);
  const revealTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = [...modes, ...decisionModes].find(item => item.id === mode)!;
  const resultDecisionMode = result ? decisionModes.find(item => item.id === result.action) : undefined;

  async function refreshFiles() {
    const config = await request<{ files: { name: string }[] }>('/api/config');
    setFiles(config.files.map(item => item.name));
  }
  useEffect(() => { void refreshFiles().catch(err => setError(String(err.message))); }, []);
  useEffect(() => {
    let active = true;
    if (revealTimeout.current) clearTimeout(revealTimeout.current);
    revealTimeout.current = null;
    pendingRevealId.current = null;
    setResult(null); setError(''); setDirty(false); setSheets([]); requestId.current++;
    if (!file) return;
    request<{ profile: { status: string; sheets?: { name: string }[] } }>(`/api/profile?path=${encodeURIComponent(file)}`).then(data => {
      if (!active) return;
      const names = data.profile.sheets?.map(item => item.name) ?? [];
      setSheets(names); setSheet(previous => names.includes(previous) ? previous : names[0] ?? '');
    }).catch(err => { if (active) setError(err.message); });
    const poll = () => request<{ context: { dirty: boolean } | null }>(`/api/context?path=${encodeURIComponent(file)}`)
      .then(data => { if (active) setDirty(data.context?.dirty ?? false); }).catch(() => {});
    void poll(); const timer = setInterval(poll, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [file]);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== canvasFrame.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'mog:reveal-result'
        || !('id' in message) || message.id !== pendingRevealId.current || !('status' in message)) return;
      pendingRevealId.current = null;
      if (revealTimeout.current) clearTimeout(revealTimeout.current);
      revealTimeout.current = null;
      if (message.status === 'applied') setNotice('Cell shown in the live canvas.');
      else setError('The live canvas could not show that cell.');
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); if (revealTimeout.current) clearTimeout(revealTimeout.current); };
  }, []);

  function change(setter: (value: string) => void, value: string) { setter(value); setResult(null); setError(''); requestId.current++; }
  function openNewWorkbook() {
    if (dirty) { setError('Save your canvas changes before starting a new workbook.'); return; }
    let candidate = 'Untitled.xlsx', suffix = 2;
    while (files.some(name => name.toLowerCase() === candidate.toLowerCase())) candidate = `Untitled ${suffix++}.xlsx`;
    setNewName(candidate); setCreateError(''); newWorkbookDialog.current?.showModal();
  }
  async function createWorkbook(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    if (dirty) { setCreateError('Save your canvas changes before starting a new workbook.'); return; }
    setCreating(true); setCreateError(''); requestId.current++;
    try {
      const created = await request<{ name: string; revision: string }>('/api/workbooks', { name: newName.trim() });
      setFiles(previous => [...new Set([...previous, created.name])].sort());
      setFile(created.name); setSheet('Sheet1'); setRange('A1:D20'); setAddress('A1');
      setMode('context'); setResult(null); setExample(false); setError('');
      setNotice('Your blank workbook is ready. Enter data in the canvas, then Save to analyze it.');
      newWorkbookDialog.current?.close();
    } catch (err) { setCreateError((err as Error).message); }
    finally { setCreating(false); }
  }
  async function loadExample() {
    if (dirty) { setError('Save your canvas changes before opening the example.'); return; }
    setBusy(true); setError('');
    try {
      const data = await request<{ name: string }>('/api/analyst/example', {});
      await refreshFiles(); setFile(data.name); setSheet('Model'); setRange('A1:D20'); setAddress('B8');
      setLeft('B11:B13'); setRight('D11:D13'); setInput('B3'); setValues('0, 0.1, 0.2'); setOutputs('B8');
      setDecision({ ...decisionDefaults }); setRules(structuredClone(initialRules)); setMode('context'); setResult(null); setExample(true); setNotice('Synthetic example ready. Start with Inspect, then try each review tool.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function useSelection() {
    const id = ++requestId.current;
    try {
      const data = await request<{ context: { activeSheet: string | null; selection: string | null } | null }>(`/api/context?path=${encodeURIComponent(file)}`);
      if (id !== requestId.current) return;
      if (!data.context?.selection || !data.context.activeSheet) throw new Error('Select a cell or range in the spreadsheet first.');
      setSheet(data.context.activeSheet);
      const decisionTarget = decisionSelectionTargets[mode];
      if (decisionTarget) setDecision(previous => ({ ...previous, [decisionTarget.key]: decisionTarget.useRange ? data.context!.selection! : data.context!.selection!.split(':')[0] }));
      else if (mode === 'checks') setRules(previous => previous.map((rule, i) => i === 0 ? { ...rule, range: data.context!.selection! } : rule));
      else if (mode === 'scenario') setInput(data.context.selection.split(':')[0]);
      else if (mode === 'reconcile') setLeft(data.context.selection);
      else if (mode === 'explain') setAddress(data.context.selection.split(':')[0]);
      else setRange(data.context.selection);
      setResult(null); setError(''); requestId.current++;
      setNotice(`Using ${data.context.activeSheet}!${data.context.selection}`);
    } catch (err) { if (id === requestId.current) setError((err as Error).message); }
  }
  async function run(event: React.FormEvent) {
    event.preventDefault(); const id = ++requestId.current; setBusy(true); setError(''); setResult(null);
    try {
      const fields = decisionPayload(mode, decision, rules) ?? (mode === 'explain' ? { address } : mode === 'reconcile' ? { left, right, tolerance: Number(tolerance), blankPolicy: 'reject' }
        : mode === 'scenario' ? { input, values: values.split(',').map(value => value.trim() === '' ? NaN : Number(value)), outputs: outputs.split(',').map(value => value.trim()) } : { range });
      if (mode === 'scenario' && (fields.values as number[]).some(value => !Number.isFinite(value))) throw new Error('Enter finite numbers separated by commas.');
      if (mode === 'reconcile' && (!tolerance.trim() || !Number.isFinite(Number(tolerance)))) throw new Error('Enter a finite tolerance.');
      const data = await request<Result>('/api/analyst', { action: mode, name: file, sheet, ...fields });
      if (id === requestId.current) { setResult(data); setAssumptions({ action: mode, name: file, sheet, ...fields }); }
    } catch (err) { if (id === requestId.current) setError((err as Error).message); } finally { setBusy(false); }
  }
  async function reveal(cell: string, targetSheet = sheet) {
    const target = canvasFrame.current?.contentWindow;
    if (!target) { setError('Open a workbook before following cell evidence.'); return; }
    const id = `workbench-reveal-${++revealRequestId.current}`;
    if (revealTimeout.current) clearTimeout(revealTimeout.current);
    pendingRevealId.current = id;
    revealTimeout.current = setTimeout(() => {
      if (pendingRevealId.current !== id) return;
      pendingRevealId.current = null;
      revealTimeout.current = null;
      setError('The live canvas did not acknowledge navigation. Try the cell link again.');
    }, 10_000);
    target.postMessage({ type: 'mog:reveal', id, workbook: file, range: cell, sheet: targetSheet }, window.location.origin);
    setNotice(`Showing ${targetSheet}!${cell} in this canvas…`);
  }
  function downloadEvidence() {
    if (!result) return;
    downloadFile(`mog-${result.action}-evidence.json`, JSON.stringify(result, null, 2), 'application/json');
  }
  return <div className="workbench">
    <header className="workbench-header"><a className="wordmark" href="/analyst.html">mog<span> / </span><span>financial workbench</span></a><span className="local-label"><i />Local workspace</span></header>
    <div className="workbook-bar"><div><label htmlFor="workbook">WORKBOOK</label><select id="workbook" value={file} disabled={busy || dirty} onChange={event => { requestId.current++; setFile(event.target.value); setExample(false); }}><option value="">Choose a workbook</option>{files.map(name => <option key={name}>{name}</option>)}</select></div><div className="workbook-actions"><button className="primary" onClick={openNewWorkbook} disabled={busy || dirty} data-testid="new-workbook">New workbook</button><button onClick={loadExample} disabled={busy} data-testid="load-example">Open financial example</button>{file && <a href={`/index.html?wb=${encodeURIComponent(file)}`} target="_blank" rel="noreferrer">Open full canvas ↗</a>}</div></div>
    <dialog className="new-workbook-dialog" ref={newWorkbookDialog} aria-labelledby="new-workbook-title" onCancel={event => { if (creating) event.preventDefault(); }}>
      <form onSubmit={createWorkbook}>
        <span className="eyebrow">A FRESH WORKING PAPER</span><h2 id="new-workbook-title">New workbook</h2>
        <p>Start with a blank sheet. Your Excel file stays on this computer.</p>
        <label htmlFor="new-workbook-name">Workbook name</label><input id="new-workbook-name" data-testid="new-workbook-name" autoFocus required maxLength={120} value={newName} disabled={creating} onChange={event => setNewName(event.target.value)} />
        <p className="field-help">The .xlsx extension is added automatically. Existing files are never replaced.</p>
        {createError && <p role="alert" className="error" data-testid="create-workbook-error">{createError}</p>}
        <div className="new-workbook-actions"><button type="button" disabled={creating} onClick={() => newWorkbookDialog.current?.close()}>Cancel</button><button className="primary" type="submit" disabled={creating || !newName.trim()} data-testid="create-workbook">{creating ? 'Creating…' : 'Create workbook'}</button></div>
      </form>
    </dialog>
    <main className="workbench-body">
      <section className="sheet-stage" aria-label="Live spreadsheet">
        <div className="stage-caption"><span>WORKING PAPER</span><span>{file ? 'Live Mog canvas · human edits' : 'Your model, with the evidence beside it'}</span></div>
        {file ? <iframe ref={canvasFrame} title="Live workbook canvas" key={file} src={`/index.html?wb=${encodeURIComponent(file)}&compact=1&embedded=1`} /> : <div className="empty-workbook"><span className="eyebrow">FROM MODEL TO ANSWER</span><h1>Understand the number.<br />Test the assumption.</h1><p>Start a workbook of your own, or explore a financial example with the evidence beside it.</p><div className="empty-workbook-actions"><button className="primary" onClick={openNewWorkbook} disabled={busy} data-testid="empty-new-workbook">New workbook</button><button onClick={loadExample} disabled={busy}>Try the financial example</button></div><p className="quiet">All workbook analysis stays on this computer. The example uses generated financial data.</p></div>}
        <div className="stage-footer"><span>{dirty ? 'Unsaved edits in canvas — save before analyzing' : 'Analysis reads the saved workbook'}</span><span>Scenarios never save</span></div>
      </section>
      <aside className="analysis-panel" aria-label="Analysis tools">
        <div className="panel-intro"><span className="eyebrow">REVIEW DESK</span><h2>Follow the evidence</h2><p>Exact cells. Explicit assumptions. Reproducible results.</p></div>
        <nav className="mode-tabs" aria-label="Analysis mode">{modes.map(item => <button key={item.id} aria-current={mode === item.id ? 'page' : undefined} onClick={() => { setMode(item.id); setResult(null); setError(''); requestId.current++; }} disabled={busy}>{item.label}</button>)}</nav><nav className="mode-tabs decision-tabs" aria-label="Decision tools">{decisionModes.map(item => <button key={item.id} data-testid={`mode-${item.id}`} aria-current={mode === item.id ? 'page' : undefined} onClick={() => { setMode(item.id); setResult(null); setError(''); requestId.current++; }} disabled={busy}>{item.label}</button>)}</nav>
        <div className="analysis-content"><p className="mode-description">{current.description}</p>
          {example && <div className="example-note"><strong>Example guide</strong><span>{mode === 'sensitivity' ? 'Growth × margin: the center case returns EBITDA 360,000.' : mode === 'drivers' ? 'Growth B3 and margin B4 are tested around saved EBITDA 360,000.' : mode === 'goalSeek' ? 'Target EBITDA 420,000 requires growth 0.2 (20%).' : mode === 'variance' ? 'Both lists total 1,000,000. Rows are positional amounts, not matched accounts or actual/budget.' : mode === 'checks' ? 'The example balances and exceeds the 300,000 EBITDA floor.' : mode === 'scenario' ? 'Growth of 0%, 10%, 20% → EBITDA 300,000 / 360,000 / 420,000.' : mode === 'reconcile' ? 'Assets and funding both total 1,000,000.' : mode === 'audit' ? 'D19 intentionally uses addition where its peers use multiplication. This is a review exercise.' : mode === 'explain' ? 'B8 = gross profit less operating costs. Expected EBITDA: 360,000.' : 'Inspect the saved model, then follow B8 through Explain.'}</span></div>}
          <form onSubmit={run}><fieldset disabled={busy || !file}><div className="form-row"><label>Sheet<select value={sheet} onChange={event => change(setSheet, event.target.value)}>{sheets.map(name => <option key={name}>{name}</option>)}</select></label><button className="selection-button" type="button" onClick={useSelection}>Use selection</button></div>
            {(mode === 'context' || mode === 'audit') && <label>Range<input value={range} onChange={event => change(setRange, event.target.value)} required placeholder="A1:D19" /></label>}
            {mode === 'explain' && <label>Output cell<input value={address} onChange={event => change(setAddress, event.target.value)} required placeholder="B8" /></label>}
            {mode === 'reconcile' && <><div className="form-row"><label>Left range<input value={left} onChange={event => change(setLeft, event.target.value)} required /></label><label>Right range<input value={right} onChange={event => change(setRight, event.target.value)} required /></label></div><label>Absolute tolerance<input type="number" min="0" step="any" value={tolerance} onChange={event => change(setTolerance, event.target.value)} required /></label><p className="field-help">Blank cells are rejected. Saved numeric values are compared.</p></>}
            {mode === 'scenario' && <><label>Numeric input cell<input value={input} onChange={event => change(setInput, event.target.value)} required /></label><label>Assumptions <span>(up to 9, comma separated)</span><input value={values} onChange={event => change(setValues, event.target.value)} required /></label><label>Output cells <span>(up to 6, comma separated)</span><input value={outputs} onChange={event => change(setOutputs, event.target.value)} required /></label><p className="field-help">Use decimals for percentages: 0.1 means 10%.</p></>}
            <DecisionFields mode={mode} values={decision} set={(key, value) => { setDecision(previous => ({ ...previous, [key]: value })); setResult(null); setError(''); requestId.current++; }} rules={rules} setRules={value => { setRules(value); setResult(null); requestId.current++; }} error={setError} />
            <button className="primary run-button" type="submit" data-testid="run-analysis">{busy ? 'Working…' : mode === 'scenario' ? 'Calculate scenarios' : mode === 'reconcile' ? 'Run tie-out' : `${current.label} saved model`}</button>
          </fieldset></form>
          {dirty && <p className="warning">These results exclude unsaved canvas changes.</p>}
          {error && <div className="failure" role="alert"><strong>Unable to complete analysis</strong><p>{error}</p></div>}
          <div aria-live="polite" className="quiet notice">{busy ? 'Reading the saved revision…' : notice}</div>
          {result && <section className="analysis-result" data-testid="analysis-result"><div className="result-heading"><h3>{resultTitle(result, resultDecisionMode?.label)}</h3><span className="timing">{number(result.elapsedMs)} ms{result.cache?.hit ? ' · reused index' : ''}</span></div>
            {!resultDecisionMode && result.status !== 'ok' && result.status !== 'calculated' && result.status !== 'balanced' && result.status !== 'difference' && <p className="warning">{result.status}: {String(result.reason ?? result.provenance ?? 'Inspect coverage below.')}</p>}
            {result.action === 'reconcile' && result.left && result.right && <><div className="tieout-values"><div><span>{result.left.range}</span><strong>{number(result.left.sum)}</strong></div><div><span>{result.right.range}</span><strong>{number(result.right.sum)}</strong></div></div><p className={result.status === 'balanced' ? 'success' : 'warning'}>Difference {number(result.difference ?? 0)} · tolerance {number(result.tolerance ?? 0)}</p></>}
            {result.action === 'scenario' && result.cases && <div className="table-scroll"><table><thead><tr><th>{result.input}</th>{result.outputs?.map(cell => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{result.cases.map((item, index) => <tr key={index}><td>{number(item.input)}</td>{result.outputs?.map(cell => <td key={cell}>{number(item.outputs[cell])}</td>)}</tr>)}</tbody></table></div>}
            {result.cells && <div className="table-scroll"><table><thead><tr><th>Cell</th><th>Saved value / formula</th></tr></thead><tbody>{result.cells.map(cell => <tr key={cell.address}><td><button className="cell-link" onClick={() => reveal(cell.address)}>{cell.address}</button></td><td>{String(cell.value ?? '—')}{cell.formula && <code>{cell.formula}</code>}</td></tr>)}</tbody></table></div>}
            {result.status === 'ok' && result.findings && (result.findings.length ? <ul className="findings">{result.findings.map((finding, index) => <li key={index}><strong>{finding.address && <button className="cell-link" onClick={() => reveal(finding.address!)}>{finding.address}</button>} {finding.kind.replaceAll('-', ' ')}</strong><p>{finding.message ?? String(finding.reason ?? '')}</p><details><summary>Finding evidence</summary><pre>{JSON.stringify(finding, null, 2)}</pre></details></li>)}</ul> : <p className="success">No review signals found in this bounded scan. This is not a correctness certificate.</p>)}
            <DecisionResults result={result} />
            {result.action === 'explain' && <Trace result={result} reveal={reveal} />}
            {result.coverage && <div className="coverage"><strong>{result.coverage.complete ? 'Requested scope examined' : 'Coverage is limited'}</strong>{result.coverage.limitations.map((item, index) => <p key={index}>{item}</p>)}</div>}
            <div className="evidence-footer"><span title={result.revision}>Saved revision {result.revision?.slice(0, 12)}</span><button data-testid="pin-evidence" disabled={notebook.length >= 20 || !pinnableStatuses.has(result.status)} onClick={() => {
              if (notebook.length && (notebook[0].result.workbook !== result.workbook || notebook[0].result.revision !== result.revision)) { setError('This notebook belongs to another workbook or saved revision. Export it, then clear it before pinning this result.'); return; }
              setNotebook(previous => [...previous, { result: structuredClone(result), assumptions: structuredClone(assumptions) }]); setNotice('Result pinned in this session.');
            }}>Pin to notebook</button><button onClick={downloadEvidence}>Export evidence ↓</button></div><details className="raw-evidence"><summary>Full result and provenance</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
          </section>}
          <section className="evidence-notebook" data-testid="evidence-notebook"><span className="eyebrow">SESSION NOTEBOOK</span><h3>Evidence worth keeping <span>{notebook.length}/20</span></h3><p className="field-help">Pin results from one workbook revision. Kept in this tab only; download before closing. No automatic storage.</p>{notebook.length > 0 && <><p className="quiet">{String(notebook[0].result.workbook)} · revision {String(notebook[0].result.revision).slice(0, 12)}</p><ol>{notebook.map((entry, i) => <li key={i}>{String(entry.result.action)} <button aria-label={`Remove evidence ${i + 1}`} onClick={() => setNotebook(previous => previous.filter((_, index) => index !== i))}>Remove</button></li>)}</ol><div className="notebook-actions"><button data-testid="export-brief" onClick={() => downloadFile('mog-decision-brief.html', evidenceBrief(notebook), 'text/html')}>Printable brief</button><button data-testid="export-notebook" onClick={() => downloadFile('mog-decision-evidence.json', JSON.stringify({ version: 1, entries: notebook }, null, 2), 'application/json')}>Download JSON</button><button data-testid="clear-notebook" onClick={() => setNotebook([])}>Clear</button></div></>}</section>
        </div>
      </aside>
    </main>
  </div>;
}

function Trace({ result, reveal }: { result: Result; reveal: (cell: string, sheet?: string) => void }) {
  const entries = (Array.isArray(result.precedents) ? result.precedents : []) as { kind?: string; node?: string; sheet?: string; address?: string; ref?: string }[];
  const target = result.target as { address?: string; formula?: string; value?: Json } | null;
  const trace = (Array.isArray(result.trace) ? result.trace : []) as { node: string; depth: number; formula?: string; value?: Json }[];
  return <div className="trace"><div className="trace-target"><span>Selected output · {target?.address ?? 'unavailable'}</span><strong>{target ? String(target.value ?? 'No cached value') : 'No cell evidence available'}</strong>{target?.formula && <code>={target.formula.replace(/^=/, '')}</code>}</div><h4>Direct inputs</h4>{entries.length ? <ul>{entries.map((entry, index) => <li key={index}><button className="cell-link" onClick={() => reveal(entry.address ?? entry.ref ?? entry.node?.split('!').pop() ?? '', entry.sheet)}>{entry.node ?? `${entry.sheet}!${entry.address ?? entry.ref}`}</button></li>)}</ul> : <p className="quiet">No direct inputs reported. Check coverage before drawing conclusions.</p>}{trace.length > 0 && <><h4>Upstream calculation path</h4><ol className="trace-chain">{trace.map((item, index) => <li key={index}><span>{item.node}</span><code>{item.formula ? `=${item.formula.replace(/^=/, '')}` : String(item.value ?? 'No cached value')}</code></li>)}</ol></>}<details><summary>Dependency evidence</summary><pre>{JSON.stringify({ precedents: result.precedents, dependents: result.dependents, target: result.target, trace: result.trace }, null, 2)}</pre></details></div>;
}
