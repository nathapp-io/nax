import { totalSpendUsd } from "@/runtime";

/**
 * Reconcile the run cost accumulator with the cost aggregator's view (#2006).
 *
 * The orchestrator's `phaseCosts` sum (and `batchResult.totalCost` derived
 * from it) structurally cannot see spend the aggregator attributes to this
 * run: pre-run pipeline dispatches (acceptance-gen) and failed dispatches.
 * The budget guard already reads the aggregator basis (cost-guard.ts), so
 * folding it in here makes the accumulator — what the status writer, the
 * progress events, and the crash path report — the same single number.
 */
export function reconcileRunCost(
  totalCost: number,
  costAggregator: { snapshot(): { totalCostUsd: number; totalErrorCostUsd: number } },
): number {
  return Math.max(totalCost, totalSpendUsd(costAggregator.snapshot()));
}
