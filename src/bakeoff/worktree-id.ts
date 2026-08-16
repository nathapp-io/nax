/**
 * Bake-off Worktree ID Derivation
 *
 * Derives a safe, `bakeoff-`-prefixed worktree/branch ID from a feature and
 * contestant profile name, guaranteed to pass `validateStoryId` and stay
 * within its 64-character cap (US-004 AC-2..AC-5).
 */

/**
 * STUB (US-004 test-writer session): real derivation (sanitize, truncate,
 * distinguishing-suffix-on-collision) is not yet implemented.
 */
export function deriveBakeoffWorktreeId(_feature: string, _profile: string): string {
  return "";
}
