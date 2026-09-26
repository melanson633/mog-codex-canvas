import type { WorkbookService } from './workbook-service.ts';
import { assertFinancialPrivacy, financialNumericSumCells, validateFinancialRange, readFinancialCells } from './financial-lab.ts';

export interface VarianceRequest { sheet: string; baseline: string; comparison: string; expectedRevision?: string }
export interface ModelCheck {
  label: string; range: string; operator: 'equals' | 'at-least' | 'at-most';
  target?: number; compareRange?: string; tolerance?: number;
}
export interface ChecksRequest { sheet: string; checks: ModelCheck[]; expectedRevision?: string }

const finite = (value: number) => {
  if (!Number.isFinite(value)) throw new Error('The calculation exceeds finite numeric precision.');
  return value;
};
function sum(values: number[]) {
  let total = 0, correction = 0;
  for (const value of values) {
    const adjusted = value - correction;
    const next = finite(total + adjusted);
    correction = (next - total) - adjusted; total = next;
  }
  return total;
}
function address(col: number, row: number) {
  let letters = '';
  for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) letters = String.fromCharCode(65 + (c - 1) % 26) + letters;
  return `${letters}${row}`;
}

/** Read-only consulting procedures; all file access and revision identity belong to the service. */
export function createConsultantAnalysis(service: Pick<WorkbookService, 'read'>) {
  async function source(name: string, expectedRevision?: string) {
    const read = await service.read(name);
    if (expectedRevision !== undefined && expectedRevision !== read.revision) throw new Error('The workbook revision changed. Refresh before running this analysis.');
    assertFinancialPrivacy(read.bytes);
    return read;
  }
  return {
    async variance(name: string, request: VarianceRequest) {
      const left = validateFinancialRange(request.baseline), right = validateFinancialRange(request.comparison);
      const height = left.endRow - left.startRow + 1, width = left.endCol - left.startCol + 1;
      if (height !== right.endRow - right.startRow + 1 || width !== right.endCol - right.startCol + 1) throw new Error('Compared ranges must have the same shape; cells are paired by position.');
      if (height * width > 200) throw new Error('Variance bridges support at most 200 paired cells.');
      const { bytes, revision } = await source(name, request.expectedRevision);
      const baselineCells = readFinancialCells(bytes, request.sheet, request.baseline);
      const baselineTotal = financialNumericSumCells(request.baseline, left, baselineCells, 'reject').sum;
      const comparisonCells = readFinancialCells(bytes, request.sheet, request.comparison);
      const comparisonTotal = financialNumericSumCells(request.comparison, right, comparisonCells, 'reject').sum;
      const a = new Map(baselineCells.map(cell => [cell.address.toUpperCase(), cell.value as number]));
      const b = new Map(comparisonCells.map(cell => [cell.address.toUpperCase(), cell.value as number]));
      const rows = [];
      for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
        const baselineCell = address(left.startCol + c, left.startRow + r), comparisonCell = address(right.startCol + c, right.startRow + r);
        const baseline = a.get(baselineCell)!, comparison = b.get(comparisonCell)!;
        const difference = finite(comparison - baseline);
        rows.push({ baselineCell, comparisonCell, baseline, comparison, difference,
          percentChange: baseline === 0 ? null : finite(difference / Math.abs(baseline) * 100) });
      }
      const difference = finite(comparisonTotal - baselineTotal);
      const residual = finite(difference - sum(rows.map(row => row.difference)));
      return { status: 'calculated' as const, revision, sheet: request.sheet, baselineRange: request.baseline,
        comparisonRange: request.comparison, baselineTotal, comparisonTotal, difference, residual, rows,
        alignment: 'positional' as const, basis: 'saved-cached-values' as const, sourceUnchanged: true as const,
        coverage: { complete: true, limitations: ['Cells are paired by position, not matched by business labels. Confirm that the selected ranges are comparable.', 'Percentage change uses the absolute baseline; a zero baseline has no percentage.', 'Saved values only. Formula caches are not recalculated. A bridge explains arithmetic differences, not business causation.'] } };
    },
    async checks(name: string, request: ChecksRequest) {
      if (!Array.isArray(request.checks) || request.checks.length < 1 || request.checks.length > 8) throw new Error('Provide 1 to 8 explicit model checks.');
      for (const check of request.checks) {
        if (!check || typeof check.label !== 'string' || !check.label.trim() || check.label.length > 100) throw new Error('Each check needs a label of 1 to 100 characters.');
        if (!['equals', 'at-least', 'at-most'].includes(check.operator)) throw new Error('Use equals, at-least, or at-most.');
        validateFinancialRange(check.range);
        if ((check.target !== undefined) === (check.compareRange !== undefined)) throw new Error('Specify exactly one target number or comparison range.');
        if (check.compareRange !== undefined) validateFinancialRange(check.compareRange);
        if (check.target !== undefined && (typeof check.target !== 'number' || !Number.isFinite(check.target))) throw new Error('Targets must be finite numbers.');
        if (check.tolerance !== undefined && (typeof check.tolerance !== 'number' || !Number.isFinite(check.tolerance) || check.tolerance < 0)) throw new Error('Tolerance must be finite and nonnegative.');
      }
      const { bytes, revision } = await source(name, request.expectedRevision);
      const totals = new Map<string, number>();
      const total = (ref: string) => {
        const key = ref.toUpperCase();
        const cached = totals.get(key);
        if (cached !== undefined) return cached;
        const range = validateFinancialRange(ref);
        const value = financialNumericSumCells(ref, range, readFinancialCells(bytes, request.sheet, ref), 'reject').sum;
        totals.set(key, value);
        return value;
      };
      const checks = request.checks.map(check => {
        const actual = total(check.range);
        const target = check.compareRange !== undefined ? total(check.compareRange) : check.target!;
        const tolerance = check.tolerance ?? 0.01, difference = finite(actual - target);
        const passed = check.operator === 'equals' ? Math.abs(difference) <= tolerance : check.operator === 'at-least' ? difference >= -tolerance : difference <= tolerance;
        return { ...check, target, tolerance, actual, difference, passed };
      });
      const passed = checks.filter(check => check.passed).length;
      return { status: passed === checks.length ? 'passed' as const : 'failed' as const,
        revision, sheet: request.sheet, checks, passed, failed: checks.length - passed,
        basis: 'saved-cached-values' as const, sourceUnchanged: true as const,
        coverage: { complete: true, limitations: ['Only the explicitly configured checks were evaluated. Passing is not a correctness certificate or audit opinion.', 'Each range is summed; blanks, text, errors, and missing formula caches prevent the entire pack from running.', 'Saved values only. Formula caches are not recalculated.'] } };
    },
  };
}
