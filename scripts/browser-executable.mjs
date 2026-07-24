/**
 * Picks the browser that scripts/browser-smoke.mjs drives over CDP.
 *
 * Chrome first, Edge second: both are Chromium and speak the same protocol, and
 * Edge ships with Windows, so the smoke test still runs on a machine that has
 * no Chrome. Each is looked for in every root a Windows installer uses — 64-bit
 * and 32-bit Program Files, plus %LOCALAPPDATA% for the per-user install Chrome
 * falls back to without admin rights, which the Program Files paths alone miss.
 * Kept in its own module so scripts/verify.mjs can check the resolution without
 * launching anything.
 */
import { existsSync } from 'node:fs';

const INSTALL_ROOTS = [
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  process.env.LOCALAPPDATA,
].filter(Boolean);

const inEveryRoot = (relativePath) =>
  INSTALL_ROOTS.map((root) => `${root.replaceAll('\\', '/')}/${relativePath}`);

export const BROWSER_CANDIDATES = [
  ...inEveryRoot('Google/Chrome/Application/chrome.exe'),
  ...inEveryRoot('Microsoft/Edge/Application/msedge.exe'),
];

/** Absolute path of the first candidate that exists. Throws if none do. */
export function resolveBrowserExecutable(candidates = BROWSER_CANDIDATES) {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No Chromium-based browser found. Looked for:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}
