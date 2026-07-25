/**
 * The headless lane: edit -> save -> validate -> screenshot, no browser.
 *
 * This is what an agent (Codex, Claude Code, a script) should use to change a
 * workbook while you keep the live canvas open next to it. Reload the canvas
 * afterwards to see the result.
 *
 *   node scripts/headless-edit.mjs [workbook.xlsx]
 *
 * The selector is a path *relative to the workbook root*, and it goes through
 * the same containment policy as the browser lane (../server/path-policy.ts):
 * this lane has the same disk access the file bridge has, so an agent must not
 * be able to reach further with it than the canvas can.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbook } from '@mog-sdk/sdk';
import { canonicalizeRoot, resolveSaveTarget } from '../server/path-policy.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workbookRoot = process.env.MOG_WORKBOOK_DIR ?? resolve(projectRoot, 'workbooks');
const selector = process.argv[2] ?? 'sample.xlsx';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(workbookRoot, { recursive: true });
const root = canonicalizeRoot(workbookRoot);

// Both targets are authorized before the engine starts, so a rejected selector
// never opens a workbook and never leaves a stray image beside one.
let file;
let pngPath;
try {
  file = await resolveSaveTarget(root, selector, 'workbook');
  pngPath = await resolveSaveTarget(root, selector.replace(/\.xlsx$/i, '.headless.png'), 'screenshot');
} catch (error) {
  console.error(`[headless] ${error.message}`);
  process.exit(1);
}

const isNew = !(await exists(file));

const wb = isNew ? await createWorkbook() : await createWorkbook(file);
try {
  const ws = wb.activeSheet;

  if (isNew) {
    await ws.setRange('A1', [
      ['Line item', 'Q1', 'Q2', 'Total'],
      ['Revenue', 120000, 135000, '=SUM(B2:C2)'],
      ['COGS', 48000, 52000, '=SUM(B3:C3)'],
      ['Gross profit', '=B2-B3', '=C2-C3', '=SUM(B4:C4)'],
    ]);
    console.log(`[headless] created ${basename(file)}`);
  } else {
    // Demonstrative edit against an existing workbook: stamp the run.
    await ws.setCell('A6', 'Last headless edit');
    await ws.setCell('B6', new Date().toISOString());
    console.log(`[headless] edited ${basename(file)}`);
  }

  await wb.save(file);
} finally {
  await wb.dispose();
}

// Validate by reopening the file that actually landed on disk.
const check = await createWorkbook(file);
try {
  const ws = check.activeSheet;
  console.log(`[validate] sheets: ${check.sheetNames.join(', ')}`);
  console.log(await ws.summarize());

  const png = await check.captureScreenshot(ws, 'A1:D6', { dpr: 2 });
  await writeFile(pngPath, png);
  console.log(`[screenshot] ${pngPath} (${png.length.toLocaleString()} bytes)`);
} finally {
  await check.dispose();
}
