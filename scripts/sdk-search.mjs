/**
 * Ask the SDK what its API is called, instead of guessing.
 *
 *   npm run sdk:search -- "used range"        # plain-language search
 *   npm run sdk:search -- ws.setFormulas      # signature + docstring
 *   npm run sdk:search -- --all               # every path the SDK exposes
 *
 * Guessing has been wrong here repeatedly — `wb.sheets.get`,
 * `ws.structure.setColumnWidth` and a `workbook_metadata` tool were all
 * invented names. The engine ships its own index; this is the shortest path
 * to it. See docs/solutions/integration-issues/mog-sdk-node-subpath-and-proxy-introspection.md
 *
 * Read-only: introspection only, no workbook is opened.
 */
import { api } from '@mog-sdk/sdk';

const query = process.argv.slice(2).join(' ').trim();

if (!query) {
  console.error('usage: npm run sdk:search -- "<query>" | <ws.path> | --all');
  process.exit(2);
}

function show(entry) {
  const path = entry.path ?? entry.name;
  const kind = entry.kind ? `  [${entry.kind}]` : '';
  console.log(`\n${path}${kind}`);
  if (entry.signature) console.log(`  ${entry.signature}`);
  const doc = (entry.docstring ?? '').trim();
  if (doc) {
    for (const l of doc.split('\n').slice(0, 6)) console.log(`  | ${l.trim()}`);
  }
}

if (query === '--all') {
  // The full map, for "what are we not using?" sweeps.
  const top = await api.describe();
  const paths = new Set();
  const harvest = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const e of value) {
          const name = typeof e === 'string' ? e : e?.name;
          if (name) paths.add(prefix + name);
        }
      } else if (value && typeof value === 'object') harvest(value, prefix);
    }
  };
  for (const [group, node] of Object.entries(top ?? {})) {
    harvest(node, group === 'workbook' ? 'wb.' : group === 'worksheet' ? 'ws.' : `${group}.`);
  }
  for (const p of [...paths].sort()) console.log(p);
  console.log(`\n${paths.size} paths`);
  process.exit(0);
}

// A dotted path is a lookup; anything else is a search. The `ws.`/`wb.` prefix
// is required — describe() returns null for a bare name, which reads as "no
// such API" when it really means "bad path".
if (/^(ws|wb|worksheet|workbook)\./.test(query)) {
  const described = await api.describe(query);
  if (!described) {
    console.error(`No such path: ${query}`);
    console.error('Paths need a ws. or wb. prefix. Try a search instead:');
    console.error(`  npm run sdk:search -- "${query.replace(/^\w+\./, '')}"`);
    process.exit(1);
  }
  show(typeof described === 'object' ? { path: query, ...described } : { path: query });
  console.log('');
  process.exit(0);
}

const results = await api.search(query);
const rows = Array.isArray(results) ? results : [];
if (rows.length === 0) {
  console.error(`No matches for ${JSON.stringify(query)}.`);
  console.error('Try fewer or more general words, or `--all` to browse.');
  process.exit(1);
}
// The raw ranking floats type declarations above callable members, which is
// backwards for the question this command exists to answer ("what do I call?").
const callableFirst = [...rows].sort((a, b) => {
  const rank = (r) => (String(r.path ?? r.name ?? '').startsWith('type:') ? 1 : 0);
  return rank(a) - rank(b);
});
for (const row of callableFirst.slice(0, 12)) show(row);
console.log(`\n${rows.length} match(es).`);
