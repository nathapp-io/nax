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
      const runOpts = ctx.request?.runOptions as Record<string, unknown> | undefined;
      const prompt = ctx.prompt ?? (runOpts?.prompt as string | undefined);
      if (!prompt) return;

      // Extract ACP session correlation from AgentResult if present.
      const agentResult = result as Record<string, unknown> | null | undefined;
      const protocolIds = agentResult?.protocolIds as
        | { recordId?: string | null; sessionId?: string | null }
        | undefined;
      const sessionMeta = agentResult?.sessionMetadata as
        | { sessionName?: string; turn?: number; resumed?: boolean }
        | undefined;

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
        callType: ctx.kind,
        workdir: runOpts?.workdir as string | undefined,
        projectDir: runOpts?.projectDir as string | undefined,
        featureName: runOpts?.featureName as string | undefined,
        ...(sessionMeta?.sessionName !== undefined && { sessionName: sessionMeta.sessionName }),
        ...(protocolIds?.recordId !== undefined && { recordId: protocolIds.recordId }),
        ...(protocolIds?.sessionId !== undefined && { sessionId: protocolIds.sessionId }),
        ...(sessionMeta?.turn !== undefined && { turn: sessionMeta.turn }),
        ...(sessionMeta?.resumed !== undefined && { resumed: sessionMeta.resumed }),
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
