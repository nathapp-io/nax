/**
 * Single SSOT for spelling `refs/nax/orphan/<worktreeId>`.
 *
 * The ref name is written by `pipeline-result-handler.ts` (after a
 * non-conflict merge failure) and read by `worktree/manager.ts` (during
 * `create()`). Two modules with two different `_deps` seams — if the
 * spellings drift, the record is written and never found. This helper is
 * the only place that interpolates the ref name; both modules call it.
 * The `WorktreeId` parameter is branded — every caller must reach this
 * helper through `deriveStoryWorktreeId(feature, storyId)` (US-001)
 * rather than interpolating a raw story ID. The brand prevents the
 * `refs/nax/orphan/<rawStoryId>` spelling from leaking back into the
 * system alongside the composed `refs/nax/orphan/<worktreeId>` form —
 * the two spellings cannot coexist, because the writer (US-003) and
 * reader both pass the composed identity through this same helper.
 *
 * Story: US-002
 */
import { validateStoryId } from "@/prd";
import type { WorktreeId } from "./worktree-id";

export function naxOrphanRefName(worktreeId: WorktreeId): string {
  validateStoryId(worktreeId);
  return `refs/nax/orphan/${worktreeId}`;
}
