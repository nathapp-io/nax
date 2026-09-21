/**
 * Worktree ID Derivation — Single SSOT
 *
 * One module owns every spelling of a worktree identity: the path under
 * `.nax-wt/<id>`, the branch name `nax/<id>`, the orphan ref
 * `refs/nax/orphan/<id>`, and the `bakeoff-<feature>-<profile>` namespace.
 * Callers must not interpolate these strings themselves — they go through
 * the producers below, and `scripts/check-worktree-id-ssot.ts` enforces
 * the rule statically.
 *
 * Story: US-001
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateStoryId } from "@/prd";

const MAX_WORKTREE_ID_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

/**
 * Branded worktree identity.
 *
 * A `WorktreeId` is a runtime `string`, but the type tag prevents accidental
 * construction: only `deriveStoryWorktreeId` and `deriveBakeoffWorktreeId`
 * produce one, so a typo at a call site (`storyWorktreePath("/repo", "US-001")`)
 * fails to type-check instead of silently building a missing worktree.
 *
 * The brand is intentionally narrow — only the producers above mint it, and
 * the brand itself carries no runtime overhead.
 */
export type WorktreeId = string & { readonly __brand: "WorktreeId" };

/**
 * Replaces characters outside validateStoryId's alphabet with `-`, then
 * collapses any `..` run left in the result — validateStoryId rejects path
 * traversal sequences even though `.` alone is in its allowed alphabet.
 */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.\./g, "-");
}

/**
 * Derives a `story-<feature>-<storyId>` worktree ID, sanitized to
 * validateStoryId's alphabet and truncated to at most 64 characters. When
 * truncation would collide two distinct overlong inputs, a stable hash of
 * the untruncated natural ID is appended as a distinguishing suffix.
 */
export function deriveStoryWorktreeId(feature: string, storyId: string): WorktreeId {
  const natural = `story-${sanitize(feature)}-${sanitize(storyId)}`;
  const id = natural.length <= MAX_WORKTREE_ID_LENGTH ? natural : collapse(natural, feature, storyId);
  validateStoryId(id);
  return id as WorktreeId;
}

/**
 * Derives a `bakeoff-<feature>-<profile>` worktree ID. Behaviour is unchanged
 * from the pre-US-001 `src/bakeoff/worktree-id.ts` implementation; only the
 * return type narrows to `WorktreeId` so the producers below carry it.
 */
export function deriveBakeoffWorktreeId(feature: string, profile: string): WorktreeId {
  const natural = `bakeoff-${sanitize(feature)}-${sanitize(profile)}`;
  const id = natural.length <= MAX_WORKTREE_ID_LENGTH ? natural : collapse(natural, feature, profile);
  validateStoryId(id);
  return id as WorktreeId;
}

/**
 * Returns the natural identity truncated to fit `MAX_WORKTREE_ID_LENGTH`,
 * with a stable hash of the raw inputs appended so two distinct overlong
 * pairs that share their natural first `MAX_WORKTREE_ID_LENGTH` characters
 * still derive distinct identities.
 *
 * Hashes the raw feature/storyId pair (JSON-encoded to disambiguate the
 * pairing) rather than `natural` — distinct raw inputs that sanitize to
 * the same characters (e.g. names differing only by a trailing '!' vs
 * '?', both replaced with '-') must still hash differently, or they
 * would collide on the same truncated ID.
 */
function collapse(natural: string, rawA: string, rawB: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([rawA, rawB]))
    .digest("hex")
    .slice(0, HASH_SUFFIX_LENGTH);
  const suffix = `-${hash}`;
  const prefixBudget = MAX_WORKTREE_ID_LENGTH - suffix.length;
  return natural.slice(0, prefixBudget) + suffix;
}

/**
 * The path of a story worktree: `<projectRoot>/.nax-wt/<worktreeId>`.
 *
 * The ONLY function in the codebase that may spell `.nax-wt` followed by
 * a worktree id. Static-check enforced.
 */
export function storyWorktreePath(projectRoot: string, worktreeId: WorktreeId): string {
  return join(projectRoot, ".nax-wt", worktreeId);
}

/**
 * The branch name of a story worktree: `nax/<worktreeId>`.
 *
 * The ONLY function in the codebase that may spell `nax/<id>` for a story.
 * Static-check enforced.
 */
export function storyBranchName(worktreeId: WorktreeId): string {
  return `nax/${worktreeId}`;
}
