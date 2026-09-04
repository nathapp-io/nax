import { buildRunInteractionHandler } from "../agents/acp/adapter";
import { resolveCodingToolSupport } from "../agents/coding-tool-support";
import type { IAgentManager } from "../agents/manager-types";
import { promptWithToolPreamble } from "../agents/tool-preamble";
import type { AgentResult, AgentRunOptions } from "../agents/types";
import { SessionFailureError, SessionTurnError } from "../agents/types";
import { getSafeLogger } from "../logger";
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
      signal: options.abortSignal,
      onSessionEstablished: options.onSessionEstablished,
    });

    // nax#1722: a swap re-opens the same session name under the fallback agent, and
    // openSession leaves the descriptor's `agent` at the primary. No-op when unchanged.
    recordAgentHandoff(sessionManager, sessionName, agentName, "agent-swap");

    // Resolved per hop, not per run: a swap changes the agent and the grants
    // are stage-scoped, so a runtime captured earlier would outlive its
    // dispatch. Mirrors build-hop-callback.ts — the two must not drift.
    // Declared above the try so the finally block can flush the audit sink.
    let codingSupport: ReturnType<typeof resolveCodingToolSupport>;

    try {
      const hasContextTools = Boolean(options.contextToolRuntime && (options.contextPullTools?.length ?? 0) > 0);
      // `maxInteractionTurns` is the human Q&A budget (config-descriptions.ts),
      // not an agent round-trip cap. Forwarded unchanged: acpx's iterations ARE
      // interaction turns and it still consumes this as its loop bound, while
      // the native loop no longer reads it for round-trips at all (it is bounded
      // by time) and spends it only on ask_human exchanges.
      const maxTurns =
        options.interactionBridge || hasContextTools
          ? (options.maxInteractionTurns ?? 10)
          : (options.maxInteractionTurns ?? 1);

      codingSupport = resolveCodingToolSupport(options);
      const interactionHandler = buildRunInteractionHandler({
        ...options,
        ...(codingSupport ? { codingToolRuntime: codingSupport.runtime } : {}),
      });
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
            codingTools: codingSupport?.tools,
          })
        : await sessionManager.sendPrompt(handle, prompt, {
            interactionHandler,
            signal: options.abortSignal,
            maxTurns,
            contextPullTools: options.contextPullTools,
            codingTools: codingSupport?.tools,
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
      // Best-effort ledger write (mirrors review-audit doctrine): a flush
      // failure logs a warning and never replaces the hop's return value.
      try {
        await codingSupport?.auditSink.flush();
      } catch (flushErr) {
        getSafeLogger()?.warn("tools", "coding-tool audit flush failed", {
          storyId: options.storyId,
          error: flushErr instanceof Error ? flushErr.message : String(flushErr),
        });
      }
      if (!options.keepOpen) {
        await sessionManager.closeSession(handle);
      }
    }
  };
}
