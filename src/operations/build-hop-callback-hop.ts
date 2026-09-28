/**
 * Per-hop phases extracted from buildHopCallback (A5 cognitive-complexity drain).
 *
 * `buildHopCallback` (build-hop-callback.ts) creates the closure-scoped state once —
 * `_buildHopCallbackDeps`, the session-scoped pull budgets, the run call counter, and
 * `HopClosureState` — and the closure it returns is now a straight sequence of the
 * phase functions below (the dispatch try/catch/finally lives in
 * build-hop-callback-dispatch.ts — this file alone exceeded the 600-line new-file cap).
 * Behaviour is line-for-line the pre-extraction closure's; the
 * phase boundaries are the comment-block seams that already existed in it.
 *
 * Two state rules, both inherited from the original closure semantics (see A2's §9.2
 * write-up for the general shape):
 * - `HopClosureState` (`preAttemptGitRefPromise`, `priorHopStartedAt`) is MUTATED IN
 *   PLACE by `composeHopPrompt` and lives across closure invocations — it is created
 *   once in the factory, never returned wholesale.
 * - `input.deps` IS `_buildHopCallbackDeps` passed by reference. Tests reassign the
 *   object's PROPERTIES between building the callback and invoking it; every phase
 *   reads `deps.X` fresh at call time, so the reassignment is picked up. Do not
 *   destructure `deps` outside a phase body, and do not import these functions back
 *   from build-hop-callback.ts (that would cycle).
 */

import { buildRunInteractionHandler } from "../agents/acp/adapter-output";
import { resolveCodingToolSupport } from "../agents/coding-tool-support";
import type { HopKind } from "../agents/manager-types";
import { applyDiffAccessForAgentProtocol, promptWithToolPreamble } from "../agents/tool-preamble";
import type { AgentResult, AgentRunOptions, SessionHandle, TurnResult } from "../agents/types";
import { DEFAULT_CONFIG } from "../config";
import type { PipelineStage } from "../config/permissions";
import type {
  ContextBundle,
  createContextToolRuntime,
  createSessionToolBudgets,
  RunCallCounter,
} from "../context/engine";
import { getLogger } from "../logger";
import { RectifierPromptBuilder } from "../prompts";
import { recordAgentHandoff } from "../session";
import type { OpenSessionRequest } from "../session/types";
import type { _buildHopCallbackDeps, BuildHopCallbackContext } from "./build-hop-callback";
import type { HopEndpoint } from "./hop-endpoint";
import { resolveHopEndpoint } from "./hop-endpoint";

/** Session-scoped pull budgets — created ONCE per callback, outside the closure (gap finding 7). */
export type SessionToolBudgets = ReturnType<typeof createSessionToolBudgets>;

/** The per-hop tool set resolved from the bundle + grants, threaded through the dispatch. */
export interface HopTooling {
  workingBundle: ContextBundle | undefined;
  /** The final dispatched prompt: preamble applied, then the diff-access substitution. */
  prompt: string;
  contextToolRuntime: ReturnType<typeof createContextToolRuntime>;
  contextPullTools: ContextBundle["pullTools"] | undefined;
  advertisedTools: string[];
  codingSupport: Awaited<ReturnType<typeof resolveCodingToolSupport>>;
  interactionHandler: ReturnType<typeof buildRunInteractionHandler> | undefined;
  hasContextTools: boolean;
}

/** The hop result shape — matches AgentRunRequest["executeHop"]'s return type. */
export interface HopOutcome {
  result: AgentResult;
  bundle: ContextBundle | undefined;
  prompt?: string;
  endpoint?: HopEndpoint;
  dispatched?: boolean;
}

/**
 * Closure-scoped mutable state shared ACROSS hops (US-003 / AC5). Mutated in place by
 * `composeHopPrompt`; created once in buildHopCallback, never reassigned.
 */
export interface HopClosureState {
  /**
   * US-003: fire-and-forget capture of the pre-attempt git ref on the FIRST primary
   * hop (no `await` so the hot path stays synchronous), awaited only by the
   * subsequent timeout-retry hop. Best-effort — absence falls through to the generic
   * preamble path inside `_buildHopCallbackDeps.timeoutRetry` (AC8).
   */
  preAttemptGitRefPromise?: Promise<string | undefined>;
  /**
   * When the PRECEDING hop started. elapsedMs must report the timed-out attempt's own
   * duration, not time spent in any stale-retry hops that happened to precede it
   * (AC5), so it is read before being overwritten with this hop's own start time.
   */
  priorHopStartedAt?: number;
}

/** Everything one closure invocation needs — built fresh by buildHopCallback per hop. */
export interface HopInvocation {
  ctx: BuildHopCallbackContext;
  /** `_buildHopCallbackDeps` BY REFERENCE — see the module comment on property reassignment. */
  deps: typeof _buildHopCallbackDeps;
  stage: PipelineStage;
  sessionId: string | undefined;
  sessionToolBudgets: SessionToolBudgets;
  runCounterForHops: RunCallCounter;
  state: HopClosureState;
  agentName: string;
  hopBundle: ContextBundle | undefined;
  hopKind: HopKind;
  resolvedRunOptions: AgentRunOptions;
}

/** TurnResult → AgentResult for the hop's success return; shared with the dispatch file. */
export function turnResultToAgentResult(r: TurnResult): AgentResult {
  return {
    success: !r.adapterFailure,
    exitCode: r.adapterFailure ? 1 : 0,
    output: r.output,
    rateLimited: r.adapterFailure?.outcome === "fail-rate-limit",
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
 * Hop-kind dependent prompt composition: the swap rebuild + manifest write + handoff
 * rewrite, and the timeout-retry retry-prompt composition. Unconditional bookkeeping
 * (elapsed time, the once-only pre-attempt git-ref capture) happens here too, because
 * the original interleaved it with these branches and the ORDER matters: the capture
 * fires before a swap's rebuild can run, and `priorHopStartedAt` is overwritten only
 * after `elapsedSincePriorHop` is read.
 */
export async function composeHopPrompt(
  input: HopInvocation,
): Promise<{ workingBundle: ContextBundle | undefined; prompt: string }> {
  const { ctx, deps, state, agentName, hopBundle, hopKind, resolvedRunOptions } = input;
  const logger = getLogger();
  const elapsedSincePriorHop = state.priorHopStartedAt ? Date.now() - state.priorHopStartedAt : 0;
  state.priorHopStartedAt = Date.now();

  // US-003: start pre-attempt git ref capture once on the first primary hop,
  // without awaiting. The promise is awaited later on the timeout-retry hop.
  if (hopKind.kind === "primary" && !state.preAttemptGitRefPromise) {
    state.preAttemptGitRefPromise = deps.captureGitRef(ctx.workdir);
  }

  let workingBundle = hopBundle;
  let prompt = resolvedRunOptions.prompt;

  // SWAP only: rebuild bundle for the new agent, rewrite the prompt, and record the handoff.
  // Stale-retry reuses the same agent and session — no rebuild, no prompt rewrite.
  if (hopKind.kind === "swap" && hopBundle) {
    workingBundle = deps.rebuildForAgent(hopBundle, agentName, hopKind.failure, ctx.story.id);
    if (ctx.projectDir && ctx.featureName && workingBundle.manifest.rebuildInfo) {
      try {
        await deps.writeRebuildManifest(ctx.projectDir, ctx.featureName, ctx.story.id, {
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
          storyId: ctx.story.id,
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
    // Local + `!== undefined` (never truthiness on the promise itself — a Promise
    // object is always truthy, so this is the same test the closure made, in a
    // shape noMisusedPromises accepts).
    const pendingRef = state.preAttemptGitRefPromise;
    const preAttemptGitRef = pendingRef !== undefined ? await pendingRef : undefined;
    const changedFiles = preAttemptGitRef ? await deps.captureWorkingTreeChanges(ctx.workdir, preAttemptGitRef) : [];
    prompt = deps.timeoutRetry({
      prompt: resolvedRunOptions.prompt,
      changedFiles,
      elapsedMs: elapsedSincePriorHop,
      attempt: hopKind.attempt,
      ...(hopKind.failure !== undefined ? { failure: hopKind.failure } : {}), // nax#2200
    });
  }

  return { workingBundle, prompt };
}

/**
 * Resolve what the hop dispatches WITH: the pull-tool runtime, the tool preamble, the
 * coding-tool support (whose refusal is converted into a failed AgentResult — #1794 —
 * rather than a propagated throw), the diff-access substitution, and the interaction
 * handler. The `ok: false` arm is the codingSupport-throw early return: the prompt it
 * reports carries the preamble but NOT the diff-access substitution, exactly as the
 * original's early return did.
 */
export async function resolveHopTooling(
  input: HopInvocation,
  composed: { workingBundle: ContextBundle | undefined; prompt: string },
): Promise<{ ok: true; tooling: HopTooling } | { ok: false; result: AgentResult; prompt: string }> {
  const { ctx, deps, agentName, resolvedRunOptions } = input;
  const { workingBundle } = composed;
  let prompt = composed.prompt;

  const contextToolRuntime = workingBundle
    ? deps.createContextToolRuntime({
        bundle: workingBundle,
        story: ctx.story,
        config: ctx.config,
        repoRoot: ctx.workdir,
        runCounter: input.runCounterForHops,
        sessionBudgets: input.sessionToolBudgets,
        // US-005: thread the requesting agent so query_scratch neutralizes
        // tool references for the actual reader (AC10), not story.id.
        agentId: agentName,
        // US-005: thread the story scratch dirs the stage-assembly path
        // resolved, so query_scratch reads the same data the push
        // providers (SessionScratchProvider / ToolDiagnosticsProvider) read.
        ...(ctx.storyScratchDirs?.length ? { storyScratchDirs: ctx.storyScratchDirs } : {}),
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
  // Unconditional: the scope block must reach every dispatch, even a
  // tool-less one; only the pull-tool catalogue inside stays gated, since
  // buildContextToolPreamble returns the prompt unchanged without tools.
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

  // Coding tools are resolved per hop rather than per run: a swap changes the
  // agent, and the grants are stage-scoped, so a runtime captured once above
  // would outlive the dispatch it was resolved for.
  //
  // US-002 — the substitution happens AFTER coding-tool support resolves,
  // not before. Native rendering additionally requires `Git` AND `Read` to
  // be advertised, and the resolved runtime is the single source of truth
  // for what the agent will advertise: the intersection of the operation's
  // declared tools with the policy grants at this pipeline stage. The
  // advertised names are read directly from the runtime (see CodingToolRuntime.advertised),
  // so a fallback swap that changes the protocol cannot change the tool set,
  // and the gate at dispatch matches the gate the agent is gated on at
  // call-time.
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
    codingSupport = await resolveCodingToolSupport(resolvedRunOptions);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    // US-001: coding-tool setup failed before any adapter was reached — no model
    // was dispatched. Same signal as the dispatch catch path.
    return {
      ok: false,
      result: {
        success: false,
        exitCode: 1,
        // Always prefix with agent name so downstream logs can attribute the
        // failure even when the underlying error message doesn't carry it
        // (e.g. bare `new Error("timeout")`).
        output: `Agent "${agentName}" failed: ${errMessage}`,
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
      },
      prompt,
    };
  }
  const advertisedTools = codingSupport ? codingSupport.tools.map((t) => t.name) : [];

  // Unconditional, unlike the preamble above: a review prompt carries a
  // diff-access region whether or not the op also has context pull tools, and
  // ACP needs the markers stripped even though it keeps the body. Placed after
  // the preamble for the same reason the preamble is placed after the swap
  // rewrites — those replace the prompt wholesale, and a region rendered
  // before one would be discarded. Placed after `codingSupport` resolves for
  // the same reason: the gate depends on the advertised tools.
  prompt = applyDiffAccessForAgentProtocol(agentName, prompt, advertisedTools);

  // A bridge is no longer required: without a handler, sendPrompt falls back
  // to NO_OP_INTERACTION_HANDLER and a well-formed tool call goes unanswered.
  // Coding tools join that predicate for the same reason — a review op
  // declares tools but carries no bridge and often no context bundle, so
  // gating on those two alone left it with a handler-less session.
  const interactionHandler =
    ctx.interactionBridge || hasContextTools || codingSupport
      ? buildRunInteractionHandler({
          ...resolvedRunOptions,
          contextToolRuntime,
          contextPullTools,
          ...(codingSupport ? { codingToolRuntime: codingSupport.runtime } : {}),
          ...(ctx.interactionBridge ? { interactionBridge: ctx.interactionBridge } : {}),
        })
      : undefined;

  return {
    ok: true,
    tooling: {
      workingBundle,
      prompt,
      contextToolRuntime,
      contextPullTools,
      advertisedTools,
      codingSupport,
      interactionHandler,
      hasContextTools,
    },
  };
}

/**
 * Session identity + the opener. `openFresh` returns the endpoint it resolved
 * alongside the handle — the original assigned a closure-scoped `endpoint` variable
 * as a side effect, which only the success return ever read; returning it keeps that
 * "endpoint is defined only when a session was actually opened" shape explicit.
 */
export interface HopSession {
  sessionName: string;
  openFresh: () => Promise<{ handle: SessionHandle; endpoint: HopEndpoint }>;
}

export function prepareHopSession(input: HopInvocation): HopSession {
  const { ctx, agentName, resolvedRunOptions, stage } = input;

  const sessionName = ctx.sessionManager.nameFor({
    workdir: ctx.workdir,
    featureName: ctx.featureName,
    storyId: ctx.story.id,
    role: resolvedRunOptions.sessionRole ?? "implementer",
    pipelineStage: stage,
  });

  // nax#1877: the transcript's owner. `scopeId` when the caller scopes a
  // session across stages, else this op invocation's `callId` — either way an
  // identity that survives this invocation's hops and retries and changes for
  // the next one, so a stale transcript at this deterministic session name is
  // recognised as foreign instead of silently resumed.
  const transcriptOwner = resolvedRunOptions.scopeId ?? resolvedRunOptions.callId;
  // The caller's pinned model is usable only on the agent it was resolved for; any
  // other agent re-resolves from its own tier map (nax#1722 — see pinnedModelAgent).
  const pinnedModelDef =
    ctx.pinnedModelAgent === undefined || ctx.pinnedModelAgent === agentName ? resolvedRunOptions.modelDef : undefined;

  // Identical across every non-reuse branch (stale-retry fallback, primary,
  // swap) — each branch resolves `endpoint` first, then opens with it.
  const openSessionRequest = (
    modelDef: OpenSessionRequest["modelDef"],
    modelTier?: OpenSessionRequest["modelTier"],
  ): OpenSessionRequest => ({
    agentName,
    role: resolvedRunOptions.sessionRole ?? "implementer",
    workdir: ctx.workdir,
    pipelineStage: stage,
    // SEC-3: thread per-package config so monorepo permissionProfile is honored.
    config: ctx.config,
    modelDef,
    ...(modelTier ? { modelTier } : {}),
    timeoutSeconds:
      resolvedRunOptions.timeoutSeconds ??
      ctx.config.execution?.sessionTimeoutSeconds ??
      DEFAULT_CONFIG.execution.sessionTimeoutSeconds,
    featureName: ctx.featureName,
    storyId: ctx.story.id,
    ...(transcriptOwner !== undefined ? { transcriptOwner } : {}),
    signal: resolvedRunOptions.abortSignal,
  });

  const openFresh = async (): Promise<{ handle: SessionHandle; endpoint: HopEndpoint }> => {
    const endpoint = resolveHopEndpoint({
      hopKind: input.hopKind,
      pinnedModelDef,
      models: ctx.config.models,
      agentName,
      effectiveTier: ctx.effectiveTier,
      defaultAgent: ctx.defaultAgent,
    });
    const handle = await ctx.sessionManager.openSession(
      sessionName,
      openSessionRequest(endpoint.modelDef, endpoint.modelTier),
    );
    return { handle, endpoint };
  };

  return { sessionName, openFresh };
}

/**
 * Acquire the handle the turn dispatches on. `endpoint` is undefined exactly when an
 * existing warm handle was reused (openFresh never ran) — the stale-retry reuse arm
 * of the original's closure-scoped `endpoint` variable.
 *
 * openSession errors propagate naturally — no handle, no closeSession needed.
 */
export async function acquireSessionHandle(
  input: HopInvocation,
  session: HopSession,
): Promise<{ handle: SessionHandle; endpoint: HopEndpoint | undefined }> {
  const { ctx, agentName, hopKind } = input;
  if (hopKind.kind !== "stale-retry") {
    return session.openFresh();
  }

  // STALE-RETRY: reuse the existing live handle — no openSession, no acpx reconnect.
  // nax#2218: a CANCELLED warm handle is poisoned — sendPrompt's SESSION_CANCELLED
  // guard would kill the retry before reaching a model. Close it and reopen so the
  // "same-agent retry with fresh session" actually dispatches.
  const cached = ctx.sessionManager.getLiveHandle(session.sessionName);
  if (cached && cached.agentName === agentName && !ctx.sessionManager.isCancelled(session.sessionName)) {
    return { handle: cached, endpoint: undefined };
  }
  const logger = getLogger();
  if (cached && ctx.sessionManager.isCancelled(session.sessionName)) {
    logger.warn("execution", "Stale-retry: cached session was cancelled — closing and reopening fresh", {
      storyId: ctx.story.id,
      sessionName: session.sessionName,
      attempt: hopKind.attempt,
    });
    await ctx.sessionManager.closeSession(cached);
  } else {
    // Defensive: cache miss should never happen in practice (the handle was just
    // used by the prior attempt), but fall back to openSession so the retry
    // can still proceed. Logged at warn to detect unexpected misses in production.
    logger.warn("execution", "Stale-retry: live handle missing, re-opening session", {
      storyId: ctx.story.id,
      sessionName: session.sessionName,
      attempt: hopKind.attempt,
    });
  }
  return session.openFresh();
}

/**
 * Record the descriptor handoff for any swap, whether or not a bundle was rebuilt.
 * nax#1722: callOp carries no sessionId, so otherwise the descriptor kept naming the
 * failed primary on every production swap.
 */
export function recordSwapHandoff(input: HopInvocation, sessionName: string): void {
  const { ctx, sessionId, agentName, hopKind } = input;
  if (hopKind.kind !== "swap") return;
  if (sessionId) ctx.sessionManager.handoff?.(sessionId, agentName, hopKind.failure.outcome);
  else recordAgentHandoff(ctx.sessionManager, sessionName, agentName, hopKind.failure.outcome);
}
