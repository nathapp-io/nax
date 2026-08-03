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
import {
  ContextOrchestrator,
  createContextToolRuntime,
  createRunCallCounter,
  createSessionToolBudgets,
} from "../context/engine";
import type { AdapterFailure, ContextBundle, RunCallCounter } from "../context/engine";
import { writeRebuildManifest } from "../context/engine/manifest-store";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder, timeoutRetry as defaultTimeoutRetry } from "../prompts";
import type { TimeoutRetryInput } from "../prompts";
import type { ISessionManager } from "../session";
import { captureGitRef, captureWorkingTreeChanges } from "../utils/git";

export const _buildHopCallbackDeps = {
  rebuildForAgent: (
    prior: ContextBundle,
    newAgentId: string,
    failure: AdapterFailure,
    storyId?: string,
  ): ContextBundle => new ContextOrchestrator([]).rebuildForAgent(prior, { newAgentId, failure, storyId }),
  writeRebuildManifest,
  createContextToolRuntime,
  captureGitRef,
  captureWorkingTreeChanges,
  timeoutRetry: (input: TimeoutRetryInput): string => defaultTimeoutRetry(input),
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
    success: !r.adapterFailure,
    exitCode: r.adapterFailure ? 1 : 0,
    output: r.output,
    rateLimited: false,
    durationMs: 0,
    estimatedCostUsd: r.estimatedCostUsd ?? 0,
    exactCostUsd: r.exactCostUsd,
    tokenUsage: r.tokenUsage,
    protocolIds: r.protocolIds,
    internalRoundTrips: r.internalRoundTrips,
    ...(r.adapterFailure ? { adapterFailure: r.adapterFailure } : {}),
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

  // US-003: closure-scoped memoization of the pre-attempt git ref + start time.
  // Capture is fire-and-forget on the FIRST primary hop (no `await` so the hot
  // path stays synchronous) and awaited only when the subsequent timeout-retry
  // hop needs the result. Best-effort — absence falls through to the generic
  // preamble path inside _buildHopCallbackDeps.timeoutRetry (AC8).
  let preAttemptGitRefPromise: Promise<string | undefined> | undefined;
  // Tracks when the PRECEDING hop started (unlike preAttemptGitRefPromise,
  // which stays pinned to the first primary hop so captureWorkingTreeChanges
  // sees the full cumulative diff). elapsedMs must report the timed-out
  // attempt's own duration, not time spent in any stale-retry hops that
  // happened to precede it (AC5), so it is read before being overwritten with
  // this hop's own start time.
  let priorHopStartedAt: number | undefined;

  // Gap finding 7: pull-tool budgets must be scoped to the SESSION, not the hop.
  // createContextToolRuntime is called inside the closure below (once per hop),
  // so a runtime-local registry reset maxCallsPerSession on every retry /
  // fallback / escalation. Created here, outside the closure, alongside
  // contextToolRunCounter — which until now was declared but never populated by
  // any production caller, so the run-level cap reset per hop too (call.ts).
  const sessionToolBudgets = createSessionToolBudgets();
  // Same defect, different cause, for the RUN-level cap: BuildHopCallbackContext
  // declares contextToolRunCounter but no production site populates it (the
  // hopCtx literal in call.ts omits it), so tool-runtime's
  // createRunCallCounter() fallback minted a fresh counter per hop and
  // pull.maxCallsPerRun never bound. Hoisting the fallback here makes it hold
  // across the hops of one callback. It is NOT yet a true per-run cap — that
  // needs contextToolRunCounter threaded through CallContext, which cannot land
  // in this change because call.ts is at its grandfathered file-size ceiling
  // and the ratchet forbids growing it. Tracked as a follow-up.
  const runCounterForHops = contextToolRunCounter ?? createRunCallCounter();

  return async (
    agentName,
    hopBundle,
    hopKind,
    resolvedRunOptions,
  ): Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }> => {
    const logger = getLogger();
    let workingBundle = hopBundle;
    let prompt: string = resolvedRunOptions.prompt;
    const elapsedSincePriorHop = priorHopStartedAt ? Date.now() - priorHopStartedAt : 0;
    priorHopStartedAt = Date.now();

    // US-003: start pre-attempt git ref capture once on the first primary hop,
    // without awaiting. The promise is awaited later on the timeout-retry hop.
    if (hopKind.kind === "primary" && !preAttemptGitRefPromise) {
      preAttemptGitRefPromise = _buildHopCallbackDeps.captureGitRef(workdir);
    }

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

    // US-003: compose the timeout-retry prompt with the pre-attempt ref + elapsed time.
    // Called exactly once on the timeout-retry hop; absent a captured ref the helper
    // degrades to the generic preamble (AC8) and never throws.
    if (hopKind.kind === "timeout-retry") {
      const preAttemptGitRef = preAttemptGitRefPromise ? await preAttemptGitRefPromise : undefined;
      const changedFiles = preAttemptGitRef
        ? await _buildHopCallbackDeps.captureWorkingTreeChanges(workdir, preAttemptGitRef)
        : [];
      const elapsedMs = elapsedSincePriorHop;
      prompt = _buildHopCallbackDeps.timeoutRetry({
        prompt: resolvedRunOptions.prompt,
        changedFiles,
        elapsedMs,
        attempt: hopKind.attempt,
      });
    }

    const contextToolRuntime = workingBundle
      ? _buildHopCallbackDeps.createContextToolRuntime({
          bundle: workingBundle,
          story,
          config,
          // `workdir` here is ALREADY join(projectDir, story.workdir) — set from
          // ctx.packageDir in call.ts, which iteration-runner joined. Passing it
          // as repoRoot made `repoRoot` a lie inside the runtime; pass the real
          // root and the package dir separately instead. Never re-join
          // story.workdir onto workdir (pipeline/types.ts:88-93).
          repoRoot: projectDir ?? workdir,
          packageDir: workdir,
          runCounter: runCounterForHops,
          sessionBudgets: sessionToolBudgets,
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
          // Only report a tier when one actually selected the model. A caller-pinned
          // modelDef bypassed tier resolution, and `effectiveTier` is defaulted, so
          // forwarding it there would record a tier that never applied (#1433).
          ...(resolvedRunOptions.modelDef !== undefined ? {} : { modelTier: effectiveTier }),
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
      const pinned = hopKind.kind === "primary" && resolvedRunOptions.modelDef !== undefined;
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
        // See the pin rationale above — a pinned modelDef has no meaningful tier.
        ...(pinned ? {} : { modelTier: effectiveTier }),
        timeoutSeconds:
          resolvedRunOptions.timeoutSeconds ??
          config.execution?.sessionTimeoutSeconds ??
          DEFAULT_CONFIG.execution.sessionTimeoutSeconds,
        featureName,
        storyId: story.id,
        signal: resolvedRunOptions.abortSignal,
      });
    }

    let timedOut = false;

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
      // Capture timedOut from the TurnResult so the finally block can force-close
      // the session when keepOpen is true. classifyEmptyOutputFailure (called by
      // sendWithFileOutput → hopBody) synthesises a fail-timeout adapterFailure for
      // timedOut turns but the hop returns normally — the catch block never executes.
      if (turnResult.timedOut) timedOut = true;
      return { result: turnResultToAgentResult(turnResult), bundle: workingBundle, prompt };
    } catch (err) {
      // Preserve typed adapter failure on SessionFailureError so runWithFallback's
      // swap policy sees the real outcome (rate-limit, auth, quota) instead of
      // a generic "fail-adapter-error" reclassification. Mirrors session-run-hop.ts.
      const sessionFailure = err instanceof SessionFailureError ? err.adapterFailure : undefined;
      timedOut = sessionFailure?.outcome === "fail-timeout";
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
      // Timeout overrides keepOpen: a wall-clock-timed-out session is dead —
      // leaving it cached would hand the retry a non-functional handle.
      if (hopKind.kind !== "stale-retry" && (!resolvedRunOptions.keepOpen || timedOut)) {
        await sessionManager.closeSession(handle);
      }
    }
  };
}
