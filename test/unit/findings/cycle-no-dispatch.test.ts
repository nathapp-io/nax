/**
 * US-003 — "Skip rectification validation after zero dispatch" (fix cycle).
 *
 * US-001 makes `callOp` raise `CALL_OP_NO_DISPATCH` when no hop of an operation
 * ever returned a turn. `dispatchStrategy` records the attempt's spend and then
 * rethrows that error unchanged, so `runFixCycle` is the layer that must decide
 * what a zero-dispatch iteration means: nothing ran, so there is nothing for
 * `validate` to judge, and the cycle must say so with its own terminal reason
 * instead of reporting a completed iteration and re-validating an untouched tree.
 *
 * AC1 — a zero-dispatch dispatch is not validated for that iteration.
 * AC2 — the cycle returns a distinct terminal reason naming the zero-dispatch
 *       condition, different from "agent-gave-up" and "validate-short-circuit".
 * AC5 — that exit records the failed dispatch's spend (and the cycle's
 *       accumulated spend) on the returned result.
 * AC4 — a completed dispatch that applies no edits and signals no UNRESOLVED
 *       still runs validate (the existing no-edit path is unchanged), while a
 *       completed UNRESOLVED dispatch keeps taking "agent-gave-up".
 *
 * The rectification-phase counterpart of these tests — the same condition driven
 * through `runRectification` and the no-progress budget — lives in
 * test/unit/execution/story-orchestrator-rectification-no-dispatch.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { assertDefined, assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";
import type { Finding, FixCycle, FixCycleExitReason, FixCycleResult } from "@/findings";
import { runFixCycle } from "@/findings";
import { lintA, makeCallOpMock, makeCtx, makeCycle, makeStrategy } from "./_cycle-fixtures";

/**
 * The distinct terminal reason US-003 adds. Named here as the test's contract:
 * the exit must name the zero-dispatch condition and must not be one of the
 * existing skip-validate reasons.
 */
const NO_DISPATCH_EXIT_REASON: FixCycleExitReason = "no-dispatch";

/** The error `callOp` raises for an operation whose hops never reached a model (US-001). */
function zeroDispatchError(opName = "noop-op"): NaxError {
  return new NaxError(`callOp[${opName}]: no dispatch completed`, "CALL_OP_NO_DISPATCH", {
    stage: "run",
    storyId: "story-1",
    agentName: "claude",
  });
}

/**
 * Runs the cycle, capturing rather than letting escape any error it throws.
 * The assertions then read as `expect(thrown).toBeUndefined()` — a zero-dispatch
 * is a cycle outcome, so a rejection here is the defect being pinned, and it
 * must surface as a failed assertion rather than as an aborted test.
 */
async function runCycleCapturing(
  cycle: FixCycle<Finding>,
  callOp: ReturnType<typeof makeCallOpMock>,
): Promise<{ result?: FixCycleResult<Finding>; thrown?: unknown }> {
  try {
    return { result: await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp }) };
  } catch (thrown) {
    return { thrown };
  }
}

/** Accumulates the validate call options, so a test can assert validate never ran. */
function recordValidateCalls(): {
  calls: Array<{ mode: "full" | "lite"; strategiesRun?: readonly string[] }>;
  validate: FixCycle<Finding>["validate"];
} {
  const calls: Array<{ mode: "full" | "lite"; strategiesRun?: readonly string[] }> = [];
  return {
    calls,
    validate: async (_ctx, opts) => {
      calls.push(opts);
      return [lintA];
    },
  };
}

describe("runFixCycle — zero dispatch skips validation (US-003 AC1/AC2)", () => {
  test("AC1: a CALL_OP_NO_DISPATCH dispatch is not validated and the cycle returns instead of revalidating", async () => {
    const recorder = recordValidateCalls();
    const strategy = makeStrategy({ name: "implementer", maxAttempts: 3 });
    const cycle = makeCycle([lintA], [strategy], recorder.validate);
    const callOp = makeCallOpMock(() => {
      throw zeroDispatchError();
    });

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    // The dispatch error is consumed by the cycle, not propagated to the caller.
    expect(thrown).toBeUndefined();
    // ...and the iteration did dispatch — this is not "validate skipped because nothing ran".
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(recorder.calls).toHaveLength(0);
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe(NO_DISPATCH_EXIT_REASON);
  });

  test("AC2: the exit reason names the zero-dispatch condition and differs from agent-gave-up / validate-short-circuit", async () => {
    const strategy = makeStrategy({ name: "implementer" });
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    const callOp = makeCallOpMock(() => {
      throw zeroDispatchError();
    });

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    expect(thrown).toBeUndefined();
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe(NO_DISPATCH_EXIT_REASON);
    expect(result.exitReason).not.toBe("agent-gave-up");
    expect(result.exitReason).not.toBe("validate-short-circuit");
    // Nothing was resolved: the findings the cycle could not dispatch against survive the exit.
    expect(result.finalFindings).toEqual([lintA]);
  });

  test("AC1 boundary: a zero dispatch on the strategy's final allowed attempt still skips validate", async () => {
    const recorder = recordValidateCalls();
    // maxAttempts 1 puts this iteration on the terminal-exhausted branch — the
    // one other place validate can run (in "lite" mode). A zero dispatch means
    // nothing was edited, so even that revalidation must not run.
    const strategy = makeStrategy({ name: "implementer", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], recorder.validate);
    const callOp = makeCallOpMock(() => {
      throw zeroDispatchError();
    });

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    expect(thrown).toBeUndefined();
    expect(recorder.calls).toHaveLength(0);
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe(NO_DISPATCH_EXIT_REASON);
  });

  test("AC1 boundary: a dispatch error that is NOT CALL_OP_NO_DISPATCH still propagates unchanged", async () => {
    const recorder = recordValidateCalls();
    const strategy = makeStrategy({ name: "implementer" });
    const cycle = makeCycle([lintA], [strategy], recorder.validate);
    const callOp = makeCallOpMock(() => {
      throw new NaxError("adapter exploded", "ADAPTER_FAILURE", { stage: "run", storyId: "story-1" });
    });

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    // Only the zero-dispatch code is converted; every other failure keeps its
    // existing behaviour (escape the cycle, crash the pass loudly).
    assertNaxError(thrown, "cycle rejection");
    expect(thrown.code).toBe("ADAPTER_FAILURE");
    expect(result).toBeUndefined();
  });
});

describe("runFixCycle — zero dispatch retains the failed dispatch's spend (US-003 AC5)", () => {
  test("AC5: the zero-dispatch exit reports the failed dispatch's spend", async () => {
    const strategy = makeStrategy({ name: "implementer" });
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    const callOp = makeCallOpMock(({ ctx }) => {
      // The cost middleware records the attempt's spend against the dispatch's
      // callId; the cycle reads it back from that ledger row (#1932).
      ctx.runtime.costAggregator.recordError({
        kind: "error",
        ts: Date.now(),
        runId: "run-1",
        agentName: "claude",
        storyId: ctx.storyId,
        callId: ctx.callId,
        errorCode: "rate-limit",
        costUsd: 0.9,
        durationMs: 1,
      });
      throw zeroDispatchError();
    });

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    expect(thrown).toBeUndefined();
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe(NO_DISPATCH_EXIT_REASON);
    expect(result.costUsd).toBeCloseTo(0.9, 5);
  });

  test("AC5 boundary: earlier iterations' spend is retained alongside the failed dispatch's", async () => {
    let dispatch = 0;
    const callOp = makeCallOpMock(({ ctx }) => {
      dispatch += 1;
      if (dispatch === 1) {
        ctx.runtime.costAggregator.record({
          ts: Date.now(),
          runId: "run-1",
          agentName: "claude",
          model: "test-model",
          storyId: ctx.storyId,
          callId: ctx.callId,
          estimatedCostUsd: 0.25,
          exactCostUsd: 0.25,
          costUsd: 0.25,
          confidence: "estimated",
          durationMs: 1,
        });
        return { applied: false };
      }
      ctx.runtime.costAggregator.recordError({
        kind: "error",
        ts: Date.now(),
        runId: "run-1",
        agentName: "claude",
        storyId: ctx.storyId,
        callId: ctx.callId,
        errorCode: "rate-limit",
        costUsd: 0.5,
        durationMs: 1,
      });
      throw zeroDispatchError();
    });
    const recorder = recordValidateCalls();
    const strategy = makeStrategy({ name: "implementer", maxAttempts: 5 });
    const cycle = makeCycle([lintA], [strategy], recorder.validate);

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    expect(thrown).toBeUndefined();
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe(NO_DISPATCH_EXIT_REASON);
    // Iteration 1's completed dispatch (0.25) plus iteration 2's failed one (0.5).
    expect(result.costUsd).toBeCloseTo(0.75, 5);
    // validate ran for the completed iteration only — the zero-dispatch iteration skipped it.
    expect(recorder.calls).toHaveLength(1);
  });
});

describe("runFixCycle — the completed no-edit path is unchanged (US-003 AC4)", () => {
  test("AC4: a completed dispatch that applies no edits and signals no UNRESOLVED still runs validate", async () => {
    const recorder = recordValidateCalls();
    const strategy = makeStrategy({ name: "implementer" });
    const cycle = makeCycle([lintA], [strategy], async (_ctx, opts) => {
      recorder.calls.push(opts);
      // The completed no-edit dispatch resolved nothing, and the (empty)
      // revalidation confirms it: the cycle exits cleanly through validate.
      return [];
    });
    // Completes normally (empty output, no edits) — the opposite of zero-dispatch.
    const callOp = makeCallOpMock({ applied: false, filesChanged: [] });

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    expect(thrown).toBeUndefined();
    expect(recorder.calls).toHaveLength(1);
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe("resolved");
  });

  test("AC4 boundary: a completed dispatch that signals UNRESOLVED keeps the agent-gave-up exit", async () => {
    const recorder = recordValidateCalls();
    const strategy = makeStrategy({
      name: "implementer",
      extractApplied: () => ({ summary: "", unresolved: "conflicting requirements" }),
    });
    const cycle = makeCycle([lintA], [strategy], recorder.validate);
    const callOp = makeCallOpMock({});

    const { result, thrown } = await runCycleCapturing(cycle, callOp);

    expect(thrown).toBeUndefined();
    assertDefined(result, "cycle result");
    expect(result.exitReason).toBe("agent-gave-up");
    expect(result.unresolvedDetail).toBe("conflicting requirements");
    // The existing give-up exit already skips validation; US-003 does not change it.
    expect(recorder.calls).toHaveLength(0);
  });
});
