import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceBrief } from '../src/evidence-brief.ts';

test('evidence brief renders readable outcomes, assumptions, limitations and raw evidence', () => {
  const html = evidenceBrief([{
    assumptions: { action: 'variance', name: 'model.xlsx', sheet: 'Model', baseline: 'B2:B3', comparison: 'C2:C3' },
    result: { action: 'variance', status: 'calculated', workbook: 'model.xlsx', revision: 'abc123', baselineTotal: 100, comparisonTotal: 115, difference: 15, rows: [{ baselineCell: 'B2', comparisonCell: 'C2', baseline: 100, comparison: 115, difference: 15, percentChange: 15 }], coverage: { complete: true, limitations: ['Cells are paired by position.'] } },
  }]);
  assert.match(html, /<h3>Outcome<\/h3>/);
  assert.match(html, /Baseline source/);
  assert.match(html, /15%/);
  assert.match(html, /Exact sources and assumptions/);
  assert.match(html, /Cells are paired by position\./);
  assert.match(html, /<details><summary>Full result and provenance<\/summary>/);
});

test('evidence brief escapes report fields, table values, limitations and raw JSON', () => {
  const attack = `<script>alert("x")</script> & 'quoted'`;
  const html = evidenceBrief([{
    assumptions: { action: 'checks', sheet: attack },
    result: { action: 'checks', status: 'failed', workbook: attack, revision: attack, passed: 0, failed: 1, checks: [{ label: attack, range: attack, actual: 1, target: 2, difference: -1, passed: false }], coverage: { complete: false, limitations: [attack] } },
  }]);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\("x"\)/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;quoted&#39;/);
  assert.ok((html.match(/&lt;script&gt;/g) ?? []).length >= 5);
});

test('goal-seek brief preserves the input precision needed to reproduce the target', () => {
  const solution = 0.3333333358168602, target = 1000000, value = solution * 3000000;
  const html = evidenceBrief([{ assumptions: { target, tolerance: 0.01 }, result: { action: 'goalSeek', status: 'converged', solution, value, residual: value - target, iterations: 27 } }]);
  const displayed = html.match(/Candidate input ([\d.]+) produced output/);
  assert.ok(displayed);
  assert.equal(Number(displayed[1]), solution);
  assert.ok(Math.abs(Number(displayed[1]) * 3000000 - target) <= 0.01);
});


test('check outcome explains a passing at-most rule with its effective tolerance', () => {
  const html = evidenceBrief([{
    assumptions: {},
    result: { action: 'checks', status: 'passed', passed: 1, failed: 0, checks: [{ label: 'EBITDA cap', range: 'B8', operator: 'at-most', actual: 360000, target: 300000, tolerance: 100000, difference: 60000, passed: true }] },
  }]);
  const visibleOutcome = html.split('<h3>Outcome</h3>')[1].split('<h3>Exact sources and assumptions</h3>')[0];
  assert.match(visibleOutcome, /At most 300,000/);
  assert.match(visibleOutcome, /Effective tolerance/);
  assert.match(visibleOutcome, /<td>100000<\/td>/);
  assert.match(visibleOutcome, /<td>360,000<\/td>/);
  assert.match(visibleOutcome, /<td>Passed<\/td>/);
});
