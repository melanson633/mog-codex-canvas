---
title: Running a WASM engine in an MCP Apps sandboxed iframe — CSP grant ladder and storage shim
date: 2026-07-26
category: integration-issues
module: mcp-app
problem_type: integration_issue
component: mcp_server
symptoms:
  - "CSP violations: script-src blocked eval / wasm-eval; engine never compiles"
  - "SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag"
  - "Mount stuck at 'mounting canvas' after CSP is relaxed"
root_cause: platform_constraint
resolution_type: code_fix
severity: high
tags: [mcp-apps, sep-1865, csp, wasm-unsafe-eval, sandbox, localstorage, iframe, mog]
---

# Running a WASM engine in an MCP Apps sandboxed iframe — CSP grant ladder and storage shim

## Problem

The Mog spreadsheet engine would not boot inside a spec-literal MCP Apps (SEP-1865) iframe: first the WASM would not compile under the default CSP, and after relaxing CSP the mount hung on a `localStorage` SecurityError.

## Root Cause

1. SEP-1865's default CSP has no `wasm-unsafe-eval`, so `WebAssembly.instantiate` is blocked outright.
2. `sandbox="allow-scripts"` (without `allow-same-origin`) gives the iframe an opaque origin, and **accessing** `window.localStorage` from an opaque origin throws — the Mog engine reads web storage at startup.

## Solution

**CSP: prove the minimal grant with a ladder, don't jump to `unsafe-eval`.** The smoke harness injects CSP in three steps — strict → `+ wasm-unsafe-eval + worker-src blob:` → `+ unsafe-eval` — and reports which rung reaches full ready. Result: `'wasm-unsafe-eval'` + `worker-src blob:` is sufficient. Three `eval` violations persist at that rung but are **caught feature probes**, not load-bearing — `'unsafe-eval'` is never needed. This is documented as a host requirement rather than hidden.

**Storage: shim before the engine module loads.** An in-memory `Storage` stand-in is installed via `Object.defineProperty(window, 'localStorage', ...)` at the top of `mcp-app.ts`, before the engine module is imported. This is product-side compatibility for opaque origins, not host patching.

Two adjacent constraints worth knowing:

- Assets can't be inlined into the MCP Apps HTML resource: the engine is ~19 MB JS + 41 MB WASM (~55 MB as base64), and inline/base64 instantiation has no guaranteed `wasm-unsafe-eval` anyway. Hence the loopback asset host: static assets over HTTP with CORS `*` (safe because nothing private is served — workbook bytes travel only through MCP tools), while the iframe origin stays host-chosen and unknowable in advance.
- Mog's actor model refuses privileged actor kinds (`host`/`agent`/`automation`/`system`) without a registered host authority adapter; `kind: 'user'` resolves directly — required for `captureScreenshot` from an embed shell.

## Prevention

- When a CSP violation report mixes load-bearing and probe failures, distinguish them empirically (does the app reach ready?) before granting broader eval rights.
- Any startup `localStorage`/`sessionStorage` read in third-party code will throw in an `allow-scripts`-only sandbox — shim storage before module evaluation, not after mount fails.

## Related Issues

- docs/solutions/runtime-errors/wasm-bindgen-ignores-wasm-base-url.md — the asset host must serve the wasm at both URL shapes
