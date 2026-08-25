/**
 * withIncreasingFailuresBail — consecutive-increase bail predicate.
 *
 * Verifies the `abortOnIncreasingFailures` bail fires only after N *trailing*
 * iterations have each regressed the finding count (findingsAfter > findingsBefore).
 * A threshold of 1 reproduces the legacy single-iteration behaviour; the
 * production default of 2 tolerates one transient regression (e.g. a tightened
 * test surfacing more verifier failures before the implementer fixes the source).
 */

import { describe, expect, test } from "bun:test";
import { withIncreasingFailuresBail } from "@/execution";
import type { Finding, FixStrategy, Iteration } from "@/findings";

function finding(message: string): Finding {
  return { severity: "error", category: "test", source: "tdd-verifier", message };
}

function iter(beforeCount: number, afterCount: number, num = 1): Iteration<Finding> {
  return {
    iterationNum: num,
    findingsBefore: Array.from({ length: beforeCount }, (_, i) => finding(`before-${i}`)),
    findingsAfter: Array.from({ length: afterCount }, (_, i) => finding(`after-${i}`)),
    fixesApplied: [{ strategyName: "s", op: "noop-op", targetFiles: [], summary: "" }],
    outcome: afterCount > beforeCount ? "regressed" : "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

function baseStrategy(): FixStrategy<Finding, unknown, unknown, unknown> {
  const fixOp: FixStrategy<Finding, unknown, unknown, unknown>["fixOp"] = {
    name: "noop",
    kind: "complete",
    stage: "verify",
    config: [],
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => null,
    jsonMode: false,
  };
  return {
    name: "autofix-test-writer",
    appliesTo: () => true,
    fixOp,
    buildInput: () => ({}),
    maxAttempts: 3,
    coRun: "co-run-sequential",
  };
}

function bailOf(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
): (iters: Iteration<Finding>[]) => string | null {
  const fn = strategies[0]?.bailWhen;
  if (!fn) throw new Error("expected bailWhen to be wrapped");
  return fn;
}

describe("withIncreasingFailuresBail — consecutive threshold", () => {
  test("disabled: returns strategies unchanged (no bailWhen wrapping)", () => {
    const original = baseStrategy();
    const [wrapped] = withIncreasingFailuresBail([original], false, 2);
    expect(wrapped).toBe(original);
    expect(wrapped.bailWhen).toBeUndefined();
  });

  test("threshold 2: a single regressing iteration does NOT bail", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 2));
    // The flailing scenario from the log: churn (1->1) then one increase (1->2).
    expect(bail([iter(1, 1, 1)])).toBeNull();
    expect(bail([iter(1, 1, 1), iter(1, 2, 2)])).toBeNull();
  });

  test("threshold 2: two consecutive regressing iterations bail", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 2));
    const reason = bail([iter(1, 2, 1), iter(2, 3, 2)]);
    expect(reason).toContain("2 consecutive");
    expect(reason).toContain("1 -> 3");
  });

  test("threshold 2: a non-regressing iteration between increases resets the run", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 2));
    // increase, then flat — trailing window [flat, ...] is not all-regressed.
    expect(bail([iter(1, 2, 1), iter(2, 2, 2)])).toBeNull();
    // ...but two increases AFTER the flat one do bail.
    expect(bail([iter(1, 2, 1), iter(2, 2, 2), iter(2, 3, 3), iter(3, 4, 4)])).toContain("2 consecutive");
  });

  test("threshold 1: reproduces legacy bail-on-first-increase behaviour", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 1));
    expect(bail([iter(1, 1, 1)])).toBeNull();
    expect(bail([iter(1, 2, 1)])).toContain("1 -> 2");
  });

  test("user-supplied bailWhen wins over the increasing-failures predicate", () => {
    const strat = { ...baseStrategy(), bailWhen: () => "user-reason" };
    const bail = bailOf(withIncreasingFailuresBail([strat], true, 2));
    expect(bail([iter(1, 2, 1), iter(2, 3, 2)])).toBe("user-reason");
  });
});
