/**
 * ADR-022 — per-dispatch cost attribution for the fix cycle (#1932).
 *
 * `FixApplied.costUsd` used to come from `strategy.extractApplied` alone, and
 * no implementation in the repo supplies one — so every fix cycle summed zeroes
 * over real spend, and rectification (35% of one $11.17 run) reported $0.
 *
 * The run's cost ledger already records that spend. This module is the seam
 * that reads it back: `runFixCycle` stamps a fresh correlation id on each
 * dispatch context and looks the dispatch's rows up by that id afterwards.
 * `callOp` preserves a caller-supplied `callId`, and one id per dispatch keeps
 * co-running strategies from conflating.
 *
 * Deliberately a callId and NOT a cost scope: the rectification path routes the
 * fix-cycle dispatch through `runPhase`, which opens its own scope and
 * overwrites `scopeId` on the context it forwards — a scope opened in the cycle
 * would read zero on the single biggest-spending caller. `callId` survives that
 * hop untouched.
 *
 * scope: repo-scoped (telemetry only; never fails a cycle)
 */

import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import { totalSpendUsd } from "../runtime/cost-aggregator";
import type { FixCycleContext } from "./cycle-types";

/** Both halves of one dispatch's spend; `costUsd` already sums them (#1960). */
export interface DispatchSpend {
  /** Total dispatch spend — successful plus failed (#1960). */
  costUsd: number;
  /** Failed-dispatch spend — `CostSnapshot.totalErrorCostUsd`. */
  errorCostUsd: number;
}

/**
 * Spend recorded against one dispatch, read back from the run's cost ledger.
 *
 * The ledger splits its rows by outcome; this read recombines that split into
 * the total, keeping the failed half visible beside it (#1960):
 *
 * - `costUsd` is total spend -- successful plus failed-dispatch -- mirroring
 *   `runPhase`'s `phaseCosts`, so the fix-cycle number never means something
 *   different from the phase number beside it. #1960 folded `phaseCosts`, and
 *   this moved with it deliberately, reversing #1948's original
 *   split-at-the-fix-cycle reading. Every run total that consumes it
 *   (`acceptance-loop`, `run-regression`) is re-based by exactly the failed
 *   spend, which was zero on every run recorded before this change.
 * - `totalErrorCostUsd` is real money too. `callOp`'s complete-branch retry
 *   loop reuses one `callId` across attempts, so a failed attempt's error row
 *   is keyed here; rectification is failure-heavy by construction, which is
 *   where that spend clusters. #1932 read it and dropped it, leaving the
 *   magnitude unmeasurable.
 *
 * `errorCostUsd` survives the fold: folded into `costUsd` but still carried
 * beside it, exactly like `RunMetrics.errorCostUsd`, so the wasted spend stays
 * measurable instead of vanishing into the total.
 *
 * Returns zeros, never undefined, when the aggregator has no rows for the call:
 * a deterministic strategy genuinely spends nothing, and a truthful 0 is what
 * the iteration log's `costUsd > 0` omission already means.
 */
export function ledgerSpendFor(ctx: FixCycleContext, callId: string): DispatchSpend {
  try {
    // No optional chaining on `runtime.costAggregator`: it is a required field,
    // and `?.` would turn a genuinely broken wiring into a silent $0 — the very
    // failure shape this fix exists to remove. A real absence lands in the catch.
    const snap = ctx.runtime.costAggregator.byCall()[callId];
    if (snap === undefined) return { costUsd: 0, errorCostUsd: 0 };
    return { costUsd: totalSpendUsd(snap), errorCostUsd: snap.totalErrorCostUsd };
  } catch (err) {
    // Telemetry must never fail a fix cycle — but a swallowed failure that
    // leaves no trace is how #1932 stayed invisible, so say so.
    getSafeLogger()?.debug("findings.cycle", "cost ledger read failed; reporting 0 for this dispatch", {
      storyId: ctx.storyId,
      callId,
      error: errorMessage(err),
    });
    return { costUsd: 0, errorCostUsd: 0 };
  }
}
