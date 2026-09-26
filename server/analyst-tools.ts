import { z } from 'zod';
import type { WorkbookService } from './workbook-service.ts';
import { createAnalystIndex } from './analyst-index.ts';
import { createFinancialLab } from './financial-lab.ts';
import { createConsultantAnalysis } from './consultant-analysis.ts';

const modelCheck = z.object({ label: z.string().trim().min(1).max(100), range: z.string().min(1), operator: z.enum(['equals', 'at-least', 'at-most']), target: z.number().finite().optional(), compareRange: z.string().min(1).optional(), tolerance: z.number().finite().nonnegative().optional() });

export const analystRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('context'), name: z.string().min(1), sheet: z.string().min(1), range: z.string().min(1) }),
  z.object({ action: z.literal('explain'), name: z.string().min(1), sheet: z.string().min(1), address: z.string().min(1) }),
  z.object({ action: z.literal('audit'), name: z.string().min(1), sheet: z.string().min(1), range: z.string().min(1) }),
  z.object({ action: z.literal('reconcile'), name: z.string().min(1), sheet: z.string().min(1), left: z.string().min(1), right: z.string().min(1), tolerance: z.number().finite().nonnegative().default(0.01), blankPolicy: z.enum(['reject', 'zero']).default('reject'), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('scenario'), name: z.string().min(1), sheet: z.string().min(1), input: z.string().min(1), values: z.array(z.number().finite()).min(1).max(9), outputs: z.array(z.string().min(1)).min(1).max(6), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('sensitivity'), name: z.string().min(1), sheet: z.string().min(1), rowInput: z.string().min(1), rowValues: z.array(z.number().finite()).min(1).max(5), colInput: z.string().min(1), colValues: z.array(z.number().finite()).min(1).max(5), output: z.string().min(1), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('drivers'), name: z.string().min(1), sheet: z.string().min(1), inputs: z.array(z.object({ cell: z.string().min(1), low: z.number().finite(), high: z.number().finite() })).min(1).max(6), output: z.string().min(1), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('goalSeek'), name: z.string().min(1), sheet: z.string().min(1), input: z.string().min(1), output: z.string().min(1), target: z.number().finite(), lower: z.number().finite(), upper: z.number().finite(), tolerance: z.number().finite().positive().optional(), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('variance'), name: z.string().min(1), sheet: z.string().min(1), baseline: z.string().min(1), comparison: z.string().min(1), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('checks'), name: z.string().min(1), sheet: z.string().min(1), checks: z.array(modelCheck).min(1).max(8), expectedRevision: z.string().optional() }),
]);

/** One contract and service instance for HTTP and MCP; no client-supplied filesystem access. */
export function createAnalystTools(service: WorkbookService) {
  const index = createAnalystIndex(service);
  const lab = createFinancialLab(service);
  const consulting = createConsultantAnalysis(service);
  return async (input: unknown) => {
    const request = analystRequest.parse(input);
    const started = performance.now();
    async function execute() {
      switch (request.action) {
        case 'context': return index.context(request.name, request.sheet, request.range);
        case 'explain': return index.explain(request.name, request.sheet, request.address);
        case 'audit': return index.audit(request.name, request.sheet, request.range);
        case 'reconcile': return lab.reconcile(request.name, request);
        case 'scenario': return lab.scenario(request.name, request);
        case 'sensitivity': return lab.sensitivity(request.name, request);
        case 'drivers': return lab.drivers(request.name, request);
        case 'goalSeek': return lab.goalSeek(request.name, request);
        case 'variance': return consulting.variance(request.name, request);
        case 'checks': return consulting.checks(request.name, request);
      }
    }
    const result = await execute();
    return { ...result, action: request.action, workbook: request.name, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      evidence: { generatedAt: new Date().toISOString(), source: 'saved-workbook', unsavedCanvasChangesIncluded: false, request } };
  };
}
