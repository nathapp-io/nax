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
import { assertDefined } from "@test/helpers";
import { runFixCycle } from "@/findings";
import { ledgerCostFor } from "@/findings/cycle-cost";
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
    // nothing is ever recorded under this callId and `ledgerCostFor`'s `?? 0`
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

  test("failed-dispatch spend is deliberately excluded, mirroring runPhase's phaseCosts", async () => {
    // Pins the decision so it reads as a choice, not an accident: an error row
    // for this dispatch's callId lands in `totalErrorCostUsd`, which this
    // number does not sum. See cycle-cost.ts for why.
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
        costUsd: 5,
        durationMs: 1,
      });
      return null;
    });

    const r = await runFixCycle(
      makeCycle([lintA], [s], async () => [lintA]),
      makeCtx(),
      "test-cycle",
      { callOp },
    );

    expect(r.costUsd).toBe(0);
  });

  test("known gap: a dispatch that throws loses its spend — the ledger read is never reached", async () => {
    // Pinned as known behaviour rather than left to be rediscovered as a fresh
    // #1932. The throw propagates out of runFixCycle before `ledgerCostFor`
    // runs, so whatever that dispatch burned is not attributed here.
    const s = makeStrategy({ name: "implementer", maxAttempts: 1 });
    const callOp = makeCallOpMock(() => {
      throw new Error("dispatch exploded");
    });
    const cycle = makeCycle([lintA], [s], async () => [lintA]);

    await expect(runFixCycle(cycle, makeCtx(), "test-cycle", { callOp })).rejects.toThrow("dispatch exploded");
    expect(cycle.iterations).toHaveLength(0);
  });
});

// ─── ledgerCostFor — direct unit coverage of the read itself ─────────────────

describe("ledgerCostFor", () => {
  /**
   * A ctx whose aggregator behaves as `byCall` is told to. Built from the
   * real no-op aggregator so the shape cannot drift from `ICostAggregator`.
   */
  function ctxWithByCall(byCall: () => Record<string, { totalCostUsd: number }>) {
    const base = makeCtx();
    const aggregator = { ...createNoOpCostAggregator(), byCall };
    return { ...base, runtime: { ...base.runtime, costAggregator: aggregator } } as typeof base;
  }

  test("returns the recorded spend for the call", () => {
    const ctx = ctxWithByCall(() => ({ "call-1": { totalCostUsd: 1.25 } }));

    expect(ledgerCostFor(ctx, "call-1")).toBeCloseTo(1.25, 5);
  });

  test("returns 0 when the ledger holds no row for the call", () => {
    const ctx = ctxWithByCall(() => ({ "some-other-call": { totalCostUsd: 9 } }));

    expect(ledgerCostFor(ctx, "call-1")).toBe(0);
  });

  test("returns 0 instead of throwing when the ledger read fails", () => {
    // Telemetry must never fail a fix cycle. Exercises the catch branch — the
    // one place a genuine wiring failure now lands, and logs rather than
    // vanishing silently.
    const ctx = ctxWithByCall(() => {
      throw new Error("aggregator exploded");
    });

    expect(() => ledgerCostFor(ctx, "call-1")).not.toThrow();
    expect(ledgerCostFor(ctx, "call-1")).toBe(0);
  });
});
