import { NaxError } from "../../errors";
import type { AgentMiddleware, MiddlewareContext } from "../agent-middleware";

export function cancellationMiddleware(): AgentMiddleware {
  return {
    name: "cancellation",
    async before(ctx: MiddlewareContext): Promise<void> {
      if (ctx.signal?.aborted) {
        throw new NaxError("Agent call cancelled before start", "AGENT_CANCELLED", {
          stage: ctx.stage ?? "run",
          agentName: ctx.agentName,
        });
      }
    },
  };
}
