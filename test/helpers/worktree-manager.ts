/**
 * A `WorktreeManager` the tests can assert against.
 *
 * `WorktreeManager` is a class, so a bare `{ create, remove }` stub can never
 * satisfy it structurally. Sites in `parallel-batch.test.ts` therefore cast
 * their stubs into the dep slot — 16 casts for one missing helper (#1514 §5.3),
 * two of which had already been downgraded to a ratcheted double cast.
 *
 * Same shape of fix as `makeMergeEngine` / `makeDebateRunner`: intersect, and
 * keep the one cast here.
 */
import { mock } from "bun:test";
import type { WorktreeManager } from "@/worktree";

export type MockWorktreeManager = WorktreeManager & {
  create: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  list: ReturnType<typeof mock>;
  ensureGitExcludes: ReturnType<typeof mock>;
};

/**
 * Every method is a bun mock, so `toHaveBeenCalledWith` works on any of them.
 * Pass overrides to give a method real behaviour:
 *
 * ```ts
 * _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
 * ```
 *
 * The dep slot is `() => Promise<WorktreeManager>`, and `MockWorktreeManager`
 * intersects the class, so the result needs no cast at the call site.
 */
export function makeWorktreeManager(
  overrides: Partial<Record<keyof WorktreeManager, unknown>> = {},
): MockWorktreeManager {
  const manager = {
    create: mock(async () => {}),
    remove: mock(async () => {}),
    list: mock(async () => []),
    ensureGitExcludes: mock(async () => {}),
    ...overrides,
  };
  // The single type-lie, mirroring makeMergeEngine: a class cannot be satisfied
  // structurally, so the cast lives here once instead of at all 16 call sites.
  return manager as unknown as MockWorktreeManager; // test-ratchet-allow: as-unknown-as
}
