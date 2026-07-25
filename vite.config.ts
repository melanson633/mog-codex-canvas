import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, normalizePath } from 'vite';
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
    // The workbook root holds data, not source. Nothing here reloads from it —
    // the canvas re-reads over the bridge on demand — and watching it is
    // actively harmful on Windows: a watch added to a file that is still being
    // written fails with EBUSY, chokidar raises that as an unhandled error
    // event, and the dev server dies in the middle of the save that created the
    // file. A save from the canvas or an edit from the headless lane both do it.
    watch: { ignored: [`${normalizePath(workbookRoot)}/**`] },
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
