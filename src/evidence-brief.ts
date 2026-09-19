export interface EvidenceEntry { result: Record<string, unknown>; assumptions: Record<string, unknown>; }

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const fmt = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value) : String(value ?? '—');
const cell = (value: unknown) => `<td>${escape(fmt(value))}</td>`;
const row = (values: unknown[]) => `<tr>${values.map(cell).join('')}</tr>`;
const table = (headers: string[], rows: unknown[][]) => `<table><thead><tr>${headers.map(value => `<th>${escape(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table>`;
const list = (values: unknown[]) => `<ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`;

export const checkComparisonLabel = (operator: unknown) => operator === 'equals' ? 'Equals' : operator === 'at-least' ? 'At least' : operator === 'at-most' ? 'At most' : 'Comparison unavailable';

function outcome(result: Record<string, unknown>) {
  const action = String(result.action ?? 'analysis');
  if (action === 'sensitivity' && Array.isArray(result.matrix)) {
    const rows = result.matrix as unknown[][];
    const rowValues = Array.isArray(result.rowValues) ? result.rowValues : [];
    const colValues = Array.isArray(result.colValues) ? result.colValues : [];
    return `<p><strong>Output:</strong> ${escape(result.output)}. Rows vary ${escape(result.rowInput)}; columns vary ${escape(result.colInput)}.</p>${table([`${fmt(result.rowInput)} / ${fmt(result.colInput)}`, ...colValues.map(fmt)], rows.map((values, index) => [rowValues[index], ...values]))}`;
  }
  if (action === 'drivers' && Array.isArray(result.drivers)) return `<p><strong>Baseline output:</strong> ${escape(fmt(result.baseline))}</p>${table(['Input', 'Low output', 'Low change', 'High output', 'High change'], (result.drivers as Record<string, unknown>[]).map(driver => [driver.cell, driver.lowOutput, driver.lowDelta, driver.highOutput, driver.highDelta]))}`;
  if (action === 'goalSeek') return `<p><strong>${result.status === 'converged' ? 'Target reached within tolerance' : 'Target not reached'}.</strong> Candidate input ${escape(result.solution)} produced output ${escape(result.value)}, with residual ${escape(result.residual)} after ${escape(fmt(result.iterations))} iterations.</p>`;
  if (action === 'variance' && Array.isArray(result.rows)) return `<p>Baseline ${escape(fmt(result.baselineTotal))}; comparison ${escape(fmt(result.comparisonTotal))}; change ${escape(fmt(result.difference))}.</p>${table(['Baseline source', 'Comparison source', 'Baseline', 'Comparison', 'Change', '% change'], (result.rows as Record<string, unknown>[]).map(item => [item.baselineCell, item.comparisonCell, item.baseline, item.comparison, item.difference, item.percentChange === null ? 'N/A' : `${fmt(item.percentChange)}%`]))}`;
  if (action === 'checks' && Array.isArray(result.checks)) return `<p><strong>${escape(fmt(result.passed))} passed; ${escape(fmt(result.failed))} failed.</strong></p>${table(['Check', 'Source', 'Actual', 'Comparison and target', 'Effective tolerance', 'Difference', 'Outcome'], (result.checks as Record<string, unknown>[]).map(check => [check.label, check.range, check.actual, `${checkComparisonLabel(check.operator)} ${fmt(check.target)}`, check.tolerance == null ? undefined : String(check.tolerance), check.difference, check.passed ? 'Passed' : 'Failed']))}`;
  if (action === 'scenario' && Array.isArray(result.cases)) {
    const outputs = Array.isArray(result.outputs) ? result.outputs.map(String) : [];
    return table([String(result.input ?? 'Input'), ...outputs], (result.cases as Record<string, unknown>[]).map(item => {
      const values = item.outputs as Record<string, unknown> | undefined;
      return [item.input, ...outputs.map(output => values?.[output])];
    }));
  }
  if (action === 'reconcile') return `<p><strong>${result.status === 'balanced' ? 'Balances agree' : 'Difference to investigate'}.</strong> Difference ${escape(fmt(result.difference))}; tolerance ${escape(fmt(result.tolerance))}.</p>`;
  if (action === 'audit' && Array.isArray(result.findings)) return `<p><strong>${result.findings.length} review finding${result.findings.length === 1 ? '' : 's'}.</strong></p>${table(['Cell', 'Finding', 'Message'], (result.findings as Record<string, unknown>[]).map(finding => [finding.address, finding.kind, finding.message ?? finding.reason]))}`;
  if (action === 'context' && Array.isArray(result.cells)) return table(['Cell', 'Saved value', 'Formula'], (result.cells as Record<string, unknown>[]).map(item => [item.address, item.value, item.formula]));
  if (action === 'explain') return `<p><strong>Selected output:</strong> ${escape((result.target as Record<string, unknown> | undefined)?.address ?? 'Unavailable')}. Review the exact assumptions, sources, and raw evidence below.</p>`;
  return `<p>Status: <strong>${escape(result.status ?? 'unknown')}</strong>.</p>`;
}

function assumptions(value: Record<string, unknown>) {
  const rows = Object.entries(value).filter(([key]) => key !== 'action' && key !== 'name').map(([key, item]) => [key, Array.isArray(item) || (item && typeof item === 'object') ? JSON.stringify(item) : item]);
  return rows.length ? table(['Source or assumption', 'Value'], rows) : '<p>No separate assumptions were recorded.</p>';
}

function limitations(result: Record<string, unknown>) {
  const coverage = result.coverage as { complete?: boolean; limitations?: unknown[] } | undefined;
  if (!coverage) return '<p>No additional coverage limitations were reported.</p>';
  return `<p><strong>${coverage.complete ? 'Requested scope reported complete.' : 'Coverage is limited.'}</strong></p>${coverage.limitations?.length ? list(coverage.limitations) : ''}`;
}

export function downloadFile(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function evidenceBrief(entries: EvidenceEntry[]) {
  const first = entries[0]?.result ?? {};
  const sections = entries.map((entry, index) => `<section><h2>${index + 1}. ${escape(entry.result.action ?? 'Analysis')}</h2><p class="status">Status: ${escape(entry.result.status ?? 'unknown')}</p><h3>Outcome</h3>${outcome(entry.result)}<h3>Exact sources and assumptions</h3>${assumptions(entry.assumptions)}<h3>Coverage and limitations</h3>${limitations(entry.result)}<details><summary>Full result and provenance</summary><pre>${escape(JSON.stringify(entry.result, null, 2))}</pre></details></section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mog · Decision evidence</title><style>body{font:15px/1.6 system-ui;color:#233a39;max-width:1000px;margin:50px auto;padding:24px}h1,h2{font-family:Georgia,serif}section{border-top:1px solid #cad4ce;margin-top:30px;padding-top:20px}.status{color:#526c5e}table{width:100%;border-collapse:collapse;margin:12px 0 22px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dce4de;padding:8px}th{background:#f0f3ee}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4ef;padding:20px;font-size:12px}summary{cursor:pointer}@media print{section{break-before:page}pre,th{background:white}}</style></head><body><h1>Decision evidence</h1><p>Workbook: ${escape(first.workbook ?? '')}<br>Saved revision: ${escape(first.revision ?? '')}</p><p>Prepared ${escape(new Date().toISOString())}. A session record of explicit assumptions and calculated results. Saved workbook analysis excludes unsaved edits. Sensitivity and driver results describe these tested assumptions only; they do not establish causation or forecasts.</p>${sections}</body></html>`;
}
