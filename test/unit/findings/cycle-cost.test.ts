/**
 * #1932 — the fix cycle's per-dispatch cost attribution.
 *
 * Split out of cycle.test.ts, which is at its size baseline.
 *
 * These tests pin one link of the chain #1932 now depends on: the cycle stamps
 * a callId and reads the ledger back by it. The other two links are pinned
 * elsewhere, and all three must hold or fix-cycle cost silently returns to $0:
 *
 * - cycle -> runPhase -> callOp (callId survives, scopeId does not):
 *   test/unit/execution/story-orchestrator/run-phase-callid-passthrough.test.ts
 * - callOp -> cost row (a caller-supplied callId is never re-minted):
 *   test/unit/operations/call-correlation.test.ts
 */
import { describe, expect, test } from "bun:test";
import { assertDefined, makeLogger } from "@test/helpers";
import { runFixCycle } from "@/findings";
import { ledgerSpendFor } from "@/findings/cycle-cost";
import { createNoOpCostAggregator } from "@/runtime";
import { lintA, makeCallOpMock, makeCtx, makeCycle, makeStrategy } from "./_cycle-fixtures";

describe("runFixCycle — dispatch cost is read from the cost ledger (#1932)", () => {
  /**
   * Record a cost row the way the real cost subscriber does: keyed on the
   * callId `runFixCycle` stamped onto the dispatch context. Returns the ctx so
   * a test can read the same aggregator back.
   */
  function makeLedgerCallOpMock(costPerCall: number) {
    const seenCallIds: (string | undefined)[] = [];
    const callOp = makeCallOpMock(({ ctx }) => {
      seenCallIds.push(ctx.callId);
      ctx.runtime.costAggregator.record({
        ts: Date.now(),
        runId: "run-1",
        agentName: "claude",
        model: "test-model",
        storyId: ctx.storyId,
        callId: ctx.callId,
        estimatedCostUsd: costPerCall,
        exactCostUsd: costPerCall,
        costUsd: costPerCall,
        confidence: "estimated",
        durationMs: 1,
      });
      return null;
    });
    return { callOp, seenCallIds };
  }

  /**
   * Record an ERROR row the way the cost middleware does when a dispatch
   * throws: same callId, but summed into `totalErrorCostUsd` rather than
   * `totalCostUsd` (`accumulateError`).
   */
  function makeErrorRowCallOpMock(errorCostPerCall: number) {
    return makeCallOpMock(({ ctx }) => {
      ctx.runtime.costAggregator.recordError({
        kind: "error",
        ts: Date.now(),
        runId: "run-1",
        agentName: "claude",
        storyId: ctx.storyId,
        callId: ctx.callId,
        errorCode: "timeout",
        costUsd: errorCostPerCall,
        durationMs: 1,
      });
      return null;
    });
  }

  test("a strategy with no extractApplied still reports its real spend", async () => {
    // The whole defect: every extractApplied implementation in the repo omits
    // costUsd, so the cycle summed zeroes over genuinely expensive dispatches.
    const s = makeStrategy({ name: "implementer", maxAttempts: 1 });
    expect(s.extractApplied).toBeUndefined();
    const { callOp } = makeLedgerCallOpMock(0.75);

    const r = await runFixCycle(
      makeCycle([lintA], [s], async () => [lintA]),
      makeCtx(),
      "test-cycle",
      { callOp },
    );

    expect(r.costUsd).toBeCloseTo(0.75, 5);
  });

  test("each dispatch is stamped with its own callId, so co-run strategies do not conflate", async () => {
    const a = makeStrategy({ name: "fix-a", maxAttempts: 1, coRun: "co-run-sequential" });
    const b = makeStrategy({ name: "fix-b", maxAttempts: 1, coRun: "co-run-sequential" });
    const { callOp, seenCallIds } = makeLedgerCallOpMock(0.5);

    const r = await runFixCycle(
      makeCycle([lintA], [a, b], async () => [lintA]),
      makeCtx(),
      "test-cycle",
      { callOp },
    );

    expect(seenCallIds).toHaveLength(2);
    expect(seenCallIds[0]).toBeString();
    expect(seenCallIds[0]).not.toBe(seenCallIds[1]);
    expect(r.costUsd).toBeCloseTo(1, 5);
  });

  test("the per-fix cost lands on FixApplied, so the iteration log records it", async () => {
    const s = makeStrategy({ name: "implementer", maxAttempts: 1 });
    const { callOp } = makeLedgerCallOpMock(0.3);
    const cycle = makeCycle([lintA], [s], async () => [lintA]);

    await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp });

    const iteration = cycle.iterations[0];
    assertDefined(iteration, "iteration");
    expect(iteration.fixesApplied[0]?.costUsd).toBeCloseTo(0.3, 5);
    expect(iteration.costUsd).toBeCloseTo(0.3, 5);
  });

  test("an explicit extractApplied costUsd still wins over the ledger", async () => {
    // The declared API stays honoured: a strategy that knows its own cost is
    // not overwritten by the ledger reading.
    const s = makeStrategy({
      name: "implementer",
      maxAttempts: 1,
      extractApplied: () => ({ summary: "", costUsd: 2 }),
    });
    const { callOp } = makeLedgerCallOpMock(0.75);

    const r = await runFixCycle(
      makeCycle([lintA], [s], async () => [lintA]),
      makeCtx(),
      "test-cycle",
      { callOp },
    );

    expect(r.costUsd).toBeCloseTo(2, 5);
  });

  test("a dispatch with NO ledger rows reports zero, not undefined-by-omission", async () => {
    // The deterministic-op shape: `callOp` returns before any cost tracking, so
    // nothing is ever recorded under this callId and `ledgerSpendFor`'s `?? 0`
    // fallback is the branch that runs. Recording a zero-cost row instead would
    // leave that fallback untested.
    const s = makeStrategy({ name: "mechanical-lintfix", maxAttempts: 1 });
    const callOp = makeCallOpMock(() => null);
    const cycle = makeCycle([lintA], [s], async () => [lintA]);

    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp });

    expect(r.costUsd).toBe(0);
    expect(cycle.iterations[0]?.fixesApplied[0]?.costUsd).toBe(0);
  });

  test("cost accumulates across iterations, not just within one", async () => {
    const s = makeStrategy({ name: "implementer", maxAttempts: 2 });
    const { callOp, seenCallIds } = makeLedgerCallOpMock(0.4);

    const r = await runFixCycle(
      makeCycle([lintA], [s], async () => [lintA]),
      makeCtx(),
      "test-cycle",
      { callOp },
    );

    // Two iterations, each its own dispatch and its own ledger key.
    expect(seenCallIds).toHaveLength(2);
    expect(new Set(seenCallIds).size).toBe(2);
    expect(r.costUsd).toBeCloseTo(0.8, 5);
  });

  test("failed-dispatch spend is recorded beside costUsd, never folded into it (#1948)", async () => {
    // #1932 left this spend invisible; #1948 Part A surfaces it as its own
    // field. `costUsd` keeps its exact meaning — mirroring `runPhase`'s
    // `phaseCosts` — so no existing total is re-based. See cycle-cost.ts.
    const s = makeStrategy({ name: "implementer", maxAttempts: 1 });
    const callOp = makeErrorRowCallOpMock(5);
    const cycle = makeCycle([lintA], [s], async () => [lintA]);

    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp });

    expect(r.costUsd).toBe(0);
    expect(cycle.iterations[0]?.fixesApplied[0]?.errorCostUsd).toBeCloseTo(5, 5);
  });

  test("an explicit extractApplied costUsd does not suppress the ledger's errorCostUsd", async () => {
    // The override is scoped to the half a strategy can actually know. It knows
    // what its successful call billed; it cannot know what the attempts that
    // threw beforehand burned, so that half still comes from the ledger.
    const s = makeStrategy({
      name: "implementer",
      maxAttempts: 1,
      extractApplied: () => ({ summary: "", costUsd: 2 }),
    });
    const callOp = makeErrorRowCallOpMock(1.75);
    const cycle = makeCycle([lintA], [s], async () => [lintA]);

    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp });

    expect(r.costUsd).toBeCloseTo(2, 5);
    expect(cycle.iterations[0]?.fixesApplied[0]?.errorCostUsd).toBeCloseTo(1.75, 5);
  });

  test("the iteration record and its log sum failed-dispatch spend across the group", async () => {
    const a = makeStrategy({ name: "fix-a", maxAttempts: 1, coRun: "co-run-sequential" });
    const b = makeStrategy({ name: "fix-b", maxAttempts: 1, coRun: "co-run-sequential" });
    const callOp = makeErrorRowCallOpMock(1.5);
    const cycle = makeCycle([lintA], [a, b], async () => [lintA]);
    const logger = makeLogger();

    await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp, logger });

    expect(cycle.iterations[0]?.errorCostUsd).toBeCloseTo(3, 5);
    const completed = logger.calls.find((c) => c.message === "iteration completed");
    expect(completed?.data?.errorCostUsd).toBeCloseTo(3, 5);
  });

  test("an iteration with no failed spend omits errorCostUsd rather than carrying a zero", async () => {
    // Mirrors how `costUsd` is omitted at zero, so the record stays free of
    // fields that only ever mean "nothing went wrong".
    const s = makeStrategy({ name: "implementer", maxAttempts: 1 });
    const { callOp } = makeLedgerCallOpMock(0.3);
    const cycle = makeCycle([lintA], [s], async () => [lintA]);
    const logger = makeLogger();

    await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp, logger });

    expect(cycle.iterations[0]).not.toHaveProperty("errorCostUsd");
    const completed = logger.calls.find((c) => c.message === "iteration completed");
    expect(completed?.data).not.toHaveProperty("errorCostUsd");
  });

  test("a dispatch that throws has its spend logged before the throw propagates (#1948)", async () => {
    // The throw escapes `runFixCycle`, so no iteration is ever recorded and
    // there is no `FixApplied` left to carry the number. The log line is the
    // only channel remaining — and it is the one the curator collects from, so
    // the spend stays attributable instead of vanishing entirely.
    const s = makeStrategy({ name: "implementer", maxAttempts: 1 });
    const callOp = makeCallOpMock(({ ctx }) => {
      ctx.runtime.costAggregator.recordError({
        kind: "error",
        ts: Date.now(),
        runId: "run-1",
        agentName: "claude",
        storyId: ctx.storyId,
        callId: ctx.callId,
        errorCode: "timeout",
        costUsd: 4,
        durationMs: 1,
      });
      throw new Error("dispatch exploded");
    });
    const cycle = makeCycle([lintA], [s], async () => [lintA]);
    const logger = makeLogger();

    await expect(runFixCycle(cycle, makeCtx(), "test-cycle", { callOp, logger })).rejects.toThrow("dispatch exploded");

    expect(cycle.iterations).toHaveLength(0);
    const thrown = logger.calls.find((c) => c.message === "dispatch threw — spend recorded here, not on an iteration");
    expect(thrown?.level).toBe("warn");
    expect(thrown?.data?.errorCostUsd).toBeCloseTo(4, 5);
    expect(thrown?.data?.strategyName).toBe("implementer");
  });
});

// ─── ledgerSpendFor — direct unit coverage of the read itself ────────────────

describe("ledgerSpendFor", () => {
  /**
   * A ctx whose aggregator behaves as `byCall` is told to. Built from the
   * real no-op aggregator so the shape cannot drift from `ICostAggregator`.
   */
  function ctxWithByCall(byCall: () => Record<string, { totalCostUsd: number; totalErrorCostUsd: number }>) {
    const base = makeCtx();
    const aggregator = { ...createNoOpCostAggregator(), byCall };
    return { ...base, runtime: { ...base.runtime, costAggregator: aggregator } } as typeof base;
  }

  test("returns the successful and the failed spend for the call, kept apart", () => {
    const ctx = ctxWithByCall(() => ({ "call-1": { totalCostUsd: 1.25, totalErrorCostUsd: 0.5 } }));

    expect(ledgerSpendFor(ctx, "call-1")).toEqual({ costUsd: 1.25, errorCostUsd: 0.5 });
  });

  test("returns zeros when the ledger holds no row for the call", () => {
    const ctx = ctxWithByCall(() => ({ "some-other-call": { totalCostUsd: 9, totalErrorCostUsd: 9 } }));

    expect(ledgerSpendFor(ctx, "call-1")).toEqual({ costUsd: 0, errorCostUsd: 0 });
  });

  test("returns zeros instead of throwing when the ledger read fails", () => {
    // Telemetry must never fail a fix cycle. Exercises the catch branch — the
    // one place a genuine wiring failure now lands, and logs rather than
    // vanishing silently.
    const ctx = ctxWithByCall(() => {
      throw new Error("aggregator exploded");
    });

    expect(() => ledgerSpendFor(ctx, "call-1")).not.toThrow();
    expect(ledgerSpendFor(ctx, "call-1")).toEqual({ costUsd: 0, errorCostUsd: 0 });
  });
});
