import type { CostErrorEvent, CostEvent, ICostAggregator, OperationSummaryEvent } from "../cost-aggregator";
import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus, OperationCompletedEvent } from "../dispatch-events";

/**
 * Cost-row schema version.
 *
 * 1 — implicit, pre-#1433: `model` hardcoded to "unknown", no `modelTier`,
 *     `sessionRole` or `featureName`, and error rows indistinguishable from
 *     zero-cost rows. Those rows cannot be backfilled — `model` in particular is
 *     unrecoverable — so consumers must treat a row without this field as
 *     model-unattributed rather than reading its "unknown" as a value.
 * 2 — current.
 */
export const COST_ROW_SCHEMA_VERSION = 2;

export function attachCostSubscriber(bus: IDispatchEventBus, aggregator: ICostAggregator, runId: string): () => void {
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
      schemaVersion: COST_ROW_SCHEMA_VERSION,
      agentName: event.agentName,
      // #1433: this was the literal "unknown" on every row, because DispatchEvent
      // carried no model. It still falls back to "unknown" when a dispatch has no
      // resolved model, but that is now a real signal rather than a constant.
      model: event.model ?? "unknown",
      ...(event.modelTier !== undefined ? { modelTier: event.modelTier } : {}),
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
      durationMs: event.durationMs,
    };
    aggregator.record(costEvent);
  });

  const offError = bus.onDispatchError((event: DispatchErrorEvent) => {
    const errorEvent: CostErrorEvent = {
      kind: "error",
      ts: event.timestamp,
      runId,
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
