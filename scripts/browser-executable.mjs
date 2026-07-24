/**
 * Picks the browser that scripts/browser-smoke.mjs drives over CDP.
 *
 * Chrome first, Edge second: both are Chromium and speak the same protocol, and
 * Edge ships with Windows, so the smoke test still runs on a machine that has
 * no Chrome. Kept in its own module so scripts/verify.mjs can check the
 * resolution without launching anything.
 */
import { existsSync } from 'node:fs';

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
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
