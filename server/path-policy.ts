/**
 * Shared path-containment policy for the local file bridge.
 *
 * Lexical containment (`resolve` + a prefix test) is not enough on a real disk:
 * a symlink — or a Windows junction, which needs no elevation to create —
 * placed inside the workbook root resolves lexically under the root while
 * pointing anywhere on the filesystem. Every target the bridge touches is
 * therefore canonicalized with realpath (the target itself when it exists, its
 * parent directory when it does not), and it is the canonical result that gets
 * checked against the canonical root.
 */
import { realpathSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The only extensions the bridge will read or write, by target kind. */
export const WORKBOOK_EXTENSION = '.xlsx';
export const SCREENSHOT_EXTENSION = '.png';

const EXTENSIONS = {
  workbook: WORKBOOK_EXTENSION,
  screenshot: SCREENSHOT_EXTENSION,
  /** Flight-recorder save receipts under .audit/receipts/. */
  receipt: '.json',
  /** The .bak sibling replaceFile keeps of a replaced workbook. */
  backup: '.bak',
} as const;

export type TargetKind = keyof typeof EXTENSIONS;

/** Windows drive-relative names ("C:book.xlsx") are not absolute but do escape. */
const DRIVE_RELATIVE = /^[a-zA-Z]:/;

/**
 * Canonical form of the configured workbook root. Called once at startup: if the
 * root cannot be canonicalized there is no containment boundary to enforce, so
 * the bridge must not come up at all.
 */
export function canonicalizeRoot(root: string): string {
  const resolved = resolve(root);
  try {
    // .native, to match fsPromises.realpath (documented as native semantics):
    // targets are canonicalized with the latter, and on Windows only the
    // native call expands 8.3 short names (C:\Users\MARKME~1\...). A root kept
    // in short form while targets expand makes every real file look like an
    // escape.
    return realpathSync.native(resolved);
  } catch {
    throw new Error(`Workbook root does not exist: ${resolved}`);
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '' || isAbsolute(rel)) return false;
  return !rel.split(sep).includes('..');
}

/** Shape checks on the client-supplied name, before it ever touches disk. */
function requestedPath(root: string, name: string, kind: TargetKind): string {
  if (name.includes('\0')) throw new Error('Path contains a null byte');
  if (isAbsolute(name) || DRIVE_RELATIVE.test(name) || name.startsWith('\\\\') || name.startsWith('//')) {
    throw new Error(`Absolute paths are not accepted: ${name}`);
  }
  // On NTFS a colon opens an alternate data stream: `notes.txt:book.xlsx` names
  // a stream hanging off notes.txt, and `extname` reads the stream name, so the
  // check below would pass a .txt through as a workbook. The stream lives inside
  // the root, so this is not an escape — it is a way around the extension
  // allowlist, and no legitimate workbook or screenshot name contains a colon.
  if (name.includes(':')) {
    throw new Error(`Path names an alternate data stream: ${name}`);
  }
  const expected = EXTENSIONS[kind];
  if (extname(name).toLowerCase() !== expected) {
    throw new Error(`A ${kind} path must end in ${expected}: ${name}`);
  }
  const target = resolve(root, name);
  if (!isInside(root, target)) throw new Error(`Path escapes the workbook root: ${name}`);
  return target;
}

/** Resolves an entry that exists on disk: must canonicalize under root, and be a regular file. */
async function canonicalizeExisting(root: string, target: string, name: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    // Reachable via a dangling symlink: the entry exists but has no real target.
    throw new Error(`Path could not be resolved: ${name}`);
  }
  if (!isInside(root, canonical)) throw new Error(`Path escapes the workbook root: ${name}`);
  if (!(await stat(canonical)).isFile()) throw new Error(`Not a regular file: ${name}`);
  return canonical;
}

/** Resolves a target that must already exist (reads and read-backs). */
export async function resolveReadTarget(
  root: string,
  name: string | null,
  kind: TargetKind,
): Promise<string> {
  if (!name) throw new Error('Missing "path" query parameter');
  const target = requestedPath(root, name, kind);
  if (!(await lstat(target).catch(() => null))) throw new Error(`No such file: ${name}`);
  return canonicalizeExisting(root, target, name);
}

/**
 * Resolves a target that may or may not exist yet (saves). A new file is only
 * as contained as its directory, so the existing parent is canonicalized and the
 * basename re-joined onto it.
 */
export async function resolveSaveTarget(
  root: string,
  name: string | null,
  kind: TargetKind,
): Promise<string> {
  if (!name) throw new Error('Missing "path" query parameter');
  const target = requestedPath(root, name, kind);
  if (await lstat(target).catch(() => null)) return canonicalizeExisting(root, target, name);

  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch {
    throw new Error(`Parent directory does not exist: ${name}`);
  }
  if (!(await stat(parent)).isDirectory()) throw new Error(`Parent is not a directory: ${name}`);
  const canonical = join(parent, basename(target));
  if (!isInside(root, canonical)) throw new Error(`Path escapes the workbook root: ${name}`);
  return canonical;
}
