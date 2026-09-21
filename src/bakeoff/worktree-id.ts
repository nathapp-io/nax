/**
 * Bake-off Worktree ID Derivation — compatibility shim.
 *
 * The sanitize / cap / hash-suffix derivation moved into the shared
 * `src/worktree/worktree-id.ts` module (US-001). This file remains as a
 * re-export so existing imports (`@/bakeoff`) keep resolving and the
 * pinned pre-US-001 string values are unchanged for the same inputs.
 *
 * Story: US-001
 */

export type { WorktreeId } from "../worktree/worktree-id";
export { deriveBakeoffWorktreeId } from "../worktree/worktree-id";
