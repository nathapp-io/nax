import { resolvePricingSource } from "@/agents";
import type { CostErrorEvent, CostEvent, ICostAggregator, OperationSummaryEvent } from "../cost-aggregator";
import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus, OperationCompletedEvent } from "../dispatch-events";

/**
 * Cost-row schema version.
 *
 * 1 — implicit, pre-#1433. `model` was hardcoded to the literal "unknown" on
 *     every row; `modelTier`, `sessionRole`, `featureName`, `profile`,
 *     `pricingSource` and `projectKey` did not exist; and error rows were
 *     indistinguishable from genuine zero-cost rows.
 *
 *     These rows cannot be backfilled — `model` in particular is unrecoverable —
 *     so a row *without* this field must be read as model-unattributed rather
 *     than treating its "unknown" as a value.
 *
 * 2 — current. Guarantees, on every row: `model` (falling back to "unknown"
 *     only when the dispatch resolved none), `sessionRole`, `pricingSource`,
 *     `schemaVersion`, and `projectKey` when the runtime supplied one.
 *     `modelTier` is present only when a tier selected the model — an explicit
 *     `{ agent, model }` pin reports none rather than a fabricated tier.
 *     Error rows additionally carry `kind: "error"`.
 *
 * Bump this when adding or changing a field consumers key on, and extend the
 * list above — the constant is how a reader learns what a row guarantees.
 */
export const COST_ROW_SCHEMA_VERSION = 2;

export function attachCostSubscriber(
  bus: IDispatchEventBus,
  aggregator: ICostAggregator,
  runId: string,
  /**
   * Stable project identity. `runId` and `storyId` are project-local and collide
   * across repos, so a row lifted out of its directory cannot otherwise say where
   * it came from — the same defect #1429 fixed for curator observations.
   */
  projectKey?: string,
): () => void {
  const offDispatch = bus.onDispatch((event: DispatchEvent) => {
    const tu = event.tokenUsage;
    const wireExactCostUsd = event.exactCostUsd;
    const estimatedCostUsd = event.estimatedCostUsd ?? 0;

    const hasWireExactCost = typeof wireExactCostUsd === "number" && Number.isFinite(wireExactCostUsd);
    const exactCostUsd = hasWireExactCost ? wireExactCostUsd : estimatedCostUsd;
    const confidence: "exact" | "estimated" = hasWireExactCost ? "exact" : "estimated";

    if (!tu && exactCostUsd === 0) return;

    const costEvent: CostEvent = {
      ts: event.timestamp,
      runId,
      ...(projectKey !== undefined ? { projectKey } : {}),
      schemaVersion: COST_ROW_SCHEMA_VERSION,
      agentName: event.agentName,
      // #1433: this was the literal "unknown" on every row, because DispatchEvent
      // carried no model. It still falls back to "unknown" when a dispatch has no
      // resolved model, but that is now a real signal rather than a constant.
      model: event.model ?? "unknown",
      ...(event.modelTier !== undefined ? { modelTier: event.modelTier } : {}),
      ...(event.profile !== undefined ? { profile: event.profile } : {}),
      stage: event.stage,
      // Both already on the event and previously discarded. sessionRole is the
      // sub-stage attribution key: `stage` alone collapses 23 roles into 6 buckets.
      sessionRole: event.sessionRole,
      ...(event.featureName !== undefined ? { featureName: event.featureName } : {}),
      storyId: event.storyId,
      callId: event.callId,
      scopeId: event.scopeId,
      tokens: tu
        ? {
            input: tu.inputTokens ?? 0,
            output: tu.outputTokens ?? 0,
            cacheRead: tu.cacheReadInputTokens,
            cacheWrite: tu.cacheCreationInputTokens,
          }
        : { input: 0, output: 0 },
      estimatedCostUsd,
      exactCostUsd,
      costUsd: exactCostUsd,
      confidence,
      // Same MODEL_PRICING predicate the estimator uses, so this names the rate
      // card that actually produced the number rather than guessing at it.
      pricingSource: hasWireExactCost ? "wire" : resolvePricingSource(event.model),
      durationMs: event.durationMs,
    };
    aggregator.record(costEvent);
  });

  const offError = bus.onDispatchError((event: DispatchErrorEvent) => {
    const errorEvent: CostErrorEvent = {
      kind: "error",
      ts: event.timestamp,
      runId,
      ...(projectKey !== undefined ? { projectKey } : {}),
      schemaVersion: COST_ROW_SCHEMA_VERSION,
      agentName: event.agentName,
      stage: event.stage,
      storyId: event.storyId,
      callId: event.callId,
      scopeId: event.scopeId,
      errorCode: event.errorCode,
      durationMs: event.durationMs,
    };
    aggregator.recordError(errorEvent);
  });

  const offCompleted = bus.onOperationCompleted((event: OperationCompletedEvent) => {
    const summary: OperationSummaryEvent = {
      runId,
      operation: event.operation,
      hopCount: event.hopCount,
      fallbackTriggered: event.fallbackTriggered,
      totalCostUsd: event.totalCostUsd,
      totalElapsedMs: event.totalElapsedMs,
      finalStatus: event.finalStatus,
    };
    aggregator.recordOperationSummary(summary);
  });

  return () => {
    offDispatch();
    offError();
    offCompleted();
  };
}
