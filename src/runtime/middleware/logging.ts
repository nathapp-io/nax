import { getSafeLogger } from "../../logger";
import type { AgentMiddleware, MiddlewareContext } from "../agent-middleware";

export function loggingMiddleware(): AgentMiddleware {
  return {
    name: "logging",
    async before(ctx: MiddlewareContext): Promise<void> {
      getSafeLogger()?.info("middleware", "Agent call start", {
        storyId: ctx.storyId,
        runId: ctx.runId,
        agentName: ctx.agentName,
        kind: ctx.kind,
        stage: ctx.stage,
      });
    },
    async after(ctx: MiddlewareContext, _result: unknown, durationMs: number): Promise<void> {
      getSafeLogger()?.info("middleware", "Agent call complete", {
        storyId: ctx.storyId,
        runId: ctx.runId,
        agentName: ctx.agentName,
        kind: ctx.kind,
        stage: ctx.stage,
        durationMs,
      });
    },
    async onError(ctx: MiddlewareContext, err: unknown, durationMs: number): Promise<void> {
      getSafeLogger()?.warn("middleware", "Agent call failed", {
        storyId: ctx.storyId,
        runId: ctx.runId,
        agentName: ctx.agentName,
        kind: ctx.kind,
        stage: ctx.stage,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };
}
