/**
 * Formula text to structured operands.
 *
 * The correctness foundation for the consumption index (Stage 2a) and the
 * dependency graph (Stage 2b). Two disciplines hold it together:
 *
 * 1. `parseRange()` in context-bus.ts is the single A1 authority. This module
 *    recognizes *where* a reference is in the text and hands the token there;
 *    it never re-derives row/column arithmetic of its own.
 * 2. A shape this parser cannot resolve is reported under a named cause, never
 *    dropped and never mis-read as an A1 reference. A structured table
 *    reference that silently vanished would read downstream as "this column is
 *    consumed by nobody", which is the exact false negative the pipeline's
 *    depth gate must not make (R38/R41).
 *
 * Ranges stay rectangles. Nothing here expands `B2:B10` into nine cells.
 *
 * Engine-free: nothing here may import @mog-sdk.
 */
import { parseRange } from './context-bus.ts';

export interface CellOperand {
  readonly kind: 'cell';
  /** Sheet the reference names, or null when it is unqualified. */
  readonly sheet: string | null;
  readonly address: string;
  readonly row: number;
  readonly col: number;
}

export interface RangeOperand {
  readonly kind: 'range';
  readonly sheet: string | null;
  readonly ref: string;
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface NameOperand {
  readonly kind: 'name';
  readonly name: string;
}

export type FormulaOperand = CellOperand | RangeOperand | NameOperand;

/**
 * Why a reference in the text produced no operand. Every value is a shape this
 * parser deliberately does not resolve — not an internal error.
 */
export type UnresolvedCause = 'structured-table-ref' | 'external-link' | 'r1c1' | 'unparseable';

export interface UnresolvedRef {
  readonly cause: UnresolvedCause;
  /** The offending text verbatim, so a caller can report what it was. */
  readonly text: string;
}

export interface FormulaRefs {
  readonly operands: readonly FormulaOperand[];
  readonly unresolved: readonly UnresolvedRef[];
  /** True when `operandCap` bit and operands were dropped (R40). */
  readonly capped: boolean;
}

export interface ParseFormulaRefsOptions {
  readonly operandCap?: number;
}

/**
 * Operands kept per formula. Well past any hand-authored formula; present so a
 * pathological generated one cannot pin the graph builder.
 */
export const OPERAND_CAP = 256;

/** `[1]Sheet1!A1` and `'[1]My Sheet'!$A$1` — a link into another workbook. */
const EXTERNAL_LINK =
  /(?:'\[\d+\][^']*'|\[\d+\][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/g;

/**
 * `R[-1]C`, `RC[2]`, `R[3]C[4]`. Only bracketed offsets count: an unbracketed
 * `R1C1` is indistinguishable from the valid A1 address `R1` … `C1`, and
 * guessing there would corrupt real references to buy nothing.
 */
const R1C1 = /(?:R\[-?\d+\]C(?:\[-?\d+\])?|RC\[-?\d+\])/g;

/** `Table1[Amount]`, `[@Amount]`, `Table1[[#All],[Amount]]`. */
const STRUCTURED_REF = /(?:[A-Za-z_][A-Za-z0-9_.]*)?\[(?:[^[\]]|\[[^[\]]*\])*\]/g;

/** Double-quoted string literals, with `""` as the embedded-quote escape. */
const STRING_LITERAL = /"(?:[^"]|"")*"/g;

const QUALIFIED = String.raw`(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?`;
const BARE = String.raw`\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?`;
const IDENTIFIER = String.raw`[A-Za-z_][A-Za-z0-9_.]*`;

/**
 * Trailing guard on the unqualified alternatives.
 *
 * `(?!\s*\()` is the whole function-versus-reference discriminator — `LOG10(`
 * is a call, `LOG10` alone would be a defined name. That test is deliberate: a
 * dictionary of function names would be a maintenance liability that silently
 * misreads every function the list has not heard of.
 *
 * `(?![A-Za-z0-9_.])` is what makes the first guard stick. Without it the
 * engine simply backtracks to a shorter prefix — `SUM(` fails on `SUM` and
 * then matches `SU`, inventing a defined name out of a function's first two
 * letters.
 */
const TRAILING_GUARD = String.raw`(?!\s*\()(?![A-Za-z0-9_.])`;

/** A match may not begin inside a longer identifier, address, or error literal. */
const LEADING_GUARD = String.raw`(?<![A-Za-z0-9_.$#!])`;

/**
 * One left-to-right pass over the masked text. Alternation order matters:
 * a sheet-qualified reference must win over the bare address inside it.
 */
const OPERAND_SCAN = new RegExp(
  `${LEADING_GUARD}(?:${QUALIFIED}${TRAILING_GUARD}|(?:${BARE})${TRAILING_GUARD}|(?:${IDENTIFIER})${TRAILING_GUARD})`,
  'g',
);

/** Literals that look like identifiers but name nothing. */
const NOT_A_NAME = /^(?:TRUE|FALSE)$/i;

function columnLetters(col: number): string {
  let letters = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * Blanks every match with same-length spaces so later passes cannot see the
 * removed text while every remaining offset stays where it was.
 */
function mask(text: string, pattern: RegExp, cause: UnresolvedCause, unresolved: UnresolvedRef[]): string {
  return text.replace(pattern, (match) => {
    unresolved.push({ cause, text: match });
    return ' '.repeat(match.length);
  });
}

function operandFrom(token: string): FormulaOperand | null {
  const parsed = parseRange(token);
  if (!parsed) return null;
  const start = `${columnLetters(parsed.startCol)}${parsed.startRow}`;
  if (!token.includes(':')) {
    return { kind: 'cell', sheet: parsed.sheet, address: start, row: parsed.startRow, col: parsed.startCol };
  }
  return {
    kind: 'range',
    sheet: parsed.sheet,
    ref: `${start}:${columnLetters(parsed.endCol)}${parsed.endRow}`,
    startRow: parsed.startRow,
    startCol: parsed.startCol,
    endRow: parsed.endRow,
    endCol: parsed.endCol,
  };
}

/**
 * Parses one formula's text into operands plus a named account of what could
 * not be resolved. The text is the `<f>` body with a leading `=` optional.
 *
 * `capped` covers operands only: the unresolved shapes are recognized before
 * the operand scan and are always reported in full.
 */
export function parseFormulaRefs(text: string, options: ParseFormulaRefsOptions = {}): FormulaRefs {
  const operandCap = options.operandCap ?? OPERAND_CAP;
  const unresolved: UnresolvedRef[] = [];
  const operands: FormulaOperand[] = [];
  let capped = false;

  let masked = text.replace(/^\s*=/, ' ').replace(STRING_LITERAL, (match) => ' '.repeat(match.length));
  // External links first: their `[1]` prefix would otherwise read as a
  // structured reference, and the `Sheet1!A1` remainder as a real reference.
  masked = mask(masked, EXTERNAL_LINK, 'external-link', unresolved);
  // R1C1 before structured refs, so `R[-1]C` is not read as a bracket group.
  masked = mask(masked, R1C1, 'r1c1', unresolved);
  masked = mask(masked, STRUCTURED_REF, 'structured-table-ref', unresolved);

  for (const match of masked.matchAll(OPERAND_SCAN)) {
    const token = match[0];
    if (operands.length >= operandCap) {
      capped = true;
      break;
    }
    if (!/\d/.test(token)) {
      // No digits at all: an identifier, so a defined name rather than an address.
      if (!NOT_A_NAME.test(token)) operands.push({ kind: 'name', name: token });
      continue;
    }
    const operand = operandFrom(token);
    if (operand) {
      operands.push(operand);
    } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token)) {
      // Digits inside, but not an address — `Sales2024` is a name.
      operands.push({ kind: 'name', name: token });
    } else {
      unresolved.push({ cause: 'unparseable', text: token });
    }
  }

  return { operands, unresolved, capped };
}
