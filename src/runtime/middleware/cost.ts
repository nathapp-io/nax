import type { CostErrorEvent, CostEvent, ICostAggregator, OperationSummaryEvent } from "../cost-aggregator";
import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus, OperationCompletedEvent } from "../dispatch-events";

export function attachCostSubscriber(bus: IDispatchEventBus, aggregator: ICostAggregator, runId: string): () => void {
  const offDispatch = bus.onDispatch((event: DispatchEvent) => {
    const tu = event.tokenUsage;
    const exactCostUsd = event.exactCostUsd;
    const estimatedCostUsd = event.estimatedCostUsd ?? exactCostUsd ?? 0;

    if (!tu && exactCostUsd == null && estimatedCostUsd === 0) return;

    const costUsd = exactCostUsd ?? estimatedCostUsd;
    const confidence: "exact" | "estimated" = exactCostUsd != null ? "exact" : "estimated";

    const costEvent: CostEvent = {
      ts: event.timestamp,
      runId,
      agentName: event.agentName,
      model: "unknown",
      stage: event.stage,
      storyId: event.storyId,
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
      costUsd,
      confidence,
      durationMs: event.durationMs,
    };
    aggregator.record(costEvent);
  });

  const offError = bus.onDispatchError((event: DispatchErrorEvent) => {
    const errorEvent: CostErrorEvent = {
      ts: event.timestamp,
      runId,
      agentName: event.agentName,
      stage: event.stage,
      storyId: event.storyId,
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
