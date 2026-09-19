/**
 * US-002 — Single SSOT for spelling `refs/nax/orphan/<storyId>`.
 *
 * The ref name is written by `pipeline-result-handler.ts` (after a
 * non-conflict merge failure) and read by `worktree/manager.ts` (during
 * `create()`). Two modules with two different `_deps` seams — if the
 * spellings drift, the record is written and never found. This helper is
 * the only place that interpolates the ref name; both modules call it.
 * `validateStoryId` rejects path traversal, git-flag injection and
 * characters outside `[a-zA-Z0-9._-]`, so the resulting ref name cannot
 * be built from untrusted input.
 */
import { validateStoryId } from "@/prd";

export function naxOrphanRefName(storyId: string): string {
  validateStoryId(storyId);
  return `refs/nax/orphan/${storyId}`;
}
