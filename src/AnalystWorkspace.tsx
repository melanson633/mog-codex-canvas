import { useEffect, useRef, useState } from 'react';

type Action = 'context' | 'explain' | 'audit' | 'reconcile' | 'scenario';
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
  const requestId = useRef(0);
  const current = modes.find(item => item.id === mode)!;

  async function refreshFiles() {
    const config = await request<{ files: { name: string }[] }>('/api/config');
    setFiles(config.files.map(item => item.name));
  }
  useEffect(() => { void refreshFiles().catch(err => setError(String(err.message))); }, []);
  useEffect(() => {
    let active = true;
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

  function change(setter: (value: string) => void, value: string) { setter(value); setResult(null); setError(''); requestId.current++; }
  async function loadExample() {
    if (dirty) { setError('Save your canvas changes before opening the example.'); return; }
    setBusy(true); setError('');
    try {
      const data = await request<{ name: string }>('/api/analyst/example', {});
      await refreshFiles(); setFile(data.name); setSheet('Model'); setRange('A1:D20'); setAddress('B8');
      setLeft('B11:B13'); setRight('D11:D13'); setInput('B3'); setValues('0, 0.1, 0.2'); setOutputs('B8');
      setMode('context'); setResult(null); setExample(true); setNotice('Synthetic example ready. Start with Inspect, then try each review tool.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function useSelection() {
    const id = ++requestId.current;
    try {
      const data = await request<{ context: { activeSheet: string | null; selection: string | null } | null }>(`/api/context?path=${encodeURIComponent(file)}`);
      if (id !== requestId.current) return;
      if (!data.context?.selection || !data.context.activeSheet) throw new Error('Select a cell or range in the spreadsheet first.');
      setSheet(data.context.activeSheet);
      if (mode === 'scenario') setInput(data.context.selection.split(':')[0]);
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
      const fields = mode === 'explain' ? { address } : mode === 'reconcile' ? { left, right, tolerance: Number(tolerance), blankPolicy: 'reject' }
        : mode === 'scenario' ? { input, values: values.split(',').map(value => value.trim() === '' ? NaN : Number(value)), outputs: outputs.split(',').map(value => value.trim()) } : { range };
      if (mode === 'scenario' && (fields.values as number[]).some(value => !Number.isFinite(value))) throw new Error('Enter finite numbers separated by commas.');
      if (mode === 'reconcile' && (!tolerance.trim() || !Number.isFinite(Number(tolerance)))) throw new Error('Enter a finite tolerance.');
      const data = await request<Result>('/api/analyst', { action: mode, name: file, sheet, ...fields });
      if (id === requestId.current) setResult(data);
    } catch (err) { if (id === requestId.current) setError((err as Error).message); } finally { setBusy(false); }
  }
  async function reveal(cell: string, targetSheet = sheet) {
    try { await request(`/api/context/reveal?path=${encodeURIComponent(file)}`, { range: cell, sheet: targetSheet }); setNotice(`Showing ${targetSheet}!${cell}`); }
    catch (err) { setError((err as Error).message); }
  }
  function downloadEvidence() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `mog-${result.action}-evidence.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="workbench">
    <header className="workbench-header"><a className="wordmark" href="/analyst.html">mog<span> / </span><span>financial workbench</span></a><span className="local-label"><i />Local workspace</span></header>
    <div className="workbook-bar"><div><label htmlFor="workbook">WORKBOOK</label><select id="workbook" value={file} disabled={busy || dirty} onChange={event => { requestId.current++; setFile(event.target.value); setExample(false); }}><option value="">Choose a workbook</option>{files.map(name => <option key={name}>{name}</option>)}</select></div><div className="workbook-actions"><button onClick={loadExample} disabled={busy} data-testid="load-example">Open financial example</button>{file && <a href={`/index.html?wb=${encodeURIComponent(file)}`} target="_blank" rel="noreferrer">Open full canvas ↗</a>}</div></div>
    <main className="workbench-body">
      <section className="sheet-stage" aria-label="Live spreadsheet">
        <div className="stage-caption"><span>WORKING PAPER</span><span>{file ? 'Live Mog canvas · human edits' : 'Your model, with the evidence beside it'}</span></div>
        {file ? <iframe title="Live workbook canvas" key={file} src={`/index.html?wb=${encodeURIComponent(file)}&compact=1&embedded=1`} /> : <div className="empty-workbook"><span className="eyebrow">FROM MODEL TO ANSWER</span><h1>Understand the number.<br />Test the assumption.</h1><p>Trace a formula, review a model, reconcile a balance, and explore scenarios alongside the real spreadsheet.</p><button className="primary" onClick={loadExample} disabled={busy}>Try the financial example</button><p className="quiet">Generated financial data. All workbook analysis stays on this computer.</p></div>}
        <div className="stage-footer"><span>{dirty ? 'Unsaved edits in canvas — save before analyzing' : 'Analysis reads the saved workbook'}</span><span>Scenarios never save</span></div>
      </section>
      <aside className="analysis-panel" aria-label="Analysis tools">
        <div className="panel-intro"><span className="eyebrow">REVIEW DESK</span><h2>Follow the evidence</h2><p>Exact cells. Explicit assumptions. Reproducible results.</p></div>
        <nav className="mode-tabs" aria-label="Analysis mode">{modes.map(item => <button key={item.id} aria-current={mode === item.id ? 'page' : undefined} onClick={() => { setMode(item.id); setResult(null); setError(''); requestId.current++; }} disabled={busy}>{item.label}</button>)}</nav>
        <div className="analysis-content"><p className="mode-description">{current.description}</p>
          {example && <div className="example-note"><strong>Example guide</strong><span>{mode === 'scenario' ? 'Growth of 0%, 10%, 20% → EBITDA 300,000 / 360,000 / 420,000.' : mode === 'reconcile' ? 'Assets and funding both total 1,000,000.' : mode === 'audit' ? 'D19 intentionally uses addition where its peers use multiplication. This is a review exercise.' : mode === 'explain' ? 'B8 = gross profit less operating costs. Expected EBITDA: 360,000.' : 'Inspect the saved model, then follow B8 through Explain.'}</span></div>}
          <form onSubmit={run}><fieldset disabled={busy || !file}><div className="form-row"><label>Sheet<select value={sheet} onChange={event => change(setSheet, event.target.value)}>{sheets.map(name => <option key={name}>{name}</option>)}</select></label><button className="selection-button" type="button" onClick={useSelection}>Use selection</button></div>
            {(mode === 'context' || mode === 'audit') && <label>Range<input value={range} onChange={event => change(setRange, event.target.value)} required placeholder="A1:D19" /></label>}
            {mode === 'explain' && <label>Output cell<input value={address} onChange={event => change(setAddress, event.target.value)} required placeholder="B8" /></label>}
            {mode === 'reconcile' && <><div className="form-row"><label>Left range<input value={left} onChange={event => change(setLeft, event.target.value)} required /></label><label>Right range<input value={right} onChange={event => change(setRight, event.target.value)} required /></label></div><label>Absolute tolerance<input type="number" min="0" step="any" value={tolerance} onChange={event => change(setTolerance, event.target.value)} required /></label><p className="field-help">Blank cells are rejected. Saved numeric values are compared.</p></>}
            {mode === 'scenario' && <><label>Numeric input cell<input value={input} onChange={event => change(setInput, event.target.value)} required /></label><label>Assumptions <span>(up to 9, comma separated)</span><input value={values} onChange={event => change(setValues, event.target.value)} required /></label><label>Output cells <span>(up to 6, comma separated)</span><input value={outputs} onChange={event => change(setOutputs, event.target.value)} required /></label><p className="field-help">Use decimals for percentages: 0.1 means 10%.</p></>}
            <button className="primary run-button" type="submit" data-testid="run-analysis">{busy ? 'Working…' : mode === 'scenario' ? 'Calculate scenarios' : mode === 'reconcile' ? 'Run tie-out' : `${current.label} saved model`}</button>
          </fieldset></form>
          {dirty && <p className="warning">These results exclude unsaved canvas changes.</p>}
          {error && <div className="failure" role="alert"><strong>Unable to complete analysis</strong><p>{error}</p></div>}
          <div aria-live="polite" className="quiet notice">{busy ? 'Reading the saved revision…' : notice}</div>
          {result && <section className="analysis-result" data-testid="analysis-result"><div className="result-heading"><h3>{result.action === 'reconcile' ? (result.status === 'balanced' ? 'Balances agree' : 'Difference to investigate') : result.action === 'scenario' ? 'Scenario results' : result.action === 'audit' ? 'Review findings' : result.action === 'explain' ? 'Calculation trail' : 'Saved range context'}</h3><span className="timing">{number(result.elapsedMs)} ms{result.cache?.hit ? ' · reused index' : ''}</span></div>
            {result.status !== 'ok' && result.status !== 'calculated' && result.status !== 'balanced' && result.status !== 'difference' && <p className="warning">{result.status}: {String(result.reason ?? result.provenance ?? 'Inspect coverage below.')}</p>}
            {result.action === 'reconcile' && result.left && result.right && <><div className="tieout-values"><div><span>{result.left.range}</span><strong>{number(result.left.sum)}</strong></div><div><span>{result.right.range}</span><strong>{number(result.right.sum)}</strong></div></div><p className={result.status === 'balanced' ? 'success' : 'warning'}>Difference {number(result.difference ?? 0)} · tolerance {number(result.tolerance ?? 0)}</p></>}
            {result.cases && <div className="table-scroll"><table><thead><tr><th>{result.input}</th>{result.outputs?.map(cell => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{result.cases.map((item, index) => <tr key={index}><td>{number(item.input)}</td>{result.outputs?.map(cell => <td key={cell}>{number(item.outputs[cell])}</td>)}</tr>)}</tbody></table></div>}
            {result.cells && <div className="table-scroll"><table><thead><tr><th>Cell</th><th>Saved value / formula</th></tr></thead><tbody>{result.cells.map(cell => <tr key={cell.address}><td><button className="cell-link" onClick={() => reveal(cell.address)}>{cell.address}</button></td><td>{String(cell.value ?? '—')}{cell.formula && <code>{cell.formula}</code>}</td></tr>)}</tbody></table></div>}
            {result.status === 'ok' && result.findings && (result.findings.length ? <ul className="findings">{result.findings.map((finding, index) => <li key={index}><strong>{finding.address && <button className="cell-link" onClick={() => reveal(finding.address!)}>{finding.address}</button>} {finding.kind.replaceAll('-', ' ')}</strong><p>{finding.message ?? String(finding.reason ?? '')}</p><details><summary>Finding evidence</summary><pre>{JSON.stringify(finding, null, 2)}</pre></details></li>)}</ul> : <p className="success">No review signals found in this bounded scan. This is not a correctness certificate.</p>)}
            {result.action === 'explain' && <Trace result={result} reveal={reveal} />}
            {result.coverage && <div className="coverage"><strong>{result.coverage.complete ? 'Requested scope examined' : 'Coverage is limited'}</strong>{result.coverage.limitations.map((item, index) => <p key={index}>{item}</p>)}</div>}
            <div className="evidence-footer"><span title={result.revision}>Saved revision {result.revision?.slice(0, 12)}</span><button onClick={downloadEvidence}>Export evidence ↓</button></div><details className="raw-evidence"><summary>Full result and provenance</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
          </section>}
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
