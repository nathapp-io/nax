import { NaxError } from "../../errors";
import type { AgentMiddleware, MiddlewareContext } from "../agent-middleware";
import type { CostErrorEvent, CostEvent, ICostAggregator } from "../cost-aggregator";

function extractTokens(
  result: unknown,
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  if (!result || typeof result !== "object") return null;
  const tu = (result as Record<string, unknown>).tokenUsage as Record<string, number> | undefined;
  if (!tu) return null;
  return {
    input: tu.inputTokens ?? 0,
    output: tu.outputTokens ?? 0,
    cacheRead: tu.cache_read_input_tokens,
    cacheWrite: tu.cache_creation_input_tokens,
  };
}

function extractCostUsd(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const r = result as Record<string, unknown>;
  return (r.estimatedCost as number | undefined) ?? (r.costUsd as number | undefined) ?? 0;
}

export function costMiddleware(aggregator: ICostAggregator, runId: string): AgentMiddleware {
  return {
    name: "cost",
    async after(ctx: MiddlewareContext, result: unknown, durationMs: number): Promise<void> {
      const tokens = extractTokens(result);
      const costUsd = extractCostUsd(result);
      if (!tokens && costUsd === 0) return;
      const event: CostEvent = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        model: ((result as Record<string, unknown>).model as string | undefined) ?? "unknown",
        stage: ctx.stage,
        storyId: ctx.storyId,
        tokens: tokens ?? { input: 0, output: 0 },
        costUsd,
        durationMs,
      };
      aggregator.record(event);
    },
    async onError(ctx: MiddlewareContext, err: unknown, durationMs: number): Promise<void> {
      const event: CostErrorEvent = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        stage: ctx.stage,
        storyId: ctx.storyId,
        errorCode: err instanceof NaxError ? err.code : "UNKNOWN",
        durationMs,
      };
      aggregator.recordError(event);
    },
  };
}
