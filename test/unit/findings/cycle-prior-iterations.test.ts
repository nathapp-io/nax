/**
 * US-002 — Make fix-cycle budgets consume carried history.
 *
 * Verifies that `runFixCycle` reads cap counters, the terminal-exhaustion check,
 * and `bailWhen` predicates over the concatenation of `priorIterations` and the
 * in-cycle `iterations`, without changing the result contract (`FixCycleResult.
 * iterations` still reports only this cycle; `Iteration.iterationNum` stays
 * 1-indexed within the cycle). Also covers the optional backing map for
 * `createDeclineLedger`.
 *
 * Each AC is given at least one success-path and one boundary / failure-path
 * test. ACs 1, 2, 3, 4, 5, 7, 8 are exercised through `runFixCycle` (the public
 * behaviour surface); ACs 6, 9, 10, 11 are exercised both through the cycle and
 * directly against `createDeclineLedger` so a regression in either layer
 * surfaces.
 */

import { describe, expect, mock, test } from "bun:test";
import { createDeclineLedger, runFixCycle } from "@/findings";
import type { Finding, FixStrategy, Iteration } from "@/findings";
import type { CallOpFn } from "@/findings/cycle";
import { makeLogger } from "@test/helpers";
import { lintA, lintB, makeCallOpMock, makeCtx, makeCycle, makeStrategy, typecheckC } from "./_cycle-fixtures";

/**
 * Build an Iteration<Finding> whose findingsBefore and findingsAfter are
 * identical to `findings` (no progress). Each iteration records one fix by the
 * supplied strategy.
 */
function stalledPriorIteration(findings: Finding[], strategyName: string, iterationNum: number): Iteration<Finding> {
  return {
    iterationNum,
    findingsBefore: findings,
    fixesApplied: [{ strategyName, op: "noop-op", targetFiles: [], summary: "" }],
    findingsAfter: findings,
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

/**
 * Build a prior iteration where one fix was applied by `strategyName` against
 * `findings`. Defaults to "no progress" (findingsAfter === findingsBefore) so
 * ACs 1-3 can stack three identical dispatches without inflating
 * `outcome === 'unchanged'` semantics; tests that need a different outcome
 * override `outcome` and `findingsAfter` after the fact.
 */
function priorFixIteration(
  findings: Finding[],
  strategyName: string,
  iterationNum: number,
  overrides: Partial<Iteration<Finding>> = {},
): Iteration<Finding> {
  return {
    iterationNum,
    findingsBefore: findings,
    fixesApplied: [{ strategyName, op: "noop-op", targetFiles: [], summary: "" }],
    findingsAfter: findings,
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

// ─── AC1: three prior dispatches of a strategy capped at 3 ──────────────────

describe("US-002 AC1 — priorIterations saturate the per-strategy cap", () => {
  test("returns max-attempts-per-strategy with exhaustedStrategy S and dispatches no fix", async () => {
    // Three prior iterations each record one fix by 'lint-fix' (cap=3). The
    // concatenation already meets the cap before the cycle body runs, so the
    // cycle must exit before calling fixOp at all.
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "lint-fix", 1),
      priorFixIteration([lintA], "lint-fix", 2),
      priorFixIteration([lintA], "lint-fix", 3),
    ];
    const cycle = makeCycle([lintA], [strategy], async () => []);
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.exhaustedStrategy).toBe("lint-fix");
    expect(callOpMock).not.toHaveBeenCalled();
    expect(result.iterations).toHaveLength(0);
  });

  test("boundary: two prior dispatches (cap=3) do NOT exhaust the cap — one live dispatch happens", async () => {
    // Boundary for AC1: cap=3 minus two prior = 1 remaining attempt, so the
    // cycle must dispatch exactly once before the next cap check.
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "lint-fix", 1),
      priorFixIteration([lintA], "lint-fix", 2),
    ];
    // Validate resolves after the first live dispatch so the cycle exits 'resolved'
    // — the assertion under test is that exactly one fix dispatch occurred.
    let validateCallCount = 0;
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      return [];
    });
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(validateCallCount).toBe(1);
    expect(result.exitReason).toBe("resolved");
  });
});

// ─── AC2: two prior dispatches + one live dispatch before the next cap check ─

describe("US-002 AC2 — two prior dispatches consume two of three cap slots", () => {
  test("dispatches S exactly once before its next cap check (cap=3, two priors)", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "lint-fix", 1),
      priorFixIteration([lintA], "lint-fix", 2),
    ];
    // The first live validate returns the same finding (no progress) so the
    // cycle loops again; the third attempt then exhausts the cap. We expect
    // exactly one live dispatch before that next cap check fires.
    let validateCallCount = 0;
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      return [lintA];
    });
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.exhaustedStrategy).toBe("lint-fix");
  });

  test("boundary: one prior dispatch + one live dispatch = 2/3 used, second live still allowed", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const priorIterations: Iteration<Finding>[] = [priorFixIteration([lintA], "lint-fix", 1)];
    let validateCallCount = 0;
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      return [lintA]; // still no progress, keep iterating
    });
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    // 1 prior + 1 live = 2 used; cap not yet hit. After the first live dispatch,
    // the next cap check sees (1 prior + 1 live = 2) < 3, so a second live
    // dispatch is allowed. The third attempt then saturates the cap.
    expect(callOpMock).toHaveBeenCalledTimes(2);
    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(validateCallCount).toBe(2);
  });
});

// ─── AC3: priorIterations saturate the total attempt cap ─────────────────────

describe("US-002 AC3 — priorIterations saturate maxAttemptsTotal", () => {
  test("returns max-attempts-total and dispatches no fix", async () => {
    // Two strategies co-run so each prior iteration contributes two fixes,
    // exhausting maxAttemptsTotal = 4 before any live dispatch.
    const strategyA = makeStrategy({ name: "fix-a", maxAttempts: 99, coRun: "co-run-sequential" });
    const strategyB = makeStrategy({ name: "fix-b", maxAttempts: 99, coRun: "co-run-sequential" });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "fix-a", 1, {
        fixesApplied: [
          { strategyName: "fix-a", op: "noop-op", targetFiles: [], summary: "" },
          { strategyName: "fix-b", op: "noop-op", targetFiles: [], summary: "" },
        ],
      }),
      priorFixIteration([lintA], "fix-a", 2, {
        fixesApplied: [
          { strategyName: "fix-a", op: "noop-op", targetFiles: [], summary: "" },
          { strategyName: "fix-b", op: "noop-op", targetFiles: [], summary: "" },
        ],
      }),
    ];
    const cycle = makeCycle([lintA], [strategyA, strategyB], async () => [], {
      config: { maxAttemptsTotal: 4, validatorRetries: 1 },
    });
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.exitReason).toBe("max-attempts-total");
    expect(callOpMock).not.toHaveBeenCalled();
    expect(result.iterations).toHaveLength(0);
  });

  test("boundary: prior iterations one short of the cap allow one live dispatch, then total saturates", async () => {
    const strategyA = makeStrategy({ name: "fix-a", maxAttempts: 99 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "fix-a", 1, {
        fixesApplied: [{ strategyName: "fix-a", op: "noop-op", targetFiles: [], summary: "" }],
      }),
      priorFixIteration([lintA], "fix-a", 2, {
        fixesApplied: [{ strategyName: "fix-a", op: "noop-op", targetFiles: [], summary: "" }],
      }),
      priorFixIteration([lintA], "fix-a", 3, {
        fixesApplied: [{ strategyName: "fix-a", op: "noop-op", targetFiles: [], summary: "" }],
      }),
    ];
    // First live validate returns the finding (no progress) so the cycle loops
    // and the second iteration's cap check sees 3 priors + 1 live = 4 = cap.
    let validateCallCount = 0;
    const cycle = makeCycle(
      [lintA],
      [strategyA],
      async () => {
        validateCallCount++;
        return [lintA];
      },
      { config: { maxAttemptsTotal: 4, validatorRetries: 1 } },
    );
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    // 3 priors < cap of 4: one live dispatch happens, then on the next iteration
    // the total cap saturates (3 priors + 1 live = 4 >= 4).
    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(result.exitReason).toBe("max-attempts-total");
    expect(validateCallCount).toBe(1);
  });
});

// ─── AC4/AC5: bailWhen consumes carried history ──────────────────────────────

describe("US-002 AC4/AC5 — bailWhen predicates read carried history", () => {
  /**
   * Strategies whose bailWhen counts trailing non-progress iterations and bails
   * when the trailing run length meets the threshold. Mirrors the shape of
   * `withNoProgressBail` for the two-trailing-prior case the story specifies.
   */
  function bailsAfterConsecutiveNoProgress(name: string, threshold: number): FixStrategy<Finding, unknown, unknown> {
    return makeStrategy({
      name,
      maxAttempts: 99,
      bailWhen: (iters) => {
        if (iters.length < threshold) return null;
        const trailing = iters.slice(-threshold);
        const allStalled = trailing.every(
          (i) =>
            i.findingsBefore.length > 0 &&
            i.findingsBefore.every((f) => i.findingsAfter.some((g) => JSON.stringify(g) === JSON.stringify(f))),
        );
        return allStalled ? `no progress for ${threshold} consecutive iterations` : null;
      },
    });
  }

  test("AC4: two stalled prior iterations + first live iteration is stalled → bail-when", async () => {
    const strategy = bailsAfterConsecutiveNoProgress("lint-fix", 3);
    const priorIterations: Iteration<Finding>[] = [
      stalledPriorIteration([lintA], "lint-fix", 1),
      stalledPriorIteration([lintA], "lint-fix", 2),
    ];
    // First live validate returns the same finding (no progress), which the
    // cycle records as a third stalled iteration. The bailWhen must then fire.
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.exitReason).toBe("bail-when");
    expect(result.bailDetail).toBe("no progress for 3 consecutive iterations");
  });

  test("[#1530] a bail fired on carried history reports how many iterations were inherited", async () => {
    // Threshold 2 with two stalled priors: the predicate fires before this
    // cycle records a single iteration, so `bailDetail` quotes counts that
    // belong entirely to earlier cycles. The log must say so.
    const strategy = bailsAfterConsecutiveNoProgress("lint-fix", 2);
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    cycle.priorIterations = [
      stalledPriorIteration([lintA], "lint-fix", 1),
      stalledPriorIteration([lintA], "lint-fix", 2),
    ];
    const logger = makeLogger();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock(),
      logger,
    });

    expect(result.exitReason).toBe("bail-when");
    expect(result.iterations).toHaveLength(0);

    const bailLog = logger.calls.find((c) => c.message === "cycle exited — bail predicate fired");
    expect(bailLog).toBeDefined();
    expect(bailLog?.data).toMatchObject({ cycleIterations: 0, inheritedIterations: 2 });
  });

  test("[#1530] a bail with no carried history omits the inherited counter", async () => {
    const strategy = bailsAfterConsecutiveNoProgress("lint-fix", 1);
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    const logger = makeLogger();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock(),
      logger,
    });

    expect(result.exitReason).toBe("bail-when");
    const bailLog = logger.calls.find((c) => c.message === "cycle exited — bail predicate fired");
    expect(bailLog?.data).toMatchObject({ cycleIterations: 1 });
    expect(bailLog?.data).not.toHaveProperty("inheritedIterations");
  });

  test("AC5: two stalled prior iterations + first live iteration resolves → does NOT bail", async () => {
    const strategy = bailsAfterConsecutiveNoProgress("lint-fix", 3);
    const priorIterations: Iteration<Finding>[] = [
      stalledPriorIteration([lintA], "lint-fix", 1),
      stalledPriorIteration([lintA], "lint-fix", 2),
    ];
    // First live validate clears the finding → outcome=resolved → cycle exits.
    // bailWhen must NOT fire on the resolved branch.
    const cycle = makeCycle([lintA], [strategy], async () => []);
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.exitReason).toBe("resolved");
    expect(result.iterations).toHaveLength(1);
    expect(callOpMock).toHaveBeenCalledTimes(1);
  });

  test("boundary: with priorIterations omitted, bailWhen fires only on this-cycle stalled iterations", async () => {
    // Omission must not inject ghost prior history. With threshold=3 and no
    // priors, bailWhen fires only after three stalled LIVE iterations, which is
    // observable as bail-when after exactly three recorded iterations.
    const strategy = bailsAfterConsecutiveNoProgress("lint-fix", 3);
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.exitReason).toBe("bail-when");
    expect(result.bailDetail).toBe("no progress for 3 consecutive iterations");
    expect(cycle.iterations).toHaveLength(3);
    void callOpMock;
  });
});

// ─── AC6: priorIterations omitted keeps current per-strategy behaviour ────────

describe("US-002 AC6 — omission preserves current behaviour", () => {
  test("dispatches S three times before exiting when priorIterations is omitted (cap=3)", async () => {
    const dispatched: string[] = [];
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    const callOpMock = makeCallOpMock(() => {
      dispatched.push("lint-fix");
      return {};
    });

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(dispatched).toHaveLength(3);
    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.exhaustedStrategy).toBe("lint-fix");
    expect(cycle.priorIterations).toBeUndefined();
  });

  test("boundary: empty priorIterations array is treated as omission (no cap saturation)", async () => {
    // An explicit empty array must behave the same as omission — there is no
    // carried history to read, so the cap is reached only by live iterations.
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    cycle.priorIterations = [] as readonly Iteration<Finding>[];
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(callOpMock).toHaveBeenCalledTimes(3);
    expect(result.exitReason).toBe("max-attempts-per-strategy");
  });
});

// ─── AC7/AC8: result contract — this-cycle-only iterations and 1-indexed nums ─

describe("US-002 AC7/AC8 — FixCycleResult contract preserved under carried history", () => {
  test("AC7: FixCycleResult.iterations has length 1 when three priors + one live iteration occurred", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 99 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "lint-fix", 1),
      priorFixIteration([lintA], "lint-fix", 2),
      priorFixIteration([lintA], "lint-fix", 3),
    ];
    // First live validate resolves the finding so the cycle exits after exactly
    // one recorded iteration.
    const cycle = makeCycle([lintA], [strategy], async () => []);
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.iterations).toHaveLength(1);
    expect(result.exitReason).toBe("resolved");
    // Prior history must not bleed into the recorded this-cycle iterations.
    expect(result.iterations[0]?.iterationNum).toBe(1);
    expect(cycle.iterations).toHaveLength(1);
  });

  test("AC8: first live iteration's iterationNum is 1 even with three priors", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 99 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "lint-fix", 1),
      priorFixIteration([lintA], "lint-fix", 2),
      priorFixIteration([lintA], "lint-fix", 3),
    ];
    let validateCallCount = 0;
    // First validate returns a finding (so classifyOutcome='unchanged'); second
    // returns empty (resolved). The recorded live iterations must number 1, 2.
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      return validateCallCount < 2 ? [lintA] : [];
    });
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.iterations).toHaveLength(2);
    expect(result.iterations.map((i) => i.iterationNum)).toEqual([1, 2]);
    expect(result.exitReason).toBe("resolved");
  });
});

// ─── AC9/AC10/AC11: createDeclineLedger optional backing map ────────────────

describe("US-002 AC9/AC10/AC11 — createDeclineLedger optional backing map", () => {
  test("AC9: backing map with a prior decline → isRetiredFor returns true without recordDeclined in this cycle", async () => {
    const backing = new Map<string, Set<string>>();
    const priorKey = JSON.stringify([
      lintA.source,
      lintA.file ?? null,
      lintA.line ?? null,
      lintA.rule ?? null,
      lintA.message,
    ]);
    backing.set("lint-fix", new Set([priorKey]));

    const strategy = makeStrategy({ name: "lint-fix" });
    const ledger = createDeclineLedger<Finding>(backing);

    // The strategy's only claim is now retired because every finding it claims
    // (just lintA) was previously declined.
    expect(ledger.isRetiredFor(strategy, [lintA])).toBe(true);

    // The backing map must not have been mutated by isRetiredFor.
    expect(backing.get("lint-fix")?.has(priorKey)).toBe(true);
  });

  test("AC9 boundary: a strategy with no prior declines in the backing map is NOT retired", async () => {
    const backing = new Map<string, Set<string>>();
    backing.set("lint-fix", new Set<string>()); // empty set: no declines yet
    const ledger = createDeclineLedger<Finding>(backing);

    const strategy = makeStrategy({ name: "lint-fix" });
    expect(ledger.isRetiredFor(strategy, [lintA])).toBe(false);
  });

  test("AC10: recordDeclined writes the finding key under the strategy in the caller's backing map", async () => {
    const backing = new Map<string, Set<string>>();
    const ledger = createDeclineLedger<Finding>(backing);
    const strategy = makeStrategy({ name: "lint-fix" });

    ledger.recordDeclined(strategy, [lintA]);

    // The caller's map must contain findingKey(lintA) under 'lint-fix'.
    const expectedKey = JSON.stringify([
      lintA.source,
      lintA.file ?? null,
      lintA.line ?? null,
      lintA.rule ?? null,
      lintA.message,
    ]);
    const set = backing.get("lint-fix");
    expect(set).toBeInstanceOf(Set);
    expect(set?.has(expectedKey)).toBe(true);
  });

  test("AC10 boundary: multiple recordDeclined calls accumulate under the same strategy", async () => {
    const backing = new Map<string, Set<string>>();
    const ledger = createDeclineLedger<Finding>(backing);
    const strategy = makeStrategy({ name: "lint-fix" });

    ledger.recordDeclined(strategy, [lintA]);
    ledger.recordDeclined(strategy, [lintB]);

    const set = backing.get("lint-fix");
    expect(set?.size).toBe(2);
  });

  test("AC11: createDeclineLedger without a backing map allocates a fresh, empty ledger", () => {
    const ledger = createDeclineLedger<Finding>();
    const strategy = makeStrategy({ name: "lint-fix" });

    // No strategy is retired until recordDeclined is called.
    expect(ledger.isRetiredFor(strategy, [lintA])).toBe(false);
    expect(ledger.isRetiredFor(strategy, [typecheckC])).toBe(false);

    // recordDeclined now retires only against the dispatched batch.
    ledger.recordDeclined(strategy, [lintA]);
    expect(ledger.isRetiredFor(strategy, [lintA])).toBe(true);
    expect(ledger.isRetiredFor(strategy, [typecheckC])).toBe(false);
  });
});

// ─── AC6 (composite): carried history does not affect non-cycle behaviour ────

describe("US-002 composite — carried history composes with runFixCycle end-to-end", () => {
  test("priorIterations of length 1 + cap=1 → cap is already saturated; no live dispatch", async () => {
    // 1 prior 'lint-fix' dispatch + cap=1 = saturation. Mirrors AC1's shape
    // (cap reached before the live iteration) and asserts the cycle never
    // calls fixOp.
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const priorIterations: Iteration<Finding>[] = [priorFixIteration([lintA], "lint-fix", 1)];
    const cycle = makeCycle([lintA], [strategy], async () => [lintA]);
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.exhaustedStrategy).toBe("lint-fix");
    expect(callOpMock).toHaveBeenCalledTimes(0);
  });

  test("priorIterations of unrelated strategy names does not affect the active strategy's cap", async () => {
    // The cap is counted per strategy name; carried iterations by another
    // strategy must not bleed into the cap check for 'lint-fix'.
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 2 });
    const priorIterations: Iteration<Finding>[] = [
      priorFixIteration([lintA], "other-fix", 1),
      priorFixIteration([lintA], "other-fix", 2),
      priorFixIteration([lintA], "other-fix", 3),
    ];
    const cycle = makeCycle([lintA], [strategy], async () => []);
    cycle.priorIterations = priorIterations;
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: callOpMock,
    });

    // 'lint-fix' is below its cap of 2 (0 prior iterations of its own name),
    // so the live dispatch happens and resolves on the first try.
    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(result.exitReason).toBe("resolved");
  });
});
