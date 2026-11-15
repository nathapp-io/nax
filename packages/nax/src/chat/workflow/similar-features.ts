/**
 * Near-miss suggestions for a feature name that has no artifacts yet.
 *
 * The chat workflow provider used to answer an absent feature with an error naming
 * every known feature directory. That made a first message about a brand-new feature
 * start with a failed tool call and a list of unrelated names, so the suggestion set
 * is now bounded to genuinely close matches (issue #2927).
 */

/** Most suggestions a single not-started result carries. */
export const MAX_SIMILAR_FEATURES = 3;

/** Two short names may differ in at least two characters; long names scale with their length. */
function distanceBound(name: string): number {
  return Math.max(2, Math.floor(name.length / 4));
}

/** Levenshtein distance over code units, computed on two rolling rows. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitute, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Known names within Levenshtein distance `max(2, floor(name.length / 4))` of `name`,
 * closest first, ties broken by name, capped at {@link MAX_SIMILAR_FEATURES}.
 *
 * Comparison is case-sensitive and every name is returned exactly as given: these are
 * directory names the caller will echo back to the user, not normalised keys.
 */
export function similarFeatureNames(name: string, known: readonly string[]): string[] {
  const bound = distanceBound(name);
  return known
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter((scored) => scored.distance <= bound)
    .sort((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0))
    .slice(0, MAX_SIMILAR_FEATURES)
    .map((scored) => scored.candidate);
}
