/**
 * Stdio entry point for the Mog Canvas MCP server.
 *
 *   node server/mcp/index.ts
 *
 * Environment:
 *   MOG_WORKBOOK_DIR  workbook root the tools are confined to
 *                     (default: <repo>/workbooks)
 *   MOG_UI_DIST       built canvas component directory
 *                     (default: <repo>/plugins/mog-canvas/ui/dist)
 *
 * stdout belongs to the MCP protocol; every log line goes to stderr.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWorkbookService } from '../workbook-service.ts';
import { startAssetHost } from './asset-host.ts';
import { createMogCanvasServer } from './mog-canvas-server.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workbookRoot = process.env.MOG_WORKBOOK_DIR ?? resolve(repoRoot, 'workbooks');
const uiDist = process.env.MOG_UI_DIST ?? resolve(repoRoot, 'plugins', 'mog-canvas', 'ui', 'dist');

const service = createWorkbookService({ root: workbookRoot });
const assets = await startAssetHost({ uiDist });

const server = createMogCanvasServer({ service, assetOrigin: assets.origin });

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
async function shutdown() {
  await assets.close().catch(() => undefined);
  process.exit(0);
}

await server.connect(new StdioServerTransport());
console.error(
  `[mog-canvas] serving workbooks from ${service.root}; assets at ${assets.origin} (ui: ${uiDist})`,
);
