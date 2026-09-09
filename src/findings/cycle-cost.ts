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
import type { FixCycleContext } from "./cycle-types";

/**
 * Spend recorded against one dispatch, read back from the run's cost ledger.
 *
 * Mirrors `runPhase`'s accounting: `totalCostUsd` is successful-dispatch spend,
 * so failed dispatches (`totalErrorCostUsd`) are excluded here too rather than
 * letting the fix-cycle number mean something different from the phase number
 * beside it. This is a deliberate exclusion, not an oversight, and it is the
 * one piece of fix-cycle spend this fix does NOT make visible:
 *
 * - `callOp`'s complete-branch retry loop reuses the same `callId` across
 *   attempts, so a failed attempt's error row is keyed here but not summed.
 * - Rectification is failure-heavy by construction, which is where that would
 *   matter most.
 *
 * Folding error spend in would silently re-base every run total that consumes
 * this number (`acceptance-loop`, `run-regression`) against its own history —
 * the split `CostSnapshot` keeps between `totalCostUsd` and `totalErrorCostUsd`
 * exists precisely to avoid that (US-001). Sizing the gap needs a measured run,
 * so it stays a separate question rather than a guess folded into this fix.
 *
 * Returns 0, never undefined, when the aggregator has no rows for the call: a
 * deterministic strategy genuinely spends nothing, and a truthful 0 is what the
 * iteration log's `costUsd > 0` omission already means.
 */
export function ledgerCostFor(ctx: FixCycleContext, callId: string): number {
  try {
    // No optional chaining on `runtime.costAggregator`: it is a required field,
    // and `?.` would turn a genuinely broken wiring into a silent $0 — the very
    // failure shape this fix exists to remove. A real absence lands in the catch.
    return ctx.runtime.costAggregator.byCall()[callId]?.totalCostUsd ?? 0;
  } catch (err) {
    // Telemetry must never fail a fix cycle — but a swallowed failure that
    // leaves no trace is how #1932 stayed invisible, so say so.
    getSafeLogger()?.debug("findings.cycle", "cost ledger read failed; reporting 0 for this dispatch", {
      storyId: ctx.storyId,
      callId,
      error: errorMessage(err),
    });
    return 0;
  }
}
