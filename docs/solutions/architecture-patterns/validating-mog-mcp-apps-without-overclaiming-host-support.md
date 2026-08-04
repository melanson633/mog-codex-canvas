---
title: Validate Mog MCP Apps without overclaiming host support
date: 2026-07-26
last_refreshed: 2026-08-04
category: architecture-patterns
module: mog-canvas
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - embedding a stateful browser UI in an agent host through an MCP Apps resource
  - local protocol and iframe harnesses can run before user-level host installation is approved
related_components:
  - testing_framework
  - documentation
tags:
  - mcp-apps
  - agent-host-plugin
  - mog
  - xlsx
  - host-validation
  - sandbox
  - revision-control
---

# Validate Mog MCP Apps without overclaiming host support

## Context

This repository delivers the Mog canvas through four deliberately separate layers:

1. A repository marketplace and plugin package declare the local `mog-canvas` plugin (`.claude-plugin/marketplace.json:1`, `plugins/mog-canvas/.claude-plugin/plugin.json:1`).
2. A stdio MCP server exposes workbook tools and the `ui://mog-canvas/canvas.html` MCP Apps resource (`server/mcp/mog-canvas-server.ts:66`).
3. The app mounts the real `@mog-sdk/spreadsheet-app`; workbook bytes enter and leave through MCP tools rather than the asset server (`plugins/mog-canvas/ui/src/mcp-app.ts:176`).
4. A shared service owns containment, revisions, conflict handling, backups, validation, and screenshots for the standalone HTTP bridge and MCP lane (`server/file-bridge.ts:78`, `server/mcp/index.ts:25`). The direct headless script shares the path policy but does not use the service's session, backup, or conflict semantics (`scripts/headless-edit.mjs:18`, `scripts/headless-edit.mjs:70`).

The UI bundle, WASM, and fonts come from a loopback-only asset host whose origin is declared in the resource's CSP metadata. Workbook data remains on the MCP tool path (`server/mcp/asset-host.ts:1`, `server/mcp/mog-canvas-server.ts:70`).

The important boundary is evidentiary: repository checks can prove the package, protocol, reference-host iframe, real Mog canvas, workbook round trip, and safety controls. They do not prove that any real desktop host renders the MCP App. Both the protocol and package checks state that limit directly (`scripts/mcp-check.mjs:20`, `scripts/plugin-check.mjs:20`).

Earlier work established the same distinction incrementally (session history): first the real canvas worked in a standalone browser, then persistence and containment were hardened, and only then was the proven core wrapped as an MCP Apps plugin. Host installation was deliberately left for a separately authorized test because it changes user-level configuration.

The gate has since been carried by two hosts differently, which is the pattern's whole point: Claude Code passed it — canvas rendered, cell edited, edit confirmed on disk — while Codex, the host this started for, still has not. One package, one ladder, two different top-rung statuses.

## Guidance

### Keep one workbook authority

Keep the UI and transport layers thin. Route stateful HTTP and MCP workbook operations through one service so authorization and save semantics cannot drift between those surfaces (`server/file-bridge.ts:78`, `server/mcp/index.ts:25`). If a direct headless lane intentionally bypasses session-aware persistence, keep its path policy aligned and describe its weaker concurrency and backup guarantees explicitly.

Accept only authorized root-relative `.xlsx` or `.png` names. Reject absolute and drive-relative paths, NTFS alternate data streams, wrong extensions, traversal, and canonicalized link escapes. For new files, canonicalize the existing parent before joining the basename (`server/path-policy.ts:27`, `server/path-policy.ts:78`).

Treat the SHA-256 of on-disk bytes as the workbook revision (`server/workbook-service.ts:69`). Bind a Workbook Session to that revision and compare it again at save time. A stale save must not overwrite newer work; preserve the attempted bytes as a conflict sibling instead (`server/workbook-service.ts:289`, `server/workbook-service.ts:395`).

For a successful save, write and flush a unique staged sibling, retain the prior workbook as a backup, and then promote the staged file. If promotion fails, keep the original in place and remove the staged file (`server/workbook-service.ts:157`).

### Keep the app transport narrow

The MCP App should receive the session from `open_workbook`, fetch workbook bytes through an app-only tool, mount the real Mog adapter, and persist exported XLSX bytes through `save_workbook` (`plugins/mog-canvas/ui/src/mcp-app.ts:176`).

Do not send workbook bytes over the loopback HTTP server. Restrict that server to public runtime assets and contained `GET` or `HEAD` requests (`server/mcp/asset-host.ts:48`, `server/mcp/asset-host.ts:67`).

Build the component as a production bundle with stable entry names and relative assets so runtime does not depend on a Vite development server (`vite.mcp-app.config.ts:1`).

### Use a validation ladder

Report each result at the highest layer actually tested:

1. **Package evidence** — manifests have the expected shape and the self-locating launcher boots the server from an unrelated working directory (`scripts/plugin-check.mjs:55`).
2. **Protocol evidence** — the real stdio server exposes the UI resource and tools; a disposable workbook can be opened, fetched, edited, saved, reopened, validated, screenshotted, and subjected to containment and stale-save checks (`scripts/mcp-check.mjs:193`).
3. **Reference Host evidence** — the real Mog canvas reaches ready in a sandboxed iframe; keyboard input makes it dirty, Save writes through the MCP tool path, the revision advances, and Screenshot produces a PNG (`scripts/mcp-app-smoke.mjs:442`).
4. **Host Acceptance Gate** — install or register the plugin in the target host, call `open_workbook`, visibly confirm that the host renders the canvas, edit and save a cell, and validate the on-disk workbook (`docs/CLAUDE-CODE-PLUGIN.md:104`).

The gate is per host, not per package. Passing it in one host says nothing about another: the same package that renders in Claude Code has never been seen rendering in Codex. Track the top rung separately for each, and name the host in every claim.

Until a given host's gate passes, use precise wording: “Validated with local protocol and Reference Host harnesses; rendering in <host> remains unverified.” Do not describe the plugin as replacing a host's native XLSX preview or guaranteeing a permanent side panel; placement and rendering are controlled by the host (`docs/CLAUDE-CODE-PLUGIN.md:204`).

Note what kind of evidence the top rung is. Rungs 1-3 are commands anyone can re-run; rung 4 is an observation, because the rendering decision belongs to the host. Keep it in its own section rather than folding it into the harness results, and re-observe it after changes to the UI bundle or resource metadata.

### Keep a useful fallback

If a host does not render the MCP App, the MCP workbook tools still provide open, save, validate, and screenshot operations; only the embedded canvas remains unavailable (`docs/CLAUDE-CODE-PLUGIN.md:124`). A human can run the standalone companion beside the host against the same confined Workbook Root (`README.md:10`).

If plugin startup fails because the plugin-root placeholder is passed literally, register the self-locating launcher directly by absolute path as documented (`docs/CLAUDE-CODE-PLUGIN.md:88`, `plugins/mog-canvas/bin/mcp-launch.mjs:1`).

## Why This Matters

A spreadsheet canvas combines path input, binary file replacement, a browser/WASM runtime, and concurrent human and agent edits. Centralizing those concerns prevents a visually successful demo from escaping its root, damaging a workbook, or silently overwriting a newer edit.

The validation ladder prevents a different failure: claiming product integration from a protocol simulation. A Reference Host is strong evidence that the resource and canvas interoperate, but only the real desktop host decides whether and where that resource appears. Separating the gates turns the remaining deployment risk into a specific, observable acceptance test — and it is what let this project switch its primary host without rewriting any claim below rung 4.

## When to Apply

- A local desktop agent should edit real files through an MCP App.
- Browser, iframe, and headless workflows must share persistence rules.
- Workbook edits need recoverable replacement and optimistic concurrency.
- A protocol-compatible harness exists but the target desktop host has not been exercised.
- The product needs a tool-only or standalone fallback while host rendering remains uncertain.

Do not substitute protocol or Reference Host success for the Host Acceptance Gate. Do not loosen path policy to simplify a demo, and do not let two lanes write the same workbook without revision coordination.

## Examples

Run each verification layer independently so a failure identifies the boundary:

```powershell
npm ci
npm run build:mcp-app
npm test
npm run typecheck
npm run verify
npm run check:mcp
npm run check:app
npm run check:plugin
```

`npm ci` installs the locked dependencies; the seven `npm run` commands are the repository's declared build and check surfaces (`package.json:7`). `check:mcp` proves protocol behavior, `check:app` exercises the real canvas through a Reference Host, and `check:plugin` validates packaging and launcher behavior for both hosts' manifest shapes. None alone proves desktop rendering anywhere.

A precise pre-host-gate release statement is:

> The local plugin package, MCP protocol, real Mog iframe canvas, edit/save/reopen/validate/screenshot round trip, path containment, revision-conflict handling, and production bundle are covered by repository checks. Rendering inside the `<host>` desktop host has not yet been verified.

After the Host Acceptance Gate, record the host and its version, connection state, whether `open_workbook` displayed the app, the edited cell and saved revision, and the `validate_workbook` result. “The tools connected” is not equivalent to “the canvas rendered.”

Past browser work also exposed two useful harness lessons (session history): a canvas-painted grid needs formula-bar or disk read-back evidence rather than DOM text, and deterministic keyboard navigation is more reliable than pixel targeting for cell edits.

## Related

- [Plugin runbook](../../CLAUDE-CODE-PLUGIN.md) — installation, host gate, fallback registration, rollback, known limitations, and the secondary Codex path.
- [Project architecture](../../../README.md) — standalone workflow, validation scripts, and human/headless lanes.
- [Historical Mog API evidence](../../API-EVIDENCE.md) — embed API evidence from the standalone phase; its “not a host integration” status predates the current plugin.
- [MCP Apps inline-rendering issue](https://github.com/openai/codex/issues/21019) — current host-rendering limitation tracked upstream.
- [Plugin-root interpolation issue](https://github.com/openai/codex/issues/19582) — reason for the documented absolute-path launcher fallback.
