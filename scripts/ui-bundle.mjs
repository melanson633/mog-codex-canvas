/**
 * Build the MCP Apps canvas bundle, and answer whether the built one is stale.
 *
 *   node scripts/ui-bundle.mjs --build     (what `npm run build:mcp-app` runs)
 *   node scripts/ui-bundle.mjs             (report freshness, build nothing)
 *
 * plugins/mog-canvas/ui/dist is a gitignored build artifact, so a clone has
 * none and a pull that changes src/ leaves the old one in place. Nothing that
 * serves it could tell: the MCP server serves whatever bytes are there, and the
 * app smoke drives them for four minutes before timing out on a status string
 * the current source no longer emits. That failure names the CSP frame, not the
 * stale bundle, which is how a source fix (049280f, "stop reporting ready
 * before the renderer is") read as a broken check for anyone who had not
 * rebuilt.
 *
 * Freshness is decided by content, not mtime: a checkout rewrites mtimes
 * without changing a byte, and `touch` changes an mtime without changing a
 * build. The hash of every input the bundle is built from is written beside the
 * dist after a successful build, and compared before anything serves it.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDist = join(repoRoot, 'plugins', 'mog-canvas', 'ui', 'dist');
const entryBundle = join(uiDist, 'mcp-app.js');
const stampFile = join(uiDist, '.build-inputs.sha256');

/**
 * Everything the bundle is built from. The component entry imports src/adapters,
 * so the dev app's sources are inputs too; the lockfile is an input because a
 * dependency bump changes the output without touching a source file here.
 */
const INPUT_DIRS = ['src', join('plugins', 'mog-canvas', 'ui', 'src')];
const INPUT_FILES = ['vite.mcp-app.config.ts', 'package-lock.json'];

async function filesUnder(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found; // A missing input directory is reported by its absence in the hash.
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * sha256 over every input's root-relative path and contents, in a stable order.
 * `root` is the repo; tests pass a scratch tree so they never edit real sources.
 */
export async function hashBuildInputs(root = repoRoot) {
  const paths = [
    ...(await Promise.all(INPUT_DIRS.map((dir) => filesUnder(join(root, dir))))).flat(),
    ...INPUT_FILES.map((file) => join(root, file)),
  ];
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash.update(relative(root, path).split(sep).join('/'));
    hash.update('\0');
    try {
      hash.update(await readFile(path));
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * `missing` (no bundle built here yet), `stale` (built from other inputs), or
 * `fresh`. Never throws: a caller decides what an unbuildable state means.
 */
export async function bundleFreshness() {
  const expected = await hashBuildInputs();
  try {
    await stat(entryBundle);
  } catch {
    return { status: 'missing', expected, reason: 'no bundle has been built in this checkout' };
  }
  let stamped = null;
  try {
    stamped = (await readFile(stampFile, 'utf8')).trim();
  } catch {
    return {
      status: 'stale',
      expected,
      reason: 'the bundle carries no record of what it was built from',
    };
  }
  if (stamped !== expected) {
    return {
      status: 'stale',
      expected,
      reason: `built from inputs ${stamped.slice(0, 12)}…, sources now hash ${expected.slice(0, 12)}…`,
    };
  }
  return { status: 'fresh', expected, reason: null };
}

/** Runs the real Vite build, then records the inputs it was built from. */
export async function buildBundle() {
  const expected = await hashBuildInputs();
  // Vite's JS entry under this Node, not `npx`: spawning a Windows .cmd shim
  // without a shell fails outright (EINVAL), and going through a shell to fix
  // that would put quoting between this script and the build.
  await run(
    process.execPath,
    [join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.mcp-app.config.ts'],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  // Stamped after the build so an interrupted build is never recorded as done.
  await writeFile(stampFile, `${expected}\n`);
  return expected;
}

/**
 * Guarantees the served bundle matches this checkout's sources. Builds when it
 * does not, and says so — a check that quietly drove a stale bundle would be
 * reporting on code that is not the code under test.
 */
export async function ensureFreshBundle({ log = console.log } = {}) {
  const before = await bundleFreshness();
  if (before.status === 'fresh') {
    log(`ui bundle: current with sources (inputs ${before.expected.slice(0, 12)}…)`);
    return before;
  }
  log(`ui bundle: ${before.status} — ${before.reason}; building`);
  await buildBundle();
  return { ...(await bundleFreshness()), rebuilt: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const build = process.argv.includes('--build');
  if (build) {
    const hash = await buildBundle();
    console.log(`ui bundle: built from inputs ${hash.slice(0, 12)}…`);
  } else {
    const state = await bundleFreshness();
    console.log(
      state.status === 'fresh'
        ? `ui bundle: current with sources (inputs ${state.expected.slice(0, 12)}…)`
        : `ui bundle: ${state.status} — ${state.reason}`,
    );
    if (state.status !== 'fresh') process.exitCode = 1;
  }
}
