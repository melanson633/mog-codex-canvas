/**
 * R38 — the high-risk personal-data guard, shared by every stage that can
 * report a column.
 *
 * It lives on its own because two stages must reach it and neither may reach
 * the other: Stage 1 (`sheet-roles.ts`) emits header labels before any
 * statistic exists, and Stage 3 (`sheet-schema.ts`) imports Stage 1. A guard
 * that only one of them could call is a guard with a hole in it, and the hole
 * is exactly where header labels leave the pipeline.
 *
 * A high-risk column is always *reported* — present, named, and marked
 * `redacted` with the matched reason — never quietly dropped. No option turns
 * it off; `override` reaches the materiality gate and nothing else.
 *
 * The asymmetry between the two rules is owned rather than hidden: an SSN has
 * a recognizable value shape, a birthdate does not. Without `styles.xml` a
 * birth date is indistinguishable from any other serial number, so birthdate
 * redaction is header-driven only.
 *
 * Engine-free: nothing here may import @mog-sdk.
 */

export const HIGH_RISK_HEADERS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bssn\b/i, label: 'header names a social-security number' },
  { pattern: /social\s*security/i, label: 'header names a social-security number' },
  { pattern: /taxpayer\s*id/i, label: 'header names a taxpayer identification number' },
  { pattern: /\btin\b/i, label: 'header names a taxpayer identification number' },
  { pattern: /\bdob\b/i, label: 'header names a birthdate' },
  { pattern: /birth\s*date/i, label: 'header names a birthdate' },
  { pattern: /date\s*of\s*birth/i, label: 'header names a birthdate' },
  { pattern: /\bbirthdate\b/i, label: 'header names a birthdate' },
];

const SSN_SHAPE = /^\s*\d{3}-\d{2}-\d{4}\s*$/;

/** Value-shape sampling is bounded: the shape repeats or it is not the shape. */
export const SHAPE_SAMPLE = 50;

/**
 * A header reduced to space-separated words before the patterns run.
 *
 * The patterns are word-bounded, and `\b` does not fire against an underscore —
 * so `SSN` matched while `Employee_SSN` did not, and `EMP_DOB` sailed past a
 * guard written to catch `DOB`. Underscored and camel-cased headers are the
 * house style of anything exported from a payroll or HR system, which is
 * precisely the data R38 exists for. Splitting on separators and on case
 * transitions puts both shapes back in reach of the same eight patterns.
 *
 * This widens what matches; it never narrows it. Over-matching costs a column
 * its extents, under-matching costs a roster.
 */
export function normalizeHeader(header: string): string {
  return header.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ');
}

/**
 * The matched R38 reason for a column, or null when nothing matched.
 *
 * `texts` is a bounded sample of the column's populated cells. Callers that
 * have not read a cell yet — Stage 1, and Stage 3's zero-consumption early
 * return — pass an empty sample and get the header-driven half of the rule.
 * That is a real limitation and callers say so rather than implying the
 * value-shape rule ran and found nothing.
 */
export function redactionReasonFor(header: string | null, texts: readonly string[]): string | null {
  if (header) {
    const normalized = normalizeHeader(header);
    for (const { pattern, label } of HIGH_RISK_HEADERS) {
      if (pattern.test(normalized)) {
        return `${label} — reported as present and redacted, never omitted (R38)`;
      }
    }
  }
  const sampled = texts.slice(0, SHAPE_SAMPLE);
  const matches = sampled.filter((text) => SSN_SHAPE.test(text)).length;
  if (matches > 0 && matches >= Math.ceil(sampled.length / 2)) {
    return (
      'values match a social-security number shape (NNN-NN-NNNN) in at least half of the ' +
      `first ${SHAPE_SAMPLE} populated cells — redaction is by value shape, not by header (R38)`
    );
  }
  return null;
}
