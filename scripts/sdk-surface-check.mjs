/**
 * Re-verify the @mog-sdk/sdk surface this project actually depends on.
 *
 *   npm run check:sdk-surface
 *
 * docs/API-EVIDENCE.md records what the SDK exposed when it was last checked.
 * A table like that goes stale silently on the next `npm update`, and a stale
 * capability list is worse than none because it reads as current. This script
 * is the durable half: it calls the API instead of describing it, so the doc's
 * claims are re-derivable rather than remembered.
 *
 * Read-only. Every workbook is in-memory and disposed; nothing under
 * workbooks/ is opened, written, or touched.
 */
import * as sdk from '@mog-sdk/sdk';

const { createWorkbook, api, MogSdkError } = sdk;

const failures = [];
const notes = [];

function expect(present, label, detail) {
  console.log(`  ${present ? 'PRESENT' : 'ABSENT '}  ${label}`);
  if (!present) failures.push(detail ?? `${label} is missing`);
}

function note(message) {
  notes.push(message);
  console.log(`  note     ${message}`);
}

console.log(`\n@mog-sdk/sdk surface check\n`);

// --- module level -----------------------------------------------------------
console.log('module exports');
expect(typeof createWorkbook === 'function', 'createWorkbook');
expect(typeof MogSdkError === 'function', 'MogSdkError');

// --- introspection ----------------------------------------------------------
// This is what keeps agents from guessing API names, so its absence is a real
// regression rather than a curiosity. See the solutions entry on proxy-backed
// objects: guessed names have been wrong three times in this repo.
console.log('\napi introspection');
for (const name of ['describe', 'search', 'guidance', 'compatibility', 'types', 'utils', 'a1']) {
  expect(Boolean(api?.[name]), `api.${name}`);
}
for (const name of ['analyze', 'preflight', 'explain']) {
  expect(typeof api?.guidance?.[name] === 'function', `api.guidance.${name}`);
}

const described = await api.describe('ws.setFormulas');
expect(Boolean(described), "api.describe('ws.setFormulas') resolves");

// The path grammar fails silently: a bad path returns null rather than
// throwing, so a caller that drops the `ws.` prefix gets "no such API" from
// what is really a typo. Pin the behavior so the doc's warning stays true.
const bare = await api.describe('setFormulas');
expect(bare === null, "api.describe('setFormulas') returns null (prefix required)");

// --- instance surfaces ------------------------------------------------------
console.log('\nworkbook / worksheet members');
const probe = await createWorkbook();
try {
  const ws = probe.activeSheet;

  for (const name of [
    'setFormulas', 'setCells', 'setRange', 'setCell', 'getFormulas', 'getValues',
    'getUsedRange', 'findLastRow', 'findLastColumn', 'findDataEdge',
    'summarize', 'toCSV', 'toJSON',
  ]) {
    expect(typeof ws?.[name] === 'function', `ws.${name}`);
  }

  for (const name of ['toXlsx', 'dispose', 'captureScreenshot', 'undoGroup']) {
    expect(typeof probe?.[name] === 'function', `wb.${name}`);
  }
  expect(Array.isArray(probe.importWarnings), 'wb.importWarnings (array)');

  // Engine-side error checking. Complements server/value-fidelity.ts; it does
  // not replace it — see the caveat in docs/API-EVIDENCE.md.
  const diagnostics = probe.diagnostics;
  expect(Boolean(diagnostics), 'wb.diagnostics');
  for (const name of ['checkErrors', 'checkFormulaErrors', 'validateWorkbook']) {
    expect(typeof diagnostics?.[name] === 'function', `wb.diagnostics.${name}`);
  }
} finally {
  await probe.dispose();
}

// --- behavioral: multi-row setRange keeps formula authorship ----------------
// Upstream #328 reported that setRange drops formula authorship after the first
// row, which would silently turn scripts/headless-edit.mjs's P&L formulas into
// frozen literals on export. It does not reproduce on 0.10.5 with the top-left
// anchor form that script uses. Assert it, so a regression is caught by a check
// rather than by a delivered workbook full of stale numbers.
console.log('\nbehavior: multi-row setRange formula authorship (upstream #328)');
const authored = await createWorkbook();
let exported;
try {
  const ws = authored.activeSheet;
  await ws.setRange('A1', [
    ['Line item', 'Q1', 'Q2', 'Total'],
    ['Revenue', 120000, 135000, '=SUM(B2:C2)'],
    ['Gross profit', '=B2-B3', '=C2-C3', '=SUM(B4:C4)'],
  ]);
  exported = Buffer.from(await authored.toXlsx());
} finally {
  await authored.dispose();
}

const reloaded = await createWorkbook(exported);
try {
  const formulas = await reloaded.activeSheet.getFormulas('A1:D3');
  // Row 3 is the one upstream reported as lost.
  const lastRow = formulas.at(-1) ?? [];
  const kept = lastRow.filter((cell) => typeof cell === 'string' && cell.startsWith('='));
  expect(kept.length === 3, 'formulas in row 3 survive toXlsx() + reload',
    `multi-row setRange lost formula authorship on export: row 3 kept ${kept.length}/3 ` +
    `(${JSON.stringify(lastRow)}). Upstream #328 has regressed or now reaches the ` +
    'anchor form; scripts/headless-edit.mjs writes exactly this shape.');
} finally {
  await reloaded.dispose();
}

// --- report -----------------------------------------------------------------
// Absences that are expected, so a future reader does not re-investigate them.
console.log('\nknown absences (not failures)');
if (sdk.MogSdkErrorCode === undefined) {
  note('MogSdkErrorCode is not exported — only MogSdkError. Match on instance, not code.');
}

console.log('');
if (failures.length > 0) {
  console.error(`[sdk-surface] ${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nThe installed SDK no longer matches docs/API-EVIDENCE.md. Update the doc ' +
    'from what this run observed — do not relax the check to make it pass.',
  );
  process.exit(1);
}

console.log(`[sdk-surface] all checks passed (${notes.length} note(s)).`);
console.log('[sdk-surface] docs/API-EVIDENCE.md is consistent with the installed SDK.');
