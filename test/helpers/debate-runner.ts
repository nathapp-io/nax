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
import { DebateRunner } from "@/debate";
import type { DebateStageConfig } from "@/debate/types";
import type { DebateResult } from "@/debate/types";
import { makeMockCallContext } from "./call-context";

/**
 * Construction-only stage config. Both public methods are replaced by mocks, so
 * nothing here is ever consulted — it exists to satisfy the real constructor.
 */
const STUB_STAGE_CONFIG: DebateStageConfig = {
  enabled: true,
  resolver: { type: "majority-fail-closed" },
  sessionMode: "one-shot",
  rounds: 1,
};

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
  return Object.assign(
    new DebateRunner({ ctx: makeMockCallContext(), stage: "review", stageConfig: STUB_STAGE_CONFIG }),
    {
      run: mock(async () => DEFAULT_DEBATE_RESULT),
      runPlan: mock(async () => DEFAULT_DEBATE_RESULT),
    },
    overrides,
  );
}
