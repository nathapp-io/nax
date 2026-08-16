/**
 * Bake-off Worktree ID Derivation
 *
 * Derives a safe, `bakeoff-`-prefixed worktree/branch ID from a feature and
 * contestant profile name, guaranteed to pass `validateStoryId` and stay
 * within its 64-character cap (US-004 AC-2..AC-5).
 */

import { createHash } from "node:crypto";

const MAX_WORKTREE_ID_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

/** Replaces characters outside validateStoryId's alphabet with `-`. */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Derives a `bakeoff-<feature>-<profile>` worktree ID, sanitized to
 * validateStoryId's alphabet and truncated to at most 64 characters. When
 * truncation would collide two distinct overlong inputs, a stable hash of
 * the untruncated natural ID is appended as a distinguishing suffix.
 */
export function deriveBakeoffWorktreeId(feature: string, profile: string): string {
  const natural = `bakeoff-${sanitize(feature)}-${sanitize(profile)}`;
  if (natural.length <= MAX_WORKTREE_ID_LENGTH) {
    return natural;
  }

  const hash = createHash("sha256").update(natural).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
  const suffix = `-${hash}`;
  const prefixBudget = MAX_WORKTREE_ID_LENGTH - suffix.length;
  return natural.slice(0, prefixBudget) + suffix;
}
