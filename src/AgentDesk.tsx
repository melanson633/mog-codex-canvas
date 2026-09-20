import { useEffect, useRef, useState } from 'react';

interface Note { id: string; name: string; scope: 'workbook' | 'sheet' | 'range'; sheet?: string; range?: string; text: string }
interface Job { id: string; noteId: string; status: string; error?: string; revision?: string; warnings?: string[]; applyResult?: { transactionId?: string; screenshots?: { name: string }[]; validation?: unknown }; result?: { answer: string; changes: { sheet: string; address: string; value: string | number | boolean | null; formula: string | null }[] } }
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent-tasks${path}`, body === undefined ? { signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error ?? 'Unable to complete this task.');
  return data;
}
export function AgentDesk({ name, sheet, range, dirty, onApplied, onWorking, onApplying, canApply }: { name: string; sheet: string; range: string; dirty: boolean; onApplied: () => void; onWorking: (busy: boolean) => void; onApplying: (busy: boolean) => void; canApply: () => boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<Note['scope']>('range');
  const [targetSheet, setTargetSheet] = useState(sheet);
  const [targetRange, setTargetRange] = useState(range);
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [pollError, setPollError] = useState('');
  const [notice, setNotice] = useState('');
  const [applyStalled, setApplyStalled] = useState<string>();
  const pollAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => { if (!editing) { setTargetSheet(sheet); setTargetRange(range); } }, [sheet, range, editing]);
  async function refresh() {
    const state = await api<{ notes: Note[]; jobs: Job[] }>(`?name=${encodeURIComponent(name)}`);
    setNotes(state.notes); setJobs(state.jobs);
  }
  useEffect(() => {
    if (!name) return;
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      pollAbort.current = controller;
      try {
        const state = await api<{ notes: Note[]; jobs: Job[] }>(`?name=${encodeURIComponent(name)}`, undefined, controller.signal);
        if (active) { setNotes(state.notes); setJobs(state.jobs); setPollError(''); }
      } catch (err) {
        if (active && (err as Error).name !== 'AbortError') setPollError((err as Error).message);
      } finally {
        inFlight = false;
        if (pollAbort.current === controller) pollAbort.current = undefined;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { active = false; clearInterval(timer); pollAbort.current?.abort(); };
  }, [name]);
  useEffect(() => { onWorking(jobs.some(job => ['queued', 'running', 'applying'].includes(job.status))); }, [jobs, onWorking]);
  async function action(operation: () => Promise<void>) {
    setBusy(true); setActionError('');
    try { await operation(); await refresh(); } catch (err) { setActionError((err as Error).message); } finally { setBusy(false); }
  }
  async function save(run: boolean) {
    await action(async () => {
      const note = await api<Note>('/notes', { id: editing, name, scope, ...(scope !== 'workbook' ? { sheet: targetSheet } : {}), ...(scope === 'range' ? { range: targetRange } : {}), text });
      setEditing(note.id);
      if (run) await api('/run', { noteId: note.id });
      setNotice(run ? 'Task queued. You can keep working in another workbook.' : 'Note saved on this computer.');
    });
  }
  async function selection() {
    try {
      const response = await fetch(`/api/context?path=${encodeURIComponent(name)}`); const { context } = await response.json();
      if (!context?.selection || !context.activeSheet) throw new Error('Select cells in the canvas first.');
      setScope('range'); setTargetSheet(context.activeSheet); setTargetRange(context.selection);
    } catch (err) { setActionError((err as Error).message); }
  }
  function downloadArchive(receipt: { name?: string; jobs?: unknown }) {
    if (!receipt.jobs) return;
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = receipt.name || 'mog-agent-archive.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }
  async function archiveFinished() {
    await action(async () => {
      const receipt = await api<{ archive?: { name?: string }; archivedCount?: number; jobs?: unknown }>('/archive', { name });
      const receiptName = receipt.archive?.name || 'local archive';
      downloadArchive({ name: receiptName, jobs: receipt.jobs });
      setNotice(`Archived ${receipt.archivedCount ?? 0} completed request${receipt.archivedCount === 1 ? '' : 's'} as ${receiptName}.`);
    });
  }
  async function apply(jobId: string) {
    await action(async () => {
      if (!canApply()) throw new Error('Save your latest canvas edits before applying changes.');
      onApplying(true);
      const timer = window.setTimeout(() => setApplyStalled(jobId), 15_000);
      try { await api('/apply', { jobId }); onApplied(); setNotice('Changes saved.'); }
      finally { window.clearTimeout(timer); setApplyStalled(undefined); onApplying(false); }
    });
  }
  if (!name) return null;
  const activeJobs = jobs.some(job => ['queued', 'running', 'applying'].includes(job.status));
  const completedJobs = jobs.some(job => !['queued', 'running', 'applying'].includes(job.status));
  return <details className="agent-desk" data-testid="agent-desk"><summary><span className="eyebrow">AGENT TASKS</span><strong>Notes & requests</strong><span>{pollError ? 'Connection issue' : activeJobs ? 'Working...'  : `${notes.length} saved notes`}</span></summary><h3>Leave a note. Put it to work.</h3>
    <label>Attach to<select value={scope} onChange={event => setScope(event.target.value as Note['scope'])}><option value="range">Selected cells</option><option value="sheet">A sheet</option><option value="workbook">This workbook</option></select></label>
    {scope !== 'workbook' && <label>Task sheet<input value={targetSheet} onChange={event => setTargetSheet(event.target.value)} /></label>}
    {scope === 'range' && <div className="form-row"><label>Task range<input value={targetRange} onChange={event => setTargetRange(event.target.value)} /></label><button onClick={selection}>Use selected cells</button></div>}
    <label>Instructions<textarea rows={4} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder="Explain these numbers, check an assumption, or propose a change…" /></label>
    <p className="field-help">Save keeps your note here. Run sends the note and the saved cells in this scope to your signed-in Claude account. Answers need review; proposed edits wait for Apply. Sheet and workbook tasks read A1:T25 (first four sheets for workbooks). Select a cell range for another area.</p>
    {dirty && <p className="warning">Save the canvas first to include your latest edits.</p>}
    <div className="agent-actions"><button disabled={busy || !text.trim()} onClick={() => void save(false)}>Save note</button><button className="primary" disabled={busy || dirty || !text.trim()} onClick={() => void save(true)}>Save & run</button>{editing && <button disabled={busy} onClick={() => { setEditing(undefined); setText(''); }}>New note</button>}</div>
    {pollError && <p role="alert" className="failure">Connection issue: {pollError}</p>}{actionError && <p role="alert" className="failure">{actionError}</p>}<p className="quiet" role="status">{notice}</p>
    {completedJobs && <div className="agent-archive"><button data-testid="archive-finished-requests" disabled={busy} onClick={() => void archiveFinished()}>Archive finished requests</button><p className="field-help">Keeps notes. Moves finished answers and unapplied proposals into a local archive.</p></div>}
    <div className="saved-notes">{notes.map(note => <article key={note.id} className="saved-note"><div className="note-heading"><strong>{note.scope === 'workbook' ? 'Workbook' : `${note.sheet}${note.range ? `!${note.range}` : ''}`}</strong><button disabled={busy} onClick={() => { setEditing(note.id); setText(note.text); setScope(note.scope); setTargetSheet(note.sheet ?? sheet); setTargetRange(note.range ?? range); }}>Edit note</button></div><p className="note-text">{note.text}</p><button disabled={busy || dirty} onClick={() => void action(async () => { await api('/run', { noteId: note.id }); })}>Run again</button>
      {jobs.filter(job => job.noteId === note.id).slice().reverse().map(job => <div key={job.id} className="agent-job" data-status={job.status}><div className="note-heading"><strong>{job.status === 'completed' ? 'Ready for review' : job.status === 'applied' ? 'Changes saved' : job.status}</strong>{['queued', 'running'].includes(job.status) && <button disabled={busy} onClick={() => void action(async () => { await api('/cancel', { jobId: job.id }); })}>Cancel</button>}</div>
        {job.warnings?.map((warning, index) => <p key={index} className="warning">{warning}</p>)}{job.applyResult && <details><summary>Save receipt and verification</summary><pre>{JSON.stringify(job.applyResult, null, 2)}</pre></details>}{job.error && <p className="warning">{job.error}</p>}{job.result && <><p className="agent-answer">{job.result.answer}</p>{job.result.changes.length > 0 && <details><summary>Preview {job.result.changes.length} proposed changes</summary><div className="table-scroll"><table><thead><tr><th>Cell</th><th>Proposed content</th></tr></thead><tbody>{job.result.changes.map((change, index) => <tr key={index}><td>{change.sheet}!{change.address}</td><td>{change.formula ?? String(change.value ?? '(clear)')}</td></tr>)}</tbody></table></div>{job.status === 'completed' && <button className="primary" disabled={busy || dirty} onClick={() => void apply(job.id)}>Apply these changes</button>}</details>}</>}{applyStalled === job.id && <p className="field-help">Still saving. You can work in another workbook.</p>}
        {job.revision && <p className="field-help">Saved revision {job.revision.slice(0, 12)}</p>}
      </div>)}
    </article>)}</div>
  </details>;
}
