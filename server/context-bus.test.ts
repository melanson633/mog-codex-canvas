import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, rangeCoversCell } from './context-bus.ts';

test('quoted sheet ranges decode doubled apostrophes before occupied-cell comparison', () => {
  const range = parseRange("'Bob''s Model'!B8");
  assert.ok(range); assert.equal(range.sheet, "Bob's Model");
  const cell = parseRange('B8')!;
  assert.equal(rangeCoversCell(range, cell, 'Summary'), false);
  assert.equal(rangeCoversCell(range, cell, "Bob's Model"), true);
  assert.equal(parseRange("'Bob's Model'!B8"), null);
});
