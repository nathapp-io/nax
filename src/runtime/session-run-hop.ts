import { buildRunInteractionHandler } from "../agents/acp/adapter";
import { resolveCodingToolSupport } from "../agents/coding-tool-support";
import type { IAgentManager } from "../agents/manager-types";
import { applyDiffAccessForAgentProtocol, promptWithToolPreamble } from "../agents/tool-preamble";
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
    const sessionName =
      options.sessionHandle ??
      sessionManager.nameFor({
        workdir: options.workdir,
        featureName: options.featureName,
        storyId: options.storyId,
        role: options.sessionRole,
        pipelineStage: options.pipelineStage,
      });

    // Resolved per hop, not per run: a swap changes the agent and the grants
    // are stage-scoped, so a runtime captured earlier would outlive its
    // dispatch. Mirrors build-hop-callback.ts — the two must not drift.
    // Resolved BEFORE the substitution so the advertised tool set drives the
    // gate at dispatch time. Without this, native rendering would apply even
    // when the agent was not granted `Git` and `Read`, and the model would
    // be taught a call the policy would then refuse at call-time — the
    // failure mode AC11 guards against.
    //
    // `resolveCodingToolSupport` can throw `NaxError('CODING_TOOL_ROOT_MISSING')`
    // when declared tools + grants exist but `codingToolRoot` is undefined
    // (issue #1794 lesson — refuse rather than silently default to cwd). The
    // hop MUST convert that into a failed AgentResult rather than letting the
    // throw propagate: callers like `runWithFallback` rely on the hop always
    // returning an AgentResult so the swap policy can classify the outcome.
    // A propagated throw also skips the `finally` block's `closeSession` /
    // `auditSink.flush()` — at this point neither has run yet (no session has
    // been opened, no runtime was created), but the seam still matters for
    // future maintainers who might add side-effects before this line.
    let codingSupport: Awaited<ReturnType<typeof resolveCodingToolSupport>>;
    try {
      codingSupport = await resolveCodingToolSupport(options);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return {
        prompt: applyDiffAccessForAgentProtocol(agentName, promptWithToolPreamble(agentName, options), []),
        result: {
          success: false,
          exitCode: 1,
          output: errMessage,
          rateLimited: false,
          durationMs: Date.now() - startMs,
          estimatedCostUsd: 0,
        },
      };
    }
    const advertisedTools = codingSupport ? codingSupport.tools.map((t) => t.name) : [];
    const prompt = applyDiffAccessForAgentProtocol(
      agentName,
      promptWithToolPreamble(agentName, options),
      advertisedTools,
    );

    const transcriptOwner = options.scopeId ?? options.callId;
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
      // nax#1877 — mirrors build-hop-callback.ts; the two must not drift.
      ...(transcriptOwner !== undefined ? { transcriptOwner } : {}),
      signal: options.abortSignal,
      onSessionEstablished: options.onSessionEstablished,
    });

    // nax#1722: a swap re-opens the same session name under the fallback agent, and
    // openSession leaves the descriptor's `agent` at the primary. No-op when unchanged.
    recordAgentHandoff(sessionManager, sessionName, agentName, "agent-swap");

    try {
      const hasContextTools = Boolean(options.contextToolRuntime && (options.contextPullTools?.length ?? 0) > 0);
      // `maxInteractionTurns` is the human Q&A budget (config-descriptions.ts),
      // not an agent round-trip cap. Forwarded unchanged: acpx's iterations ARE
      // interaction turns and it still consumes this as its loop bound, while
      // the native loop no longer reads it for round-trips at all (it is bounded
      // by time) and spends it only on ask_human exchanges.
      const maxInteractions =
        options.interactionBridge || hasContextTools
          ? (options.maxInteractionTurns ?? 10)
          : (options.maxInteractionTurns ?? 1);

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
            maxInteractions,
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
            maxInteractions,
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
      // nax#1840: native's sendTurn throws SessionTurnError (not
      // SessionFailureError) so it can also carry the cost fields, so
      // classification falls back to SessionTurnError.adapterFailure when the
      // error is not a SessionFailureError. Mirrors build-hop-callback.ts.
      const turnError = err instanceof SessionTurnError ? err : undefined;
      const sessionFailure =
        (err instanceof SessionFailureError ? err.adapterFailure : undefined) ?? turnError?.adapterFailure;
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
