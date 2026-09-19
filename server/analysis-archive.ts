import { inflateRawSync } from 'node:zlib';
import type { ZipEntry } from './ooxml-cache.ts';
import { attr } from './ooxml-cache.ts';
import { parseRange } from './context-bus.ts';

export function readAnalysisEntries(bytes: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The workbook archive is unreadable.');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > 1000) throw new Error('The analysis archive entry limit is 1,000.');
  let offset = buffer.readUInt32LE(eocd + 16), remaining = 32 * 1024 * 1024;
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The workbook archive is unreadable.');
    const method = buffer.readUInt16LE(offset + 10), compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24), nameLength = buffer.readUInt16LE(offset + 28);
    const local = buffer.readUInt32LE(offset + 42);
    if (size > remaining || remaining < 1) throw new Error('The analysis expanded archive limit is 32 MB.');
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('The workbook archive is unreadable.');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new Error('The workbook archive is truncated.');
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: remaining }) : null;
    if (!data || data.length !== size || data.length > remaining) throw new Error('The workbook archive cannot be safely expanded.');
    remaining -= data.length;
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (/^xl\/(?:worksheets\/.*\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) {
      const xml = data.toString('utf8');
      if (/<\/?[A-Za-z_][\w.-]*:/.test(xml)) {
        throw new Error('Namespace-prefixed workbook elements prevent a complete privacy scan.');
      }
      for (const tag of xml.match(/<[^>]*>/g) ?? []) {
        for (const attribute of tag.match(/\s[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g) ?? []) {
          if (!/^\s[\w:.-]+="[^"]*"$/.test(attribute)) {
            throw new Error(`${/=\s*'/.test(attribute) ? 'Single-quoted' : 'Unsupported'} XML attribute syntax prevents a complete privacy scan.`);
          }
        }
      }
      if (name.startsWith('xl/worksheets/')) {
        for (const cell of xml.matchAll(/<c\b[^>]*>/g)) {
          const address = attr(cell[0], 'r');
          const range = address && /^[A-Za-z]{1,3}[1-9]\d*$/.test(address) ? parseRange(address) : null;
          if (!range || range.endCol > 16384 || range.endRow > 1048576) {
            throw new Error('Unsupported cell coordinates prevent a complete privacy scan.');
          }
        }
      }
    }
    if (entries.some(entry => entry.name === name)) throw new Error('Duplicate archive entries prevent a complete privacy scan.');
    entries.push({ name, data });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}
