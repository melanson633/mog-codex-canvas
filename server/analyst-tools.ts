import { z } from 'zod';
import type { WorkbookService } from './workbook-service.ts';
import { createAnalystIndex } from './analyst-index.ts';
import { createFinancialLab } from './financial-lab.ts';

export const analystRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('context'), name: z.string().min(1), sheet: z.string().min(1), range: z.string().min(1) }),
  z.object({ action: z.literal('explain'), name: z.string().min(1), sheet: z.string().min(1), address: z.string().min(1) }),
  z.object({ action: z.literal('audit'), name: z.string().min(1), sheet: z.string().min(1), range: z.string().min(1) }),
  z.object({ action: z.literal('reconcile'), name: z.string().min(1), sheet: z.string().min(1), left: z.string().min(1), right: z.string().min(1), tolerance: z.number().finite().nonnegative().default(0.01), blankPolicy: z.enum(['reject', 'zero']).default('reject'), expectedRevision: z.string().optional() }),
  z.object({ action: z.literal('scenario'), name: z.string().min(1), sheet: z.string().min(1), input: z.string().min(1), values: z.array(z.number().finite()).min(1).max(9), outputs: z.array(z.string().min(1)).min(1).max(6), expectedRevision: z.string().optional() }),
]);

/** One contract and service instance for HTTP and MCP; no client-supplied filesystem access. */
export function createAnalystTools(service: WorkbookService) {
  const index = createAnalystIndex(service);
  const lab = createFinancialLab(service);
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
      }
    }
    const result = await execute();
    return { ...result, action: request.action, workbook: request.name, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      evidence: { generatedAt: new Date().toISOString(), source: 'saved-workbook', unsavedCanvasChangesIncluded: false } };
  };
}
