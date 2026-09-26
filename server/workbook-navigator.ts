import { inflateRawSync } from 'node:zlib';
import { attr, parseSharedStrings, unescapeXml } from './ooxml-cache.ts';
import { redactionReasonFor } from './redaction.ts';

/** A bounded, read-only view of values and formulas saved in an XLSX archive.
 * It intentionally does not invoke the calculation engine. */
const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MIB = 1024 * 1024;
export const NAVIGATOR_MAX_EXPANDED_BYTES = 250 * MIB;
export const NAVIGATOR_MAX_ENTRY_BYTES = 64 * MIB;
export const NAVIGATOR_MAX_ROWS = 200;
export const NAVIGATOR_MAX_COLUMNS = 20;
export const NAVIGATOR_MAX_CELLS = 1000;
const MAX_EXCEL_ROW = 1_048_576, MAX_EXCEL_COLUMN = 16_384;

interface IndexedEntry { name: string; method: number; compressed: number; expanded: number; local: number; }
interface SheetPart { name: string; part: string; }
export interface NavigatorCell {
  readonly address: string;
  readonly value: string | number | boolean | null;
  readonly formula: string | null;
  readonly formulaStatus: 'none' | 'saved' | 'shared-unexpanded';
  readonly isError: boolean;
  readonly cached: boolean;
}
export interface NavigatorSheet { readonly name: string; }
export interface NavigatorDimensions { readonly ref: string | null; readonly rows: number | null; readonly columns: number | null; }
export interface NavigatorSuccess {
  readonly status: 'ok'; readonly snapshot: true;
  readonly notice: 'Saved workbook values and formulas only; formulas are not recalculated.';
  readonly sheet: string; readonly range: string; readonly sheets: readonly NavigatorSheet[];
  readonly dimensions: NavigatorDimensions; readonly cells: readonly NavigatorCell[];
}
export interface NavigatorFailure { readonly status: 'unreadable' | 'no-such-sheet' | 'bad-range' | 'range-too-large'; readonly reason: string; }
export type NavigatorResult = NavigatorSuccess | NavigatorFailure;
export interface NavigatorRequest { readonly sheet?: string; readonly range?: string; }

function fail(reason: string): never { throw new Error(reason); }
function indexArchive(bytes: Uint8Array): { buffer: Buffer; entries: Map<string, IndexedEntry> } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0 || eocd + 22 > buffer.length) fail('The workbook archive is unreadable.');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count === 0 || count > 10_000) fail('The workbook archive has an unsupported entry count.');
  let offset = buffer.readUInt32LE(eocd + 16), total = 0;
  const entries = new Map<string, IndexedEntry>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) fail('The workbook archive is unreadable.');
    const method = buffer.readUInt16LE(offset + 10), compressed = buffer.readUInt32LE(offset + 20), expanded = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32), local = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || expanded > NAVIGATOR_MAX_ENTRY_BYTES || compressed > buffer.length) fail('The workbook archive exceeds the navigator safety limit.');
    total += expanded; if (total > NAVIGATOR_MAX_EXPANDED_BYTES) fail('The workbook archive exceeds the 250 MB navigator safety limit.');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || entries.has(name)) fail('Duplicate or invalid workbook archive entries prevent a safe read.');
    entries.set(name, { name, method, compressed, expanded, local }); offset = end;
  }
  return { buffer, entries };
}
function entryText(archive: ReturnType<typeof indexArchive>, name: string): string | null {
  const entry = archive.entries.get(name); if (!entry) return null;
  if (entry.local + 30 > archive.buffer.length || archive.buffer.readUInt32LE(entry.local) !== LOCAL) fail('The workbook archive is unreadable.');
  const start = entry.local + 30 + archive.buffer.readUInt16LE(entry.local + 26) + archive.buffer.readUInt16LE(entry.local + 28);
  if (start + entry.compressed > archive.buffer.length) fail('The workbook archive is truncated.');
  const raw = archive.buffer.subarray(start, start + entry.compressed);
  const data = entry.method === 0 ? Buffer.from(raw) : entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: entry.expanded }) : fail('The workbook uses an unsupported compression method.');
  if (data.length !== entry.expanded) fail('The workbook archive cannot be safely expanded.');
  return data.toString('utf8');
}
function parts(archive: ReturnType<typeof indexArchive>): SheetPart[] {
  const workbook = entryText(archive, 'xl/workbook.xml'), rels = entryText(archive, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) fail('Not an XLSX workbook: workbook metadata is missing.');
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attr(match[0], 'Id'), target = attr(match[0], 'Target');
    if (!id || !target || target.includes('..')) continue;
    targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const result: SheetPart[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(match[0], 'name'), rid = attr(match[0], 'r:id') ?? attr(match[0], 'r\\:id'); const part = rid ? targets.get(rid) : null;
    if (!name || !part || !archive.entries.has(part)) fail('An unresolved sheet relationship prevents a complete workbook read.');
    result.push({ name, part });
  }
  if (!result.length) fail('Not an XLSX workbook: no readable sheets are declared.');
  return result;
}
function column(letters: string): number { let n = 0; for (const c of letters) n = n * 26 + c.charCodeAt(0) - 64; return n; }
function coordinate(address: string): { row: number; col: number } | null { const m = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(address); if (!m) return null; const col = column(m[1].toUpperCase()), row = Number(m[2]); return col <= MAX_EXCEL_COLUMN && row <= MAX_EXCEL_ROW ? { row, col } : null; }
function requestedRange(text: string | undefined): { startRow: number; endRow: number; startCol: number; endCol: number; display: string } | null {
  const value = text ?? 'A1:T50'; const m = /^\$?([A-Z]{1,3})\$?([1-9]\d*)(?::\$?([A-Z]{1,3})\$?([1-9]\d*))?$/i.exec(value);
  if (!m) return null; const a = coordinate(`${m[1]}${m[2]}`), b = coordinate(`${m[3] ?? m[1]}${m[4] ?? m[2]}`); if (!a || !b) return null;
  const startRow = Math.min(a.row,b.row), endRow = Math.max(a.row,b.row), startCol = Math.min(a.col,b.col), endCol = Math.max(a.col,b.col);
  const rows=endRow-startRow+1, cols=endCol-startCol+1;
  if (rows > NAVIGATOR_MAX_ROWS || cols > NAVIGATOR_MAX_COLUMNS || rows * cols > NAVIGATOR_MAX_CELLS) return null;
  return { startRow,endRow,startCol,endCol,display:`${m[1].toUpperCase()}${m[2]}:${(m[3] ?? m[1]).toUpperCase()}${m[4] ?? m[2]}` };
}
function textValue(inner: string, type: string, shared: readonly string[]): { value: string | number | boolean | null; cached: boolean; isError: boolean } {
  const inline = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m=>unescapeXml(m[1])).join('');
  if (type === 'inlineStr') return { value:inline, cached:true,isError:false };
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner); if (!v) return { value:null,cached:false,isError:false };
  const raw = unescapeXml(v[1]);
  if (type === 's') { const index=Number(raw); return Number.isInteger(index) && index >= 0 && index < shared.length ? {value:shared[index],cached:true,isError:false}:{value:null,cached:false,isError:false}; }
  if (type === 'b') return {value:raw === '1',cached:true,isError:false};
  if (type === 'e') return {value:raw,cached:true,isError:true};
  if (type === 'str') return {value:raw,cached:true,isError:false};
  const numeric=Number(raw); return Number.isFinite(numeric) ? {value:numeric,cached:true,isError:false}:{value:raw,cached:true,isError:false};
}
function dims(xml: string): NavigatorDimensions { const ref=/<dimension\b[^>]*\bref="([^"]+)"/.exec(xml)?.[1] ?? null; if (!ref) return {ref:null,rows:null,columns:null}; const pair=(ref.includes(':') ? ref.split(':') : [ref, ref]).map(coordinate); if (!pair[0] || !pair[1]) return {ref,rows:null,columns:null}; return {ref, rows:Math.max(pair[0].row,pair[1].row), columns:Math.max(pair[0].col,pair[1].col)}; }

export function navigateWorkbook(bytes: Uint8Array, request: NavigatorRequest = {}): NavigatorResult {
  try {
    const archive=indexArchive(bytes), sheets=parts(archive), selected=request.sheet ? sheets.find(s=>s.name===request.sheet) : sheets[0];
    if (!selected) return {status:'no-such-sheet',reason:'The requested sheet is not present in this saved workbook.'};
    const range=requestedRange(request.range); if (!range) return {status: request.range ? 'range-too-large':'bad-range', reason: request.range ? `Navigator pages are limited to ${NAVIGATOR_MAX_ROWS} rows, ${NAVIGATOR_MAX_COLUMNS} columns, and ${NAVIGATOR_MAX_CELLS} cells.`:'The requested range is not a valid Excel A1 range.'};
    const xml=entryText(archive,selected.part); if (!xml) return {status:'unreadable',reason:'The selected sheet part is missing.'};
    assertDataXml(xml);
    const shared=parseSharedStrings(entryText(archive,'xl/sharedStrings.xml'));
    const cells: NavigatorCell[]=[];
    for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const address=attr(`<c ${match[1]}>`,'r'); if (!address) continue; const at=coordinate(address); if (!at || at.row<range.startRow || at.row>range.endRow || at.col<range.startCol || at.col>range.endCol) continue;
      const inner=match[2] ?? ''; const type=attr(`<c ${match[1]}>`,'t') ?? 'n'; const hasFormula=/<f\b/.test(inner); const formulaTag=/<f\b([^>]*)>([\s\S]*?)<\/f>/.exec(inner); const sharedStub=hasFormula && /\bt="shared"/.test(formulaTag?.[1] ?? inner) && !formulaTag?.[2];
      const value=textValue(inner,type,shared); if (!hasFormula && !value.cached) continue;
      cells.push({address:address.replace(/\$/g,'').toUpperCase(),value:value.value,cached:value.cached,isError:value.isError,formula:formulaTag?.[2] ? unescapeXml(formulaTag[2]) : null,formulaStatus: sharedStub ? 'shared-unexpanded' : formulaTag?.[2] ? 'saved':'none'});
    }
    return {status:'ok',snapshot:true,notice:'Saved workbook values and formulas only; formulas are not recalculated.',sheet:selected.name,range:range.display,sheets:sheets.map(s=>({name:s.name})),dimensions:dims(xml),cells};
  } catch (error) { return {status:'unreadable',reason:error instanceof Error ? error.message : String(error)}; }
}

/** Complete, sequential R38 scan for agent hand-off when legacy 32 MB analysis extraction is too small.
 * This exports no cell values and permits no calculation. */
function assertDataXml(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) fail('Unsupported XML constructs prevent a complete privacy scan.');
  // Excel conditional-format extensions carry xm:f formulas after sheetData.
  // They are not cell formulas. Exempt only these extension formula tags; the
  // original XML still receives the complete cell/value privacy scan below.
  const sheetDataEnd = xml.lastIndexOf('</sheetData>');
  const namespaceView = xml.replace(/<extLst\b[^>]*>[\s\S]*?<\/extLst>/g, (extension, offset: number) => {
    if (sheetDataEnd < 0 || offset < sheetDataEnd || /<c\b/.test(xml.slice(sheetDataEnd, offset)) || /<\/?(?:[\w.-]+:)?(?:sheetData|row|c|v|is|sst|si|r|t)\b/.test(extension)) return extension;
    return extension.replace(/<\/?[\w.-]+:f\b[^>]*>/g, '');
  });
  if (/<\/?[\w.-]+:(?:worksheet|sheetData|row|c|v|f|is|sst|si|r|t)\b/.test(namespaceView)) fail('Namespace-prefixed data elements prevent a complete privacy scan.');
  for (const tag of xml.matchAll(/<(?:c|v|f|is|si|r|t)\b[^>]*>/g)) {
    for (const attribute of tag[0].matchAll(/\s[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g)) {
      if (!/^\s[\w:.-]+="[^"]*"$/.test(attribute[0])) fail('Unsupported XML attribute syntax prevents a complete privacy scan.');
    }
  }
}
function checkPrivateText(value: string): void {
  if (redactionReasonFor(value, [value])) fail('High-risk personal data is present and redacted (R38).');
}
function strictSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  assertDataXml(xml);
  const shared = parseSharedStrings(xml);
  if ([...xml.matchAll(/<t\b(?![^>]*\/>)/g)].length !== [...xml.matchAll(/<t\b[^>]*>[\s\S]*?<\/t>/g)].length) fail('Malformed shared string text prevents a complete privacy scan.');
  if (shared.length !== [...xml.matchAll(/<si\b/g)].length) fail('Malformed shared strings prevent a complete privacy scan.');
  for (const value of shared) checkPrivateText(value);
  return shared;
}
export function assertNavigatorPrivacy(bytes: Uint8Array): void {
  const archive = indexArchive(bytes);
  const sheets = parts(archive);
  const shared = strictSharedStrings(entryText(archive, 'xl/sharedStrings.xml'));
  const paths = new Set([...sheets.map(sheet => sheet.part), ...[...archive.entries.keys()].filter(name => /^xl\/worksheets\/.*\.xml$/.test(name))]);
  let seenCells = 0;
  for (const path of paths) {
    const xml = entryText(archive, path);
    if (!xml) fail('Missing worksheet data prevents a complete privacy scan.');
    assertDataXml(xml);
    let seen = 0;
    const expected = [...xml.matchAll(/<c\b/g)].length;
    for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      seen++;
      const tag = `<c ${cell[1]}>`, address = attr(tag, 'r'), inner = cell[2] ?? '';
      if (!address || !coordinate(address) || ++seenCells > 1_000_000) fail('Unsupported cell coordinates or workbook size prevent a complete privacy scan.');
      if (/<c\b/.test(inner)) fail('Malformed cells prevent a complete privacy scan.');
      const type = attr(tag, 't') ?? 'n';
      if (!['s', 'inlineStr', 'str', 'n', 'b', 'e', 'd'].includes(type)) fail('Unsupported cell type prevents a complete privacy scan.');
      const values = [...inner.matchAll(/<v\b[^>]*>([\s\S]*?)<\/v>/g)];
      if (values.length > 1 || values.length !== [...inner.matchAll(/<v\b(?![^>]*\/>)/g)].length) fail('Malformed cell values prevent a complete privacy scan.');
      const raw = values[0]?.[1];
      if (type === 's') {
        const index = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
        if (!Number.isInteger(index) || index < 0 || index >= shared.length) fail('An unresolved shared string prevents a complete privacy scan.');
        checkPrivateText(shared[index]);
      } else {
        if (raw !== undefined) checkPrivateText(unescapeXml(raw));
        const strings = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)];
        if (strings.length !== [...inner.matchAll(/<t\b(?![^>]*\/>)/g)].length) fail('Malformed inline strings prevent a complete privacy scan.');
        checkPrivateText(strings.map(t => unescapeXml(t[1])).join(''));
      }
    }
    if (seen !== expected) fail('Malformed cells prevent a complete privacy scan.');
  }
}
