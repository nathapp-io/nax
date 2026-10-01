import { totalSpendUsd } from "@/runtime";
import { checkCostExceeded, isTriggerEnabled } from "../interaction/triggers";
// The leaf, not the `@/pipeline` barrel: the barrel reaches back into
// `src/execution` and would put this module in an import cycle. Same reason
// `merge-conflict-outcomes.ts` imports the bus this way.
import { pipelineEventBus } from "../pipeline/event-bus";
import type { SequentialExecutionContext } from "./executor-types";

/**
 * BUG-6 / D-4: shared costLimit gate for all three dispatch paths (parallel batch,
 * single-story, sequential). Emits `run:paused` and returns `stop: true` unless the
 * cost-exceeded trigger is enabled and the user approves continuing (`run:resumed`).
 *
 * Sibling of `cost-warning.ts`, and the two must read the same number: a warning
 * computed off a different total than the stop would fire late, or never.
 */
export async function enforceCostLimit(
  ctx: SequentialExecutionContext,
  totalCost: number,
  costLimit: number,
  storyId?: string,
): Promise<{ stop: boolean; enforcedCost: number }> {
  // `totalSpendUsd`, not `totalCostUsd`: a budget guard that ignores the spend of
  // dispatches that threw can be overrun by failures alone, and rectification —
  // which only runs because something already failed — is where those cluster.
  // Money spent is money spent, whether or not the dispatch returned anything.
  const enforcedCost = Math.max(totalCost, totalSpendUsd(ctx.runtime.costAggregator.snapshot()));
  if (enforcedCost < costLimit) return { stop: false, enforcedCost };

  const shouldProceed =
    ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
      ? await checkCostExceeded(
          { featureName: ctx.feature, cost: enforcedCost, limit: costLimit },
          ctx.config,
          ctx.interactionChain,
        )
      : false;

  if (!shouldProceed) {
    pipelineEventBus.emit({
      type: "run:paused",
      reason: `Cost limit reached: $${enforcedCost.toFixed(2)}`,
      ...(storyId !== undefined ? { storyId } : {}),
      cost: enforcedCost,
    });
    return { stop: true, enforcedCost };
  }
  pipelineEventBus.emit({ type: "run:resumed", feature: ctx.feature });
  return { stop: false, enforcedCost };
}
