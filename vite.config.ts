import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileBridge } from './server/file-bridge';
import { mogAssets } from './server/mog-assets';

/** Workbook root the canvas may read and write. Override with MOG_WORKBOOK_DIR. */
const workbookRoot = process.env.MOG_WORKBOOK_DIR ?? resolve(import.meta.dirname, 'workbooks');

export default defineConfig({
  plugins: [react(), mogAssets(), fileBridge({ root: workbookRoot })],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  // The embed ships a ~41 MB wasm binary and a 19 MB bundle; prebundling it on
  // every cold start is the slowest part of `npm run dev`, so keep it cached.
  // react-dom/client is listed too: discovering it after first paint triggers a
  // full page reload, which throws away a just-mounted canvas.
  optimizeDeps: {
    include: ['@mog-sdk/spreadsheet-app', 'react', 'react-dom/client'],
  },
  build: {
    chunkSizeWarningLimit: 32_000,
  },
});
