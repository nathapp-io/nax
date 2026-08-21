import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _storyOrchestratorDeps, runRectification, withIncreasingFailuresBail, withNoProgressBail } from "@/execution";
import { runFixCycle } from "@/findings";
import type { Finding, FixCycle, FixCycleContext, FixStrategy, Iteration } from "@/findings";
import type { CallContext } from "@/operations";
import { makeTestRuntime } from "@test/helpers";
import { GATE_FAILURE, mockFullSuiteGateOp, mockImplementerOp } from "./_revalidation-fixtures";

function finding(message: string): Finding {
  return { severity: "error", category: "test", source: "tdd-verifier", message };
}

/** Same source/file/line/rule as `finding(base)`, but a reworded message — simulates an LLM reviewer paraphrasing the same defect. */
function reworded(base: string, variant: number): Finding {
  return {
    severity: "error",
    category: "test",
    source: "semantic-review",
    file: "src/a.ts",
    line: 10,
    rule: "AC-2",
    message: `${base} (variant ${variant})`,
  };
}

function iteration(before: Finding[], after: Finding[], iterationNum: number): Iteration<Finding> {
  return {
    iterationNum,
    findingsBefore: before,
    findingsAfter: after,
    fixesApplied: [{ strategyName: "strategy", op: "noop", targetFiles: [], summary: "" }],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

function strategy(): FixStrategy<Finding, unknown, unknown, unknown> {
  return {
    name: "strategy",
    appliesTo: () => true,
    fixOp: { name: "noop" } as FixStrategy<Finding, unknown, unknown, unknown>["fixOp"],
    buildInput: () => ({}),
    maxAttempts: 12,
  };
}

function bailWhen(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
): (iterations: Iteration<Finding>[]) => string | null {
  const predicate = strategies[0]?.bailWhen;
  if (!predicate) throw new Error("expected bailWhen");
  return predicate;
}

function stalledIterations(findings: Finding[], count: number): Iteration<Finding>[] {
  return Array.from({ length: count }, (_, index) => iteration(findings, findings, index + 1));
}

/** An iteration in which every dispatched strategy answered UNRESOLVED — nothing ran. */
function declinedIteration(findings: Finding[], iterationNum: number): Iteration<Finding> {
  return {
    ...iteration(findings, findings, iterationNum),
    fixesApplied: [
      { strategyName: "full-suite-rectify", op: "noop", targetFiles: [], summary: "", unresolved: "out of scope" },
    ],
  };
}

describe("withNoProgressBail — US-002", () => {
  test("US-002 AC1: returns a reason for three identical trailing iterations", () => {
    const same = finding("same");
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(stalledIterations([same], 3))).not.toBeNull();
  });

  test("US-002 AC2: returns null when every iteration removes a different finding", () => {
    const all = Array.from({ length: 5 }, (_, index) => finding(`finding-${index}`));
    const iterations = all.map((removed, index) =>
      iteration(
        all,
        all.filter((candidate) => candidate !== removed),
        index + 1,
      ),
    );
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(iterations)).toBeNull();
  });

  test("US-002 AC3: returns null for exactly two no-progress iterations", () => {
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(stalledIterations([finding("same")], 2))).toBeNull();
  });

  test("US-002 AC4: returns a reason when a third no-progress iteration is appended", () => {
    const same = finding("same");
    const iterations = stalledIterations([same], 2);
    iterations.push(iteration([same], [same], 3));
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(iterations)).not.toBeNull();
  });

  test("US-002 AC5: returns a reason when before keys persist alongside new findings", () => {
    const persisted = [finding("one"), finding("two")];
    const iterations = Array.from({ length: 3 }, (_, index) =>
      iteration(persisted, [...persisted, finding(`new-a-${index}`), finding(`new-b-${index}`)], index + 1),
    );
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(iterations)).not.toBeNull();
  });

  test("US-002 AC6: disabled wrapper preserves strategy object identity", () => {
    const original = strategy();
    expect(withNoProgressBail([original], false, 3)[0]).toBe(original);
  });

  test("US-002 AC7: disabled wrapper preserves bailWhen identity", () => {
    const userBail = () => "user-stop";
    const original = { ...strategy(), bailWhen: userBail };
    expect(withNoProgressBail([original], false, 3)[0]?.bailWhen).toBe(userBail);
  });

  test("US-002 AC8: any user-supplied reason wins over no-progress", () => {
    const original = { ...strategy(), bailWhen: () => "custom-user-reason" };
    const bail = bailWhen(withNoProgressBail([original], true, 3));
    expect(bail(stalledIterations([finding("same")], 3))).toBe("custom-user-reason");
  });

  test("US-002 AC9: empty findingsBefore arrays do not count as a stall", () => {
    const iterations = Array.from({ length: 3 }, (_, index) => iteration([], [finding(`new-${index}`)], index + 1));
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(iterations)).toBeNull();
  });

  test("US-002 AC10: reason reports three consecutive iterations", () => {
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(stalledIterations([finding("one"), finding("two")], 3))).toContain("3 consecutive iteration(s)");
  });

  test("US-002 AC11: reason reports two persisted findings", () => {
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail(stalledIterations([finding("one"), finding("two")], 3))).toContain("2 finding(s) persisted");
  });

  test("nax#1581: bails on an LLM finding reworded every iteration at the same file:line:rule", () => {
    const iterations = Array.from({ length: 3 }, (_, index) =>
      iteration([reworded("same defect", index)], [reworded("same defect", index + 1)], index + 1),
    );
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    const reason = bail(iterations);
    expect(reason).not.toBeNull();
    expect(reason).toContain("3 consecutive iteration(s)");
    expect(reason).toContain("1 finding(s) persisted");
  });

  test("US-002 AC15: no-progress reason outranks count-increase", () => {
    const before = [finding("one"), finding("two")];
    const iterations = Array.from({ length: 3 }, (_, index) =>
      iteration(before, [...before, finding(`new-${index}`)], index + 1),
    );
    const countWrapped = withIncreasingFailuresBail([strategy()], true, 3);
    const bail = bailWhen(withNoProgressBail(countWrapped, true, 3));
    const reason = bail(iterations);
    expect(reason).toContain("no finding resolved");
    expect(reason).not.toContain("failure count increased");
  });

  test("US-002 AC12/AC13: production wrapper composition bails after three fix dispatches", async () => {
    const runtime = makeTestRuntime();
    const ctx = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" } as FixCycleContext;
    const persisted = [finding("one"), finding("two")];
    let dispatches = 0;
    const wrapped = withNoProgressBail(withIncreasingFailuresBail([strategy()], true, 3), true, 3);
    const cycle: FixCycle<Finding> = {
      findings: persisted,
      iterations: [],
      strategies: wrapped,
      config: { maxAttemptsTotal: 12, validatorRetries: 1 },
      validate: async () => ({ findings: persisted }),
    };
    const result = await runFixCycle(cycle, ctx, "US-002", {
      callOp: async () => {
        dispatches += 1;
        return {};
      },
    });
    await runtime.close();
    expect(result.exitReason).toBe("bail-when");
    expect(dispatches).toBe(3);
  });

  test("US-002 AC14: disabled no-progress bail dispatches more than three fixes", async () => {
    const runtime = makeTestRuntime();
    const ctx = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" } as FixCycleContext;
    const persisted = [finding("one"), finding("two")];
    let dispatches = 0;
    const wrapped = withNoProgressBail(withIncreasingFailuresBail([strategy()], false, 3), false, 3);
    const cycle: FixCycle<Finding> = {
      findings: persisted,
      iterations: [],
      strategies: wrapped,
      config: { maxAttemptsTotal: 12, validatorRetries: 1 },
      validate: async () => ({ findings: persisted }),
    };
    await runFixCycle(cycle, ctx, "US-002", {
      callOp: async () => {
        dispatches += 1;
        return {};
      },
    });
    await runtime.close();
    expect(dispatches).toBeGreaterThan(3);
  });
});

describe("withNoProgressBail — US-002 AC-2.9/AC-2.10: driven through runRectification (production entry point)", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
  });

  afterEach(() => {
    _storyOrchestratorDeps.callOp = origCallOp;
  });

  function makeCtx(runtime: ReturnType<typeof makeTestRuntime>): CallContext {
    return {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-002-integration",
    } as CallContext;
  }

  /** Minimal state with one collected validation phase (the gate) — satisfies `collectRectificationPhases`. */
  function makeState(abortOnNoProgress: boolean): Parameters<typeof runRectification>[1] {
    return {
      fullSuiteGate: { kind: "full-suite-gate", slot: { op: mockFullSuiteGateOp, input: { story: "US-002" } } },
      rectification: {
        maxAttempts: 12,
        strategies: [
          {
            name: "strategy",
            appliesTo: () => true,
            fixOp: mockImplementerOp,
            buildInput: () => ({ story: "US-002" }),
            maxAttempts: 12,
          },
        ],
        abortOnIncreasingFailures: false,
        abortOnNoProgress,
        consecutiveNoProgressToBail: 3,
      },
    } as unknown as Parameters<typeof runRectification>[1];
  }

  /** The gate stays red with the identical finding on every re-run — a pure stall, no progress ever made. */
  function alwaysRedGateAndCountFixes(): () => number {
    let dispatches = 0;
    _storyOrchestratorDeps.callOp = (async (_c: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, passed: false, findings: [GATE_FAILURE] };
      if (op.name === "implementer") {
        dispatches += 1;
        return { success: true };
      }
      return { success: true, passed: true, findings: [] };
    }) as typeof _storyOrchestratorDeps.callOp;
    return () => dispatches;
  }

  test("AC-2.9: abortOnNoProgress true bails runRectification after exactly 3 fix dispatches", async () => {
    const runtime = makeTestRuntime();
    const ctx = makeCtx(runtime);
    const dispatches = alwaysRedGateAndCountFixes();

    const result = await runRectification(ctx, makeState(true), {}, {
      "full-suite-gate": { success: false, passed: false, findings: [GATE_FAILURE] },
    });
    await runtime.close();

    expect(result.rectificationExhausted).toBe(true);
    expect(dispatches()).toBe(3);
  });

  test("AC-2.10: abortOnNoProgress false dispatches more than 3 fixes on the same production path", async () => {
    const runtime = makeTestRuntime();
    const ctx = makeCtx(runtime);
    const dispatches = alwaysRedGateAndCountFixes();

    await runRectification(ctx, makeState(false), {}, {
      "full-suite-gate": { success: false, passed: false, findings: [GATE_FAILURE] },
    });
    await runtime.close();

    expect(dispatches()).toBeGreaterThan(3);
  });
});

// ─── Declined iterations are not evidence of no progress (#1654) ─────────────
//
// Before #1654 an all-declined iteration always terminated the cycle, so it
// could never sit inside a trailing window. Now the cycle falls through to a
// repo-scoped claimant instead, which put a fake no-progress signal in the
// window: nothing was dispatched, so "no finding resolved" is trivially true
// and says nothing about whether progress is possible. Left unhandled, a story
// already stalled for two iterations bails at the give-up and the fallthrough
// claimant — the whole point of #1654 — never runs.

describe("withNoProgressBail — declined iterations (#1654)", () => {
  test("does not count an all-declined iteration toward the no-progress streak", () => {
    const same = finding("same");
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    const iterations = [...stalledIterations([same], 2), declinedIteration([same], 3)];
    expect(bail(iterations)).toBeNull();
  });

  test("still bails once real attempts fill the window again", () => {
    // The exemption must not disable the bail — an all-declined iteration is
    // skipped, not credited as progress.
    const same = finding("same");
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    const iterations = [...stalledIterations([same], 2), declinedIteration([same], 3), iteration([same], [same], 4)];
    expect(bail(iterations)).not.toBeNull();
  });

  test("a partially-declined iteration still counts — a sibling did run", () => {
    const same = finding("same");
    const partial: Iteration<Finding> = {
      ...iteration([same], [same], 3),
      fixesApplied: [
        { strategyName: "full-suite-rectify", op: "noop", targetFiles: [], summary: "", unresolved: "out of scope" },
        { strategyName: "autofix-test-writer", op: "noop", targetFiles: [], summary: "wrote a test" },
      ],
    };
    const bail = bailWhen(withNoProgressBail([strategy()], true, 3));
    expect(bail([...stalledIterations([same], 2), partial])).not.toBeNull();
  });
});
