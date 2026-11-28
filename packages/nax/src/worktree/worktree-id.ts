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
 * Derives a `story-<feature>-<storyId>-<hash8>` worktree ID. The hash is of
 * the raw (feature, storyId) tuple, taken before lossy sanitization or
 * truncation, so distinct tuples never share an ID even when they sanitize
 * to the same characters or concatenate to the same string. Bounded to 64
 * characters and accepted by validateStoryId.
 */
export function deriveStoryWorktreeId(feature: string, storyId: string): WorktreeId {
  return tupleId("story", feature, storyId);
}

/**
 * Derives a `bakeoff-<feature>-<profile>-<hash8>` worktree ID; same tuple
 * disambiguation as `deriveStoryWorktreeId`, in the `bakeoff-` namespace.
 */
export function deriveBakeoffWorktreeId(feature: string, profile: string): WorktreeId {
  return tupleId("bakeoff", feature, profile);
}

function tupleId(namespace: string, rawA: string, rawB: string): WorktreeId {
  const hash = createHash("sha256")
    .update(JSON.stringify([namespace, rawA, rawB]))
    .digest("hex")
    .slice(0, HASH_SUFFIX_LENGTH);
  const suffix = `-${hash}`;
  const natural = `${namespace}-${sanitize(rawA)}-${sanitize(rawB)}`;
  const id = natural.slice(0, MAX_WORKTREE_ID_LENGTH - suffix.length) + suffix;
  validateStoryId(id);
  return id as WorktreeId;
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
