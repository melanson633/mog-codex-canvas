---
title: Codex does not interpolate CLAUDE_PLUGIN_ROOT in plugin .mcp.json — self-locating launcher
date: 2026-07-26
category: integration-issues
module: plugin
problem_type: integration_issue
component: codex_plugin
symptoms:
  - "codex mcp list shows the literal ${CLAUDE_PLUGIN_ROOT} placeholder in args"
  - "MCP server spawn fails; tools absent in Codex sessions after plugin install"
root_cause: platform_constraint
resolution_type: workaround
severity: medium
tags: [codex, plugins, mcp, claude-plugin-root, marketplace, launcher]
---

# Codex does not interpolate CLAUDE_PLUGIN_ROOT in plugin .mcp.json — self-locating launcher

## Problem

After installing the plugin, Codex sessions had no Mog tools. `codex mcp list` showed the literal `${CLAUDE_PLUGIN_ROOT}` placeholder in the server args — Codex does not interpolate it (openai/codex#19582) — so the server spawn failed silently from the user's perspective.

## Solution

A self-locating launcher, `plugins/mog-canvas/bin/mcp-launch.mjs`, resolves the repo root from its own `import.meta.url` instead of relying on any variable. This is valid because **local marketplace plugins run in place** (no cache copy) — a fact established from Codex's own binary, not guessed. `.mcp.json` stays spec-idiomatic with the placeholder; the docs carry the working fallback the user actually ran:

```bash
codex mcp add mog-canvas -- node <absolute-path>/plugins/mog-canvas/bin/mcp-launch.mjs
```

## Ground truth via binary extraction

Rather than guessing manifest schemas, the exact contracts were extracted from the installed `codex.exe` (0.144.0): strings plus the embedded `validate_plugin.py` (trimmed of binary junk after a `U+0001` SyntaxError at line 630). That yielded:

- exact `plugin.json` / `.mcp.json` / `.app.json` / `marketplace.json` schemas and policy constants;
- marketplace resolution rules: relative source paths resolve against the **marketplace root**, and a root-level `marketplace.json` is **not** recognized — it must be `.agents/plugins/marketplace.json`;
- the "local marketplaces run in place" behavior the launcher depends on.

The extracted validator was then run against the plugin: "Plugin validation passed."

## Prevention

- Verify plugin wiring post-install with `codex mcp list` — a literal `${...}` in args means the host never interpolated it.
- Codex does not render MCP Apps inline (openai/codex#21019; `enable_mcp_apps` in development). "Works in Codex" means the install/handshake step passed, nothing more — don't upgrade partial protocol success into a verified-host claim.
- When a host's plugin format is undocumented, the installed binary is the authority: extract its embedded validator and schemas instead of pattern-matching from other ecosystems.

## Related Issues

- docs/solutions/architecture-patterns/validating-mog-mcp-apps-without-overclaiming-codex-host-support.md — the validation ladder this feeds; the launcher fallback in operation
