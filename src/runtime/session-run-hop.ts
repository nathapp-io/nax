import { buildRunInteractionHandler } from "../agents/acp/adapter";
import type { IAgentManager } from "../agents/manager-types";
import { promptWithToolPreamble } from "../agents/tool-preamble";
import type { AgentResult, AgentRunOptions } from "../agents/types";
import { SessionFailureError, SessionTurnError } from "../agents/types";
import type { ISessionManager } from "../session";
import { recordAgentHandoff } from "../session";

export interface SessionRunHopResult {
  result: AgentResult;
  prompt: string;
}

export type SessionRunHopFn = (agentName: string, options: AgentRunOptions) => Promise<SessionRunHopResult>;

export function createSessionRunHop(
  sessionManager: ISessionManager,
  getAgentManager?: () => IAgentManager | undefined,
): SessionRunHopFn {
  return async (agentName: string, options: AgentRunOptions): Promise<SessionRunHopResult> => {
    const startMs = Date.now();
    const prompt = promptWithToolPreamble(agentName, options);
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
      // SEC-3: thread per-package config so monorepo permissionProfile is honored.
      config: options.config,
      modelDef: options.modelDef,
      timeoutSeconds: options.timeoutSeconds,
      featureName: options.featureName,
      storyId: options.storyId,
      projectDir: options.projectDir,
      signal: options.abortSignal,
      onSessionEstablished: options.onSessionEstablished,
    });

    // nax#1722: a swap re-opens the same session name under the fallback agent, and
    // openSession leaves the descriptor's `agent` at the primary. No-op when unchanged.
    recordAgentHandoff(sessionManager, sessionName, agentName, "agent-swap");

    try {
      const hasContextTools = Boolean(options.contextToolRuntime && (options.contextPullTools?.length ?? 0) > 0);
      const maxTurns =
        options.interactionBridge || hasContextTools
          ? (options.maxInteractionTurns ?? 10)
          : (options.maxInteractionTurns ?? 1);

      const interactionHandler = buildRunInteractionHandler(options);
      const am = getAgentManager?.();
      // Route through agentManager.runAsSession when available so dispatch
      // events are emitted and captured by the prompt auditor. Falls back to
      // sessionManager.sendPrompt for callers without an agentManager (tests).
      const turnResult = am
        ? await am.runAsSession(agentName, handle, prompt, {
            storyId: options.storyId,
            featureName: options.featureName,
            workdir: options.workdir,
            projectDir: options.projectDir,
            pipelineStage: options.pipelineStage ?? "run",
            // SEC-3: thread per-package config so monorepo permissionProfile is honored.
            config: options.config,
            sessionRole: options.sessionRole,
            signal: options.abortSignal,
            interactionHandler,
            maxTurns,
            // Finding 3 (whole-branch review): this hop only routes the three
            // Phase B target ops today (which go through build-hop-callback.ts
            // instead), but a future op on the default hop needs its pull-tool
            // catalogue forwarded here too, or it silently gets none.
            contextPullTools: options.contextPullTools,
          })
        : await sessionManager.sendPrompt(handle, prompt, {
            interactionHandler,
            signal: options.abortSignal,
            maxTurns,
            contextPullTools: options.contextPullTools,
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
          protocolIds: handle.protocolIds,
          internalRoundTrips: turnResult.internalRoundTrips,
        },
      };
    } catch (err) {
      const sessionFailure = err instanceof SessionFailureError ? err.adapterFailure : undefined;
      const turnError = err instanceof SessionTurnError ? err : undefined;
      const errMessage = err instanceof Error ? err.message : String(err);
      return {
        prompt,
        result: {
          success: false,
          exitCode: 1,
          output: errMessage,
          rateLimited: sessionFailure?.outcome === "fail-rate-limit",
          durationMs: Date.now() - startMs,
          // BUG-57: mirror build-hop-callback.ts — a SessionTurnError (e.g.
          // mid-flight cancel) can carry real tokens already burned before the
          // failure; read them instead of hardcoding zero.
          estimatedCostUsd: turnError?.estimatedCostUsd ?? 0,
          exactCostUsd: turnError?.exactCostUsd,
          tokenUsage: turnError?.tokenUsage,
          adapterFailure: sessionFailure ?? {
            category: "availability",
            outcome: "fail-adapter-error",
            retriable: turnError?.retryable ?? false,
            message: errMessage.slice(0, 500),
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
