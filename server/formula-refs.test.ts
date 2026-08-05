/**
 * Formula operand parsing with honest coverage.
 *
 * A pure string-to-structure function with a large input space, and the
 * correctness foundation for the consumption index and the dependency graph —
 * a failing case is cheap to write here and expensive to discover through the
 * graph, which is why this file was written before the parser.
 *
 * The coverage half is as load-bearing as the parsing half: a shape this
 * parser cannot resolve must land in `unresolved` under a named cause, never
 * be dropped and never be misread as an A1 reference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFormulaRefs } from './formula-refs.ts';

test('refs: a bare cell reference yields one unqualified cell operand', () => {
  const { operands, unresolved } = parseFormulaRefs('A1');
  assert.deepEqual(unresolved, []);
  assert.equal(operands.length, 1);
  assert.deepEqual(operands[0], { kind: 'cell', sheet: null, address: 'A1', row: 1, col: 1 });
});

test('refs: a range yields one rectangle operand, not member cells', () => {
  const { operands } = parseFormulaRefs('SUM(B2:B10)');
  assert.equal(operands.length, 1);
  const [operand] = operands;
  assert.equal(operand.kind, 'range');
  assert.ok(operand.kind === 'range');
  assert.equal(operand.sheet, null);
  assert.deepEqual(
    { startRow: operand.startRow, endRow: operand.endRow, startCol: operand.startCol, endCol: operand.endCol },
    { startRow: 2, endRow: 10, startCol: 2, endCol: 2 },
  );
});

test('refs: a sheet-qualified cell keeps its sheet', () => {
  const { operands } = parseFormulaRefs('Data!B1*2');
  assert.equal(operands.length, 1);
  assert.deepEqual(operands[0], { kind: 'cell', sheet: 'Data', address: 'B1', row: 1, col: 2 });
});

test('refs: a quoted sheet name parses and absolute markers are stripped', () => {
  const { operands } = parseFormulaRefs("'My Sheet'!$A$1");
  assert.deepEqual(operands[0], { kind: 'cell', sheet: 'My Sheet', address: 'A1', row: 1, col: 1 });
});

test('refs: one formula can carry both a qualified range and a qualified cell', () => {
  const { operands } = parseFormulaRefs('SUM(Data!B2:B10)+Rates!C1');
  assert.equal(operands.length, 2);
  assert.equal(operands[0].kind, 'range');
  assert.equal(operands[0].sheet, 'Data');
  assert.equal(operands[1].kind, 'cell');
  assert.equal(operands[1].sheet, 'Rates');
});

test('refs: a defined name is a name operand alongside a cell operand', () => {
  const { operands } = parseFormulaRefs('TaxRate*B4');
  // Operands come back in the order the formula text states them.
  assert.deepEqual(
    operands.map((operand) => operand.kind),
    ['name', 'cell'],
  );
  const name = operands.find((operand) => operand.kind === 'name');
  assert.ok(name?.kind === 'name' && name.name === 'TaxRate');
});

test('refs: a structured table reference is unresolved, not resolved', () => {
  const { operands, unresolved } = parseFormulaRefs('SUM(Table1[Amount])');
  assert.deepEqual(operands, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].cause, 'structured-table-ref');
});

test('refs: a this-row structured reference is unresolved too', () => {
  const { operands, unresolved } = parseFormulaRefs('[@Amount]*2');
  assert.deepEqual(operands, []);
  assert.equal(unresolved[0].cause, 'structured-table-ref');
});

test('refs: an external link is unresolved and leaves no mis-parsed A1 behind', () => {
  const { operands, unresolved } = parseFormulaRefs('[1]Sheet1!A1');
  assert.deepEqual(operands, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].cause, 'external-link');
});

test('refs: an R1C1 shape is recorded unresolved', () => {
  const { operands, unresolved } = parseFormulaRefs('R[-1]C');
  assert.deepEqual(operands, []);
  assert.equal(unresolved[0].cause, 'r1c1');
});

test('refs: string literals never become operands', () => {
  const { operands } = parseFormulaRefs('"A1"&B2');
  assert.equal(operands.length, 1);
  assert.equal(operands[0].kind === 'cell' && operands[0].address, 'B2');
});

test('refs: the operand cap bites visibly rather than silently', () => {
  const text = Array.from({ length: 12 }, (_, index) => `A${index + 1}`).join('+');
  const { operands, capped } = parseFormulaRefs(text, { operandCap: 5 });
  assert.equal(operands.length, 5);
  assert.equal(capped, true);

  const uncapped = parseFormulaRefs(text);
  assert.equal(uncapped.operands.length, 12);
  assert.equal(uncapped.capped, false);
});

test('refs: function names never appear as name operands', () => {
  const { operands } = parseFormulaRefs('IF(YEAR(A1)>2020,SUM(B1:B9),0)');
  assert.deepEqual(
    operands.map((operand) => operand.kind),
    ['cell', 'range'],
  );
  assert.ok(!operands.some((operand) => operand.kind === 'name'));
});

test('refs: an identifier ending in digits is a name, not an A1 address', () => {
  const { operands } = parseFormulaRefs('Sales2024+1');
  assert.equal(operands.length, 1);
  assert.ok(operands[0].kind === 'name' && operands[0].name === 'Sales2024');
});

test('refs: an empty formula yields nothing and reports nothing unresolved', () => {
  assert.deepEqual(parseFormulaRefs(''), { operands: [], unresolved: [], capped: false });
});
