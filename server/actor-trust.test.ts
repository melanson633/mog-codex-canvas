/**
 * Actor-identity trust at the MCP boundary.
 *
 * The review finding these tests pin down: actor identity must be decided by
 * trusted process code, never by tool arguments. `save_workbook` (the model's
 * lane) is always an agent transaction with mandatory touchedRanges;
 * `save_workbook_canvas` (component-only) is always a human transaction; and
 * session teardown clears only the context epoch its own canvas reported.
 *
 * Driven through a real MCP client over an in-memory transport, against the
 * real server and service on an isolated temp root — never sample.xlsx.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createWorkbookService, type WorkbookService } from './workbook-service.ts';
import { createMogCanvasServer } from './mcp/mog-canvas-server.ts';

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

const cleanBytes = await makeXlsx({ A1: 10, A2: '=A1*2' });
const editedBytes = await makeXlsx({ A1: 11, A2: '=A1*2' });

interface Harness {
  readonly service: WorkbookService;
  readonly client: Client;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Unwraps structuredContent; throws the parsed error body on isError. */
  payload<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

async function harness(t: { after(fn: () => Promise<void> | void): void }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'mog-actor-'));
  const service = createWorkbookService({ root });
  const server = createMogCanvasServer({ service, assetOrigin: 'http://127.0.0.1:1' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return {
    service,
    client,
    call,
    async payload<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const result = await call(name, args);
      if (result.isError) {
        const text = (result.content as { type: string; text?: string }[] | undefined)?.find(
          (item) => item.type === 'text',
        )?.text;
        throw new Error(text ?? 'tool failed');
      }
      return (result.structuredContent ?? {}) as T;
    },
  };
}

function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

test('mcp: save_workbook is always an agent save and requires touchedRanges', async (t) => {
  const h = await harness(t);
  await h.service.save('book.xlsx', cleanBytes);
  const opened = await h.payload<{ sessionId: string }>('open_workbook', { name: 'book.xlsx' });

  // Missing touchedRanges is refused at the schema, before any service code.
  const missing = await h.call('save_workbook', {
    sessionId: opened.sessionId,
    xlsxBase64: b64(editedBytes),
  });
  assert.equal(missing.isError, true, 'touchedRanges must be required');

  // An empty list is refused too.
  const empty = await h.call('save_workbook', {
    sessionId: opened.sessionId,
    xlsxBase64: b64(editedBytes),
    touchedRanges: [],
  });
  assert.equal(empty.isError, true, 'an empty touchedRanges list must be refused');

  // A spoofed actorKind argument cannot demote the save to human: the receipt
  // records an agent regardless of what the caller claims.
  const saved = await h.payload<{ transactionId: string }>('save_workbook', {
    sessionId: opened.sessionId,
    xlsxBase64: b64(editedBytes),
    actorKind: 'human',
    actorId: 'spoofer',
    touchedRanges: ['A1:B2'],
  });
  const receipt = await h.service.getReceipt(saved.transactionId);
  assert.deepEqual(receipt.actor, { kind: 'agent', id: 'spoofer' });
  assert.equal(receipt.lane, 'mcp');
  assert.deepEqual(receipt.touchedRanges, ['A1:B2']);
});

test('mcp: save_workbook honors the occupied-cell interlock; save_workbook_canvas is the human lane', async (t) => {
  const h = await harness(t);
  await h.service.save('book.xlsx', cleanBytes);
  const opened = await h.payload<{ sessionId: string }>('open_workbook', { name: 'book.xlsx' });

  // The human canvas occupies A1.
  await h.payload('report_canvas_context', {
    sessionId: opened.sessionId,
    epoch: 1,
    sequence: 1,
    activeSheet: 'Sheet1',
    selection: 'A1:A1',
    occupiedCell: 'A1',
    focused: true,
    dirty: true,
  });

  // The agent lane cannot write under the human.
  const refused = await h.call('save_workbook', {
    sessionId: opened.sessionId,
    xlsxBase64: b64(editedBytes),
    touchedRanges: ['A1:B2'],
  });
  assert.equal(refused.isError, true);
  const body = JSON.parse(
    (refused.content as { type: string; text: string }[])[0].text,
  ) as { code: string };
  assert.equal(body.code, 'occupied-cell-conflict');

  // The human canvas lane saves the same region without declaring ranges — it
  // IS the occupant — and the receipt attributes it in trusted process code.
  const saved = await h.payload<{ transactionId: string }>('save_workbook_canvas', {
    sessionId: opened.sessionId,
    xlsxBase64: b64(editedBytes),
  });
  const receipt = await h.service.getReceipt(saved.transactionId);
  assert.deepEqual(receipt.actor, { kind: 'human', id: 'mcp-canvas' });
  assert.equal(receipt.lane, 'canvas');
  assert.equal(receipt.coordination.status, 'not-applicable');
});

test('mcp: close_workbook_session clears only its own canvas epoch', async (t) => {
  const h = await harness(t);
  await h.service.save('book.xlsx', cleanBytes);
  const a = await h.payload<{ sessionId: string }>('open_workbook', { name: 'book.xlsx' });
  const b = await h.payload<{ sessionId: string }>('open_workbook', { name: 'book.xlsx' });

  const base = {
    activeSheet: 'Sheet1',
    selection: 'B2:B2',
    occupiedCell: 'B2',
    focused: true,
    dirty: false,
  };
  await h.payload('report_canvas_context', { sessionId: a.sessionId, epoch: 1, sequence: 1, ...base });
  // Session B's canvas mounted later and owns the current context.
  await h.payload('report_canvas_context', { sessionId: b.sessionId, epoch: 2, sequence: 1, ...base });

  // Closing A tears down only epoch 1 — B's live presence survives.
  await h.payload('close_workbook_session', { sessionId: a.sessionId });
  assert.equal(h.service.context.get('book.xlsx')?.epoch, 2, "closing A must not erase B's context");

  // Closing B (the owner) removes it.
  await h.payload('close_workbook_session', { sessionId: b.sessionId });
  assert.equal(h.service.context.get('book.xlsx'), null);
});

test('mcp: a session that never reported presence clears nothing on close', async (t) => {
  const h = await harness(t);
  await h.service.save('book.xlsx', cleanBytes);
  const silent = await h.payload<{ sessionId: string }>('open_workbook', { name: 'book.xlsx' });

  // Someone else's canvas is live on the same workbook (reported directly).
  h.service.context.report('book.xlsx', {
    epoch: 7,
    sequence: 1,
    activeSheet: 'Sheet1',
    selection: 'C3:C3',
    occupiedCell: 'C3',
    focused: true,
    dirty: false,
  });

  await h.payload('close_workbook_session', { sessionId: silent.sessionId });
  assert.equal(
    h.service.context.get('book.xlsx')?.occupiedCell,
    'C3',
    'a silent session owns no epoch and must not clear anyone else',
  );
});
