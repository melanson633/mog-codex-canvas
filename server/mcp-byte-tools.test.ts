/**
 * Byte-first MCP tools: profile_workbook, read_range, graph_workbook,
 * describe_sheet_data, and brief_workbook.
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
import { datasetFixture, mixedFixture, modelFixture } from './test-fixtures.ts';

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
  /** Tool names the server advertises, so registration is proven, not assumed. */
  tools(): Promise<string[]>;
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
    async tools(): Promise<string[]> {
      const listed = await client.listTools();
      return listed.tools.map((tool) => tool.name);
    },
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

// ---- The staged pipeline on the wire ---------------------------------------

/** Prose summary of a tool call — the text an agent reads before the payload. */
async function summary(h: Harness, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await h.call(name, args);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const text = (result.content as { type: string; text?: string }[]).find(
    (item) => item.type === 'text',
  )?.text;
  assert.ok(text, 'tool returned no text summary');
  return text;
}

/** The structured error body a refused call carries. */
async function refusal(h: Harness, name: string, args: Record<string, unknown>) {
  const result = await h.call(name, args);
  assert.equal(result.isError, true, `${name} was not refused`);
  const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '{}';
  return JSON.parse(text) as { code: string; message: string };
}

interface GraphPayloadShape {
  readonly graph: {
    readonly status: string;
    readonly nodes: number;
    readonly includedSheets: readonly string[];
    readonly skipped: readonly { name: string; role: string; basis: string }[];
    readonly reason?: string;
    readonly target: {
      readonly node: string;
      readonly precedents: readonly { kind: string; sheet: string; ref?: string; address?: string }[];
      readonly dependents: readonly string[];
      readonly transitiveDependents: {
        readonly reached: readonly { node: string; hops: number }[];
        readonly truncated: boolean;
        readonly truncationReason: string | null;
      } | null;
    } | null;
  };
  readonly provenance: string;
}

interface DescribePayloadShape {
  readonly description: {
    readonly status: string;
    readonly sheet?: string;
    readonly sheets?: readonly string[];
    readonly reason?: string;
    readonly columns: readonly {
      readonly header: string;
      readonly redacted: boolean;
      readonly redactionReason: string | null;
      readonly rowCount: number | null;
      readonly min: unknown;
      readonly max: unknown;
      readonly distinctCount: number | null;
      readonly depth: string;
    }[];
  };
  readonly provenance: string;
}

test('mcp: the new tools carry the same provenance wording as profile_workbook', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'model.xlsx'), modelFixture());

  const profile = await h.payload<{ provenance: string }>('profile_workbook', {
    name: 'model.xlsx',
  });
  const graph = await h.payload<GraphPayloadShape>('graph_workbook', { name: 'model.xlsx' });
  const described = await h.payload<DescribePayloadShape>('describe_sheet_data', {
    name: 'model.xlsx',
    sheet: 'Data',
  });

  // Verbatim, not merely similar: one wording for "what these numbers describe".
  assert.equal(graph.provenance, profile.provenance);
  assert.equal(described.provenance, profile.provenance);
  assert.match(profile.provenance, /as-saved at revision/);
});

test('mcp: every new tool summary restates the provenance in its prose', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'model.xlsx'), modelFixture());
  const { provenance } = await h.payload<{ provenance: string }>('profile_workbook', {
    name: 'model.xlsx',
  });

  // The summary is what an agent reads first; the caveat must not live only in
  // the payload it may never open.
  assert.ok((await summary(h, 'graph_workbook', { name: 'model.xlsx' })).includes(provenance));
  assert.ok(
    (await summary(h, 'describe_sheet_data', { name: 'model.xlsx', sheet: 'Data' })).includes(
      provenance,
    ),
  );
});

test('mcp: graph_workbook answers precedents and dependents for a target cell', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'model.xlsx'), modelFixture());

  const result = await h.payload<GraphPayloadShape>('graph_workbook', {
    name: 'model.xlsx',
    target: 'Estimate!B66',
  });
  assert.equal(result.graph.status, 'built');
  const target = result.graph.target;
  assert.ok(target, 'no target block');
  assert.equal(target.node, 'Estimate!B66');
  // SUM(Data!B2:B10) stays a rectangle — KTD4, never expanded into nine cells.
  assert.deepEqual(
    target.precedents.map((precedent) => `${precedent.kind}:${precedent.sheet}!${precedent.ref ?? precedent.address}`),
    ['range:Data!B2:B10'],
  );
  assert.deepEqual([...target.dependents].sort(), ['Estimate!C66', 'Summary!F20']);
  // No hop bound was asked for, so none is invented.
  assert.equal(target.transitiveDependents, null);
  // Dataset sheets are named as skipped, so absence never reads as emptiness.
  assert.ok(result.graph.skipped.some((sheet) => sheet.name === 'Data'));
});

test('mcp: graph_workbook returns hop distances when a hop bound is given', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'model.xlsx'), modelFixture());

  const result = await h.payload<GraphPayloadShape>('graph_workbook', {
    name: 'model.xlsx',
    target: 'Estimate!B66',
    maxHops: 2,
  });
  const reached = result.graph.target?.transitiveDependents?.reached ?? [];
  assert.deepEqual(
    reached.map((node) => [node.node, node.hops]).sort(),
    [
      ['Estimate!C66', 1],
      ['Summary!F20', 1],
    ],
  );
});

test('mcp: describe_sheet_data redacts payroll columns and returns no raw values', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'data.xlsx'), datasetFixture());

  const result = await h.payload<DescribePayloadShape>('describe_sheet_data', {
    name: 'data.xlsx',
    sheet: 'Raw',
  });
  assert.equal(result.description.status, 'described');
  const byHeader = new Map(result.description.columns.map((column) => [column.header, column]));
  for (const header of ['SSN', 'Date of Birth', 'Employee ID']) {
    const column = byHeader.get(header);
    assert.ok(column, `no column headed ${header}`);
    assert.equal(column.redacted, true);
    assert.ok((column.redactionReason ?? '').length > 0, `${header} redacted without a reason`);
    // Redaction is reported, not silently emptied: the shape stays, the
    // statistics that could re-identify a person never appear.
    assert.equal(column.min, null);
    assert.equal(column.max, null);
    assert.equal(column.distinctCount, null);
  }
  // R39 structurally: no cell value from the fixture reaches the wire.
  const wire = JSON.stringify(result);
  for (const value of ['123-45-6', '987-65-4', 'Row 1', 'note 3']) {
    assert.ok(!wire.includes(value), `raw value ${value} crossed the tool boundary`);
  }
});

test('mcp: the depth override lifts the materiality gate but never redaction', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'data.xlsx'), datasetFixture());

  const result = await h.payload<DescribePayloadShape>('describe_sheet_data', {
    name: 'data.xlsx',
    sheet: 'Raw',
    override: true,
  });
  const byHeader = new Map(result.description.columns.map((column) => [column.header, column]));
  // A column nothing consumes is profiled in full when the caller insists...
  assert.equal(byHeader.get('Notes')?.depth, 'full');
  assert.equal(byHeader.get('Notes')?.rowCount, 3000);
  // ...and the high-risk column is still redacted. The override is not a key.
  assert.equal(byHeader.get('SSN')?.redacted, true);
  assert.equal(byHeader.get('SSN')?.min, null);
});

test('mcp: describe_sheet_data names the sheets that do exist when one is missing', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'data.xlsx'), datasetFixture());

  const result = await h.payload<DescribePayloadShape>('describe_sheet_data', {
    name: 'data.xlsx',
    sheet: 'NoSuchSheet',
  });
  assert.equal(result.description.status, 'no-such-sheet');
  assert.deepEqual(result.description.sheets, ['Raw', 'Rollup']);
});

test('mcp: the new tools report unreadable bytes as typed unknown, not a throw', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'broken.xlsx'), 'this is not a zip archive');

  const graph = await h.payload<GraphPayloadShape>('graph_workbook', { name: 'broken.xlsx' });
  assert.equal(graph.graph.status, 'unreadable');
  assert.ok((graph.graph.reason ?? '').length > 0);

  const described = await h.payload<DescribePayloadShape>('describe_sheet_data', {
    name: 'broken.xlsx',
    sheet: 'Raw',
  });
  assert.equal(described.description.status, 'unreadable');
  assert.ok((described.description.reason ?? '').length > 0);
});

test('mcp: a path outside the root is refused with the same code as the older tools', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'model.xlsx'), modelFixture());

  const escape = '../outside.xlsx';
  const baseline = await refusal(h, 'profile_workbook', { name: escape });
  assert.equal(baseline.code, 'invalid-path');
  assert.equal((await refusal(h, 'graph_workbook', { name: escape })).code, baseline.code);
  assert.equal(
    (await refusal(h, 'describe_sheet_data', { name: escape, sheet: 'Raw' })).code,
    baseline.code,
  );
});

test('mcp: profile_workbook now carries metadata without disturbing its old fields', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'model.xlsx'), modelFixture());

  const result = await h.payload<{
    profile: { status: string; sheets: { name: string }[]; genreBasis: string };
    metadata: {
      status: string;
      definedNames: readonly { name: string; scope: string | null }[];
      document: { creator: string | null };
    };
    provenance: string;
  }>('profile_workbook', { name: 'model.xlsx' });

  // The additive block.
  assert.equal(result.metadata.status, 'extracted');
  assert.deepEqual(
    result.metadata.definedNames.map((entry) => entry.name).sort(),
    ['LocalBox', 'TaxRate'],
  );
  // Everything the tool already promised is unchanged.
  assert.equal(result.profile.status, 'profiled');
  assert.equal(result.profile.sheets.length, 5);
  assert.match(result.profile.genreBasis, /uncalibrated/i);
  assert.match(result.provenance, /as-saved at revision/);
});

/** What `brief_workbook` puts on the wire: composed sections, no closures. */
interface BriefPayloadShape {
  readonly name: string;
  readonly provenance: string;
  readonly briefing: {
    readonly status: string;
    readonly provenance: string;
    readonly identity: { readonly id: string; readonly genreHint: string | null };
    readonly consumption: { readonly id: string };
    readonly sheets: readonly {
      readonly id: string;
      readonly sheet: string;
      readonly role: string;
      readonly roleBasis: string;
      readonly dataset: { readonly columns: readonly { readonly redacted: boolean }[] } | null;
      readonly model: { readonly maxDepth: number } | null;
      readonly notRun: readonly { readonly stage: string; readonly reason: string }[];
    }[];
    readonly anomalies: readonly { readonly kind: string }[];
    readonly latency: { readonly totalMs: number };
    readonly summary: string;
  };
}

test('mcp: brief_workbook composes the staged pipeline into sections and prose', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'mixed.xlsx'), mixedFixture());

  const tools = await h.tools();
  assert.ok(tools.includes('brief_workbook'), 'brief_workbook is not registered');

  // One call, both halves: the prose and the payload have to agree with each
  // other, and the measured latency they both quote changes between calls.
  const call = await h.call('brief_workbook', { name: 'mixed.xlsx' });
  assert.equal(call.isError, undefined, JSON.stringify(call.content));
  const text = (call.content as { type: string; text?: string }[]).find(
    (item) => item.type === 'text',
  )?.text;
  assert.ok(text, 'brief_workbook returned no prose summary');
  const result = (call.structuredContent ?? {}) as unknown as BriefPayloadShape;
  const briefing = result.briefing;
  assert.equal(briefing.status, 'briefed');

  // One section per sheet, each keyed to its own measured role — never to the
  // workbook genre, which the identity section reports as a hint and nothing
  // downstream reads.
  const roles = new Map(briefing.sheets.map((sheet) => [sheet.sheet, sheet.role]));
  assert.ok(roles.size >= 2, 'the briefing lost sheets');
  assert.ok([...roles.values()].some((role) => role !== [...roles.values()][0]),
    'every sheet got the same role, so the section keying proves nothing');
  for (const sheet of briefing.sheets) {
    assert.ok(sheet.roleBasis.length > 0, `${sheet.sheet} carries no role basis`);
    assert.equal(sheet.id, `sheet.${sheet.sheet}`);
    // Unknown is stated, never left as an absence.
    if (!sheet.dataset) assert.ok(sheet.notRun.some((entry) => entry.stage === 'stage-3'));
    if (!sheet.model) assert.ok(sheet.notRun.some((entry) => entry.stage === 'stage-2b'));
  }

  // The prose an agent reads first carries the as-saved provenance verbatim.
  assert.ok(text.includes(result.provenance), 'the summary dropped the provenance');
  assert.equal(briefing.provenance, result.provenance);
  assert.ok(text.includes(briefing.summary), 'the summary and the payload prose disagree');

  // Nothing survived the wire that a closure would have: the payload is data.
  const wire = JSON.stringify(result);
  assert.ok(!wire.includes('function'), 'a function leaked into the payload');
});
