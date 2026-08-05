/**
 * Presence-tracker regressions for the canvas adapter.
 *
 * The review finding: an agent-issued reveal navigates the canvas, and the
 * embed raises the same selection/sheet events a human click would — so
 * without suppression, a reveal would overwrite the human's occupied cell on
 * the context bus with an agent-chosen position, and the occupied-cell
 * interlock would then protect the wrong cell (reveal-then-save).
 *
 * The adapter's imports are all type-only, so the real module loads directly
 * under `node --test`; the embed itself is a fake that captures the onEvent
 * callback and fires events the way the real one does.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMogEmbedAdapter, type EmbedModule } from '../src/adapters/mog-embed-adapter.ts';
import type { CanvasContextSnapshot, HostServices } from '../src/adapters/types';

type EventSink = (event: unknown) => void;

interface FakeEmbed {
  readonly module: EmbedModule;
  /** Fires the runtime's onEvent callback, as the real embed would. */
  emit(event: unknown): void;
}

function fakeEmbed(): FakeEmbed {
  let sink: EventSink = () => undefined;

  const view = {
    getActiveSheet: () => ({ sheetId: 's1', sheetName: 'Sheet1' }),
    getSelection: () => ({
      selectedRanges: ['A1:A1'],
      activeCell: { address: 'A1', sheetId: 's1' },
    }),
    // The real embed raises selection events for programmatic navigation too —
    // this is exactly the behavior the tracker must suppress during a reveal.
    setActiveSheet: async (sheet: string) => {
      sink({ type: 'active-sheet-change', payload: { sheetId: 's2', sheetName: sheet } });
    },
    select: async (target: { range: string }) => {
      sink({
        type: 'selection-change',
        payload: {
          selectedRanges: [target.range],
          activeCell: { address: target.range.split(':')[0], sheetId: 's1' },
        },
      });
    },
    scrollTo: async () => undefined,
  };

  const workbook = {
    whenReady: async () => undefined,
    onDirtyChange: () => () => undefined,
    requestSave: async () => ({ status: 'saved' }),
    exportXlsx: async () => new Uint8Array(),
    captureScreenshot: async () => new Uint8Array(),
  };

  const module = {
    createSpreadsheetRuntime: async (config: { onEvent?: EventSink }) => {
      if (config.onEvent) sink = config.onEvent;
      return {
        openWorkbook: async () => workbook,
        dispose: async () => undefined,
      };
    },
    mountSpreadsheetApp: () => ({
      ready: Promise.resolve(),
      view: () => view,
      detach: async () => undefined,
    }),
  } as unknown as EmbedModule;

  return { module, emit: (event) => sink(event) };
}

function host(snapshots: CanvasContextSnapshot[]): HostServices {
  return {
    persist: async () => ({ versionId: 'v1' }),
    onDirtyChange: () => undefined,
    onStatus: () => undefined,
    onError: () => undefined,
    onContext: (snapshot) => snapshots.push(snapshot),
  };
}

test('adapter: a reveal never replaces the human occupied-cell signal', async () => {
  const embed = fakeEmbed();
  const adapter = createMogEmbedAdapter(embed.module);
  const snapshots: CanvasContextSnapshot[] = [];

  const session = await adapter.open(
    {} as unknown as HTMLElement,
    { fileName: 'book.xlsx', bytes: new Uint8Array(), colorScheme: 'system' },
    host(snapshots),
  );

  // Mounting seeds the initial presence from the view.
  assert.ok(snapshots.length >= 1, 'seed emits an initial snapshot');
  assert.equal(snapshots.at(-1)?.occupiedCell, 'A1');

  // The human clicks B2.
  embed.emit({
    type: 'selection-change',
    payload: { selectedRanges: ['B2:B2'], activeCell: { address: 'B2', sheetId: 's1' } },
  });
  assert.equal(snapshots.at(-1)?.occupiedCell, 'B2');
  const before = snapshots.length;

  // An agent reveal navigates to D4; the fake embed raises the same events a
  // human click would, during the awaited reveal.
  await session.reveal!('D4:D4', 'Elsewhere');

  assert.equal(snapshots.length, before, 'reveal-raised events emit no presence');
  assert.equal(snapshots.at(-1)?.occupiedCell, 'B2', 'the human signal survives the reveal');

  // A real human move after the reveal is tracked again — suppression is
  // scoped to the reveal, not sticky.
  embed.emit({
    type: 'selection-change',
    payload: { selectedRanges: ['C7:C7'], activeCell: { address: 'C7', sheetId: 's1' } },
  });
  assert.equal(snapshots.at(-1)?.occupiedCell, 'C7');

  // Sequences stay strictly monotonic across the suppression gap, so the bus
  // never rejects the post-reveal human report as out of order.
  const sequences = snapshots.map((s) => s.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
    'sequence must be monotonic',
  );
  assert.equal(new Set(sequences).size, sequences.length, 'sequence never repeats');

  await session.dispose();
});
