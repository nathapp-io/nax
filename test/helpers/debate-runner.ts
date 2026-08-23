/**
 * A `DebateRunner` the tests can assert against.
 *
 * `DebateRunner` is a class with eight `private readonly` fields, so the
 * `{ run }` stub the semantic-review tests need can never satisfy it
 * structurally. Every site therefore cast its stub into the dep slot —
 * 15 casts across `semantic-debate.test.ts` and `fidelity-survives-recovery.test.ts`
 * for one missing helper (#1514 §3c-ii, Decision 1).
 *
 * Same shape of fix as `makeLogger` / `makeStatusWriter`: intersect, and keep
 * the one cast here.
 */
import { mock } from "bun:test";
import type { DebateRunner } from "@/debate";
import type { DebateResult } from "@/debate/types";

export type MockDebateRunner = DebateRunner & {
  run: ReturnType<typeof mock>;
  runPlan: ReturnType<typeof mock>;
};

/**
 * A minimal passing `DebateResult`. Spread it to vary one field rather than
 * rebuilding the literal — every required field is present.
 */
export const DEFAULT_DEBATE_RESULT: DebateResult = {
  storyId: "US-001",
  stage: "review",
  outcome: "passed",
  rounds: 1,
  debaters: [],
  resolverType: "majority-fail-closed",
  proposals: [],
  totalCostUsd: 0,
};

/**
 * Both methods are bun mocks, so `toHaveBeenCalledWith` works on either.
 * Pass overrides to give a method real behaviour:
 *
 * ```ts
 * const runMock = mock(async () => DEBATE_MAJORITY_PASS_RESULT);
 * _semanticDeps.createDebateRunner = mock(() => makeDebateRunner({ run: runMock }));
 * ```
 *
 * The dep slot is `(opts: DebateRunnerOptions) => DebateRunner`; a zero-arg
 * `mock()` is assignable to it, so wrapping like the example above needs no
 * cast at the call site and keeps `createDebateRunner` itself assertable.
 */
export function makeDebateRunner(overrides: Partial<Record<keyof DebateRunner, unknown>> = {}): MockDebateRunner {
  const runner = {
    run: mock(async () => DEFAULT_DEBATE_RESULT),
    runPlan: mock(async () => DEFAULT_DEBATE_RESULT),
    ...overrides,
  };
  return runner as unknown as MockDebateRunner;
}
