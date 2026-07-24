/**
 * Fallback adapter used only when the Mog embed cannot be loaded.
 *
 * It renders no fake grid. A placeholder spreadsheet would be a worse lie than
 * an empty panel: the point of this app is that the canvas is the real engine.
 * Instead it states exactly what failed and what still works headlessly.
 */
import type { AdapterProbe, CanvasAdapter, CanvasSession } from './types';

export function createUnavailableAdapter(reason: string): CanvasAdapter {
  const probe: AdapterProbe = {
    id: 'unavailable',
    label: 'Mog embed unavailable',
    available: false,
    capabilities: { liveCanvas: false, edit: false, saveToDisk: false, screenshot: false },
    detail: reason,
  };

  return {
    probe,

    async open(container): Promise<CanvasSession> {
      container.replaceChildren(buildNotice(reason));
      const unsupported = () => {
        throw new Error(`Canvas unavailable: ${reason}`);
      };
      return {
        save: unsupported,
        exportXlsx: unsupported,
        screenshot: unsupported,
        activeSheetName: () => undefined,
        dispose: async () => container.replaceChildren(),
      };
    },
  };
}

function buildNotice(reason: string): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'canvas-notice';

  const title = document.createElement('h2');
  title.textContent = 'The Mog canvas did not load';

  const detail = document.createElement('pre');
  detail.textContent = reason;

  const next = document.createElement('p');
  next.textContent =
    'Editing in this panel is disabled. Headless work is unaffected: run "npm run headless" ' +
    'to edit and validate the workbook through @mog-sdk/sdk, and open the file in the Mog ' +
    'extension in VS Code/Cursor for a live grid.';

  notice.append(title, detail, next);
  return notice;
}
