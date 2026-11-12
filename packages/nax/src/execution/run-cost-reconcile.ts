import { getSafeLogger } from "@/logger";
import { totalSpendUsd } from "@/runtime";

/**
 * Material divergence threshold for {@link reconcileRunCost}, in USD.
 *
 * The two bases are sums of the same per-dispatch costs accumulated in a
 * different order, so they routinely differ by float noise: `1.0000000000000002`
 * against `1` is one ULP, not spend. Warning on that filled bot runs with a
 * warning no operator could act on, so the divergence must clear this epsilon
 * before it is surfaced. The returned total stays unrounded — the accumulator
 * and the aggregator are reconciled, not the reported money.
 */
export const COST_RECONCILE_EPSILON_USD = 1e-9;

/**
 * Reconcile the run cost accumulator with the cost aggregator's view (#2006).
 *
 * The orchestrator's `phaseCosts` sum (and `batchResult.totalCost` derived
 * from it) structurally cannot see spend the aggregator attributes to this
 * run: pre-run one-shot pipeline dispatches and failed dispatches.
 * The budget guard already reads the aggregator basis (cost-guard.ts), so
 * folding it in here makes the accumulator — what the status writer, the
 * progress events, and the crash path report — the same single number.
 *
 * COST-2: the max is directional. Normally the aggregator is the superset
 * (it sees everything the phaseCosts sum sees, plus more). When the
 * accumulator outruns it — worktree-parallel workers account on their own
 * aggregators, or a rolled-back pass left spend the aggregator forgave —
 * the larger figure is still the safe one to report, but the divergence is
 * surfaced once per run so a chronic basis inversion cannot drift silently.
 *
 * US-004: a divergence within {@link COST_RECONCILE_EPSILON_USD} is float
 * noise, not a basis inversion, so it is not surfaced.
 */
export function reconcileRunCost(
  totalCost: number,
  costAggregator: { snapshot(): { totalCostUsd: number; totalErrorCostUsd: number } },
): number {
  const aggregatorTotal = totalSpendUsd(costAggregator.snapshot());
  const delta = totalCost - aggregatorTotal;
  if (delta > COST_RECONCILE_EPSILON_USD) {
    getSafeLogger()?.warnOnce(
      "cost-reconcile",
      "Run cost accumulator exceeds the aggregator basis — reporting the larger figure",
      { accumulator: totalCost, aggregatorTotal, delta },
    );
  }
  return Math.max(totalCost, aggregatorTotal);
}

/**
 * The crash path's live reading of "what did this run cost" (COST-1).
 *
 * The signal-path getter must be callable at any moment, so it takes the
 * three sources it can see at any point and reports their max:
 * - `accumulated`: the post-execution local total (unset mid-run → 0).
 * - `retained`: the status writer's last story-boundary total.
 * - `aggregatorTotal`: the cost aggregator's snapshot — the full run spend
 *   once the signal path has drained the ledger, including the in-flight
 *   story whose spend no boundary total ever saw.
 *
 * `undefined` aggregatorTotal is "not available yet" (pre-setup), not zero,
 * so a caller that cannot read the aggregator still gets the boundary
 * reading without the helper inventing spend.
 */
export function liveRunTotalCost(accumulated: number, retained: number, aggregatorTotal: number | undefined): number {
  return Math.max(accumulated, retained, aggregatorTotal ?? 0);
}
