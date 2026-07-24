/**
 * Adapter resolution: decide at runtime whether a real Mog canvas is available.
 *
 * The probe is deliberately a real import + shape check rather than a version
 * guess, so the UI reports what actually loaded on this machine.
 */
import { createMogEmbedAdapter } from './mog-embed-adapter';
import { createUnavailableAdapter } from './unavailable-adapter';
import type { CanvasAdapter } from './types';

export type { CanvasAdapter, CanvasSession, AdapterProbe, HostServices, ColorScheme } from './types';

export async function resolveCanvasAdapter(): Promise<CanvasAdapter> {
  try {
    const embed = await import('@mog-sdk/spreadsheet-app');
    if (
      typeof embed.createSpreadsheetRuntime !== 'function' ||
      typeof embed.mountSpreadsheetApp !== 'function'
    ) {
      return createUnavailableAdapter(
        '@mog-sdk/spreadsheet-app loaded but does not export createSpreadsheetRuntime + ' +
          'mountSpreadsheetApp. The embed API changed; update src/adapters/mog-embed-adapter.ts.',
      );
    }
    return createMogEmbedAdapter(embed);
  } catch (error) {
    return createUnavailableAdapter(
      `Failed to load @mog-sdk/spreadsheet-app: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
