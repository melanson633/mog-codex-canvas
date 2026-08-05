import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearContext,
  fetchCanvasCommands,
  getConfig,
  readWorkbook,
  reportContext,
  validateWorkbook,
  writeScreenshot,
  writeWorkbook,
  type BridgeConfig,
  type ContextSnapshot,
  type FidelityReport,
  type ValidationReport,
} from './api';
import { resolveCanvasAdapter, type AdapterProbe, type CanvasSession } from './adapters';

/** How often coalesced presence reports leave the app, and commands are polled. */
const CONTEXT_THROTTLE_MS = 300;
const COMMAND_POLL_MS = 1500;

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
  const [fidelity, setFidelity] = useState<FidelityReport | null>(null);
  // Non-null while presence coordination is unhealthy: agents cannot see where
  // the human is, so the occupied-cell interlock is running blind.
  const [coordWarning, setCoordWarning] = useState<string | null>(null);
  // The workbook/epoch whose context this app currently owns on the bus. The
  // next open awaits its teardown before starting, so switching from A to B
  // can never leave A's presence behind.
  const contextOwnerRef = useRef<{ file: string; epoch: number } | null>(null);

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
    setFidelity(null);
    setCoordWarning(null);
    setStatus('loading workbook');

    // Coalesced presence reporting: only the newest snapshot leaves the app,
    // at most once per throttle window. The bus keeps latest-state-only, so
    // dropped intermediate snapshots lose nothing.
    let pending: ContextSnapshot | null = null;
    let lastEpoch: number | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushContext = () => {
      flushTimer = null;
      if (!pending) return;
      const snapshot = pending;
      pending = null;
      lastEpoch = snapshot.epoch;
      contextOwnerRef.current = { file, epoch: snapshot.epoch };
      void reportContext(file, snapshot).then(
        (result) => {
          if (stale) return;
          // A rejected report means the bus holds someone else's (or a newer)
          // presence — agents are coordinating against state this canvas does
          // not own. Surface it; never silently drop it.
          setCoordWarning(
            result.accepted
              ? null
              : `Presence not accepted by the context bus: ${result.reason ?? 'rejected'}`,
          );
        },
        (cause) => {
          if (stale) return;
          setCoordWarning(
            `Presence reporting failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        },
      );
    };

    let pollTimer: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      const previous = sessionRef.current;
      sessionRef.current = null;
      await previous?.dispose().catch(() => undefined);

      // Tear down the previous workbook's presence before this one comes up:
      // switching A -> B must not leave A's occupied cell live on the bus for
      // agents to coordinate against.
      const owned = contextOwnerRef.current;
      if (owned && owned.file !== file) {
        contextOwnerRef.current = null;
        await clearContext(owned.file, owned.epoch).catch(() => undefined);
      }

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
              try {
                const saved = await writeWorkbook(file, nextBytes, baseRevision);
                baseRevision = saved.versionId;
                if (saved.fidelity) setFidelity(saved.fidelity);
                return saved;
              } catch (cause) {
                // A refused save must replace any stale "passed" in the footer:
                // show the refusal's own fidelity report, or nothing — never
                // the verdict of a save that no longer describes the attempt.
                const details = (cause as { details?: { fidelity?: FidelityReport } }).details;
                setFidelity(details?.fidelity ?? null);
                throw cause;
              }
            },
            onDirtyChange: setDirty,
            onStatus: setStatus,
            onError: (cause) =>
              setError(cause instanceof Error ? cause.message : JSON.stringify(cause)),
            onContext: (snapshot) => {
              if (stale) return;
              pending = snapshot;
              flushTimer ??= setTimeout(flushContext, CONTEXT_THROTTLE_MS);
            },
          },
        );
        if (stale) {
          await session.dispose();
          return;
        }
        sessionRef.current = session;

        // Navigation-only command channel: reveal requests queued by agents.
        pollTimer = setInterval(() => {
          void fetchCanvasCommands(file)
            .then(async (commands) => {
              const live = sessionRef.current;
              if (stale || !live?.reveal || commands.length === 0) return;
              // Only the newest reveal matters — intermediate ones are history.
              const last = commands[commands.length - 1];
              await live.reveal(last.range, last.sheet);
            })
            .catch(() => undefined);
        }, COMMAND_POLL_MS);
      } catch (cause) {
        if (!stale) {
          setStatus('failed');
          setError(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
        }
      }
    })();

    return () => {
      stale = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (pollTimer) clearInterval(pollTimer);
      // Teardown ends this canvas's presence — a newer epoch survives the call.
      // (A file switch also awaits this clear inside the next effect run, so
      // B never opens while A's presence is still live.)
      if (lastEpoch !== null) {
        if (contextOwnerRef.current?.file === file) contextOwnerRef.current = null;
        void clearContext(file, lastEpoch).catch(() => undefined);
      }
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
      const next = await validateWorkbook(file);
      setReport(next);
      if (next.fidelity) setFidelity(next.fidelity);
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
        {/* warn-text: while presence reporting is unhealthy, agents are blind
            to where the human is — never conceal that. */}
        {coordWarning && <span className="warn-text">{coordWarning}</span>}
        {/* warn-text so it survives Compact Mode: fidelity failures are never concealed. */}
        {fidelity && fidelity.status !== 'passed' && (
          <span className="warn-text">
            Value fidelity {fidelity.status}: {fidelity.reason}
          </span>
        )}
        {fidelity?.status === 'passed' && (
          <span title={fidelity.reason}>fidelity: passed ({fidelity.checkedCells} cells)</span>
        )}
      </footer>
    </div>
  );
}
