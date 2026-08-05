/**
 * The staged-extraction vocabulary, in one place.
 *
 * R2 is the reason this exists: every stage result must name the stages that
 * produced it *and* the stages that were not run, so a consumer can never
 * mistake un-run depth for absence of findings. Five modules make that claim,
 * and five hand-written lists would drift — the first stage added elsewhere
 * would quietly stop appearing in anyone else's `stagesNotRun`.
 */
export type ExtractionStage = 'stage-0' | 'stage-1' | 'stage-2a' | 'stage-2b' | 'stage-3';

export const ALL_STAGES: readonly ExtractionStage[] = [
  'stage-0',
  'stage-1',
  'stage-2a',
  'stage-2b',
  'stage-3',
];

/** What each stage would have told you, for reports that must say what is missing. */
export const STAGE_DESCRIPTIONS: Readonly<Record<ExtractionStage, string>> = {
  'stage-0': 'sheet shape and claimed bounding box',
  'stage-1': 'per-sheet role hypothesis, observed box, and header detection',
  'stage-2a': 'cross-sheet consumption index',
  'stage-2b': 'intra-sheet dependency graph',
  'stage-3': 'column schema and population statistics',
};

/** The complement of `run`, in canonical stage order. */
export function stagesNotRun(run: readonly ExtractionStage[]): readonly ExtractionStage[] {
  const ran = new Set(run);
  return ALL_STAGES.filter((stage) => !ran.has(stage));
}
