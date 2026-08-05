/**
 * Minimal OOXML reader for the value-fidelity gate.
 *
 * An .xlsx file records, next to every formula, the value the producing
 * application last calculated for it (`<c><f>…</f><v>…</v></c>`). Those cached
 * values are the one oracle for "what this workbook said its formulas were
 * worth" that does not come from the Mog engine itself — a same-engine
 * round-trip can never catch the engine mis-evaluating a formula, the file's
 * own cache can (docs/solutions/integration-issues/
 * mog-sdk-xlsx-table-calc-column-import-yields-calc-error.md).
 *
 * This reader is deliberately small: stored/deflated ZIP entries via
 * node:zlib, regex-level XML extraction of exactly the cells that carry both a
 * formula and a cached value. It adds no dependency and never writes anything.
 * Malformed input throws — the caller maps that to "unverified", never to
 * "passed".
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Reads all entries of a ZIP archive via its central directory. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD is at the end, possibly preceded by a comment (max 65535 bytes).
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanFrom; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('Corrupt ZIP: bad central directory entry');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt ZIP: bad local header for ${name}`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    entries.push({ name, data });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One formula cell that carries a usable cached value. */
export interface CachedFormulaCell {
  readonly sheet: string;
  readonly address: string;
  readonly cachedValue: string | number | boolean;
  /** True when the file itself recorded an error (t="e") for this formula. */
  readonly cachedIsError: boolean;
}

export interface CachedValueExtract {
  readonly cells: readonly CachedFormulaCell[];
  /** Formula cells seen in total, including ones without a usable cached value. */
  readonly formulaCells: number;
}

export function unescapeXml(text: string): string {
  // Seven passes over a string that cannot contain an entity is the single
  // most-repeated operation in the byte-first stages — every cell address and
  // every cached value goes through here, and almost none of them are escaped.
  if (!text.includes('&')) return text;
  return text
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Compiled once per attribute name. The byte-first stages call `attr` twice
 * per cell, so on a 100,000-cell sheet a fresh `new RegExp` per call was
 * costing more than the whole XML scan it was helping with.
 */
const ATTR_PATTERNS = new Map<string, RegExp>();

export function attr(tag: string, name: string): string | null {
  let pattern = ATTR_PATTERNS.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
    ATTR_PATTERNS.set(name, pattern);
  }
  const match = pattern.exec(tag);
  return match ? unescapeXml(match[1]) : null;
}

export function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
    strings.push(text);
  }
  return strings;
}

/** Sheet display names in workbook order, mapped to their part path. */
export function sheetParts(entries: ZipEntry[]): { name: string; part: string }[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const workbook = byName.get('xl/workbook.xml');
  if (!workbook) throw new Error('Not an XLSX workbook: xl/workbook.xml is missing');
  const rels = byName.get('xl/_rels/workbook.xml.rels');
  if (!rels) throw new Error('Not an XLSX workbook: workbook relationships are missing');

  const targets = new Map<string, string>();
  for (const rel of rels.data.toString('utf8').matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attr(rel[0], 'Id');
    const target = attr(rel[0], 'Target');
    if (id && target) {
      targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
    }
  }

  const sheets: { name: string; part: string }[] = [];
  for (const sheet of workbook.data.toString('utf8').matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(sheet[0], 'name');
    const rid = attr(sheet[0], 'r:id') ?? attr(sheet[0], 'r\\:id');
    const part = rid ? targets.get(rid) : null;
    if (name && part) sheets.push({ name, part });
  }
  if (sheets.length === 0) throw new Error('Not an XLSX workbook: no sheets declared');
  return sheets;
}

/**
 * True when the bytes parse as an XLSX archive with at least one sheet — the
 * cheap pre-flight before handing bytes to the native engine. createWorkbook()
 * on unopenable bytes rejects but leaves a native thread alive in SDK 0.10.5,
 * which keeps the whole process from exiting, so callers must never open the
 * engine speculatively on bytes this rejects.
 */
export function looksLikeWorkbook(bytes: Uint8Array): boolean {
  try {
    sheetParts(readZipEntries(bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts every formula cell with a cached value from XLSX bytes.
 * Throws when the bytes are not a readable XLSX archive.
 */
export function extractCachedFormulaValues(bytes: Uint8Array): CachedValueExtract {
  const entries = readZipEntries(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const shared = parseSharedStrings(byName.get('xl/sharedStrings.xml')?.data.toString('utf8') ?? null);

  const cells: CachedFormulaCell[] = [];
  let formulaCells = 0;

  for (const { name: sheetName, part } of sheetParts(entries)) {
    const sheetXml = byName.get(part)?.data.toString('utf8');
    if (!sheetXml) continue;

    for (const cell of sheetXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, attrs, inner] = cell;
      if (!/<f[\s/>]/.test(inner)) continue;
      formulaCells += 1;

      const address = attr(`<c ${attrs}>`, 'r');
      const type = attr(`<c ${attrs}>`, 't') ?? 'n';
      const valueMatch = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      if (!address || !valueMatch) continue;
      const raw = unescapeXml(valueMatch[1]);

      let cachedValue: string | number | boolean;
      let cachedIsError = false;
      if (type === 'e') {
        cachedValue = raw;
        cachedIsError = true;
      } else if (type === 's') {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0 || index >= shared.length) continue;
        cachedValue = shared[index];
      } else if (type === 'str') {
        cachedValue = raw;
      } else if (type === 'b') {
        cachedValue = raw === '1';
      } else {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) continue;
        cachedValue = numeric;
      }
      cells.push({ sheet: sheetName, address, cachedValue, cachedIsError });
    }
  }

  return { cells, formulaCells };
}
