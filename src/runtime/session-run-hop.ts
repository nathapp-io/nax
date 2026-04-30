import { buildContextToolPreamble, buildRunInteractionHandler } from "../agents/acp/adapter";
import { SessionFailureError } from "../agents/types";
import type { AgentResult, AgentRunOptions } from "../agents/types";
import type { ISessionManager } from "../session";

export interface SessionRunHopResult {
  result: AgentResult;
  prompt: string;
}

export type SessionRunHopFn = (agentName: string, options: AgentRunOptions) => Promise<SessionRunHopResult>;

export function createSessionRunHop(sessionManager: ISessionManager): SessionRunHopFn {
  return async (agentName: string, options: AgentRunOptions): Promise<SessionRunHopResult> => {
    const startMs = Date.now();
    const prompt = buildContextToolPreamble(options);
    const sessionName =
      options.sessionHandle ??
      sessionManager.nameFor({
        workdir: options.workdir,
        featureName: options.featureName,
        storyId: options.storyId,
        role: options.sessionRole,
        pipelineStage: options.pipelineStage,
      });

    const handle = await sessionManager.openSession(sessionName, {
      agentName,
      role: options.sessionRole,
      workdir: options.workdir,
      pipelineStage: options.pipelineStage ?? "run",
      modelDef: options.modelDef,
      timeoutSeconds: options.timeoutSeconds,
      featureName: options.featureName,
      storyId: options.storyId,
      signal: options.abortSignal,
      onSessionEstablished: options.onSessionEstablished,
    });

    try {
      const hasContextTools = Boolean(options.contextToolRuntime && (options.contextPullTools?.length ?? 0) > 0);
      const maxTurns =
        options.interactionBridge || hasContextTools
          ? (options.maxInteractionTurns ?? 10)
          : (options.maxInteractionTurns ?? 1);

      const turnResult = await sessionManager.sendPrompt(handle, prompt, {
        interactionHandler: buildRunInteractionHandler(options),
        signal: options.abortSignal,
        maxTurns,
      });

      return {
        prompt,
        result: {
          success: true,
          exitCode: 0,
          output: turnResult.output,
          rateLimited: false,
          durationMs: Date.now() - startMs,
          estimatedCostUsd: turnResult.estimatedCostUsd ?? 0,
          exactCostUsd: turnResult.exactCostUsd,
          tokenUsage: turnResult.tokenUsage,
        },
      };
    } catch (err) {
      const sessionFailure = err instanceof SessionFailureError ? err.adapterFailure : undefined;
      return {
        prompt,
        result: {
          success: false,
          exitCode: 1,
          output: err instanceof Error ? err.message : String(err),
          rateLimited: sessionFailure?.outcome === "fail-rate-limit",
          durationMs: Date.now() - startMs,
          estimatedCostUsd: 0,
          adapterFailure: sessionFailure ?? {
            category: "quality",
            outcome: "fail-unknown",
            retriable: false,
            message: String(err).slice(0, 500),
          },
        },
      };
    } finally {
      if (!options.keepOpen) {
        await sessionManager.closeSession(handle);
      }
    }
  };
}
