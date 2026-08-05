/**
 * A workbook's revision key: the SHA-256 of its bytes on disk.
 *
 * This lives on its own so the extraction stages can key their results to a
 * revision (R3) without importing the filesystem-bound workbook service, which
 * will in turn import them. `workbook-service.ts` re-exports it, so its public
 * surface is unchanged.
 */
import { createHash } from 'node:crypto';

export function revisionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
