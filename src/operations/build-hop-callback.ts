/**
 * buildHopCallback — per-hop bundle-rebuild + session-dispatch factory (Phase C).
 *
 * Returned closure matches AgentRunRequest["executeHop"] and is passed
 * directly to runWithFallback.
 */

import { buildRunInteractionHandler } from "../agents/acp/adapter-output";
import type { AgentRunRequest, IAgentManager } from "../agents/manager-types";
import { SessionFailureError, SessionTurnError } from "../agents/types";
import type { AgentResult, AgentRunOptions, TurnResult } from "../agents/types";
import { DEFAULT_CONFIG, resolveModelForAgent } from "../config";
import type { NaxConfig } from "../config";
import { ContextOrchestrator, createContextToolRuntime } from "../context/engine";
import type { AdapterFailure, ContextBundle, RunCallCounter } from "../context/engine";
import { writeRebuildManifest } from "../context/engine/manifest-store";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ISessionManager } from "../session";

export const _buildHopCallbackDeps = {
  rebuildForAgent: (
    prior: ContextBundle,
    newAgentId: string,
    failure: AdapterFailure,
    storyId?: string,
  ): ContextBundle => new ContextOrchestrator([]).rebuildForAgent(prior, { newAgentId, failure, storyId }),
  writeRebuildManifest,
  createContextToolRuntime,
};

export interface BuildHopCallbackContext {
  sessionManager: ISessionManager;
  agentManager: IAgentManager;
  story: UserStory;
  config: NaxConfig;
  projectDir?: string;
  featureName: string;
  workdir: string;
  effectiveTier: Parameters<typeof resolveModelForAgent>[2];
  defaultAgent: string;
  contextToolRunCounter?: RunCallCounter;
  pipelineStage?: import("../config/permissions").PipelineStage;
  /**
   * Optional interaction bridge for mid-session human Q&A. Forwarded to
   * `buildRunInteractionHandler` so the agent can ask questions during a hop.
   */
  interactionBridge?: {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  };
  /** Max interaction round-trips when interactionBridge is active (default: 10). */
  maxInteractionTurns?: number;
  /**
   * Optional intra-hop multi-prompt body. When set, the callback invokes
   * `hopBody(initialPrompt, { send })` instead of issuing a single
   * `runAsSession` call. The `send` closure dispatches one turn against the
   * current handle. Used by review ops for same-session JSON-parse retry.
   */
  hopBody?: <I = unknown>(
    initialPrompt: string,
    bodyCtx: { send: (prompt: string) => Promise<TurnResult>; input: I },
  ) => Promise<TurnResult>;
  /** Input value forwarded to `hopBody` via its `ctx.input`. */
  hopBodyInput?: unknown;
}

function turnResultToAgentResult(r: TurnResult): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: r.output,
    rateLimited: false,
    durationMs: 0,
    estimatedCostUsd: r.estimatedCostUsd ?? 0,
    exactCostUsd: r.exactCostUsd,
    tokenUsage: r.tokenUsage,
    protocolIds: r.protocolIds,
    internalRoundTrips: r.internalRoundTrips,
  };
}

export function buildHopCallback(
  ctx: BuildHopCallbackContext,
  sessionId: string | undefined,
  _initialOptions: AgentRunOptions,
): NonNullable<AgentRunRequest["executeHop"]> {
  const {
    sessionManager,
    agentManager,
    story,
    config,
    projectDir,
    featureName,
    workdir,
    effectiveTier,
    defaultAgent,
    contextToolRunCounter,
    pipelineStage,
    interactionBridge,
    maxInteractionTurns,
    hopBody,
    hopBodyInput,
  } = ctx;

  const stage = pipelineStage ?? "run";

  return async (
    agentName,
    hopBundle,
    hopKind,
    resolvedRunOptions,
  ): Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }> => {
    const logger = getLogger();
    let workingBundle = hopBundle;
    let prompt: string = resolvedRunOptions.prompt;

    // SWAP only: rebuild bundle for the new agent, rewrite the prompt, and record the handoff.
    // Stale-retry reuses the same agent and session — no rebuild, no prompt rewrite.
    if (hopKind.kind === "swap" && hopBundle) {
      workingBundle = _buildHopCallbackDeps.rebuildForAgent(hopBundle, agentName, hopKind.failure, story.id);
      if (projectDir && featureName && workingBundle.manifest.rebuildInfo) {
        try {
          await _buildHopCallbackDeps.writeRebuildManifest(projectDir, featureName, story.id, {
            requestId: workingBundle.manifest.requestId,
            stage: "execution",
            priorAgentId: workingBundle.manifest.rebuildInfo.priorAgentId,
            newAgentId: workingBundle.manifest.rebuildInfo.newAgentId,
            failureCategory: workingBundle.manifest.rebuildInfo.failureCategory,
            failureOutcome: workingBundle.manifest.rebuildInfo.failureOutcome,
            priorChunkIds: workingBundle.manifest.rebuildInfo.priorChunkIds,
            newChunkIds: workingBundle.manifest.rebuildInfo.newChunkIds,
            chunkIdMap: workingBundle.manifest.rebuildInfo.chunkIdMap,
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          logger.warn("execution", "Failed to write rebuild manifest", {
            storyId: story.id,
            error: String(err),
          });
        }
      }
      prompt = RectifierPromptBuilder.swapHandoff(resolvedRunOptions.prompt, workingBundle.pushMarkdown);
    }
    // Record descriptor handoff for any swap, regardless of whether a bundle was rebuilt.
    if (hopKind.kind === "swap" && sessionId) {
      sessionManager.handoff?.(sessionId, agentName, hopKind.failure.outcome);
    }

    const contextToolRuntime = workingBundle
      ? _buildHopCallbackDeps.createContextToolRuntime({
          bundle: workingBundle,
          story,
          config,
          repoRoot: workdir,
          runCounter: contextToolRunCounter,
        })
      : undefined;
    const contextPullTools = workingBundle?.pullTools;

    const interactionHandler = interactionBridge
      ? buildRunInteractionHandler({
          contextToolRuntime,
          contextPullTools,
          interactionBridge,
        } as unknown as AgentRunOptions)
      : undefined;

    const sessionName = sessionManager.nameFor({
      workdir,
      featureName,
      storyId: story.id,
      role: resolvedRunOptions.sessionRole ?? "implementer",
      pipelineStage: stage,
    });

    // STALE-RETRY: reuse the existing live handle — no openSession, no acpx reconnect.
    // PRIMARY / SWAP: open (or resume) the session via the normal path.
    let handle: import("../agents/types").SessionHandle;
    if (hopKind.kind === "stale-retry") {
      const cached = sessionManager.getLiveHandle(sessionName);
      if (cached && cached.agentName === agentName) {
        handle = cached;
      } else {
        // Defensive: cache miss should never happen in practice (the handle was just
        // used by the prior attempt), but fall back to openSession so the retry
        // can still proceed. Logged at warn to detect unexpected misses in production.
        logger.warn("execution", "Stale-retry: live handle missing, re-opening session", {
          storyId: story.id,
          sessionName,
          attempt: hopKind.attempt,
        });
        const modelDef =
          resolvedRunOptions.modelDef ?? resolveModelForAgent(config.models, agentName, effectiveTier, defaultAgent);
        handle = await sessionManager.openSession(sessionName, {
          agentName,
          role: resolvedRunOptions.sessionRole ?? "implementer",
          workdir,
          pipelineStage: stage,
          modelDef,
          timeoutSeconds:
            resolvedRunOptions.timeoutSeconds ??
            config.execution?.sessionTimeoutSeconds ??
            DEFAULT_CONFIG.execution.sessionTimeoutSeconds,
          featureName,
          storyId: story.id,
          signal: resolvedRunOptions.abortSignal,
        });
      }
    } else {
      const modelDef =
        hopKind.kind === "primary"
          ? (resolvedRunOptions.modelDef ?? resolveModelForAgent(config.models, agentName, effectiveTier, defaultAgent))
          : resolveModelForAgent(config.models, agentName, effectiveTier, defaultAgent);
      // openSession errors propagate naturally — no handle, no closeSession needed
      handle = await sessionManager.openSession(sessionName, {
        agentName,
        role: resolvedRunOptions.sessionRole ?? "implementer",
        workdir,
        pipelineStage: stage,
        modelDef,
        timeoutSeconds:
          resolvedRunOptions.timeoutSeconds ??
          config.execution?.sessionTimeoutSeconds ??
          DEFAULT_CONFIG.execution.sessionTimeoutSeconds,
        featureName,
        storyId: story.id,
        signal: resolvedRunOptions.abortSignal,
      });
    }

    try {
      // Bound `send` closure: each call dispatches one turn through AgentManager
      // (so middleware fires) against the current hop's handle. Reused by both
      // the default single-prompt path and any caller-supplied hopBody.
      const send = (turnPrompt: string): Promise<TurnResult> =>
        agentManager.runAsSession(agentName, handle, turnPrompt, {
          storyId: story.id,
          featureName,
          workdir,
          projectDir,
          pipelineStage: stage,
          sessionRole: resolvedRunOptions.sessionRole,
          signal: resolvedRunOptions.abortSignal,
          contextPullTools,
          contextToolRuntime,
          ...(resolvedRunOptions.callId !== undefined ? { callId: resolvedRunOptions.callId } : {}),
          ...(resolvedRunOptions.scopeId !== undefined ? { scopeId: resolvedRunOptions.scopeId } : {}),
          ...(interactionHandler ? { interactionHandler } : {}),
          ...(maxInteractionTurns !== undefined ? { maxTurns: maxInteractionTurns } : {}),
        });

      const turnResult = hopBody ? await hopBody(prompt, { send, input: hopBodyInput }) : await send(prompt);
      return { result: turnResultToAgentResult(turnResult), bundle: workingBundle, prompt };
    } catch (err) {
      // Preserve typed adapter failure on SessionFailureError so runWithFallback's
      // swap policy sees the real outcome (rate-limit, auth, quota) instead of
      // a generic "fail-adapter-error" reclassification. Mirrors session-run-hop.ts.
      const sessionFailure = err instanceof SessionFailureError ? err.adapterFailure : undefined;
      const turnError = err instanceof SessionTurnError ? err : undefined;
      const errMessage = err instanceof Error ? err.message : String(err);
      return {
        result: {
          success: false,
          exitCode: 1,
          // Always prefix with agent name so downstream logs can attribute the
          // failure even when the underlying error message doesn't carry it
          // (e.g. bare `new Error("timeout")`).
          output: `Agent "${agentName}" failed: ${errMessage}`,
          rateLimited: sessionFailure?.outcome === "fail-rate-limit",
          durationMs: 0,
          estimatedCostUsd: 0,
          adapterFailure: sessionFailure ?? {
            category: "availability",
            outcome: "fail-adapter-error",
            retriable: turnError?.retryable ?? false,
            message: errMessage.slice(0, 500),
          },
        },
        bundle: workingBundle,
        prompt,
      };
    } finally {
      // STALE-RETRY: keep the handle open for the next attempt. The session stays
      // cached in _liveHandles; the subsequent hop (success, swap, or exhaustion)
      // either closes it in its own finally or SessionManager teardown handles it.
      // keepOpen: callers that need session continuity across pipeline stages (e.g.
      // execution.ts with review/rectification enabled, or warm-lifetime callOp ops
      // like implementerRectifyOp) set this flag so downstream stages can reuse the
      // same ACP session via sessionManager.getLiveHandle().
      if (hopKind.kind !== "stale-retry" && !resolvedRunOptions.keepOpen) {
        await sessionManager.closeSession(handle);
      }
    }
  };
}
