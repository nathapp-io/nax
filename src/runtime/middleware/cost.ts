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
    cacheRead: tu.cacheReadInputTokens,
    cacheWrite: tu.cacheCreationInputTokens,
  };
}

function extractCosts(result: unknown): { estimatedCostUsd: number; exactCostUsd?: number } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const hasEstimatedCost = "estimatedCostUsd" in r;
  const hasCost = "costUsd" in r;
  const estimatedCostUsd = (r.estimatedCostUsd as number | undefined) ?? (r.costUsd as number | undefined) ?? 0;
  const exactCostUsd = r.exactCostUsd as number | undefined;
  if (!hasEstimatedCost && !hasCost && exactCostUsd == null) return null;
  return { estimatedCostUsd, exactCostUsd };
}

export function costMiddleware(aggregator: ICostAggregator, runId: string): AgentMiddleware {
  return {
    name: "cost",
    async after(ctx: MiddlewareContext, result: unknown, durationMs: number): Promise<void> {
      if (ctx.kind === "run" && ctx.sessionHandle === undefined && ctx.request?.executeHop) return;

      const tokens = extractTokens(result);
      const costs = extractCosts(result);
      if (!tokens && !costs) return;

      const estimatedCostUsd = costs?.estimatedCostUsd ?? 0;
      const exactCostUsd = costs?.exactCostUsd;
      const costUsd = exactCostUsd ?? estimatedCostUsd;
      const confidence: "exact" | "estimated" = exactCostUsd != null ? "exact" : "estimated";

      const event: CostEvent = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        model: ((result as Record<string, unknown>).model as string | undefined) ?? "unknown",
        stage: ctx.stage,
        storyId: ctx.storyId,
        tokens: tokens ?? { input: 0, output: 0 },
        estimatedCostUsd,
        exactCostUsd,
        costUsd,
        confidence,
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
