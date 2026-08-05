/**
 * The intra-workbook dependency graph.
 *
 * Two properties carry most of the weight here. Ranges stay rectangles — a
 * dependent found through `Data!B2:B10` must be found by containment at query
 * time, never by having expanded the range into nine nodes at build time. And
 * what the graph declines to build is reported as a skip with its cause, so a
 * sheet with no edges is distinguishable from a sheet never examined.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDependencyGraph,
  type DependencyGraph,
  type RangePrecedent,
} from './workbook-graph.ts';
import {
  cyclicFixture,
  datasetFixture,
  mixedFixture,
  modelFixture,
  part,
  writeZipStored,
} from './test-fixtures.ts';

function built(bytes: Uint8Array, options?: Parameters<typeof buildDependencyGraph>[1]): DependencyGraph {
  const result = buildDependencyGraph(bytes, options);
  assert.equal(result.status, 'built');
  return result as DependencyGraph;
}

test('graph: precedents are the operands the formula states, not what they resolve to', () => {
  const graph = built(modelFixture());
  const precedents = graph.precedentsOf('Summary!F20');
  assert.equal(precedents.length, 1);
  assert.deepEqual(precedents[0], {
    kind: 'cell',
    node: 'Estimate!B66',
    sheet: 'Estimate',
    address: 'B66',
  });
});

test('graph: a cell inside a referenced rectangle has the referencing formula as a dependent', () => {
  const graph = built(modelFixture());
  // Data!B10 is reached only through SUM(Data!B2:B10) — no formula names it directly.
  assert.deepEqual(graph.dependentsOf('Data!B10'), ['Estimate!B66']);
});

test('graph: a range operand is retained as a rectangle, never expanded into cells', () => {
  const graph = built(modelFixture());
  const range = graph
    .precedentsOf('Estimate!B66')
    .find((precedent): precedent is RangePrecedent => precedent.kind === 'range');
  assert.ok(range);
  assert.equal(range.ref, 'B2:B10');
  assert.equal(range.startRow, 2);
  assert.equal(range.endRow, 10);
  // Nine cells in the rectangle, one stored edge.
  assert.equal(graph.precedentsOf('Estimate!B66').length, 1);
});

test('graph: a cell outside every referenced rectangle has no dependents', () => {
  assert.deepEqual(built(modelFixture()).dependentsOf('Data!B99'), []);
});

test('graph: bounded transitive dependents report the hop each node was reached at', () => {
  const graph = built(modelFixture());
  const walk = graph.transitiveDependentsOf('Data!B10', 2);
  const byNode = new Map(walk.reached.map((entry) => [entry.node, entry.hops]));
  assert.equal(byNode.get('Estimate!B66'), 1);
  assert.equal(byNode.get('Summary!F20'), 2);
});

test('graph: a hop bound that stops short of the end says so', () => {
  const graph = built(modelFixture());
  const walk = graph.transitiveDependentsOf('Data!B10', 1);
  assert.deepEqual(
    walk.reached.map((entry) => entry.node),
    ['Estimate!B66'],
  );
  assert.equal(walk.truncated, true);
  assert.match(walk.truncationReason ?? '', /1-hop bound/);
});

test('graph: a walk that runs out of dependents is complete, not truncated', () => {
  const walk = built(modelFixture()).transitiveDependentsOf('Data!B10', 10);
  assert.equal(walk.truncated, false);
  assert.equal(walk.truncationReason, null);
});

test('graph: a two-cell cycle is reported once and terminates', () => {
  const graph = built(cyclicFixture());
  assert.equal(graph.cycles, 1);
  assert.equal(graph.cycleNodes.length, 1);
  assert.ok(['Loop!A1', 'Loop!B1'].includes(graph.cycleNodes[0]));
});

test('graph: a cycle costs only its own branch — acyclic cells keep their depths', () => {
  const graph = built(cyclicFixture());
  // D2 reads the hand-entered C1; each row below reads the row above it.
  assert.equal(graph.depthBySheet.Loop.maxDepth, 7);
});

test('graph: an unqualified operand resolves to its own sheet, not the first sheet', () => {
  const graph = built(modelFixture());
  const precedent = graph.precedentsOf('Estimate!C66').find((entry) => entry.kind === 'cell');
  assert.equal(precedent?.node, 'Estimate!B66');
  assert.deepEqual([...graph.dependentsOf('Estimate!B66')].sort(), ['Estimate!C66', 'Summary!F20']);
});

test('graph: a defined name resolves through the workbook definition', () => {
  const graph = built(modelFixture());
  const nodes = graph.precedentsOf('Estimate!C66').map((precedent) =>
    precedent.kind === 'cell' ? precedent.node : precedent.ref,
  );
  // TaxRate -> Rates!$C$1
  assert.ok(nodes.includes('Rates!C1'), `expected Rates!C1 among ${nodes.join(', ')}`);
});

test('graph: a name with no definition is reported as unknown-name, not dropped', () => {
  const graph = built(modelFixture());
  const unknown = graph.unresolved.filter((entry) => entry.cause === 'unknown-name');
  assert.ok(unknown.some((entry) => entry.text === 'MissingName' && entry.at === 'Drivers!A2'));
  assert.equal(graph.unresolvedByCause['unknown-name'], unknown.length);
});

test('graph: a dataset sheet is skipped with its role and basis, and contributes no nodes', () => {
  const graph = built(mixedFixture());
  const skipped = graph.skipped.find((sheet) => sheet.name === 'Raw');
  assert.ok(skipped);
  assert.equal(skipped.role, 'dataset');
  assert.ok(skipped.basis.length > 0);
  assert.ok(!graph.includedSheets.includes('Raw'));
  assert.deepEqual(graph.precedentsOf('Raw!B2'), []);
});

test('graph: a named sheet can be force-included regardless of its role', () => {
  const graph = built(mixedFixture(), { includeSheets: ['Raw'] });
  assert.ok(graph.includedSheets.includes('Raw'));
  assert.equal(graph.skipped.some((sheet) => sheet.name === 'Raw'), false);
});

test('graph: structured references are counted as unresolved and excluded from resolved operands', () => {
  const graph = built(datasetFixture(), { includeSheets: ['Rollup'] });
  assert.ok((graph.unresolvedByCause['structured-table-ref'] ?? 0) >= 1);
  const structured = graph.unresolved.find((entry) => entry.cause === 'structured-table-ref');
  assert.match(structured?.text ?? '', /RawTable\[Score\]/);
  assert.equal(graph.operandsResolved, graph.edges);
});

test('graph: a shared-formula follower carrying no text is counted, not translated', () => {
  const bytes = writeZipStored([
    part(
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="Calc" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    part(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1"><v>1</v></c>' +
        '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f><v>2</v></c></row>' +
        '<row r="2"><c r="A2"><v>3</v></c>' +
        '<c r="B2"><f t="shared" si="0"/><v>6</v></c></row>' +
        '</sheetData></worksheet>',
    ),
  ]);
  const graph = built(bytes, { includeSheets: ['Calc'] });
  assert.equal(graph.unresolvedByCause['shared-follower'], 1);
  assert.equal(graph.unresolved[0].at, 'Calc!B2');
  assert.deepEqual(graph.precedentsOf('Calc!B2'), []);
  assert.deepEqual(graph.dependentsOf('Calc!A2'), []);
});

test('graph: candidate inputs are read-but-not-computed cells, never formula cells', () => {
  const graph = built(modelFixture());
  assert.ok(graph.candidateInputs.includes('Rates!C1'));
  assert.equal(
    graph.candidateInputs.some((node) => node.startsWith('Estimate!B66')),
    false,
  );
  assert.ok(graph.candidateInputsBasis.length > 0);
});

test('graph: candidate outputs exclude an intermediate cell another formula reads', () => {
  const graph = built(modelFixture());
  assert.ok(graph.candidateOutputs.includes('Summary!F20'));
  assert.equal(graph.candidateOutputs.includes('Estimate!B66'), false);
  assert.ok(graph.candidateOutputsBasis.length > 0);
});

test('graph: depth is reported per sheet alongside the workbook figure', () => {
  const graph = built(modelFixture());
  // Summary!F20 <- Estimate!B66 <- Data!B2:B10 is two reference hops.
  assert.equal(graph.depthBySheet.Summary.maxDepth, 2);
  assert.equal(graph.depth.maxDepth >= graph.depthBySheet.Summary.maxDepth, true);
  assert.equal(graph.depth.formulaCells, graph.formulaCells);
  assert.ok(graph.depthBySheet.Summary.medianDepth >= 1);
});

test('graph: the node cap is reported when it bites', () => {
  const graph = built(modelFixture(), { nodeCap: 3 });
  assert.equal(graph.truncated, true);
  assert.match(graph.truncationReason ?? '', /3-node cap bit/);
});

test('graph: the edge cap is reported when it bites', () => {
  const graph = built(modelFixture(), { edgeCap: 2 });
  assert.equal(graph.truncated, true);
  assert.match(graph.truncationReason ?? '', /2-edge cap bit/);
});

test('graph: stage 2b names the stages it ran and those it did not', () => {
  const graph = built(modelFixture());
  assert.deepEqual(graph.stagesRun, ['stage-0', 'stage-1', 'stage-2b']);
  assert.deepEqual(graph.stagesNotRun, ['stage-2a', 'stage-3']);
  assert.match(graph.revision, /^[0-9a-f]{64}$/);
  assert.equal(typeof graph.elapsedMs, 'number');
});

test('graph: non-ZIP bytes return the typed unreadable failure', () => {
  const result = buildDependencyGraph(Buffer.from('not a zip archive'));
  assert.equal(result.status, 'unreadable');
  assert.ok(result.status === 'unreadable' && result.reason.length > 0);
});
