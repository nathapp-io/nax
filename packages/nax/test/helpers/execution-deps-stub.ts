/**
 * _executionDeps stub helper.
 *
 * Snapshot-mutate-restore boilerplate for tests that override entries on
 * `src/pipeline/stages/execution.ts`'s module-level `_executionDeps` object.
 *
 * **Concurrency hazard (pre-existing pattern).** Bun's test runner executes
 * files in parallel; multiple test files can call this helper concurrently and
 * race on the singleton. Two concurrent calls can leave A's mutations leaking
 * into the post-B-restore state. Mitigations to consider for a follow-up:
 * wrap the snapshot/restore in a module-level mutex, or convert to
 * `mock.module()` once Bun's mock module no longer leaks. This helper is the
 * single mutator — do not introduce a fifth inline copy.
 */

import { _executionDeps } from "@/pipeline/stages/execution";

export type ExecutionDepsOverrides = Partial<typeof _executionDeps>;

/**
 * Override one or more entries on `_executionDeps` for the duration of `fn`.
 * Restores the prior values via `Object.assign` on return or throw.
 *
 * Usage:
 * ```ts
 * const restore = withExecutionDeps({
 *   getAgent: () => makeAgentAdapter({ name: "claude" }),
 *   captureGitRef: async () => "HEAD",
 * });
 * try {
 *   await executionStage.execute(ctx);
 * } finally {
 *   restore();
 * }
 * ```
 *
 * @param overrides Partial map of `_executionDeps` keys to override.
 * @returns A restore function that undoes the overrides.
 */
export function withExecutionDeps(overrides: ExecutionDepsOverrides): () => void {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = (_executionDeps as Record<string, unknown>)[key];
    (_executionDeps as Record<string, unknown>)[key] = (overrides as Record<string, unknown>)[key];
  }
  return () => {
    for (const key of Object.keys(saved)) {
      (_executionDeps as Record<string, unknown>)[key] = saved[key];
    }
  };
}
