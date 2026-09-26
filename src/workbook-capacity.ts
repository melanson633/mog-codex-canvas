/** Conservative routing policy, not an engine performance guarantee. */
export function needsSavedView(profile: { cells: number; formulas: number; bytes: number }) {
  return profile.cells > 100_000 || profile.formulas > 20_000 || profile.bytes > 8 * 1024 * 1024;
}
