import type { AgentResult } from "../../agents/types";
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
      const runOpts = ctx.request?.runOptions;
      const prompt = ctx.prompt ?? runOpts?.prompt;
      if (!prompt) return;

      const agentResult = (result ?? {}) as Partial<AgentResult>;
      const { protocolIds, sessionMetadata } = agentResult;

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
        workdir: runOpts?.workdir,
        projectDir: runOpts?.projectDir,
        featureName: runOpts?.featureName,
        ...(sessionMetadata?.sessionName !== undefined && { sessionName: sessionMetadata.sessionName }),
        ...(protocolIds?.recordId !== undefined && { recordId: protocolIds.recordId }),
        ...(protocolIds?.sessionId !== undefined && { sessionId: protocolIds.sessionId }),
        ...(sessionMetadata?.turn !== undefined && { turn: sessionMetadata.turn }),
        ...(sessionMetadata?.resumed !== undefined && { resumed: sessionMetadata.resumed }),
      };
      auditor.record(entry);
    },
    async onError(ctx: MiddlewareContext, err: unknown, durationMs: number): Promise<void> {
      const runOpts = ctx.request?.runOptions;
      const prompt = ctx.prompt ?? runOpts?.prompt;
      const errorMessage = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
      const entry: PromptAuditErrorEntry = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        stage: ctx.stage,
        storyId: ctx.storyId,
        errorCode: err instanceof NaxError ? err.code : "UNKNOWN",
        durationMs,
        callType: ctx.kind,
        permissionProfile: ctx.resolvedPermissions.mode,
        ...(errorMessage !== undefined && { errorMessage }),
        ...(prompt !== undefined && { prompt }),
        ...(runOpts?.workdir !== undefined && { workdir: runOpts.workdir }),
        ...(runOpts?.projectDir !== undefined && { projectDir: runOpts.projectDir }),
        ...(runOpts?.featureName !== undefined && { featureName: runOpts.featureName }),
      };
      auditor.recordError(entry);
    },
  };
}
