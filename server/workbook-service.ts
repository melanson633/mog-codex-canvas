/**
 * The shared workbook service: one policy, one persistence path, every lane.
 *
 * The HTTP file bridge (dev app), the MCP server (Claude Code plugin), and the
 * headless scripts all operate on the same workbook root with the same
 * guarantees. This module is where those guarantees live, so no lane can
 * drift from the others:
 *
 *   - containment: every client-supplied name goes through ./path-policy
 *   - durability: every write goes through replaceFile (staged + backup)
 *   - identity: a workbook's revision is the SHA-256 of its bytes on disk,
 *     and a save that names a stale revision is refused — the attempted
 *     bytes are preserved as a recoverable .conflict-*.xlsx sibling instead
 *     of silently overwriting the newer file
 *   - validation: a saved file is only trusted after the headless engine
 *     reopens it and reads it back
 *
 * Errors thrown here are WorkbookError with a stable machine-readable code,
 * so both the HTTP bridge and the MCP tools can return structured,
 * actionable failures without inventing their own taxonomy.
 */
import { randomUUID } from 'node:crypto';
import { revisionOf } from './workbook-revision.ts';
import { copyFile, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  WORKBOOK_EXTENSION,
  canonicalizeRoot,
  resolveReadTarget,
  resolveSaveTarget,
} from './path-policy.ts';
import { looksLikeWorkbook } from './ooxml-cache.ts';
import {
  profileWorkbook,
  readRangeFromBytes,
  type ProfileResult,
  type RangeReadResult,
} from './workbook-profile.ts';
import { extractWorkbookMetadata, type WorkbookMetadataResult } from './workbook-metadata.ts';
import {
  buildDependencyGraph,
  toGraphPayload,
  type GraphPayload,
  type UnreadableGraph,
} from './workbook-graph.ts';
import { describeSheetData, type SheetDataResult } from './sheet-schema.ts';
import {
  checkValueFidelity,
  fidelityNeedsEngine,
  type EngineWorkbook,
  type FidelityReport,
} from './value-fidelity.ts';
import {
  listReceipts,
  listRecoveryArtifacts,
  readReceipt,
  traceDependencies,
  writeReceipt,
  type CoordinationOutcome,
  type DependencyTrace,
  type EngineWorkbook as TraceEngineWorkbook,
  type ReceiptSummary,
  type RecoveryArtifact,
  type SaveActor,
  type SaveLane,
  type SaveReceipt,
} from './flight-recorder.ts';
import {
  createContextBus,
  parseRange,
  rangeCoversCell,
  type ContextBus,
} from './context-bus.ts';

export type WorkbookErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'empty-write'
  | 'revision-conflict'
  | 'fidelity-mismatch'
  | 'touched-ranges-required'
  | 'occupied-cell-conflict'
  | 'no-such-session'
  | 'write-failed'
  | 'validation-failed';

export class WorkbookError extends Error {
  readonly code: WorkbookErrorCode;
  /** Structured, safe-to-show context (never contains bytes). */
  readonly details: Record<string, unknown>;

  constructor(code: WorkbookErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkbookError';
    this.code = code;
    this.details = details;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Policy errors are thrown as plain Errors; give them a stable code here. */
async function policy<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    const message = reason(error);
    throw new WorkbookError(/No such file/.test(message) ? 'not-found' : 'invalid-path', message);
  }
}

export { revisionOf };

export interface WorkbookEntry {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
}

export interface SheetSummary {
  readonly name: string;
  readonly summary: string;
}

export interface ValidationReport {
  /** Root-relative name of the validated workbook — never an absolute path. */
  readonly name: string;
  readonly bytes: number;
  readonly modified: string;
  readonly revision: string;
  readonly sheetNames: readonly string[];
  readonly sheets: readonly SheetSummary[];
  /** Cached-value fidelity of the on-disk file (passed / failed / unverified). */
  readonly fidelity: FidelityReport;
}

export interface WorkbookProfileResult {
  readonly name: string;
  readonly revision: string;
  readonly profile: ProfileResult;
  /** Document properties, defined names, and table definitions. Additive. */
  readonly metadata: WorkbookMetadataResult;
  /** Fidelity verdict earned for exactly these bytes, when one exists. */
  readonly fidelity: FidelityReport | null;
  /** Honest label for what these numbers describe. Shown verbatim in UIs. */
  readonly provenance: string;
}

export interface WorkbookRangeResult {
  readonly name: string;
  readonly revision: string;
  readonly read: RangeReadResult;
  readonly fidelity: FidelityReport | null;
  readonly provenance: string;
}

export interface GraphOptions {
  /** `Sheet!Address` to answer precedent and dependent questions about. */
  readonly target?: string;
  /** Hop bound for transitive dependents of `target`. */
  readonly maxHops?: number;
  /** Sheets to build regardless of role, for on-demand deep calls. */
  readonly includeSheets?: readonly string[];
}

export interface SheetDataOptions {
  /** Full depth regardless of the materiality gate. Never bypasses redaction. */
  readonly override?: boolean;
}

export interface WorkbookGraphResult {
  readonly name: string;
  readonly revision: string;
  readonly graph: GraphPayload | UnreadableGraph;
  readonly fidelity: FidelityReport | null;
  readonly provenance: string;
}

export interface SheetDataDescriptionResult {
  readonly name: string;
  readonly revision: string;
  readonly description: SheetDataResult;
  readonly fidelity: FidelityReport | null;
  readonly provenance: string;
}

export interface OpenResult {
  readonly sessionId: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly modified: string;
  readonly revision: string;
}

export interface SaveResult {
  readonly name: string;
  readonly bytes: number;
  readonly revision: string;
  readonly backup: string | null;
  /** The value-fidelity gate's verdict on the admitted bytes. Never absent. */
  readonly fidelity: FidelityReport;
  /** Occupied-cell coordination outcome for this save. */
  readonly coordination: CoordinationOutcome;
  /** Flight-recorder receipt id; null only if the receipt could not be written. */
  readonly transactionId: string | null;
  /** Present only when the receipt write failed (the save itself succeeded). */
  readonly receiptError?: string;
}

export interface SaveContext {
  /** Which lane the save came through. Defaults to 'bridge'. */
  readonly lane?: SaveLane;
  /** Who is saving. Defaults to a human actor; agents must say so. */
  readonly actor?: SaveActor;
  /** Agent transactions declare what they set out to do. */
  readonly intent?: string;
  /** Agent transactions declare the ranges they touched (A1, sheet-qualified ok). */
  readonly touchedRanges?: readonly string[];
}

export interface SaveConflict {
  readonly expectedRevision: string;
  readonly actualRevision: string;
  /** Root-relative name of the file holding the refused bytes. */
  readonly conflictFile: string;
}

export interface ScreenshotResult {
  /** Root-relative name of the written PNG — never an absolute path. */
  readonly name: string;
  readonly bytes: number;
}

interface SessionState {
  readonly sessionId: string;
  readonly name: string;
  revision: string;
  readonly openedAt: string;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly name: string;
  readonly revision: string;
  readonly openedAt: string;
}

export interface ReplaceResult {
  readonly file: string;
  readonly bytes: number;
  readonly backup: string | null;
}

export interface ReplaceOptions {
  /** Copy the version being replaced to `<file>.bak` before promoting the new one. */
  readonly backup: boolean;
  /**
   * The promotion step. Only overridden by tests, which cannot make a real
   * rename fail on demand, and a failed promotion is the case that decides
   * whether a workbook survives a bad save.
   */
  readonly promote?: (from: string, to: string) => Promise<void>;
}

/** Unique within a process; the pid keeps two servers on one root apart. */
let stagedCount = 0;

/**
 * Replaces `file` with `bytes` without ever leaving the target path missing.
 *
 * The bytes land in a staged sibling first and are flushed to disk before
 * anything at the target moves, so a crash mid-write costs only the staged
 * file. The previous version is *copied* aside rather than renamed away — a
 * rename would open a window where the workbook exists only as a `.bak` — and
 * the staged file is then promoted with a single rename, which replaces the
 * target atomically. If that promotion fails, the original is still the file it
 * always was, and the staged copy is removed.
 */
export async function replaceFile(
  file: string,
  bytes: Buffer,
  { backup, promote = rename }: ReplaceOptions,
): Promise<ReplaceResult> {
  const staged = `${file}.${process.pid}.${stagedCount++}.staged`;
  const handle = await open(staged, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const existed = (await stat(file).catch(() => null)) !== null;
  try {
    const previous = backup && existed ? `${file}.bak` : null;
    if (previous) {
      // Clear the backup path before copying onto it. It is derived from the
      // target rather than resolved by the policy, and a copy follows a link
      // sitting there — a symlink planted at `<workbook>.bak` would send the
      // previous version outside the root. Unlink removes the link itself.
      await rm(previous, { force: true });
      await copyFile(file, previous);
    }
    await promote(staged, file);
    return { file, bytes: bytes.byteLength, backup: previous };
  } catch (error) {
    await rm(staged, { force: true });
    const present = (await stat(file).catch(() => null)) !== null;
    // basename only: this error travels out through the bridge and MCP tools,
    // which never disclose absolute paths.
    throw new WorkbookError(
      'write-failed',
      `Could not write ${basename(file)}: ${reason(error)}. ` +
        (present ? 'The file on disk was not changed by this save.' : 'No file was written.'),
      { file: basename(file), preserved: present },
    );
  }
}

export interface WorkbookServiceOptions {
  /** Directory that holds the workbooks this service may open and save. */
  readonly root: string;
}

export interface WorkbookService {
  /** Canonical workbook root this service is confined to. */
  readonly root: string;

  list(): Promise<WorkbookEntry[]>;

  /** Read current bytes without creating a session (dev-bridge GET). */
  read(name: string): Promise<{ bytes: Uint8Array; revision: string }>;

  /**
   * Byte-first shape profile of the saved file: milliseconds, engine-free.
   * Reflects the last save on disk — never unsaved canvas edits.
   */
  profile(name: string): Promise<WorkbookProfileResult>;

  /**
   * Cached values + formula text for one sheet range, straight from the saved
   * bytes. Same provenance rules as profile(): truth of the last save.
   */
  readRange(name: string, sheet: string, range: string): Promise<WorkbookRangeResult>;

  /**
   * The intra-workbook dependency graph over model-role sheets, from the saved
   * bytes. Sheets left out are reported with the role that excluded them.
   */
  graph(name: string, options?: GraphOptions): Promise<WorkbookGraphResult>;

  /**
   * Column schema and population statistics for one sheet, at a depth
   * proportional to measured consumption. High-risk columns are redacted.
   */
  describeSheet(
    name: string,
    sheet: string,
    options?: SheetDataOptions,
  ): Promise<SheetDataDescriptionResult>;

  /** Open a tracked session: bytes + the revision saves must be based on. */
  openSession(name: string): Promise<OpenResult>;

  getSession(sessionId: string): SessionInfo;
  listSessions(): SessionInfo[];
  closeSession(sessionId: string): void;

  /**
   * Save through a session with stale-revision protection. The session's
   * revision advances on success.
   */
  saveSession(sessionId: string, bytes: Uint8Array, context?: SaveContext): Promise<SaveResult>;

  /**
   * Save by name. When `expectedRevision` is given and the file on disk no
   * longer matches it, the save is refused: the attempted bytes are preserved
   * as a `.conflict-<stamp>.xlsx` sibling and a revision-conflict error is
   * thrown naming both revisions and the preserved file. Passing no
   * expectedRevision is an explicit "last write wins" (headless lane).
   *
   * Every save additionally passes the value-fidelity gate (a deterministic
   * cached-vs-engine mismatch is refused, the bytes preserved as a
   * `.fidelity-refused-*.xlsx` sibling), agent saves pass the occupied-cell
   * interlock against the context bus, and every successful save writes one
   * immutable flight-recorder receipt.
   */
  save(
    name: string,
    bytes: Uint8Array,
    expectedRevision?: string,
    context?: SaveContext,
  ): Promise<SaveResult>;

  // ---- Flight recorder ----
  listRecoveryArtifacts(): Promise<RecoveryArtifact[]>;
  listReceipts(): Promise<ReceiptSummary[]>;
  getReceipt(transactionId: string): Promise<SaveReceipt>;
  /** Read a recovery artifact's bytes: a .bak backup or a preserved .xlsx sibling. */
  readRecoveryArtifact(name: string): Promise<{ bytes: Uint8Array; revision: string }>;

  /** Ephemeral canvas presence + navigation commands (one bus per service). */
  readonly context: ContextBus;

  /** Reopen a saved workbook with the headless engine and read it back. */
  validate(name: string): Promise<ValidationReport>;

  /** Write PNG bytes to a contained .png path. */
  writeScreenshot(name: string, bytes: Uint8Array): Promise<ScreenshotResult>;

  /**
   * Render a PNG of a saved workbook with the headless engine — no browser —
   * and write it next to the workbook (or to `outName`).
   */
  captureScreenshot(name: string, range?: string, outName?: string): Promise<ScreenshotResult>;
}

export function createWorkbookService(options: WorkbookServiceOptions): WorkbookService {
  // Canonicalized at construction: without a resolvable root there is no
  // containment boundary, and the service must not come up at all.
  const root = canonicalizeRoot(options.root);
  const sessions = new Map<string, SessionState>();
  const contextBus = createContextBus();

  // Deterministic fidelity verdicts, keyed by the SHA-256 of the exact bytes
  // they describe. Only passed/failed are cached — those are functions of the
  // bytes and the installed engine; `unverified` can be transient (engine
  // unavailable) and must be re-earned. This is what keeps validate-after-save
  // from paying a second engine import for the very bytes the save just judged.
  const FIDELITY_CACHE_LIMIT = 32;
  const fidelityCache = new Map<string, FidelityReport>();
  function rememberFidelity(report: FidelityReport): void {
    if (report.status === 'unverified') return;
    fidelityCache.delete(report.revision);
    fidelityCache.set(report.revision, report);
    while (fidelityCache.size > FIDELITY_CACHE_LIMIT) {
      const oldest = fidelityCache.keys().next().value!;
      fidelityCache.delete(oldest);
    }
  }

  // One promotion at a time per target file. Expensive analysis (fidelity,
  // dependency trace) runs outside this; only the re-read/recheck, backup and
  // replacement — all fast — run inside.
  const promotionLocks = new Map<string, Promise<void>>();
  async function withPromotionLock<T>(file: string, action: () => Promise<T>): Promise<T> {
    const previous = promotionLocks.get(file) ?? Promise.resolve();
    const run = previous.then(action);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    promotionLocks.set(file, tail);
    try {
      return await run;
    } finally {
      if (promotionLocks.get(file) === tail) promotionLocks.delete(file);
    }
  }

  async function list(): Promise<WorkbookEntry[]> {
    const names = await readdir(root).catch(() => [] as string[]);
    const entries: WorkbookEntry[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith(WORKBOOK_EXTENSION) || name.startsWith('~$')) continue;
      const info = await stat(join(root, name));
      entries.push({ name, size: info.size, modified: info.mtime.toISOString() });
    }
    return entries.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async function read(name: string): Promise<{ bytes: Uint8Array; revision: string }> {
    const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
    const bytes = await readFile(file);
    return { bytes, revision: revisionOf(bytes) };
  }

  /** What byte reads are the truth of — shown verbatim wherever they travel. */
  function byteProvenance(revision: string): string {
    return (
      `as-saved at revision ${revision.slice(0, 12)}… — reflects the last save on disk, ` +
      'not unsaved canvas edits'
    );
  }

  async function profile(name: string): Promise<WorkbookProfileResult> {
    const { bytes, revision } = await read(name);
    return {
      name,
      revision,
      profile: profileWorkbook(bytes),
      metadata: extractWorkbookMetadata(bytes),
      fidelity: fidelityCache.get(revision) ?? null,
      provenance: byteProvenance(revision),
    };
  }

  async function readRange(
    name: string,
    sheet: string,
    range: string,
  ): Promise<WorkbookRangeResult> {
    const { bytes, revision } = await read(name);
    return {
      name,
      revision,
      read: readRangeFromBytes(bytes, sheet, range),
      fidelity: fidelityCache.get(revision) ?? null,
      provenance: byteProvenance(revision),
    };
  }

  async function graph(name: string, options: GraphOptions = {}): Promise<WorkbookGraphResult> {
    const { bytes, revision } = await read(name);
    const built = buildDependencyGraph(bytes, {
      ...(options.includeSheets ? { includeSheets: options.includeSheets } : {}),
    });
    return {
      name,
      revision,
      graph:
        built.status === 'built'
          ? toGraphPayload(built, {
              ...(options.target ? { target: options.target } : {}),
              ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }),
            })
          : built,
      fidelity: fidelityCache.get(revision) ?? null,
      provenance: byteProvenance(revision),
    };
  }

  async function describeSheet(
    name: string,
    sheet: string,
    options: SheetDataOptions = {},
  ): Promise<SheetDataDescriptionResult> {
    const { bytes, revision } = await read(name);
    return {
      name,
      revision,
      description: describeSheetData(bytes, sheet, options),
      fidelity: fidelityCache.get(revision) ?? null,
      provenance: byteProvenance(revision),
    };
  }

  function requireSession(sessionId: string): SessionState {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new WorkbookError('no-such-session', `No open session: ${sessionId}`, { sessionId });
    }
    return session;
  }

  /** Park refused bytes beside the target so a refusal never costs the caller's work. */
  async function preserveRefused(name: string, bytes: Uint8Array, label: string): Promise<string> {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const parkedName = name.replace(/\.xlsx$/i, `.${label}-${stamp}.xlsx`);
    const parkedFile = await policy(() => resolveSaveTarget(root, parkedName, 'workbook'));
    await replaceFile(parkedFile, Buffer.from(bytes), { backup: false });
    return basename(parkedFile);
  }

  /**
   * The occupied-cell interlock. Agent saves must declare touched ranges; a
   * declared range that covers (or cannot be proven disjoint from) the human's
   * occupied cell is refused with a retryable, typed error. No queueing, no
   * merging, no blanket lock — the agent simply tries again later or elsewhere.
   */
  function checkCoordination(name: string, context: SaveContext): CoordinationOutcome {
    const actor = context.actor ?? { kind: 'human', id: 'unattributed' };
    if (actor.kind !== 'agent') return { status: 'not-applicable', occupiedCell: null };

    const ranges = context.touchedRanges ?? [];
    if (ranges.length === 0) {
      throw new WorkbookError(
        'touched-ranges-required',
        'Agent saves must declare the ranges they touched (touchedRanges), so the ' +
          'occupied-cell interlock can prove they are disjoint from the live canvas.',
        { name },
      );
    }
    const parsed = ranges.map((ref) => ({ ref, range: parseRange(ref) }));
    const bad = parsed.find((entry) => !entry.range);
    if (bad) {
      throw new WorkbookError(
        'touched-ranges-required',
        `Touched range could not be parsed as an A1 reference: ${bad.ref}`,
        { name, touchedRange: bad.ref },
      );
    }

    const canvas = contextBus.get(name);
    if (!canvas || !canvas.occupiedCell) {
      return { status: 'no-live-canvas', occupiedCell: null };
    }
    const occupied = parseRange(canvas.occupiedCell);
    if (!occupied) {
      // Fail closed: a live canvas is reporting, but its occupied cell cannot
      // be parsed, so disjointness cannot be proven. Treating this as "no live
      // canvas" would let an agent write under the human's cursor.
      throw new WorkbookError(
        'occupied-cell-conflict',
        `Refusing this save: the live canvas reports an occupied cell this service ` +
          `cannot parse (${canvas.occupiedCell}), so no declared range can be proven ` +
          `disjoint from it. Nothing was written. Retry after the canvas reports a ` +
          `readable position.`,
        {
          retryable: true,
          occupiedCell: canvas.occupiedCell,
          activeSheet: canvas.activeSheet,
          touchedRange: null,
        },
      );
    }

    const hit = parsed.find((entry) =>
      rangeCoversCell(entry.range!, occupied, canvas.activeSheet),
    );
    if (hit) {
      throw new WorkbookError(
        'occupied-cell-conflict',
        `Refusing this save: the declared range ${hit.ref} intersects the cell the ` +
          `human is on (${canvas.activeSheet ? `${canvas.activeSheet}!` : ''}${canvas.occupiedCell}). ` +
          'Nothing was written. Retry after the human moves, or narrow the touched ranges.',
        {
          retryable: true,
          occupiedCell: canvas.occupiedCell,
          activeSheet: canvas.activeSheet,
          touchedRange: hit.ref,
        },
      );
    }
    return { status: 'disjoint', occupiedCell: canvas.occupiedCell };
  }

  async function save(
    name: string,
    bytes: Uint8Array,
    expectedRevision?: string,
    context: SaveContext = {},
  ): Promise<SaveResult> {
    if (bytes.byteLength === 0) {
      throw new WorkbookError('empty-write', 'Refusing to write an empty workbook', { name });
    }
    const file = await policy(() => resolveSaveTarget(root, name, 'workbook'));
    const actor = context.actor ?? { kind: 'human' as const, id: 'unattributed' };
    const lane = context.lane ?? 'bridge';

    // The prior bytes as of admission-time analysis: the dependency trace
    // compares against this "before". Receipt lineage uses the re-read taken
    // inside the promotion critical section, which is what the save replaces.
    const current = await readFile(file).catch(() => null);

    const staleRevision = (actualRevision: string): Promise<never> =>
      preserveRefused(name, bytes, 'conflict').then((conflictFile) => {
        throw new WorkbookError(
          'revision-conflict',
          `${name} changed on disk after it was opened (expected revision ` +
            `${expectedRevision!.slice(0, 12)}…, found ${actualRevision.slice(0, 12)}…). ` +
            `Nothing was overwritten; your version was preserved as ${conflictFile}. ` +
            'Reopen the workbook to pick up the newer file, then reapply or merge from the preserved copy.',
          {
            expectedRevision: expectedRevision!,
            actualRevision,
            conflictFile,
          } satisfies SaveConflict & Record<string, unknown>,
        );
      });

    // Fast-fail before paying for analysis; the authoritative check happens
    // again inside the promotion critical section.
    if (expectedRevision !== undefined) {
      const actualRevision = current ? revisionOf(current) : 'absent';
      if (actualRevision !== expectedRevision) await staleRevision(actualRevision);
    }

    const coordination = checkCoordination(name, context);

    // ---- Expensive analysis: everything below until the promotion lock may
    // take engine-import time and runs without holding any lock. ----

    const revision = revisionOf(bytes);
    const wantTrace = actor.kind === 'agent' && (context.touchedRanges?.length ?? 0) > 0;

    // One engine import of the attempted bytes serves both the fidelity gate
    // and the dependency trace. If the open fails, each consumer reports its
    // own typed unavailability exactly as before. Bytes the fidelity check
    // would call unverified without an engine are never opened speculatively —
    // createWorkbook() on unopenable bytes leaks a native thread in 0.10.5.
    let engine: TraceEngineWorkbook | null = null;
    if (
      (wantTrace && looksLikeWorkbook(bytes)) ||
      (!fidelityCache.has(revision) && fidelityNeedsEngine(bytes))
    ) {
      try {
        const { createWorkbook } = (await import('@mog-sdk/sdk/node')) as unknown as {
          createWorkbook: (source: Buffer) => Promise<TraceEngineWorkbook>;
        };
        engine = await createWorkbook(Buffer.from(bytes));
      } catch {
        engine = null;
      }
    }

    let fidelity: FidelityReport;
    let dependencyTrace: DependencyTrace | null = null;
    try {
      // The value-fidelity gate: a deterministic cached-vs-engine mismatch is
      // refused before the staged bytes ever replace the admitted revision.
      // Missing evidence (unopenable bytes, no cached values) is `unverified`,
      // never `passed` — and never a refusal, which would trade honesty for
      // data loss.
      fidelity =
        fidelityCache.get(revision) ??
        (await checkValueFidelity(bytes, revision, engine ? { engine } : {}));
      rememberFidelity(fidelity);
      if (fidelity.status === 'failed') {
        const refusedFile = await preserveRefused(name, bytes, 'fidelity-refused');
        throw new WorkbookError(
          'fidelity-mismatch',
          `Refusing to admit ${name}: ${fidelity.reason}. The engine's view of this ` +
            `workbook contradicts the file's own recorded values, so saving it would ` +
            `persist values the workbook never agreed to. Nothing was overwritten; the ` +
            `attempted bytes were preserved as ${refusedFile}.`,
          { fidelity, refusedFile },
        );
      }

      // Agent transactions get an old-vs-new dependency cascade from their
      // declared ranges — or a typed "unavailable" recording why not.
      if (wantTrace) {
        dependencyTrace = await traceDependencies({
          beforeBytes: current,
          afterBytes: bytes,
          touchedRanges: context.touchedRanges!,
          ...(engine ? { afterWorkbook: engine } : {}),
        }).catch((error) => ({
          status: 'unavailable' as const,
          reason: reason(error),
        }));
      }
    } finally {
      // dispose() has been observed returning undefined instead of a Promise
      // on some paths in 0.10.5, so never chain onto its return value.
      if (engine) {
        try {
          await engine.dispose();
        } catch {
          // A cleanup failure must not mask the save outcome.
        }
      }
    }

    // ---- Promotion critical section: re-read, recheck, backup, replace. ----
    return withPromotionLock(file, async () => {
      const latest = await readFile(file).catch(() => null);
      const beforeRevision = latest ? revisionOf(latest) : null;
      if (expectedRevision !== undefined && (beforeRevision ?? 'absent') !== expectedRevision) {
        // The workbook changed while analysis ran. Refuse, preserving the
        // caller's work exactly as the fast-fail path does.
        await staleRevision(beforeRevision ?? 'absent');
      }

      const saved = await replaceFile(file, Buffer.from(bytes), { backup: true });

      const receipt: SaveReceipt = {
        schemaVersion: 1,
        transactionId: randomUUID(),
        workbook: name,
        beforeRevision,
        afterRevision: revision,
        timestamp: new Date().toISOString(),
        lane,
        actor,
        intent: context.intent ?? null,
        touchedRanges: context.touchedRanges ?? null,
        fidelity,
        coordination,
        backup: saved.backup ? basename(saved.backup) : null,
        dependencyTrace,
      };
      let transactionId: string | null = receipt.transactionId;
      let receiptError: string | undefined;
      try {
        await writeReceipt(root, receipt);
      } catch (error) {
        // The bytes are already admitted; failing the save now would misreport
        // what happened on disk. Surface the missing evidence instead.
        transactionId = null;
        receiptError = reason(error);
      }

      return {
        name,
        bytes: saved.bytes,
        revision,
        backup: saved.backup ? basename(saved.backup) : null,
        fidelity,
        coordination,
        transactionId,
        ...(receiptError ? { receiptError } : {}),
      };
    });
  }

  async function validate(name: string): Promise<ValidationReport> {
    const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
    // The /node subpath forces the native binding; the bare specifier resolves
    // to the browser WASM build under bundler resolution, which has no
    // file-path API.
    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    let wb: Awaited<ReturnType<typeof createWorkbook>>;
    try {
      wb = await createWorkbook(file);
    } catch (error) {
      throw new WorkbookError('validation-failed', `${name} could not be reopened: ${reason(error)}`, {
        name,
      });
    }
    try {
      const sheets: SheetSummary[] = [];
      for (const sheetName of wb.sheetNames) {
        const { sheet } = await wb.getOrCreateSheet(sheetName);
        sheets.push({ name: sheetName, summary: await sheet.summarize() });
      }
      const [info, bytes] = await Promise.all([stat(file), readFile(file)]);
      const revision = revisionOf(bytes);
      // Reuse the save-time verdict when this exact byte-revision was already
      // judged; otherwise lend validate's own open workbook to the check so it
      // never pays a second engine import.
      let fidelity = fidelityCache.get(revision);
      if (!fidelity) {
        fidelity = await checkValueFidelity(bytes, revision, {
          engine: wb as unknown as EngineWorkbook,
        });
        rememberFidelity(fidelity);
      }
      return {
        name,
        bytes: info.size,
        modified: info.mtime.toISOString(),
        revision,
        sheetNames: wb.sheetNames,
        sheets,
        fidelity,
      };
    } finally {
      await wb.dispose();
    }
  }

  async function writeScreenshot(name: string, bytes: Uint8Array): Promise<ScreenshotResult> {
    const file = await policy(() => resolveSaveTarget(root, name, 'screenshot'));
    const saved = await replaceFile(file, Buffer.from(bytes), { backup: false });
    return { name, bytes: saved.bytes };
  }

  async function captureScreenshot(
    name: string,
    range = 'A1:H30',
    outName?: string,
  ): Promise<ScreenshotResult> {
    const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
    const { createWorkbook } = await import('@mog-sdk/sdk/node');
    const wb = await createWorkbook(file);
    let png: Uint8Array;
    try {
      png = await wb.captureScreenshot(wb.activeSheet, range, { dpr: 1 });
    } finally {
      await wb.dispose();
    }
    return writeScreenshot(outName ?? name.replace(/\.xlsx$/i, '.png'), png);
  }

  return {
    root,
    list,
    read,
    profile,
    readRange,
    graph,
    describeSheet,

    async openSession(name) {
      const { bytes, revision } = await read(name);
      const file = await policy(() => resolveReadTarget(root, name, 'workbook'));
      const info = await stat(file);
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        sessionId,
        name,
        revision,
        openedAt: new Date().toISOString(),
      });
      return {
        sessionId,
        name,
        bytes,
        size: info.size,
        modified: info.mtime.toISOString(),
        revision,
      };
    },

    getSession(sessionId) {
      const { name, revision, openedAt } = requireSession(sessionId);
      return { sessionId, name, revision, openedAt };
    },

    listSessions() {
      return [...sessions.values()].map(({ sessionId, name, revision, openedAt }) => ({
        sessionId,
        name,
        revision,
        openedAt,
      }));
    },

    closeSession(sessionId) {
      requireSession(sessionId);
      sessions.delete(sessionId);
    },

    async saveSession(sessionId, bytes, context) {
      const session = requireSession(sessionId);
      const saved = await save(session.name, bytes, session.revision, context);
      session.revision = saved.revision;
      return saved;
    },

    save,
    validate,
    writeScreenshot,
    captureScreenshot,

    listRecoveryArtifacts: () => policy(() => listRecoveryArtifacts(root)),
    listReceipts: () => policy(() => listReceipts(root)),
    getReceipt: (transactionId) => policy(() => readReceipt(root, transactionId)),

    async readRecoveryArtifact(name) {
      // Backups (.bak) and preserved .xlsx siblings only — the closed artifact
      // set. Receipts have their own reader; screenshots are not artifacts.
      const kind = name.toLowerCase().endsWith('.bak') ? ('backup' as const) : ('workbook' as const);
      const file = await policy(() => resolveReadTarget(root, name, kind));
      const bytes = await readFile(file);
      return { bytes, revision: revisionOf(bytes) };
    },

    context: contextBus,
  };
}
