/**
 * Workbook identity, defined names, and table definitions — from saved bytes.
 *
 * Stage-agnostic prerequisite of the progressive-retrieval pipeline: Stage 2b
 * resolves `name` operands through the defined names here, Stage 3 takes
 * column headers from the table definitions here, and the briefing's identity
 * section is these document properties. All of it comes out of parts
 * `readZipEntries()` has already inflated, so this costs no second
 * decompression.
 *
 * Engine-free: nothing here may import @mog-sdk. Missing or malformed
 * docProps degrade to nulls with a stated note rather than failing the read —
 * an absent field is reported as absent, never as empty (R44).
 */
import { attr, readZipEntries, sheetParts, unescapeXml, type ZipEntry } from './ooxml-cache.ts';

export interface DocumentMetadata {
  readonly creator: string | null;
  readonly lastModifiedBy: string | null;
  readonly created: string | null;
  readonly modified: string | null;
  readonly application: string | null;
  readonly appVersion: string | null;
}

export interface DefinedNameEntry {
  readonly name: string;
  /** Reference text exactly as the file recorded it — never normalized. */
  readonly reference: string;
  /** Owning sheet for a sheet-scoped name; null for workbook-global names. */
  readonly scope: string | null;
}

export interface TableDefinition {
  readonly name: string;
  readonly displayName: string;
  /** Sheet the table part is related to; null when the relationship is absent. */
  readonly sheet: string | null;
  readonly ref: string;
  readonly columns: readonly string[];
}

export interface WorkbookMetadata {
  readonly status: 'extracted';
  readonly document: DocumentMetadata;
  readonly definedNames: readonly DefinedNameEntry[];
  readonly tables: readonly TableDefinition[];
  /** Why any field above is degraded. Empty when nothing was missing. */
  readonly notes: readonly string[];
}

export interface UnreadableMetadata {
  readonly status: 'unreadable';
  readonly reason: string;
}

export type WorkbookMetadataResult = WorkbookMetadata | UnreadableMetadata;

/** Text of the first `<tag>…</tag>`, XML-unescaped; null when absent. */
function element(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1]) : null;
}

function readDocument(byName: Map<string, ZipEntry>, notes: string[]): DocumentMetadata {
  const core = byName.get('docProps/core.xml')?.data.toString('utf8') ?? null;
  const app = byName.get('docProps/app.xml')?.data.toString('utf8') ?? null;
  if (!core) notes.push('docProps/core.xml is absent: creator, last-modified-by, and timestamps are unknown.');
  if (!app) notes.push('docProps/app.xml is absent: the producing application is unknown.');
  return {
    creator: core ? element(core, 'dc:creator') : null,
    lastModifiedBy: core ? element(core, 'cp:lastModifiedBy') : null,
    created: core ? element(core, 'dcterms:created') : null,
    modified: core ? element(core, 'dcterms:modified') : null,
    application: app ? element(app, 'Application') : null,
    appVersion: app ? element(app, 'AppVersion') : null,
  };
}

function readDefinedNames(
  byName: Map<string, ZipEntry>,
  sheets: readonly { name: string }[],
  notes: string[],
): DefinedNameEntry[] {
  const workbook = byName.get('xl/workbook.xml')?.data.toString('utf8') ?? '';
  const names: DefinedNameEntry[] = [];
  for (const match of workbook.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const [, attrs, body] = match;
    const tag = `<definedName ${attrs}>`;
    const name = attr(tag, 'name');
    if (!name) continue;
    const localSheetId = attr(tag, 'localSheetId');
    let scope: string | null = null;
    if (localSheetId !== null) {
      const index = Number(localSheetId);
      scope = sheets[index]?.name ?? null;
      if (scope === null) {
        notes.push(
          `Defined name ${name} declares localSheetId=${localSheetId}, which is outside the ` +
            `${sheets.length} sheets this workbook declares: its scope is unknown.`,
        );
      }
    }
    names.push({ name, reference: unescapeXml(body), scope });
  }
  return names;
}

/** Sheet name that a table part belongs to, via that sheet's relationships. */
function tableOwners(entries: readonly ZipEntry[], sheets: readonly { name: string; part: string }[]): Map<string, string> {
  const owners = new Map<string, string>();
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const sheet of sheets) {
    const relsPath = sheet.part.replace(/([^/]+)$/, '_rels/$1.rels');
    const rels = byName.get(relsPath)?.data.toString('utf8');
    if (!rels) continue;
    for (const rel of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      const target = attr(rel[0], 'Target');
      if (!target || !/tables\/table[^/]*\.xml$/i.test(target)) continue;
      // Targets are relative to xl/worksheets/; only the part name matters.
      owners.set(target.replace(/^.*\//, '').toLowerCase(), sheet.name);
    }
  }
  return owners;
}

function readTables(
  entries: readonly ZipEntry[],
  sheets: readonly { name: string; part: string }[],
  notes: string[],
): TableDefinition[] {
  const owners = tableOwners(entries, sheets);
  const tables: TableDefinition[] = [];
  for (const entry of entries) {
    if (!/^xl\/tables\/table[^/]*\.xml$/i.test(entry.name)) continue;
    const xml = entry.data.toString('utf8');
    const open = xml.match(/<table\b[^>]*>/)?.[0];
    if (!open) {
      notes.push(`${entry.name} carries no <table> element: its definition could not be read.`);
      continue;
    }
    const name = attr(open, 'name') ?? attr(open, 'displayName');
    if (!name) {
      notes.push(`${entry.name} declares no table name: its definition could not be read.`);
      continue;
    }
    const columns: string[] = [];
    for (const column of xml.matchAll(/<tableColumn\b[^>]*\/?>/g)) {
      const columnName = attr(column[0], 'name');
      if (columnName !== null) columns.push(columnName);
    }
    const sheet = owners.get(entry.name.replace(/^.*\//, '').toLowerCase()) ?? null;
    if (sheet === null) {
      notes.push(`${entry.name} is not related to any worksheet: its owning sheet is unknown.`);
    }
    tables.push({
      name,
      displayName: attr(open, 'displayName') ?? name,
      sheet,
      ref: attr(open, 'ref') ?? '',
      columns,
    });
  }
  return tables;
}

/**
 * Reads metadata from parts that are already inflated. This is the entry
 * point the pipeline uses — one decompression serves every stage (R4).
 */
export function metadataFromEntries(
  entries: readonly ZipEntry[],
  sheets: readonly { name: string; part: string }[],
): WorkbookMetadata {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const notes: string[] = [];
  return {
    status: 'extracted',
    document: readDocument(byName, notes),
    definedNames: readDefinedNames(byName, sheets, notes),
    tables: readTables(entries, sheets, notes),
    notes,
  };
}

export function extractWorkbookMetadata(bytes: Uint8Array): WorkbookMetadataResult {
  let entries: ZipEntry[];
  let sheets: { name: string; part: string }[];
  try {
    entries = readZipEntries(bytes);
    sheets = sheetParts(entries);
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  return metadataFromEntries(entries, sheets);
}
