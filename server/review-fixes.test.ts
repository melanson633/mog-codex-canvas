/**
 * Regressions for the validated review findings on save concurrency, the
 * fail-closed interlock, context-bus input validation, and the bridge's
 * trusted attribution + teardown rules.
 *
 * Everything runs on isolated temp roots; workbooks/sample.xlsx is never
 * touched. Bridge tests drive the real middleware over a real HTTP server,
 * exactly as the dev app does.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { readZipEntries } from './ooxml-cache.ts';
import { createContextBus } from './context-bus.ts';
import { createBridgeHandler } from './file-bridge.ts';
import { WorkbookError, createWorkbookService, revisionOf } from './workbook-service.ts';

// ---- Fixtures (same construction as trust-features.test.ts) -----------------

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

/** Cached 20, engine #NAME? — the deterministic fidelity-refusal shape. */
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

const baseBytes = await makeXlsx({ A1: 1, A2: '=A1*2' });
const editOneBytes = await makeXlsx({ A1: 2, A2: '=A1*2' });
const editTwoBytes = await makeXlsx({ A1: 3, A2: '=A1*2' });
const mismatchBytes = tamperForMismatch(baseBytes);

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mog-review-'));
}

// ---- Save concurrency -------------------------------------------------------

test('save: concurrent saves against the same revision — one wins, one preserved conflict', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });

  const first = await service.save('book.xlsx', baseBytes);

  const results = await Promise.allSettled([
    service.save('book.xlsx', editOneBytes, first.revision),
    service.save('book.xlsx', editTwoBytes, first.revision),
  ]);
  const wins = results.filter((r) => r.status === 'fulfilled');
  const losses = results.filter((r) => r.status === 'rejected');
  assert.equal(wins.length, 1, 'exactly one concurrent save may promote');
  assert.equal(losses.length, 1, 'the other must be refused, not silently lost');

  const loss = (losses[0] as PromiseRejectedResult).reason as WorkbookError;
  assert.ok(loss instanceof WorkbookError);
  assert.equal(loss.code, 'revision-conflict');

  // The loser's bytes were preserved, byte-for-byte.
  const conflictFile = loss.details.conflictFile as string;
  assert.match(conflictFile, /^book\.conflict-.*\.xlsx$/);
  const parked = await readFile(join(root, conflictFile));
  const winnerBytes = (wins[0] as PromiseFulfilledResult<{ revision: string }>).value.revision;
  const loserExpected = winnerBytes === revisionOf(editOneBytes) ? editTwoBytes : editOneBytes;
  assert.deepEqual(parked, loserExpected);

  // The winner's bytes are what is on disk.
  assert.equal(revisionOf(await readFile(join(root, 'book.xlsx'))), winnerBytes);
});

test('save: two sessions sharing a workbook — the second save is a typed conflict', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });

  await service.save('book.xlsx', baseBytes);
  const a = await service.openSession('book.xlsx');
  const b = await service.openSession('book.xlsx');

  await service.saveSession(a.sessionId, editOneBytes);

  try {
    await service.saveSession(b.sessionId, editTwoBytes);
    assert.fail('the stale session must not overwrite the newer save');
  } catch (error) {
    assert.ok(error instanceof WorkbookError);
    assert.equal(error.code, 'revision-conflict');
    assert.equal(error.details.expectedRevision, b.revision);
    assert.equal(error.details.actualRevision, revisionOf(editOneBytes));
  }
  assert.deepEqual(await readFile(join(root, 'book.xlsx')), editOneBytes);
});

// ---- Fail-closed interlock --------------------------------------------------

test('interlock: an unparseable occupied cell fails closed, not open', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorkbookService({ root });
  await service.save('book.xlsx', baseBytes);

  // A live canvas reporting a position this service cannot parse.
  assert.equal(
    service.context.report('book.xlsx', {
      epoch: 1,
      sequence: 1,
      activeSheet: 'Sheet1',
      selection: null,
      occupiedCell: '###not-a-cell###',
      focused: true,
      dirty: false,
    }).accepted,
    true,
  );

  try {
    await service.save('book.xlsx', editOneBytes, undefined, {
      lane: 'headless',
      actor: { kind: 'agent', id: 'test' },
      touchedRanges: ['Z99'],
    });
    assert.fail('disjointness cannot be proven, so the save must be refused');
  } catch (error) {
    assert.ok(error instanceof WorkbookError);
    assert.equal(error.code, 'occupied-cell-conflict');
    assert.equal(error.details.retryable, true);
    assert.equal(error.details.occupiedCell, '###not-a-cell###');
  }
  assert.deepEqual(await readFile(join(root, 'book.xlsx')), baseBytes, 'nothing was written');
});

// ---- Context bus input validation ------------------------------------------

test('context bus: non-finite epochs and sequences are rejected with a reason', () => {
  const bus = createContextBus();
  const base = {
    activeSheet: 'Sheet1',
    selection: 'A1:A1',
    occupiedCell: 'A1',
    focused: true,
    dirty: false,
  };

  for (const bad of [NaN, Infinity, -Infinity]) {
    const byEpoch = bus.report('b.xlsx', { ...base, epoch: bad, sequence: 1 });
    assert.equal(byEpoch.accepted, false);
    assert.match((byEpoch as { reason: string }).reason, /finite/);
    const bySequence = bus.report('b.xlsx', { ...base, epoch: 1, sequence: bad });
    assert.equal(bySequence.accepted, false);
  }

  // A malformed clear proves ownership of nothing and clears nothing.
  assert.equal(bus.report('b.xlsx', { ...base, epoch: 3, sequence: 1 }).accepted, true);
  bus.clear('b.xlsx', NaN);
  bus.clear('b.xlsx', Infinity);
  assert.equal(bus.get('b.xlsx')?.epoch, 3, 'non-finite epochs must not tear down live state');
  bus.clear('b.xlsx', 3);
  assert.equal(bus.get('b.xlsx'), null);
});

// ---- Bridge attribution + teardown rules ------------------------------------

test('bridge: trusted attribution, epoch-gated teardown, structured refusals', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'mog-review-bridge-'));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  });
  const handler = createBridgeHandler({ root: base });
  const server: Server = createServer((req, res) => {
    handler(req, res, () => res.writeHead(418).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // PUT ignores actor/lane query spoofing: the receipt is human/canvas.
  const put = await fetch(
    `${origin}/api/workbook?path=book.xlsx&actor=agent&actorId=spoofer&lane=headless&touched=A1`,
    { method: 'PUT', body: new Uint8Array(baseBytes) },
  );
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { transactionId: string };
  const receipt = (await (await fetch(`${origin}/api/receipt?id=${saved.transactionId}`)).json()) as {
    actor: { kind: string; id: string };
    lane: string;
    touchedRanges: string[] | null;
  };
  assert.deepEqual(receipt.actor, { kind: 'human', id: 'dev-canvas' });
  assert.equal(receipt.lane, 'canvas');
  assert.equal(receipt.touchedRanges, null, 'query params cannot inject agent metadata');

  // A fidelity refusal travels as a structured 409 carrying the full report.
  const refused = await fetch(`${origin}/api/workbook?path=bad.xlsx`, {
    method: 'PUT',
    body: new Uint8Array(mismatchBytes),
  });
  assert.equal(refused.status, 409);
  const refusal = (await refused.json()) as {
    code: string;
    fidelity: { status: string; mismatches: unknown[] };
  };
  assert.equal(refusal.code, 'fidelity-mismatch');
  assert.equal(refusal.fidelity.status, 'failed');
  assert.ok(refusal.fidelity.mismatches.length > 0);

  // Presence reports: accepted, then out-of-order -> 409 with a reason.
  const snapshot = {
    epoch: 5,
    sequence: 2,
    activeSheet: 'Sheet1',
    selection: 'A1:A1',
    occupiedCell: 'A1',
    focused: true,
    dirty: false,
  };
  const ok = await fetch(`${origin}/api/context?path=book.xlsx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  assert.equal(ok.status, 200);
  const stale = await fetch(`${origin}/api/context?path=book.xlsx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...snapshot, sequence: 1 }),
  });
  assert.equal(stale.status, 409);
  const staleBody = (await stale.json()) as { accepted: boolean; reason: string };
  assert.equal(staleBody.accepted, false);
  assert.match(staleBody.reason, /out-of-order/);

  // Teardown without a provable epoch is refused; the context survives.
  for (const query of ['', '&epoch=', '&epoch=abc', '&epoch=Infinity']) {
    const del = await fetch(`${origin}/api/context?path=book.xlsx${query}`, { method: 'DELETE' });
    assert.equal(del.status, 400, `epoch ${JSON.stringify(query)} must be refused`);
  }
  const still = (await (await fetch(`${origin}/api/context?path=book.xlsx`)).json()) as {
    context: { epoch: number } | null;
  };
  assert.equal(still.context?.epoch, 5);

  // The owning epoch tears down cleanly.
  const del = await fetch(`${origin}/api/context?path=book.xlsx&epoch=5`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = (await (await fetch(`${origin}/api/context?path=book.xlsx`)).json()) as {
    context: unknown;
  };
  assert.equal(gone.context, null);
});
