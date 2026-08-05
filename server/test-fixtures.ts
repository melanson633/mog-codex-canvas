/**
 * Hand-authored OOXML fixtures for the byte-first lane's tests.
 *
 * Only `workbooks/sample.xlsx` is a committed real workbook and real client
 * specimens can never be committed, so the staged-extraction pipeline is
 * verified against workbooks built here byte by byte. Three shapes, because
 * the design correction this lane exists for is about *mixed* workbooks and a
 * correction with no fixture exercising it is not verified:
 *
 *   - `modelFixture()`   — multi-sheet formula cascade, defined names
 *   - `datasetFixture()` — one wide table, per-row depth-1 formulas, a stale
 *     <dimension>, a mixed-type column, payroll-shaped headers, and a second
 *     sheet that actually consumes one of its columns
 *   - `mixedFixture()`   — both in one file, plus an indeterminate sheet
 *
 * This is weaker evidence than a real specimen and should be described that
 * way: it proves the code does what it was told, not that the thresholds it
 * applies are right (see the plan's Q3).
 *
 * Engine-free like everything else on this lane: nothing here imports
 * @mog-sdk. Fixtures are built lazily and memoized — the large ones cost
 * megabytes of XML and most test files need only one.
 */
import { crc32 } from 'node:zlib';

// ---- ZIP writer -------------------------------------------------------------

/** Rebuild a ZIP with stored (uncompressed) entries — enough for the reader. */
export function writeZipStored(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export const part = (name: string, xml: string) => ({ name, data: Buffer.from(xml) });

// ---- Part builders ----------------------------------------------------------

export interface SheetSpec {
  readonly name: string;
  /** Sheet XML body, without the <worksheet> wrapper. */
  readonly xml: string;
}

/** workbook.xml + its rels for an ordered sheet list. */
function workbookParts(sheets: readonly SheetSpec[], definedNamesXml = ''): { name: string; data: Buffer }[] {
  const sheetTags = sheets
    .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const rels = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  return [
    part('xl/workbook.xml', `<workbook><sheets>${sheetTags}</sheets>${definedNamesXml}</workbook>`),
    part('xl/_rels/workbook.xml.rels', `<Relationships>${rels}</Relationships>`),
    ...sheets.map((sheet, index) =>
      part(`xl/worksheets/sheet${index + 1}.xml`, `<worksheet>${sheet.xml}</worksheet>`),
    ),
  ];
}

const DOC_PROPS = [
  part(
    'docProps/core.xml',
    '<cp:coreProperties>' +
      '<dc:creator>Ada Lovelace</dc:creator>' +
      '<cp:lastModifiedBy>Grace Hopper</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-02-03T04:05:06Z</dcterms:modified>' +
      '</cp:coreProperties>',
  ),
  part(
    'docProps/app.xml',
    '<Properties><Application>Microsoft Excel</Application><AppVersion>16.0300</AppVersion></Properties>',
  ),
];

/** A <c> element. `value` is written verbatim into <v>. */
function cell(address: string, value: string, options: { type?: string; formula?: string } = {}): string {
  const type = options.type ? ` t="${options.type}"` : '';
  const formula = options.formula ? `<f>${options.formula}</f>` : '';
  return `<c r="${address}"${type}>${formula}<v>${value}</v></c>`;
}

/** A string cell carried inline, so fixtures need no sharedStrings bookkeeping. */
function textCell(address: string, text: string): string {
  return `<c r="${address}" t="inlineStr"><is><t>${text}</t></is></c>`;
}

/**
 * A run of single-formula rows.
 *
 * Model sheets need enough populated cells to be classifiable: a two-cell
 * sheet is honestly `indeterminate`, so a fixture meant to exercise model-role
 * behavior has to look like a model rather than lean on a lowered threshold.
 */
function formulaRows(
  from: number,
  to: number,
  at: (row: number) => { address: string; formula: string },
): string {
  const rows: string[] = [];
  for (let r = from; r <= to; r += 1) {
    const { address, formula } = at(r);
    rows.push(`<row r="${r}">${cell(address, '0', { formula })}</row>`);
  }
  return rows.join('');
}

function memoize<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

// ---- Model fixture ----------------------------------------------------------

/**
 * A formula cascade: Summary!F20 <- Estimate!B66 <- Data!B2:B10, plus a
 * defined name (TaxRate -> Rates!$C$1) and a hand-entered driver column.
 * Summary's chain is two hops deep, so it earns a trace section (R32).
 */
export const modelFixture = memoize(() =>
  writeZipStored([
    ...workbookParts(
      [
        {
          name: 'Summary',
          xml:
            '<dimension ref="A1:F20"/><sheetData>' +
            formulaRows(1, 8, (r) => ({ address: `B${r}`, formula: `Drivers!A1*${r}` })) +
            `<row r="20">${cell('F20', '42', { formula: 'Estimate!B66' })}` +
            `${cell('F21', '3', { formula: 'Drivers!A1+1' })}</row>` +
            '</sheetData>',
        },
        {
          name: 'Estimate',
          xml:
            '<dimension ref="A1:B66"/><sheetData>' +
            formulaRows(1, 8, (r) => ({ address: `A${r}`, formula: `Data!B${r + 1}` })) +
            `<row r="66">${cell('B66', '42', { formula: 'SUM(Data!B2:B10)' })}` +
            `${cell('C66', '4', { formula: 'B66*TaxRate' })}</row>` +
            '</sheetData>',
        },
        {
          name: 'Drivers',
          xml:
            '<dimension ref="A1:A2"/><sheetData>' +
            `<row r="1">${cell('A1', '2', { formula: 'Rates!C1*100' })}</row>` +
            `<row r="2">${cell('A2', '7', { formula: 'MissingName+1' })}</row>` +
            formulaRows(3, 10, (r) => ({ address: `A${r}`, formula: `Rates!C1*${r}` })) +
            '</sheetData>',
        },
        {
          name: 'Rates',
          xml: '<dimension ref="C1:C1"/><sheetData>' + `<row r="1">${cell('C1', '0.07')}</row>` + '</sheetData>',
        },
        {
          name: 'Data',
          xml:
            '<dimension ref="B1:B10"/><sheetData>' +
            `<row r="1">${textCell('B1', 'Values')}</row>` +
            Array.from(
              { length: 9 },
              (_, index) => `<row r="${index + 2}">${cell(`B${index + 2}`, String(index + 1))}</row>`,
            ).join('') +
            '</sheetData>',
        },
      ],
      '<definedNames>' +
        '<definedName name="TaxRate">Rates!$C$1</definedName>' +
        '<definedName name="LocalBox" localSheetId="1">Estimate!$A$1:$A$5</definedName>' +
        '</definedNames>',
    ),
    ...DOC_PROPS,
  ]),
);

/** Two cells that reference each other — the cycle-termination fixture (AE9). */
export const cyclicFixture = memoize(() =>
  writeZipStored(
    workbookParts([
      {
        name: 'Loop',
        xml:
          '<dimension ref="A1:B1"/><sheetData><row r="1">' +
          `${cell('A1', '0', { formula: 'B1' })}${cell('B1', '0', { formula: 'A1' })}` +
          '</row></sheetData>',
      },
    ]),
  ),
);

// ---- Dataset fixture --------------------------------------------------------

export const DATASET_ROWS = 3000;
/** How many Rollup formulas point at Raw!C — the heavily-consumed column. */
export const DATASET_AMOUNT_REFS = 40;

const DATASET_HEADERS = [
  'Id',
  'Name',
  'Amount',
  'Notes',
  'Score',
  'SSN',
  'Date of Birth',
  'Employee ID',
  'Total',
];

/**
 * One wide table on `Raw` with a deliberately stale <dimension> (declares
 * A1:Z5000 over a table that ends at row 3001), a mixed-type column, payroll
 * -shaped headers for the redaction guard, and per-row depth-1 formulas.
 * `Rollup` consumes column C forty times and column D never, and carries one
 * structured-reference formula the v1 parser cannot resolve.
 */
function buildDataset(rows: number): Buffer {
  const raw: string[] = [
    `<row r="1">${DATASET_HEADERS.map((header, index) =>
      textCell(`${String.fromCharCode(65 + index)}1`, header),
    ).join('')}</row>`,
  ];
  for (let index = 0; index < rows; index += 1) {
    const r = index + 2;
    // Column E disagrees on type six times: 'n/a' among numbers (AE7).
    const score = index % 500 === 3 ? textCell(`E${r}`, 'n/a') : cell(`E${r}`, String(index % 97));
    raw.push(
      `<row r="${r}">` +
        cell(`A${r}`, String(index + 1)) +
        textCell(`B${r}`, `Row ${index + 1}`) +
        cell(`C${r}`, String((index % 250) * 3)) +
        textCell(`D${r}`, index % 7 === 0 ? '' : `note ${index % 11}`) +
        score +
        textCell(`F${r}`, `123-45-${String(6000 + (index % 1000)).padStart(4, '0')}`) +
        cell(`G${r}`, String(30000 + (index % 9000))) +
        textCell(`H${r}`, `987-65-${String(4000 + (index % 1000)).padStart(4, '0')}`) +
        cell(`I${r}`, String((index % 250) * 6), { formula: `C${r}*2` }) +
        '</row>',
    );
  }

  const rollup: string[] = [];
  for (let index = 0; index < DATASET_AMOUNT_REFS; index += 1) {
    const r = index + 1;
    rollup.push(`<row r="${r}">${cell(`A${r}`, '0', { formula: `Raw!C${index + 2}+1` })}</row>`);
  }
  rollup.push(
    `<row r="${DATASET_AMOUNT_REFS + 1}">` +
      cell(`A${DATASET_AMOUNT_REFS + 1}`, '0', { formula: 'SUM(RawTable[Score])' }) +
      '</row>',
  );

  return writeZipStored([
    ...workbookParts([
      {
        name: 'Raw',
        // Claimed extent overstates the real one on purpose (AE2).
        xml: `<dimension ref="A1:Z5000"/><sheetData>${raw.join('')}</sheetData>`,
      },
      {
        name: 'Rollup',
        xml: `<dimension ref="A1:A${DATASET_AMOUNT_REFS + 1}"/><sheetData>${rollup.join('')}</sheetData>`,
      },
    ]),
    part(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="../tables/table1.xml"/></Relationships>',
    ),
    part(
      'xl/tables/table1.xml',
      `<table id="1" name="RawTable" displayName="RawTable" ref="A1:I${rows + 1}"><tableColumns count="${DATASET_HEADERS.length}">` +
        DATASET_HEADERS.map((header) => `<tableColumn id="1" name="${header}"/>`).join('') +
        '</tableColumns></table>',
    ),
    ...DOC_PROPS,
  ]);
}

export const datasetFixture = memoize(() => buildDataset(DATASET_ROWS));

/**
 * The latency specimen: ~12,000 formulas and ~120,000 cells, the shape R33's
 * budget is stated against. Built only by the tests that time the pipeline.
 */
export const largeDatasetFixture = memoize(() => buildDataset(12000));

// ---- Mixed fixture ----------------------------------------------------------

/**
 * The case a workbook-level genre label gets wrong: a dataset sheet and a
 * model cascade in one file, plus a sheet too sparse to judge. Its workbook
 * -level genre is necessarily wrong for at least one of its sheets, which is
 * what makes it the fixture for "no section is chosen by workbook genre".
 */
export const mixedFixture = memoize(() => {
  const rows = 300;
  const raw: string[] = [
    `<row r="1">${['Id', 'Amount', 'Notes'].map((header, index) => textCell(`${String.fromCharCode(65 + index)}1`, header)).join('')}</row>`,
  ];
  for (let index = 0; index < rows; index += 1) {
    const r = index + 2;
    raw.push(
      `<row r="${r}">` +
        cell(`A${r}`, String(index + 1)) +
        cell(`B${r}`, String((index % 50) * 4)) +
        textCell(`C${r}`, `note ${index % 5}`) +
        '</row>',
    );
  }

  return writeZipStored([
    ...workbookParts([
      { name: 'Raw', xml: `<dimension ref="A1:C${rows + 1}"/><sheetData>${raw.join('')}</sheetData>` },
      {
        name: 'Summary',
        xml:
          '<dimension ref="A1:B3"/><sheetData>' +
          `<row r="1">${cell('A1', '5', { formula: 'Estimate!A1' })}${cell('B1', '6', { formula: 'Estimate!A1*2' })}</row>` +
          `<row r="2">${cell('A2', '7', { formula: 'A1+B1' })}</row>` +
          formulaRows(3, 9, (r) => ({ address: `A${r}`, formula: `A2*${r}` })) +
          '</sheetData>',
      },
      {
        name: 'Estimate',
        xml:
          '<dimension ref="A1:A1"/><sheetData>' +
          `<row r="1">${cell('A1', '5', { formula: 'SUM(Raw!B2:B301)' })}</row>` +
          formulaRows(2, 8, (r) => ({ address: `A${r}`, formula: `Raw!B${r}*2` })) +
          '</sheetData>',
      },
      {
        name: 'Notes',
        xml:
          '<dimension ref="A1:A3"/><sheetData>' +
          `<row r="1">${textCell('A1', 'scratch')}</row>` +
          `<row r="2">${cell('A2', '1')}</row>` +
          `<row r="3">${cell('A3', '2')}</row>` +
          '</sheetData>',
      },
    ]),
    ...DOC_PROPS,
  ]);
});
