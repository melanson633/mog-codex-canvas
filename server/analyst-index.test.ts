import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalystIndex } from './analyst-index.ts';
import { part, writeZipStored } from './test-fixtures.ts';
import { revisionOf } from './workbook-revision.ts';
import type { createWorkbookService } from './workbook-service.ts';

function fixture(body: string) {
  return writeZipStored([
    part('xl/workbook.xml', '<workbook><sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${body}</sheetData></worksheet>`),
  ]);
}
const value = (address: string, n: number) => `<c r="${address}"><v>${n}</v></c>`;
const formula = (address: string, f: string) => `<c r="${address}"><f>${f}</f><v>10</v></c>`;
function harness(initial: Buffer) {
  let bytes = initial;
  let reads = 0;
  const service = { read: async () => { reads++; return { bytes, revision: revisionOf(bytes) }; } } as unknown as ReturnType<typeof createWorkbookService>;
  return { index: createAnalystIndex(service), replace: (next: Buffer) => { bytes = next; }, reads: () => reads };
}

test('index checks fresh bytes, reuses derived context, clones output and invalidates by revision', async () => {
  const h = harness(fixture(value('A1', 2) + formula('B1', 'A1*5')));
  const first = await h.index.context('model.xlsx', 'Model', 'A1:B1');
  assert.equal(first.cache.hit, false);
  first.cells[0] = { address: 'A1', value: 999, formula: null, isError: false };
  const second = await h.index.context('model.xlsx', 'Model', 'A1:B1');
  assert.equal(second.cache.hit, true);
  assert.equal(second.cells[0].value, 2);
  assert.equal(h.reads(), 2);
  h.replace(fixture(value('A1', 3) + formula('B1', 'A1*5')));
  const changed = await h.index.context('model.xlsx', 'Model', 'A1:B1');
  assert.equal(changed.cache.hit, false);
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.cells[0].value, 3);
  for (let n = 4; n < 10; n++) {
    h.replace(fixture(value('A1', n)));
    assert.ok((await h.index.context('model.xlsx', 'Model', 'A1')).cache.entries <= 4);
  }
});

test('explain returns saved precedent evidence and explicitly incomplete coverage', async () => {
  const h = harness(fixture(value('A1', 2) + formula('B1', 'A1*5') + formula('C1', 'Table1[Revenue]')));
  const result = await h.index.explain('model.xlsx', 'Model', 'B1');
  assert.equal(result.status, 'ok');
  assert.equal(result.target?.value, 10);
  assert.equal(result.precedents[0].kind, 'cell');
  assert.equal(result.coverage.complete, false);
  const unresolved = await h.index.explain('model.xlsx', 'Model', 'C1');
  assert.ok(unresolved.unresolved.length > 0);
});

test('explain walks upstream, retains unexpanded ranges, exposes cycles and bounds', async () => {
  const h = harness(fixture(value('A1', 2) + formula('B1', 'A1*5') + formula('C1', 'B1+1') + formula('D1', 'SUM(A1:C1)')));
  const result = await h.index.explain('model.xlsx', 'Model', 'C1');
  assert.deepEqual(result.trace.map(item => [item.node, item.depth]), [['Model!C1', 0], ['Model!B1', 1], ['Model!A1', 2]]);
  assert.equal(result.trace[2].value, 2);
  assert.equal(result.traversal.truncated, false);
  const range = await h.index.explain('model.xlsx', 'Model', 'D1');
  assert.equal(range.traversal.unexpandedRanges, 1);
  assert.equal(range.trace.length, 1);
  const cyclic = harness(fixture(formula('A1', 'B1') + formula('B1', 'A1')));
  assert.deepEqual((await cyclic.index.explain('model.xlsx', 'Model', 'A1')).traversal.cycles, [{ from: 'Model!B1', to: 'Model!A1' }]);
  const deep = harness(fixture(Array.from({ length: 10 }, (_, i) => formula(`A${i + 1}`, `A${i + 2}+1`)).join('')));
  const bounded = await deep.index.explain('model.xlsx', 'Model', 'A1');
  assert.equal(bounded.trace.length, 7);
  assert.equal(bounded.traversal.truncated, true);
  assert.ok(bounded.traversal.reasons.some(reason => reason.includes('six hops')));
  const wide = harness(fixture(formula('A1', Array.from({ length: 110 }, (_, i) => `B${i + 1}`).join('+'))));
  const nodes = await wide.index.explain('model.xlsx', 'Model', 'A1');
  assert.equal(nodes.trace.length, 100);
  assert.equal(nodes.traversal.truncated, true);
});

test('audit normalizes relative and mixed references, flags exceptions and overrides', async () => {
  const h = harness(fixture(
    formula('D2', 'B2*$A$1') + formula('D3', 'B3*$A$1') + formula('D4', 'B4*$A$1') +
    formula('E2', 'B2*C2') + formula('E3', 'B3+C3') + formula('E4', 'B4*C4') +
    formula('F2', '$B2*C$1') + value('F3', 77) + formula('F4', '$B4*C$1') +
    '<c r="G3" t="e"><f>1/0</f><v>#DIV/0!</v></c>'
  ));
  const result = await h.index.audit('model.xlsx', 'Model', 'D2:G4');
  assert.deepEqual(result.findings.map(f => [f.address, f.kind]), [
    ['E3', 'formula-pattern'], ['F3', 'constant-in-formula-run'], ['G3', 'formula-error'],
  ]);
});

test('offset high-risk labels and SSN-shaped values suppress all evidence, including formulas', async () => {
  for (const sensitive of ['Employee_DOB', '123-45-6789']) {
    const h = harness(fixture(value('A1', 42345) + formula('B1', 'A1*2') + `<c r="Z99" t="inlineStr"><is><t>${sensitive}</t></is></c>`));
    const context = await h.index.context('model.xlsx', 'Model', 'A1:B1');
    assert.equal(context.status, 'redacted');
    assert.deepEqual(context.cells, []);
    assert.deepEqual(context.dependencies, []);
    assert.equal((await h.index.explain('model.xlsx', 'Model', 'B1')).target, null);
    assert.deepEqual((await h.index.audit('model.xlsx', 'Model', 'A1:B1')).findings, []);
  }
  for (const richText of ['<r><t>Employee_</t></r><r><t>DOB</t></r>', '<r><t>SS</t></r><r><t>N</t></r>']) {
    const h = harness(fixture(value('A1', 123456) + `<c r="Z99" t="inlineStr"><is>${richText}</is></c>`));
    const result = await h.index.explain('model.xlsx', 'Model', 'A1');
    assert.equal(result.status, 'redacted');
    assert.deepEqual(result.trace, []);
  }
});

test('range and privacy scan bounds fail closed', async () => {
  const h = harness(fixture(value('A1', 1)));
  await assert.rejects(h.index.context('model.xlsx', 'Model', 'A1:Z1000'), /500/);
  await assert.rejects(h.index.explain('model.xlsx', 'Model', 'A1:A2'), /cell/);
  await assert.rejects(h.index.context('model.xlsx', 'Model', 'Other!A1'), /unqualified/);
  const big = harness(fixture(Array.from({ length: 20001 }, (_, i) => value(`A${i + 1}`, i)).join('')));
  const result = await big.index.context('model.xlsx', 'Model', 'A1');
  assert.equal(result.status, 'unreadable');
  assert.deepEqual(result.cells, []);
  assert.ok(result.coverage.limitations.some(item => item.includes('20,000')));
  const missingLabel = harness(fixture('<c r="A1" t="s"><v>99</v></c>' + value('A2', 123456)));
  const guarded = await missingLabel.index.context('model.xlsx', 'Model', 'A1:A2');
  assert.equal(guarded.status, 'unreadable');
  assert.deepEqual(guarded.cells, []);
  for (const address of ['A0', 'XFE1', 'A1048577', 'not-a-cell', '']) {
    const malformed = harness(fixture(`<c r="${address}" t="inlineStr"><is><t>DOB</t></is></c>` + value('A2', 123456)));
    const result = await malformed.index.context('model.xlsx', 'Model', 'A2');
    assert.equal(result.status, 'unreadable');
    assert.deepEqual(result.cells, []);
  }
});
