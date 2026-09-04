/**
 * buildHopCallback — per-hop bundle-rebuild + session-dispatch factory (Phase C).
 *
 * Returned closure matches AgentRunRequest["executeHop"] and is passed
 * directly to runWithFallback.
 */

import { buildRunInteractionHandler } from "../agents/acp/adapter-output";
import { resolveCodingToolSupport } from "../agents/coding-tool-support";
import type { AgentRunRequest, HopKind, IAgentManager } from "../agents/manager-types";
import { applyDiffAccessForAgent, promptWithToolPreamble } from "../agents/tool-preamble";
import type { AgentResult, AgentRunOptions, TurnResult } from "../agents/types";
import { SessionFailureError, SessionTurnError } from "../agents/types";
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG, resolveModelForAgent } from "../config";
import type { AdapterFailure, ContextBundle, RunCallCounter } from "../context/engine";
import {
  ContextOrchestrator,
  createContextToolRuntime,
  createRunCallCounter,
  createSessionToolBudgets,
} from "../context/engine";
import { writeRebuildManifest } from "../context/engine/manifest-store";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import type { TimeoutRetryInput } from "../prompts";
import { timeoutRetry as defaultTimeoutRetry, RectifierPromptBuilder } from "../prompts";
import type { ISessionManager } from "../session";
import { recordAgentHandoff } from "../session";
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
  /**
   * The agent `runOptions.modelDef` was resolved for — `dispatchAgent` in callOp, which
   * may differ from `ctx.agentName` when `op.model` pins an `{ agent, model }` pair.
   *
   * nax#1722: a hop can now run on a DIFFERENT agent than the options were resolved for
   * (`resolveStartAgent` starts an operation on a fallback when the primary is already
   * unavailable). A pinned modelDef belongs to this agent alone; carried onto another it
   * produces `acpx --model haiku ... codex`, which the ACP agent rejects outright
   * ("did not advertise that model"). Absent = trust the pin, the pre-#1722 behaviour.
   */
  pinnedModelAgent?: string;
  contextToolRunCounter?: RunCallCounter;
  pipelineStage?: import("../config/permissions").PipelineStage;
  /**
   * Story scratch directories (US-005). Threaded from the stage-assembly
   * path (PipelineContext.storyScratchDirs) so the pull-tool runtime's
   * query_scratch handler reads the same set of session data as the push
   * providers (SessionScratchProvider / ToolDiagnosticsProvider). Absent /
   * empty disables the scratch handler (it returns a no-entries message on
   * its own — never throws).
   */
  storyScratchDirs?: string[];
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

/**
 * The tier a hop should resolve its model at.
 *
 * Only a swap, or a start-on-fallback that named one, can carry a tier.
 * Everything else is the caller's effective tier, which is what every hop did
 * before tier-aware targets existed.
 */
export function hopTier(hopKind: HopKind, effectiveTier: string): string {
  return "tier" in hopKind ? (hopKind.tier ?? effectiveTier) : effectiveTier;
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
    pinnedModelAgent,
    contextToolRunCounter,
    storyScratchDirs,
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
  // The counter is now threaded from the context stage through CallContext and
  // hopCtx (call.ts), so a real one arrives here. The fallback covers callers
  // that construct a hop context directly — tests, and any op invoked outside
  // the pipeline. Hoisted out of the closure either way so it survives hops.
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
          repoRoot: workdir,
          runCounter: runCounterForHops,
          sessionBudgets: sessionToolBudgets,
          // US-005: thread the requesting agent so query_scratch neutralizes
          // tool references for the actual reader (AC10), not story.id.
          agentId: agentName,
          // US-005: thread the story scratch dirs the stage-assembly path
          // resolved, so query_scratch reads the same data the push
          // providers (SessionScratchProvider / ToolDiagnosticsProvider) read.
          ...(storyScratchDirs?.length ? { storyScratchDirs } : {}),
        })
      : undefined;
    const contextPullTools = workingBundle?.pullTools;
    // nax#1744: the run() path dispatches through this callback as
    // AgentManager's `executeHop`, and runWithFallback invokes `executeHop`
    // INSTEAD OF `_runHop` — so createSessionRunHop (runtime/session-run-hop.ts)
    // is bypassed here, and it was the only place that told the agent the pull
    // tools exist. #1737/#1741/#1742 assembled the bundle, the descriptors and
    // the runtime correctly, but nothing advertised them: no agent could emit a
    // <nax_tool_call>, so every pull tool was unreachable outside unit tests.
    // The three lines that made it reachable are the preamble below, the
    // handler that answers the call, and the turn budget in `send`.
    const hasContextTools = Boolean(contextToolRuntime && (contextPullTools?.length ?? 0) > 0);
    if (hasContextTools) {
      // AFTER the swap-handoff / timeout-retry rewrites above, both of which
      // replace the prompt wholesale — a preamble applied before either would
      // be discarded, leaving that hop's agent with tools it was never told
      // about. Safe against compounding across hops: `prompt` is re-seeded from
      // resolvedRunOptions.prompt on every hop, and the `finalPrompt` the hop
      // returns is audit-only (manager.ts) — it never feeds a later hop's
      // runOptions.
      prompt = promptWithToolPreamble(agentName, {
        ...resolvedRunOptions,
        prompt,
        contextPullTools,
        contextToolRuntime,
      });
    }

    // Unconditional, unlike the preamble above: a review prompt carries a
    // diff-access region whether or not the op also has context pull tools, and
    // ACP needs the markers stripped even though it keeps the body. Placed after
    // the preamble for the same reason the preamble is placed after the swap
    // rewrites — those replace the prompt wholesale, and a region rendered
    // before one would be discarded.
    prompt = applyDiffAccessForAgent(agentName, prompt);

    // Coding tools are resolved per hop rather than per run: a swap changes the
    // agent, and the grants are stage-scoped, so a runtime captured once above
    // would outlive the dispatch it was resolved for.
    const codingSupport = resolveCodingToolSupport(resolvedRunOptions);

    // A bridge is no longer required: without a handler, sendPrompt falls back
    // to NO_OP_INTERACTION_HANDLER and a well-formed tool call goes unanswered.
    // Coding tools join that predicate for the same reason — a review op
    // declares tools but carries no bridge and often no context bundle, so
    // gating on those two alone left it with a handler-less session.
    const interactionHandler =
      interactionBridge || hasContextTools || codingSupport
        ? buildRunInteractionHandler({
            ...resolvedRunOptions,
            contextToolRuntime,
            contextPullTools,
            ...(codingSupport ? { codingToolRuntime: codingSupport.runtime } : {}),
            ...(interactionBridge ? { interactionBridge } : {}),
          })
        : undefined;

    const sessionName = sessionManager.nameFor({
      workdir,
      featureName,
      storyId: story.id,
      role: resolvedRunOptions.sessionRole ?? "implementer",
      pipelineStage: stage,
    });

    // The caller's pinned model is usable only on the agent it was resolved for; any
    // other agent re-resolves from its own tier map (nax#1722 — see pinnedModelAgent).
    const pinnedModelDef =
      pinnedModelAgent === undefined || pinnedModelAgent === agentName ? resolvedRunOptions.modelDef : undefined;

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
          pinnedModelDef ??
          resolveModelForAgent(config.models, agentName, hopTier(hopKind, effectiveTier), defaultAgent);
        handle = await sessionManager.openSession(sessionName, {
          agentName,
          role: resolvedRunOptions.sessionRole ?? "implementer",
          workdir,
          pipelineStage: stage,
          // SEC-3: thread per-package config so monorepo permissionProfile is honored.
          config,
          modelDef,
          // Only report a tier when one actually selected the model. A caller-pinned
          // modelDef bypassed tier resolution, and `effectiveTier` is defaulted, so
          // forwarding it there would record a tier that never applied (#1433).
          ...(pinnedModelDef !== undefined ? {} : { modelTier: hopTier(hopKind, effectiveTier) }),
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
      const pinned = hopKind.kind === "primary" && pinnedModelDef !== undefined;
      const tier = hopTier(hopKind, effectiveTier);
      const modelDef =
        hopKind.kind === "primary"
          ? (pinnedModelDef ?? resolveModelForAgent(config.models, agentName, tier, defaultAgent))
          : resolveModelForAgent(config.models, agentName, tier, defaultAgent);
      // openSession errors propagate naturally — no handle, no closeSession needed
      handle = await sessionManager.openSession(sessionName, {
        agentName,
        role: resolvedRunOptions.sessionRole ?? "implementer",
        workdir,
        pipelineStage: stage,
        // SEC-3: thread per-package config so monorepo permissionProfile is honored.
        config,
        modelDef,
        // See the pin rationale above — a pinned modelDef has no meaningful tier.
        ...(pinned ? {} : { modelTier: tier }),
        timeoutSeconds:
          resolvedRunOptions.timeoutSeconds ??
          config.execution?.sessionTimeoutSeconds ??
          DEFAULT_CONFIG.execution.sessionTimeoutSeconds,
        featureName,
        storyId: story.id,
        signal: resolvedRunOptions.abortSignal,
      });
    }

    // Record the descriptor handoff for any swap, whether or not a bundle was rebuilt.
    // nax#1722: callOp carries no sessionId, so fall back to the session NAME — without
    // it the descriptor kept naming the failed primary on every production swap.
    if (hopKind.kind === "swap") {
      if (sessionId) sessionManager.handoff?.(sessionId, agentName, hopKind.failure.outcome);
      else recordAgentHandoff(sessionManager, sessionName, agentName, hopKind.failure.outcome);
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
          // SEC-3: thread per-package config so monorepo permissionProfile is honored.
          config,
          sessionRole: resolvedRunOptions.sessionRole,
          signal: resolvedRunOptions.abortSignal,
          contextPullTools,
          contextToolRuntime,
          codingTools: codingSupport?.tools,
          ...(resolvedRunOptions.callId !== undefined ? { callId: resolvedRunOptions.callId } : {}),
          ...(resolvedRunOptions.scopeId !== undefined ? { scopeId: resolvedRunOptions.scopeId } : {}),
          ...(interactionHandler ? { interactionHandler } : {}),
          // Context tools need at least one extra round-trip to answer a call;
          // the adapter default of a single turn leaves no room. Mirrors
          // session-run-hop.ts. Bridge-only callers keep their prior behaviour.
          // Mirrors session-run-hop.ts — the two must not drift. Forwarded as
          // the Q&A budget it is documented to be; the native loop no longer
          // spends it on round-trips.
          ...(hasContextTools
            ? { maxInteractions: maxInteractionTurns ?? 10 }
            : maxInteractionTurns !== undefined
              ? { maxInteractions: maxInteractionTurns }
              : {}),
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
          // BUG-57: a SessionTurnError (e.g. mid-flight cancel) can carry real
          // tokens already burned before the failure — read them instead of
          // hardcoding zero, or the spend silently disappears from cost accounting.
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
        bundle: workingBundle,
        prompt,
      };
    } finally {
      // Best-effort ledger write (mirrors review-audit doctrine): a flush
      // failure logs a warning and never replaces the hop's return value.
      try {
        await codingSupport?.auditSink.flush();
      } catch (flushErr) {
        logger.warn("tools", "coding-tool audit flush failed", {
          storyId: story.id,
          error: flushErr instanceof Error ? flushErr.message : String(flushErr),
        });
      }
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
