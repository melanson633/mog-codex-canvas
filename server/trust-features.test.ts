/**
 * Trust features: value-fidelity gate, flight recorder, canvas context bus.
 *
 * Every test runs against an isolated temp workbook root — never against
 * workbooks/sample.xlsx. The failing-fidelity fixture is synthetic: a real
 * engine-produced workbook whose sheet XML is tampered (formula swapped, cached
 * value kept) with fullCalcOnLoad set, so the engine deterministically reports
 * an error where the file recorded a value — the exact shape of the known
 * SDK 0.10.5 import defect, reproduced without the defect.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { extractCachedFormulaValues, readZipEntries } from './ooxml-cache.ts';
import { checkValueFidelity } from './value-fidelity.ts';
import { createContextBus, parseRange, rangeCoversCell } from './context-bus.ts';
import { traceDependencies } from './flight-recorder.ts';
import { WorkbookError, createWorkbookService, revisionOf } from './workbook-service.ts';

// ---- Fixture builders -------------------------------------------------------

async function makeXlsx(cells: Record<string, string | number>): Promise<Buffer> {
  const { createWorkbook } = await import('@mog-sdk/sdk/node');
  const wb = await createWorkbook();
  try {
    for (const [address, value] of Object.entries(cells)) {
      await wb.activeSheet.setCell(address, value);
    }
    return Buffer.from(await wb.toXlsx());
  } finally {
    await wb.dispose();
  }
}

/** Rebuild a ZIP with stored (uncompressed) entries — enough for the engine. */
function writeZipStored(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * The failing fixture: swap a formula while keeping its cached value, and set
 * fullCalcOnLoad so the engine re-evaluates on open. Cached says 20, engine
 * says #NAME? — a deterministic cached-non-error vs engine-error mismatch.
 */
function tamperForMismatch(bytes: Buffer): Buffer {
  const entries = readZipEntries(bytes).map(({ name, data }) => {
    if (/worksheets\/sheet1\.xml$/i.test(name)) {
      return { name, data: Buffer.from(data.toString().replace(/<f>A1\*2<\/f>/, '<f>NOSUCHFN(1)</f>')) };
    }
    if (name === 'xl/workbook.xml') {
      let xml = data.toString();
      xml = xml.includes('<calcPr')
        ? xml.replace(/<calcPr\b([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>')
        : xml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      return { name, data: Buffer.from(xml) };
    }
    return { name, data };
  });
  return writeZipStored(entries);
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mog-trust-'));
}

async function expectWorkbookError(
  action: () => Promise<unknown>,
  code: string,
): Promise<WorkbookError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof WorkbookError, `expected WorkbookError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected WorkbookError ${code}, but the action succeeded`);
}

// Shared fixtures, built once: engine startup dominates the suite otherwise.
const cleanBytes = await makeXlsx({ A1: 10, A2: '=A1*2', A3: '=A2+5' });
const noFormulaBytes = await makeXlsx({ A1: 'just text', B1: 42 });
const mismatchBytes = tamperForMismatch(cleanBytes);

// ---- Value fidelity ---------------------------------------------------------

test('ooxml cache: extracts cached formula values from an engine export', () => {
  const extract = extractCachedFormulaValues(cleanBytes);
  assert.equal(extract.formulaCells, 2);
  const a2 = extract.cells.find((cell) => cell.address === 'A2');
  assert.deepEqual(a2, { sheet: 'Sheet1', address: 'A2', cachedValue: 20, cachedIsError: false });
});

test('fidelity: passes when the engine agrees with the cached values', async () => {
  const report = await checkValueFidelity(cleanBytes, revisionOf(cleanBytes));
  assert.equal(report.status, 'passed');
  assert.equal(report.checkedCells, 2);
  assert.equal(report.mismatches.length, 0);
});

test('fidelity: fails deterministically when the engine reports an error over a cached value', async () => {
  const report = await checkValueFidelity(mismatchBytes, revisionOf(mismatchBytes));
  assert.equal(report.status, 'failed');
  // The tampered A2 cascades its error into A3 (=A2+5), so both cells mismatch
  // their cached values. The tampered cell itself must be reported exactly.
  assert.equal(report.mismatches.length, 2);
  const tampered = report.mismatches.find((m) => m.address === 'A2');
  assert.deepEqual(
    { ...tampered },
    { sheet: 'Sheet1', address: 'A2', cachedValue: 20, engineValue: '#NAME?' },
  );
  assert.match(report.reason, /#NAME\?/);
});

test('fidelity: unreadable bytes are unverified, never passed', async () => {
  const report = await checkValueFidelity(Buffer.from('not an xlsx at all'), 'r');
  assert.equal(report.status, 'unverified');
  assert.match(report.reason, /could not be read/);
});

test('fidelity: a workbook without formulas is unverified with its reason', async () => {
  const report = await checkValueFidelity(noFormulaBytes, revisionOf(noFormulaBytes));
  assert.equal(report.status, 'unverified');
  assert.match(report.reason, /no formula cells/);
});

// ---- Save admission ---------------------------------------------------------

test('save: a fidelity mismatch is refused, preserved, and the target untouched', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });

  await service.save('book.xlsx', cleanBytes);
  const before = await readFile(join(root, 'book.xlsx'));

  const error = await expectWorkbookError(
    () => service.save('book.xlsx', mismatchBytes),
    'fidelity-mismatch',
  );
  const refused = error.details.refusedFile as string;
  assert.match(refused, /^book\.fidelity-refused-.*\.xlsx$/);
  assert.deepEqual(await readFile(join(root, refused)), mismatchBytes);
  assert.deepEqual(await readFile(join(root, 'book.xlsx')), before, 'target must be unchanged');

  // The refusal itself surfaces as a typed recovery artifact.
  const artifacts = await service.listRecoveryArtifacts();
  assert.ok(artifacts.some((a) => a.kind === 'fidelity-refused' && a.name === refused));
});

test('save: unverified bytes are admitted, reported unverified, and receipted', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });

  // The MCP stale-save check and the bridge tests write non-workbook bytes;
  // missing cache evidence must not become a refusal.
  const saved = await service.save('junk.xlsx', Buffer.from('PK not really a zip'));
  assert.equal(saved.fidelity.status, 'unverified');
  assert.ok(saved.transactionId, 'unverified saves still get a receipt');

  const receipt = await service.getReceipt(saved.transactionId!);
  assert.equal(receipt.fidelity.status, 'unverified');
  assert.equal(receipt.afterRevision, saved.revision);
});

test('save: every successful save writes one immutable, retrievable receipt', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });

  const first = await service.save('book.xlsx', cleanBytes);
  assert.equal(first.fidelity.status, 'passed');
  assert.ok(first.transactionId);

  const receipt = await service.getReceipt(first.transactionId!);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.workbook, 'book.xlsx');
  assert.equal(receipt.beforeRevision, null);
  assert.equal(receipt.afterRevision, revisionOf(cleanBytes));
  assert.equal(receipt.lane, 'bridge');
  assert.deepEqual(receipt.actor, { kind: 'human', id: 'unattributed' });
  assert.equal(receipt.intent, null);
  assert.equal(receipt.fidelity.status, 'passed');

  // Second save records lineage from the first.
  const second = await service.save('book.xlsx', noFormulaBytes, first.revision, {
    lane: 'canvas',
    actor: { kind: 'human', id: 'dev-app' },
  });
  const receipt2 = await service.getReceipt(second.transactionId!);
  assert.equal(receipt2.beforeRevision, first.revision);
  assert.equal(receipt2.lane, 'canvas');

  const summaries = await service.listReceipts();
  assert.deepEqual(
    summaries.map((s) => s.transactionId).sort(),
    [first.transactionId, second.transactionId].sort(),
  );
  assert.ok(summaries.every((s) => s.workbook === 'book.xlsx'));

  // Receipt ids that are not UUIDs never touch a path.
  await expectWorkbookError(() => service.getReceipt('../escape'), 'invalid-path');

  // Immutable: the receipt file cannot be rewritten through any service lane.
  const receiptFiles = await readdir(join(root, '.audit/receipts'));
  assert.equal(receiptFiles.length, 2);
});

test('save: recovery artifacts are typed and readable; backups retrievable', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });

  const first = await service.save('book.xlsx', cleanBytes);
  await service.save('book.xlsx', noFormulaBytes, first.revision); // creates book.xlsx.bak
  // Stale save -> conflict artifact.
  await expectWorkbookError(
    () => service.save('book.xlsx', noFormulaBytes, first.revision),
    'revision-conflict',
  );

  const artifacts = await service.listRecoveryArtifacts();
  const kinds = new Set(artifacts.map((a) => a.kind));
  assert.ok(kinds.has('backup'));
  assert.ok(kinds.has('conflict'));
  assert.ok(kinds.has('receipt'));

  const backup = await service.readRecoveryArtifact('book.xlsx.bak');
  assert.equal(backup.revision, revisionOf(cleanBytes), 'the .bak holds the replaced version');

  const conflict = artifacts.find((a) => a.kind === 'conflict')!;
  const parked = await service.readRecoveryArtifact(conflict.name);
  assert.equal(parked.revision, revisionOf(noFormulaBytes));

  // Containment still holds for artifact reads.
  await expectWorkbookError(() => service.readRecoveryArtifact('../outside.bak'), 'invalid-path');
});

// ---- Occupied-cell interlock ------------------------------------------------

test('interlock: agent saves declare ranges; intersections are refused retryably', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });
  const agent = { lane: 'headless' as const, actor: { kind: 'agent' as const, id: 'test-agent' } };

  await service.save('book.xlsx', cleanBytes);
  const onDisk = await readFile(join(root, 'book.xlsx'));

  // No declared ranges -> typed refusal.
  await expectWorkbookError(
    () => service.save('book.xlsx', noFormulaBytes, undefined, agent),
    'touched-ranges-required',
  );

  // Human is on Sheet1!B2.
  assert.equal(
    service.context.report('book.xlsx', {
      epoch: 1,
      sequence: 1,
      activeSheet: 'Sheet1',
      selection: 'B2:B2',
      occupiedCell: 'B2',
      focused: true,
      dirty: false,
    }).accepted,
    true,
  );

  // Intersecting range -> retryable refusal, nothing written.
  const conflict = await expectWorkbookError(
    () =>
      service.save('book.xlsx', noFormulaBytes, undefined, { ...agent, touchedRanges: ['A1:C3'] }),
    'occupied-cell-conflict',
  );
  assert.equal(conflict.details.retryable, true);
  assert.equal(conflict.details.occupiedCell, 'B2');
  assert.deepEqual(await readFile(join(root, 'book.xlsx')), onDisk);

  // Disjoint range -> admitted, coordination recorded in result and receipt.
  const saved = await service.save('book.xlsx', noFormulaBytes, undefined, {
    ...agent,
    intent: 'test disjoint write',
    touchedRanges: ['E10:F12'],
  });
  assert.equal(saved.coordination.status, 'disjoint');
  const receipt = await service.getReceipt(saved.transactionId!);
  assert.equal(receipt.coordination.status, 'disjoint');
  assert.equal(receipt.intent, 'test disjoint write');
  assert.deepEqual(receipt.touchedRanges, ['E10:F12']);

  // A range on another sheet is provably disjoint.
  const other = await service.save('book.xlsx', cleanBytes, undefined, {
    ...agent,
    touchedRanges: ['Elsewhere!A1:C3'],
  });
  assert.equal(other.coordination.status, 'disjoint');

  // No live canvas (context cleared) -> allowed, recorded as such.
  service.context.clear('book.xlsx', 1);
  const free = await service.save('book.xlsx', noFormulaBytes, undefined, {
    ...agent,
    touchedRanges: ['A1:C3'],
  });
  assert.equal(free.coordination.status, 'no-live-canvas');
});

// ---- Context bus ------------------------------------------------------------

test('context bus: stale epochs and out-of-order events are rejected; latest wins', () => {
  const bus = createContextBus();
  const base = {
    activeSheet: 'Sheet1',
    selection: 'A1:A1',
    occupiedCell: 'A1',
    focused: true,
    dirty: false,
  };

  assert.equal(bus.report('b.xlsx', { ...base, epoch: 5, sequence: 1 }).accepted, true);
  assert.equal(bus.report('b.xlsx', { ...base, epoch: 5, sequence: 3 }).accepted, true);
  // Out of order within the epoch.
  assert.equal(bus.report('b.xlsx', { ...base, epoch: 5, sequence: 2 }).accepted, false);
  assert.equal(bus.report('b.xlsx', { ...base, epoch: 5, sequence: 3 }).accepted, false);
  // Stale epoch.
  assert.equal(bus.report('b.xlsx', { ...base, epoch: 4, sequence: 99 }).accepted, false);
  // Newer epoch replaces wholesale.
  assert.equal(bus.report('b.xlsx', { ...base, epoch: 6, sequence: 1, occupiedCell: 'C9' }).accepted, true);
  assert.equal(bus.get('b.xlsx')?.occupiedCell, 'C9');

  // Teardown of an old epoch cannot wipe the newer canvas's state.
  bus.clear('b.xlsx', 5);
  assert.ok(bus.get('b.xlsx'));
  bus.clear('b.xlsx', 6);
  assert.equal(bus.get('b.xlsx'), null);
});

test('context bus: reveal commands queue bounded and drain once', () => {
  const bus = createContextBus();
  for (let i = 0; i < 20; i += 1) bus.requestReveal('b.xlsx', `A${i + 1}`);
  const drained = bus.drainCommands('b.xlsx');
  assert.equal(drained.length, 16, 'queue is bounded; oldest dropped');
  assert.equal(drained.at(-1)?.range, 'A20');
  assert.equal(drained[0]?.kind, 'reveal');
  assert.deepEqual(bus.drainCommands('b.xlsx'), [], 'drain removes what it returns');
});

test('context bus: range parsing and occupied-cell coverage', () => {
  assert.deepEqual(parseRange("'My Sheet'!B2:C4"), {
    sheet: 'My Sheet',
    startRow: 2,
    startCol: 2,
    endRow: 4,
    endCol: 3,
  });
  assert.equal(parseRange('nonsense!!'), null);
  const cell = parseRange('B2')!;
  assert.equal(rangeCoversCell(parseRange('A1:C3')!, cell, 'Sheet1'), true);
  assert.equal(rangeCoversCell(parseRange('Sheet1!A1:C3')!, cell, 'Sheet1'), true);
  assert.equal(rangeCoversCell(parseRange('Other!A1:C3')!, cell, 'Sheet1'), false);
  assert.equal(rangeCoversCell(parseRange('D4:E5')!, cell, 'Sheet1'), false);
});

// ---- Dependency trace -------------------------------------------------------

test('trace: bounded old-vs-new cascade from declared seeds', async () => {
  const trace = await traceDependencies({
    beforeBytes: cleanBytes,
    afterBytes: cleanBytes,
    touchedRanges: ['A1'],
  });
  assert.equal(trace.status, 'traced');
  if (trace.status !== 'traced') return;
  assert.deepEqual(trace.seeds, ['Sheet1!A1']);
  const addresses = trace.cells.map((cell) => cell.address);
  assert.deepEqual(addresses, ['A1', 'A2', 'A3'], 'the cascade follows A1 -> A2 -> A3');
  assert.ok(trace.cells.every((cell) => !cell.changed), 'identical revisions change nothing');
  assert.equal(trace.truncated, false);
});

test('trace: the cascade truncates at its cap and says so', async () => {
  const trace = await traceDependencies({
    beforeBytes: null,
    afterBytes: cleanBytes,
    touchedRanges: ['A1'],
    cellCap: 1,
  });
  assert.equal(trace.status, 'traced');
  if (trace.status !== 'traced') return;
  assert.equal(trace.truncated, true);
  assert.equal(trace.visited, 1);
  assert.ok(trace.limitations.some((note) => /no prior revision/.test(note)));
});

test('trace: unparseable touched ranges are a typed unavailable, not a guess', async () => {
  const trace = await traceDependencies({
    beforeBytes: null,
    afterBytes: cleanBytes,
    touchedRanges: ['%%%'],
  });
  assert.deepEqual(trace.status, 'unavailable');
});
