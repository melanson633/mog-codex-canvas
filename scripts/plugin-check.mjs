/**
 * Codex plugin package check.
 *
 *   node scripts/plugin-check.mjs
 *
 * Verifies the installable plugin package under plugins/mog-canvas plus the
 * repo marketplace manifest, against the shapes Codex 0.144.0 actually
 * ingests (extracted from its bundled plugin-creator skill and validator):
 *
 *   1. plugin.json: required fields, strict semver, companion paths exist
 *   2. .mcp.json: only the mcpServers key; entries have command + args
 *   3. .app.json: app objects carry only id and category
 *   4. marketplace.json at .agents/plugins/: source path resolves to the
 *      plugin dir relative to the repo root (the marketplace root)
 *   5. the launcher boots the real MCP server from an unrelated working
 *      directory: MCP initialize succeeds and tools/list returns the full
 *      tool surface
 *
 * Exit code 0 only if every check passes. This validates the package, not
 * any particular Codex host behavior.
 */
import { readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(repoRoot, 'plugins', 'mog-canvas');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error?.stack ?? error}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

await check('plugin.json follows the ingestion contract', async () => {
  const manifest = await readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
  for (const field of ['name', 'version', 'description']) {
    expect(typeof manifest[field] === 'string' && manifest[field].length > 0, `missing ${field}`);
  }
  expect(manifest.name === 'mog-canvas', `name is ${manifest.name}`);
  expect(SEMVER.test(manifest.version), `version not strict semver: ${manifest.version}`);
  expect(typeof manifest.author?.name === 'string' && manifest.author.name.length > 0, 'author.name missing');
  const iface = manifest.interface;
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    expect(typeof iface?.[field] === 'string' && iface[field].length > 0, `interface.${field} missing`);
  }
  expect(Array.isArray(iface.defaultPrompt) && iface.defaultPrompt.length <= 3, 'defaultPrompt must be ≤3 entries');
  for (const prompt of iface.defaultPrompt) {
    expect(prompt.length <= 128, `defaultPrompt entry over 128 chars: ${prompt}`);
  }
  expect(!('skills' in manifest), 'skills declared but no skills/ directory ships');
  expect(!('hooks' in manifest), 'hooks is not an accepted manifest field');
  // Companion paths must start with ./ and exist inside the plugin root.
  for (const [field, file] of [['mcpServers', '.mcp.json'], ['apps', '.app.json']]) {
    expect(manifest[field] === `./${file}`, `${field} should be ./${file}`);
    await access(join(pluginRoot, file));
  }
  return `v${manifest.version}`;
});

await check('.mcp.json declares only mcpServers with runnable entries', async () => {
  const config = await readJson(join(pluginRoot, '.mcp.json'));
  expect(
    Object.keys(config).length === 1 && 'mcpServers' in config,
    `.mcp.json may only contain mcpServers, has ${Object.keys(config).join(', ')}`,
  );
  const servers = Object.entries(config.mcpServers);
  expect(servers.length === 1, `expected one server, found ${servers.length}`);
  const [name, server] = servers[0];
  expect(name === 'mog-canvas', `server name is ${name}`);
  expect(server.command === 'node', `command is ${server.command}`);
  expect(Array.isArray(server.args) && server.args.length > 0, 'args missing');
  // The arg uses the cross-CLI plugin-root placeholder; the file it points at
  // must exist inside the plugin. (Codex does not interpolate it yet —
  // openai/codex#19582 — which is why the launcher also works by absolute path.)
  const relative = server.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
  expect(relative !== server.args[0], 'args[0] should be anchored at ${CLAUDE_PLUGIN_ROOT}');
  await access(join(pluginRoot, relative));
  return server.args[0];
});

await check('.app.json app objects carry only id and category', async () => {
  const config = await readJson(join(pluginRoot, '.app.json'));
  expect(
    Object.keys(config).length === 1 && 'apps' in config,
    `.app.json may only contain apps, has ${Object.keys(config).join(', ')}`,
  );
  const apps = Object.entries(config.apps);
  expect(apps.length === 1, `expected one app, found ${apps.length}`);
  const [, app] = apps[0];
  const extra = Object.keys(app).filter((key) => key !== 'id' && key !== 'category');
  expect(extra.length === 0, `unsupported app fields: ${extra.join(', ')}`);
  expect(typeof app.id === 'string' && app.id.length > 0, 'id must be a non-empty string');
  return `id=${app.id}`;
});

await check('marketplace.json points at the plugin relative to the repo root', async () => {
  const manifest = await readJson(join(repoRoot, '.agents', 'plugins', 'marketplace.json'));
  expect(typeof manifest.name === 'string' && /^[A-Za-z0-9_-]+$/.test(manifest.name), 'marketplace name invalid');
  expect(manifest.name !== 'personal', 'must not collide with the default personal marketplace');
  const entry = manifest.plugins?.find((p) => p.name === 'mog-canvas');
  expect(entry, 'no mog-canvas entry');
  expect(entry.source?.source === 'local', 'source.source must be local');
  // Relative source paths resolve against the marketplace root — the
  // directory containing .agents/ — which for this repo is the repo root.
  expect(entry.source?.path === './plugins/mog-canvas', `source.path is ${entry.source?.path}`);
  await access(join(repoRoot, 'plugins', 'mog-canvas', '.codex-plugin', 'plugin.json'));
  expect(['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(entry.policy?.installation), 'bad installation policy');
  expect(['ON_INSTALL', 'ON_USE'].includes(entry.policy?.authentication), 'bad authentication policy');
  expect(typeof entry.category === 'string' && entry.category.length > 0, 'category missing');
  return `${manifest.name} → ${entry.source.path}`;
});

await check('launcher boots the server from an unrelated cwd', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginRoot, 'bin', 'mcp-launch.mjs')],
    // A cwd the repo has nothing to do with — the launcher must not care.
    cwd: tmpdir(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'plugin-check', version: '0.0.1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    const required = [
      'close_workbook_session',
      'fetch_workbook_bytes',
      'get_workbook_session',
      'list_workbooks',
      'open_workbook',
      'save_screenshot',
      'save_workbook',
      'screenshot_workbook',
      'validate_workbook',
    ];
    for (const name of required) {
      expect(names.includes(name), `missing tool ${name}`);
    }
    return `${tools.length} tools via launcher`;
  } finally {
    await client.close().catch(() => undefined);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
