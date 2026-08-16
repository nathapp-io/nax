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

/**
 * Replaces characters outside validateStoryId's alphabet with `-`, then
 * collapses any `..` run left in the result — validateStoryId rejects path
 * traversal sequences even though `.` alone is in its allowed alphabet.
 */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.\./g, "-");
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

  // Hash the raw, unsanitized inputs, encoded via JSON.stringify so the
  // pairing is unambiguous (a plain join could itself collide, e.g.
  // feature="a-b", profile="c" vs feature="a", profile="b-c") -- rather
  // than hashing `natural`. Distinct raw feature/profile pairs that
  // sanitize to the same characters (e.g. names differing only by a
  // trailing '!' vs '?', both replaced with '-') must still hash
  // differently, or they would collide on the same truncated ID.
  const hash = createHash("sha256")
    .update(JSON.stringify([feature, profile]))
    .digest("hex")
    .slice(0, HASH_SUFFIX_LENGTH);
  const suffix = `-${hash}`;
  const prefixBudget = MAX_WORKTREE_ID_LENGTH - suffix.length;
  return natural.slice(0, prefixBudget) + suffix;
}
