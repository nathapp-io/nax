// test/unit/execution/run-cost-reconcile.test.ts
//
// #2006 — the run-cost accumulator and the cost aggregator must agree on
// "what did this run cost". `reconcileRunCost` folds the aggregator basis
// (success + failed-dispatch spend) into the accumulator at every story
// boundary; `liveRunTotalCost` is the crash-path getter's reading — the
// same single number, available even when the last story boundary predates
// the spent money (COST-1).
import { describe, expect, test } from "bun:test";
import { liveRunTotalCost, reconcileRunCost } from "@/execution/run-cost-reconcile";

type AggLike = { snapshot(): { totalCostUsd: number; totalErrorCostUsd: number } };

function agg(totalCostUsd: number, totalErrorCostUsd = 0): AggLike {
  return { snapshot: () => ({ totalCostUsd, totalErrorCostUsd }) };
}

describe("reconcileRunCost — #2006: accumulator reconciles to the aggregator basis", () => {
  test("aggregator total (success + error halves) wins when it exceeds the accumulator", () => {
    // Pre-run pipeline + failed-dispatch spend the phaseCosts sum cannot see.
    expect(reconcileRunCost(2, agg(4, 2))).toBe(6);
  });

  test("accumulator wins when it exceeds the aggregator (e.g. worker-process spend)", () => {
    expect(reconcileRunCost(11, agg(4, 2))).toBe(11);
  });

  test("a zero aggregator never lowers the accumulated total", () => {
    expect(reconcileRunCost(3.5, agg(0))).toBe(3.5);
  });

  test("a negative error half cannot drag the total below the accumulator", () => {
    expect(reconcileRunCost(5, agg(3, -1))).toBe(5);
  });
});

describe("liveRunTotalCost — crash-path live total (COST-1)", () => {
  test("aggregator basis is the ceiling once the ledger has been drained", () => {
    // Mid-story SIGINT: the last boundary total (2) saw nothing of the
    // in-flight story; the drained ledger has everything.
    expect(liveRunTotalCost(2, 2, 12)).toBe(12);
  });

  test("accumulated run total wins when it exceeds both the retained and aggregator figures", () => {
    // Parallel workers account on their own aggregators — the parent's
    // accumulated total can outread its own aggregator snapshot legitimately.
    expect(liveRunTotalCost(10, 6, 4)).toBe(10);
  });

  test("retained boundary value wins while the aggregator reading is unavailable", () => {
    // Pre-drain call (heartbeat during teardown): the aggregator snapshot is
    // still safe to read, but the helper must not require it.
    expect(liveRunTotalCost(0, 6, undefined)).toBe(6);
  });

  test("pre-setup: no sources have any spend → 0", () => {
    expect(liveRunTotalCost(0, 0, undefined)).toBe(0);
  });
});
