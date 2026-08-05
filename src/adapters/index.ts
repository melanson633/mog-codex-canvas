/**
 * Adapter resolution: decide at runtime whether a real Mog canvas is available.
 *
 * The probe is deliberately a real import + shape check rather than a version
 * guess, so the UI reports what actually loaded on this machine.
 *
 * Both halves of the embed — the module and its stylesheet — are imported here,
 * inside the same guarded path. Either one failing therefore produces the
 * unavailable adapter before anything asks a canvas to open; loading the
 * stylesheet later, from the returned adapter, would let a renamed
 * ./styles.css export throw after the app had already committed to the canvas.
 */
import { createMogEmbedAdapter, type EmbedModule } from './mog-embed-adapter';
import { createUnavailableAdapter } from './unavailable-adapter';
import type { CanvasAdapter } from './types';

export type {
  CanvasAdapter,
  CanvasSession,
  CanvasContextSnapshot,
  AdapterProbe,
  HostServices,
  ColorScheme,
} from './types';

/**
 * The two imports resolution depends on. Injectable so the fallback path can be
 * exercised by faulting one import, instead of deleting the package on disk.
 */
export interface EmbedImports {
  styles(): Promise<unknown>;
  module(): Promise<EmbedModule>;
}

export const EMBED_IMPORTS: EmbedImports = {
  styles: () => import('@mog-sdk/spreadsheet-app/styles.css'),
  module: () => import('@mog-sdk/spreadsheet-app'),
};

export async function resolveCanvasAdapter(
  imports: EmbedImports = EMBED_IMPORTS,
): Promise<CanvasAdapter> {
  // The stylesheet first, so it is in the document before any grid paints. It
  // still lands after src/styles.css — which src/main.tsx imports statically,
  // before this ever runs — so the app's own rules keep the last word.
  try {
    await imports.styles();
  } catch (error) {
    return createUnavailableAdapter(
      `Failed to load @mog-sdk/spreadsheet-app/styles.css: ${reason(error)}`,
    );
  }

  let embed: EmbedModule;
  try {
    embed = await imports.module();
  } catch (error) {
    return createUnavailableAdapter(`Failed to load @mog-sdk/spreadsheet-app: ${reason(error)}`);
  }

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
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
