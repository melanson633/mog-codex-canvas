#!/usr/bin/env node
/**
 * Launcher for the Mog Canvas MCP server, shipped inside the plugin root.
 *
 * This plugin installs from a local marketplace, which both supported hosts
 * use in place ("local marketplace sources are added without staging a copied
 * install root"), so this file always lives at <repo>/plugins/mog-canvas/bin/
 * and can locate the repo checkout from its own position. That keeps startup
 * independent of the host's working directory, environment variables, and
 * `${CLAUDE_PLUGIN_ROOT}` interpolation — which Claude Code performs but Codex
 * does not, in plugin .mcp.json args today (openai/codex#19582).
 *
 * The server entry resolves its own defaults (workbook root, UI dist) from
 * the repo layout; MOG_WORKBOOK_DIR / MOG_UI_DIST still override them.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pluginRoot, '..', '..');
await import(pathToFileURL(resolve(repoRoot, 'server', 'mcp', 'index.ts')).href);
