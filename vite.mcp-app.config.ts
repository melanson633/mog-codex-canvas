/**
 * Production build of the MCP Apps canvas component.
 *
 *   vite build --config vite.mcp-app.config.ts
 *
 * Emits plugins/mog-canvas/ui/dist with fixed entry names — the MCP server's
 * bootstrap HTML links exactly /ui/mcp-app.js and /ui/mcp-app.css — plus
 * hash-named chunks and assets that those two reference relatively (base
 * './'), so the whole dist is portable to whatever loopback port the asset
 * host binds. No dev server is involved at runtime.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // The component only ever runs in a current desktop-host webview; ES2022
    // keeps the entry's top-level await instead of transpiling it away.
    target: 'es2022',
    outDir: 'plugins/mog-canvas/ui/dist',
    emptyOutDir: true,
    // One stylesheet, linked by the bootstrap document. Dynamic CSS imports
    // (the embed's styles.css) land here too instead of in per-chunk files
    // the bootstrap could never know about.
    cssCodeSplit: false,
    chunkSizeWarningLimit: 32_000,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'plugins/mog-canvas/ui/src/mcp-app.ts'),
      output: {
        entryFileNames: 'mcp-app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (info) =>
          (info.names ?? []).some((name) => name.endsWith('.css'))
            ? 'mcp-app.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
