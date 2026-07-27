---
title: wasm-bindgen loader ignores the asset policy — serve the WASM at both URL shapes
date: 2026-07-26
category: runtime-errors
module: dev-app
problem_type: runtime_error
component: tooling
symptoms:
  - "EngineCreateError / CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f"
  - "200 text/html for a .wasm request (the SPA fallback answered it)"
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [wasm, wasm-bindgen, vite, spa-fallback, mog-sdk, spreadsheet-app]
---

# wasm-bindgen loader ignores the asset policy — serve the WASM at both URL shapes

## Problem

The embedded Mog canvas (`@mog-sdk/spreadsheet-app`) failed to boot with `CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f`. The found bytes are `<!do` — the engine received HTML where it expected WASM.

## Root Cause

The wasm-bindgen loader inside the bundle resolves `compute_core_wasm_bg.wasm` against **its own `import.meta.url`**, ignoring the `assets.wasmBaseUrl` host policy entirely. Under Vite dependency optimization the bundle chunk lives at `/node_modules/.vite/deps/`, so the fetch goes to `/node_modules/.vite/deps/compute_core_wasm_bg.wasm` — a path nothing serves, which the SPA fallback answers with `200 text/html` (index.html). A 200 with the wrong body is invisible until the engine tries to compile it. Upstream never hits this because its build copies the wasm next to the bundle.

CDP network capture found it, not static analysis — grepping the 19 MB bundle for the URL construction dead-ended (`DEFAULT_HOST_WASM_BASE_URL = "/"` exists, but the filename join site was not findable).

## Solution

A Vite middleware plugin (`server/mog-assets.ts`) serves the wasm and fonts straight out of `node_modules` and answers **both** URL shapes:

1. the policy shape (`/mog/...` per `assets.wasmBaseUrl`), and
2. the bundle-relative shape (`/node_modules/.vite/deps/compute_core_wasm_bg.wasm`).

`scripts/verify.mjs` asserts both routes return `application/wasm` (41,303,291 bytes), so a regression fails loudly. An earlier asset-copy approach (a sync script copying into a public asset directory — both since deleted) handled shape 1 only and could not fix the self-relative fetch; it was deleted when the middleware replaced it.

## Prevention

- Any host serving `@mog-sdk/spreadsheet-app` (static build, MCP asset host, other server) must replicate both routes or it will silently regress with the same magic-word error. The MCP asset host in this repo already does.
- When a WASM engine dies at instantiate with `3c 21 64 6f` / `3c 68 74 6d`, the request got HTML — check what URL was actually fetched (network capture), not what the policy says should be fetched.

## Related Issues

- docs/solutions/ui-bugs/file-origin-compare-page-blank-iframes.md — "use the dev server" works because of this middleware
