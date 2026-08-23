/**
 * A `FixCycleResult` for `_storyOrchestratorDeps.runFixCycle` stubs.
 *
 * Two things go wrong at these sites (#1514 §5.3):
 *
 * 1. `exitReason` is required and the stubs omit it — the field was added to
 *    `FixCycleResult` after the fixtures were written.
 * 2. The dep slot is *generic* (`<F extends Finding>(...) => Promise<FixCycleResult<F>>`),
 *    so even a complete `FixCycleResult<Finding>` is not assignable: `F` could be
 *    narrower than `Finding`. This is the shape the handoff called "`Mock<() => X>`
 *    assigned to a multi-parameter slot" — the parameters are fine here, the
 *    *type parameter* is the problem.
 *
 * Stub with a generic arrow so the slot's `F` flows through:
 *
 * ```ts
 * _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() => makeFixCycleResult<F>();
 * ```
 *
 * Same shape of fix as `makeMergeEngine` / `makeWorktreeManager`: one cast here
 * instead of one per call site.
 */
import type { Finding, Iteration } from "@/findings";
import type { FixCycleResult } from "@/findings/cycle-types";

/**
 * Defaults describe a cycle that resolved with nothing left over. Overrides are
 * typed against `FixCycleResult<Finding>` — pass concrete findings without
 * having to name `F` at the call site.
 */
export function makeFixCycleResult<F extends Finding = Finding>(
  overrides: Partial<FixCycleResult<Finding>> = {},
): FixCycleResult<F> {
  const result: FixCycleResult<Finding> = {
    iterations: [],
    finalFindings: [],
    exitReason: "resolved",
    costUsd: 0,
    ...overrides,
  };
  // The single type-lie: `F` is chosen by the caller of the dep slot, and no
  // runtime value can prove a `Finding` is an `F`. Kept here, once.
  return result as unknown as FixCycleResult<F>; // test-ratchet-allow: as-unknown-as
}

/**
 * One `Iteration` for a `FixCycleResult`.
 *
 * The literal these replace had `findingsBefore: 1` and `startedAt: 0` — both
 * wrong (`F[]` and an ISO string), and both invisible because the enclosing
 * result was already failing to typecheck as a whole. Defaults describe a
 * single resolved iteration that changed nothing.
 */
export function makeIteration<F extends Finding = Finding>(overrides: Partial<Iteration<F>> = {}): Iteration<F> {
  // No cast needed here, unlike makeFixCycleResult: every default is an empty
  // array, and `never[]` is assignable to `F[]` whatever `F` turns out to be.
  return {
    iterationNum: 1,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [],
    outcome: "resolved",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}
