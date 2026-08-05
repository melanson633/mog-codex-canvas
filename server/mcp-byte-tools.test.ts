/**
 * Byte-first MCP tools: profile_workbook and read_range.
 *
 * These tools exist so an agent can orient on a workbook in milliseconds while
 * the canvas renderer is still hydrating — so the tests run without the engine
 * on purpose, over a hand-authored OOXML fixture written straight into the
 * temp root. Driven through a real MCP client over an in-memory transport,
 * against the real server and service.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createWorkbookService } from './workbook-service.ts';
import { createMogCanvasServer } from './mcp/mog-canvas-server.ts';

// ---- Fixture builder --------------------------------------------------------

/** Rebuild a ZIP with stored (uncompressed) entries — enough for the reader. */
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

const part = (name: string, xml: string) => ({ name, data: Buffer.from(xml) });

/** One sheet "Model" with a value, a formula, and a cross-sheet formula. */
const fixtureBytes = writeZipStored([
  part(
    'xl/workbook.xml',
    '<workbook><sheets>' +
      '<sheet name="Model" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Data" sheetId="2" r:id="rId2"/>' +
      '</sheets></workbook>',
  ),
  part(
    'xl/_rels/workbook.xml.rels',
    '<Relationships>' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
      '</Relationships>',
  ),
  part(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData>' +
      '<row r="1"><c r="A1"><v>5</v></c></row>' +
      '<row r="2"><c r="A2"><f>Data!B1*2</f><v>10</v></c></row>' +
      '</sheetData></worksheet>',
  ),
  part(
    'xl/worksheets/sheet2.xml',
    '<worksheet><sheetData><row r="1"><c r="B1"><v>5</v></c></row></sheetData></worksheet>',
  ),
]);

// ---- Harness ----------------------------------------------------------------

interface Harness {
  readonly root: string;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  payload<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

async function harness(t: { after(fn: () => Promise<void> | void): void }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'mog-byte-tools-'));
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
    root,
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

// ---- Tests ------------------------------------------------------------------

test('mcp: profile_workbook answers from bytes with provenance, engine-free', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'book.xlsx'), fixtureBytes);

  const result = await h.payload<{
    revision: string;
    profile: { status: string; sheets: { name: string }[]; formulas: number; genreBasis: string };
    provenance: string;
    fidelity: unknown;
  }>('profile_workbook', { name: 'book.xlsx' });

  assert.equal(result.profile.status, 'profiled');
  assert.deepEqual(
    result.profile.sheets.map((sheet) => sheet.name),
    ['Model', 'Data'],
  );
  assert.equal(result.profile.formulas, 1);
  assert.equal(result.revision.length, 64);
  // The provenance label must travel with the numbers, verbatim.
  assert.match(result.provenance, /as-saved at revision/);
  assert.match(result.provenance, /not unsaved canvas edits/);
  // The genre guess never travels without its uncalibrated basis.
  assert.match(result.profile.genreBasis, /uncalibrated/i);
  // No fidelity verdict exists for this revision — null, never fabricated.
  assert.equal(result.fidelity, null);
});

test('mcp: profile_workbook reports unreadable bytes as typed unknown', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'broken.xlsx'), 'this is not a zip archive');

  const result = await h.payload<{ profile: { status: string; reason: string } }>(
    'profile_workbook',
    { name: 'broken.xlsx' },
  );
  assert.equal(result.profile.status, 'unreadable');
  assert.ok(result.profile.reason.length > 0);
});

test('mcp: read_range returns as-saved values and formula text', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'book.xlsx'), fixtureBytes);

  const result = await h.payload<{
    read: {
      status: string;
      cells: { address: string; value: unknown; formula: string | null }[];
    };
    provenance: string;
  }>('read_range', { name: 'book.xlsx', sheet: 'Model', range: 'A1:A2' });

  assert.equal(result.read.status, 'ok');
  assert.deepEqual(result.read.cells, [
    { address: 'A1', value: 5, formula: null, isError: false },
    { address: 'A2', value: 10, formula: 'Data!B1*2', isError: false },
  ]);
  assert.match(result.provenance, /as-saved at revision/);
});

test('mcp: read_range failures are typed, not thrown prose', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'book.xlsx'), fixtureBytes);

  const missing = await h.payload<{ read: { status: string; reason: string } }>('read_range', {
    name: 'book.xlsx',
    sheet: 'NoSuchSheet',
    range: 'A1:A1',
  });
  assert.equal(missing.read.status, 'no-such-sheet');
  assert.match(missing.read.reason, /Model/); // names the sheets that do exist

  const bad = await h.payload<{ read: { status: string } }>('read_range', {
    name: 'book.xlsx',
    sheet: 'Model',
    range: 'not-a-range',
  });
  assert.equal(bad.read.status, 'bad-range');
});
