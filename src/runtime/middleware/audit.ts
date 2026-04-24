import { NaxError } from "../../errors";
import type { AgentMiddleware, MiddlewareContext } from "../agent-middleware";
import type { IPromptAuditor, PromptAuditEntry, PromptAuditErrorEntry } from "../prompt-auditor";

function extractOutput(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  return ((result as Record<string, unknown>).output as string | undefined) ?? "";
}

export function auditMiddleware(auditor: IPromptAuditor, runId: string): AgentMiddleware {
  return {
    name: "audit",
    async after(ctx: MiddlewareContext, result: unknown, durationMs: number): Promise<void> {
      const prompt =
        ctx.prompt ?? ((ctx.request?.runOptions as Record<string, unknown> | undefined)?.prompt as string | undefined);
      if (!prompt) return;
      const entry: PromptAuditEntry = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        stage: ctx.stage,
        storyId: ctx.storyId,
        permissionProfile: ctx.resolvedPermissions.mode,
        prompt,
        response: extractOutput(result),
        durationMs,
      };
      auditor.record(entry);
    },
    async onError(ctx: MiddlewareContext, err: unknown, durationMs: number): Promise<void> {
      const entry: PromptAuditErrorEntry = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        stage: ctx.stage,
        storyId: ctx.storyId,
        errorCode: err instanceof NaxError ? err.code : "UNKNOWN",
        durationMs,
      };
      auditor.recordError(entry);
    },
  };
}
