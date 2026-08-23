/**
 * A `MergeEngine` the tests can assert against.
 *
 * `MergeEngine` is a class with a `private worktreeManager` parameter property,
 * so a bare `{ merge }` stub can never satisfy it structurally. Sites in
 * `pipeline-result-handler.test.ts` therefore cast their stubs into the dep
 * slot — 7 casts for one missing helper (#1514 §3c-ii, Decision 1).
 *
 * Same shape of fix as `makeDebateRunner` / `makeLogger` / `makeStatusWriter`:
 * intersect, and keep the one cast here.
 */
import { mock } from "bun:test";
import type { MergeEngine } from "@/worktree/merge";

export type MockMergeEngine = MergeEngine & {
  merge: ReturnType<typeof mock>;
  mergeAll: ReturnType<typeof mock>;
};

/**
 * Both methods are bun mocks, so `toHaveBeenCalledWith` works on either.
 * Pass overrides to give a method real behaviour:
 *
 * ```ts
 * const mergeMock = mock(async () => ({ success: false, failureKind: "error" }));
 * _resultHandlerDeps.mergeEngine = makeMergeEngine({ merge: mergeMock });
 * ```
 *
 * The dep slot is a `MergeEngine` instance, and `MockMergeEngine` intersects the
 * class, so the result needs no cast at the call site.
 */
export function makeMergeEngine(overrides: Partial<Record<keyof MergeEngine, unknown>> = {}): MockMergeEngine {
  const engine = {
    merge: mock(async () => ({ success: true })),
    mergeAll: mock(async () => []),
    ...overrides,
  };
  return engine as unknown as MockMergeEngine;
}
