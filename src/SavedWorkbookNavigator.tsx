import { useEffect, useRef, useState } from 'react';
import type { ProfileShape } from './api';
import './saved-navigator.css';

interface SavedCell { address: string; value: string | number | boolean | null; formula: string | null; isError?: boolean; formulaStatus?: string }
interface SavedPage { revision: string; sheet: string; range: string; cells: SavedCell[]; limitations?: string[]; truncated?: boolean }
export function SavedWorkbookNavigator({ name, profile }: { name: string; profile: ProfileShape }) {
  const [sheet, setSheet] = useState(profile.sheets[0]?.name ?? '');
  const [range, setRange] = useState('A1:L25');
  const [page, setPage] = useState<SavedPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  const sequence = useRef(0);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const id = ++sequence.current;
    const controller = new AbortController();
    setLoading(true); setError(''); setPage(undefined);
    fetch(`/api/workbook-page?path=${encodeURIComponent(name)}&sheet=${encodeURIComponent(sheet)}&range=${encodeURIComponent(range)}`, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.error ?? 'Unable to read this range.');
      if (sequence.current === id) setPage(data);
    }).catch(cause => { if (sequence.current === id && cause.name !== 'AbortError') setError(cause.message); })
      .finally(() => { if (sequence.current === id) setLoading(false); });
    return () => controller.abort();
  }, [name, sheet, request]);
  useEffect(() => {
    function reveal(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'mog:reveal' || event.data.workbook !== name) return;
      const nextSheet = event.data.sheet ?? sheet;
      if (typeof event.data.range !== 'string' || !/^[A-Za-z]{1,3}[1-9]\d*(?::[A-Za-z]{1,3}[1-9]\d*)?$/.test(event.data.range) || !profile.sheets.some(item => item.name === nextSheet)) {
        parent.postMessage({ type: 'mog:reveal-result', id: event.data.id, status: 'failed' }, location.origin); return;
      }
      setSheet(nextSheet); setRange(event.data.range); setRequest(value => value + 1);
      // Navigation is acknowledged only after the requested saved page arrives.
      pendingReveal.current = event.data.id;
    }
    window.addEventListener('message', reveal);
    return () => window.removeEventListener('message', reveal);
  }, [name, sheet, profile.sheets]);
  const pendingReveal = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pendingReveal.current && (page || error)) {
      parent.postMessage({ type: 'mog:reveal-result', id: pendingReveal.current, status: page ? 'applied' : 'failed' }, location.origin);
      pendingReveal.current = undefined;
    }
  }, [page, error]);
  function select(address: string) {
    setSelected(address);
    parent.postMessage({ type: 'mog:navigator-selection', workbook: name, sheet, range: address }, location.origin);
  }
  function move(direction: number) {
    const match = range.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
    if (!match) { setRange('A1:L25'); setRequest(value => value + 1); return; }
    const height = Number(match[4]) - Number(match[2]) + 1;
    const start = Math.max(1, Math.min(1048576 - height + 1, Number(match[2]) + direction * height));
    setRange(`${match[1]}${start}:${match[3]}${start + height - 1}`); setRequest(value => value + 1);
  }
  return <section className="saved-navigator" data-testid="saved-workbook-navigator" aria-label="Saved workbook navigator">
    <header><span className="navigator-label">LARGE WORKBOOK · SAVED VIEW</span><h2>Explore the model, one range at a time.</h2><p>{profile.sheets.length} sheets · {profile.cells.toLocaleString()} cells · {profile.formulas.toLocaleString()} formulas. This view reads the saved file without loading its calculation engine.</p></header>
    <form className="navigator-controls" onSubmit={event => { event.preventDefault(); setRequest(value => value + 1); }}>
      <label>Worksheet<select value={sheet} onChange={event => { setSheet(event.target.value); setRange('A1:L25'); }}>{profile.sheets.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
      <label>Cell or range<input value={range} onChange={event => setRange(event.target.value)} maxLength={40} placeholder="A1:L25" required /></label><button type="submit" disabled={loading}>Show range</button>
    </form>
    <div className="navigator-actions"><button onClick={() => move(-1)} disabled={loading}>Previous rows</button><button onClick={() => move(1)} disabled={loading}>Next rows</button><button onClick={() => setRequest(value => value + 1)} disabled={loading}>Refresh saved values</button><a href={`/api/workbook?path=${encodeURIComponent(name)}`} download={name}>Download for Excel</a></div>
    <p className="navigator-help">Read-only values and formulas from the last save. No recalculation. Select a cell to discuss it in the Review Desk. Use Excel for full-model editing and recalculation, then reopen the updated file.</p>
    {loading && <p role="status">Reading {sheet}!{range}…</p>}{error && <p role="alert">{error}</p>}
    {page && <><div className="navigator-page-heading"><strong>{page.sheet}!{page.range}</strong><span>Saved revision {page.revision.slice(0, 12)} · {page.cells.length} populated cells</span></div><div className="navigator-table-wrap"><table><thead><tr><th>Cell</th><th>Saved value</th><th>Formula / source</th></tr></thead><tbody>{page.cells.map(cell => <tr key={cell.address} aria-selected={selected === cell.address}><td><button onClick={() => select(cell.address)}>{cell.address}</button></td><td className={cell.isError ? 'saved-error' : ''}>{cell.value === null ? 'No saved value' : String(cell.value)}</td><td><code>{cell.formula ? `=${cell.formula.replace(/^=/, '')}` : cell.formulaStatus === 'shared-unexpanded' ? 'Shared formula (see Excel)' : 'Stored value'}</code></td></tr>)}</tbody></table></div>{!page.cells.length && <p>No populated cells in this range. Choose another range or worksheet.</p>}{page.limitations?.map((item, index) => <p className="navigator-help" key={index}>{item}</p>)}</>}
  </section>;
}
