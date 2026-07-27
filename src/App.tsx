import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConfig,
  readWorkbook,
  validateWorkbook,
  writeScreenshot,
  writeWorkbook,
  type BridgeConfig,
  type ValidationReport,
} from './api';
import { resolveCanvasAdapter, type AdapterProbe, type CanvasSession } from './adapters';

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<CanvasSession | null>(null);

  const [probe, setProbe] = useState<AdapterProbe | null>(null);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [status, setStatus] = useState('starting');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getConfig()
      .then((next) => {
        setConfig(next);
        // ?wb=<name> pins the initial workbook (used by compare.html panes).
        const wanted = new URLSearchParams(window.location.search).get('wb');
        const pinned = wanted && next.files.some((f) => f.name === wanted) ? wanted : null;
        setFile((current) => current ?? pinned ?? next.files[0]?.name ?? null);
        if (next.files.length === 0) setStatus('no workbooks found');
      })
      .catch((cause) => setError(String(cause)));
  }, []);

  // Open the selected workbook in the canvas. The generation guard keeps a slow
  // open from overwriting a newer one when the selection changes mid-load.
  useEffect(() => {
    if (!file) return;
    let stale = false;
    const container = canvasRef.current;
    if (!container) return;

    setError(null);
    setReport(null);
    setDirty(false);
    setStatus('loading workbook');

    void (async () => {
      const previous = sessionRef.current;
      sessionRef.current = null;
      await previous?.dispose().catch(() => undefined);

      try {
        const adapter = await resolveCanvasAdapter();
        if (stale) return;
        setProbe(adapter.probe);

        const { bytes, revision } = await readWorkbook(file);
        if (stale) return;

        // The revision this canvas last saw on disk. Saves send it as the
        // expected base; a concurrent writer makes the save fail with a 409
        // instead of silently overwriting their work.
        let baseRevision = revision;

        const session = await adapter.open(
          container,
          { fileName: file, bytes, colorScheme: 'system' },
          {
            persist: async (nextBytes) => {
              const saved = await writeWorkbook(file, nextBytes, baseRevision);
              baseRevision = saved.versionId;
              return saved;
            },
            onDirtyChange: setDirty,
            onStatus: setStatus,
            onError: (cause) =>
              setError(cause instanceof Error ? cause.message : JSON.stringify(cause)),
          },
        );
        if (stale) {
          await session.dispose();
          return;
        }
        sessionRef.current = session;
      } catch (cause) {
        if (!stale) {
          setStatus('failed');
          setError(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
        }
      }
    })();

    return () => {
      stale = true;
    };
  }, [file]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setStatus(`${label} failed`);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const onSave = () =>
    run('save', async () => {
      await sessionRef.current?.save();
      setStatus('saved to disk');
    });

  const onVerify = () =>
    run('verify', async () => {
      if (!file) return;
      setStatus('verifying saved file');
      setReport(await validateWorkbook(file));
      setStatus('verified');
    });

  const onScreenshot = () =>
    run('screenshot', async () => {
      const session = sessionRef.current;
      if (!session || !file) return;
      setStatus('capturing screenshot');
      const png = await session.screenshot('A1:H30');
      const target = `${file.replace(/\.xlsx$/i, '')}.png`;
      await writeScreenshot(target, png);
      setStatus(`screenshot written: ${target}`);
    });

  const canEdit = probe?.capabilities.liveCanvas ?? false;
  // ?compact=1 slims the chrome for multi-pane embedding (compare.html).
  const compact = new URLSearchParams(window.location.search).get('compact') === '1';

  return (
    <div className={compact ? 'app compact' : 'app'}>
      <header className="bar">
        <div className="bar-row">
          <select
            className="picker"
            value={file ?? ''}
            onChange={(event) => setFile(event.target.value || null)}
            disabled={!config || config.files.length === 0}
          >
            {config?.files.length === 0 && <option value="">no .xlsx in workbook root</option>}
            {config?.files.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
          <span className={dirty ? 'dot dirty' : 'dot'} title={dirty ? 'unsaved changes' : 'clean'} />
        </div>

        <div className="bar-row">
          <button onClick={onSave} disabled={busy || !canEdit}>
            Save
          </button>
          <button onClick={onVerify} disabled={busy || !file}>
            Verify
          </button>
          <button onClick={onScreenshot} disabled={busy || !canEdit}>
            Screenshot
          </button>
        </div>

        <div className="meta">
          <span className={probe?.available ? 'badge ok' : 'badge warn'}>
            {probe ? probe.label : 'resolving adapter…'}
          </span>
          <span className="status">{status}</span>
        </div>
      </header>

      {error && <pre className="error">{error}</pre>}

      <div className="canvas" ref={canvasRef} />

      {report && (
        <section className="report">
          <div className="report-head">
            <strong>Headless read-back</strong>
            <span>
              {report.bytes.toLocaleString()} bytes · {report.sheetNames.length} sheet(s)
            </span>
            <button onClick={() => setReport(null)}>close</button>
          </div>
          {report.sheets.map((sheet) => (
            <pre key={sheet.name}>{sheet.summary}</pre>
          ))}
        </section>
      )}

      <footer className="foot">
        <span>{config ? config.root : '…'}</span>
        {probe && !probe.available && <span className="warn-text">{probe.detail}</span>}
      </footer>
    </div>
  );
}
