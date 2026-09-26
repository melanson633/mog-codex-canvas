import { useCallback, useState } from 'react';
import { AnalystWorkspace } from './AnalystWorkspace';

type Desk = { id: number; name: string; dirty: boolean; busy: boolean };
export function ParallelWorkbench() {
  const [desks, setDesks] = useState<Desk[]>([{ id: 1, name: new URLSearchParams(location.search).get('wb') ?? '', dirty: false, busy: false }]);
  const [active, setActive] = useState(1);
  const [notice, setNotice] = useState('');
  const open = useCallback((name: string) => {
    setDesks(previous => {
      const existing = previous.find(desk => desk.name.toLowerCase() === name.toLowerCase());
      if (existing) { setActive(existing.id); return previous; }
      if (previous.length >= 4) { setNotice('Four workbooks are open. Close a tab before opening another.'); return previous; }
      const id = Math.max(...previous.map(desk => desk.id), 0) + 1;
      setActive(id); setNotice('');
      return [...previous, { id, name, dirty: false, busy: false }];
    });
  }, []);
  const status = useCallback((id: number, name: string, dirty: boolean, busy: boolean) => {
    setDesks(previous => {
      const current = previous.find(desk => desk.id === id);
      if (!current || (current.name === name && current.dirty === dirty && current.busy === busy)) return previous;
      return previous.map(desk => desk.id === id ? { ...desk, name, dirty, busy } : desk);
    });
  }, []);
  function close(desk: Desk) {
    if (desk.dirty || (document.querySelector(`#desk-panel-${desk.id} iframe`) as HTMLIFrameElement | null)?.contentDocument?.querySelector('.dot.dirty')) { setNotice(`Save ${desk.name} in its canvas before closing it. Your edits are still open.`); return; }
    if (!window.confirm(`Close ${desk.name || 'this desk'}? Unexported notebook results and unsaved note drafts will be lost. Saved agent tasks keep running.`)) return;
    const remaining = desks.filter(item => item.id !== desk.id);
    setDesks(remaining.length ? remaining : [{ id: desk.id + 1, name: '', dirty: false, busy: false }]);
    if (active === desk.id) setActive(remaining[0]?.id ?? desk.id + 1);
    setNotice('');
  }
  return <div className="parallel-workbench">
    <nav className="workbook-tabs" aria-label="Open workbooks"><div role="tablist">{desks.map(desk => <div className="workbook-tab" key={desk.id}>
      <button role="tab" id={`desk-tab-${desk.id}`} aria-controls={`desk-panel-${desk.id}`} aria-selected={active === desk.id} onClick={() => setActive(desk.id)}>{desk.name || 'Start here'}{desk.dirty ? ' • Unsaved' : desk.busy ? ' · Working' : ''}</button>
      <button aria-label={`Close ${desk.name || 'desk'}`} onClick={() => close(desk)}>×</button>
    </div>)}</div><span>Up to 4 workbooks · tasks continue in the background</span></nav>
    {notice && <div className="workspace-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
    {desks.map(desk => <div key={desk.id} role="tabpanel" id={`desk-panel-${desk.id}`} aria-labelledby={`desk-tab-${desk.id}`} hidden={active !== desk.id}><DeskView desk={desk} availableSlots={4 - desks.length} onOpen={open} onStatus={status} /></div>)}
  </div>;
}

function DeskView({ desk, availableSlots, onOpen, onStatus }: { desk: Desk; availableSlots: number; onOpen: (name: string) => void; onStatus: (id: number, name: string, dirty: boolean, busy: boolean) => void }) {
  const report = useCallback((name: string, dirty: boolean, busy: boolean) => onStatus(desk.id, name, dirty, busy), [desk.id, onStatus]);
  return <AnalystWorkspace initialFile={desk.name} availableSlots={availableSlots} onOpen={onOpen} onStatus={report} />;
}
