/**
 * callOpDispatch's complete-kind phase (extracted from call.ts for the A6
 * cognitive-complexity drain, docs/plans/STATUS-complexity-drain.md).
 *
 * Behaviour-preserving move of the `op.kind === "complete"` branch: options
 * assembly (including the nax#1739 per-agent `modelDefFor` resolver), the
 * MAX_COMPLETE_RETRY_ATTEMPTS loop, and the retry-decision policy. The
 * injectable `_callOpDeps` seam arrives by reference as `params.deps` —
 * it stays defined in `call.ts` because the barrel re-exports it for tests.
 */

import { computeAcpHandle } from "../agents";
import type { RetryStrategy } from "../agents/retry";
import type { CompleteOptions } from "../agents/types";
import { resolveModelForAgent } from "../config";
import type { AdapterFailure } from "../context/engine";
import { getSafeLogger } from "../logger";
import { storyExecRoot } from "../runtime/packages";
import { errorMessage } from "../utils/errors";
import type { CallOpDeps, DispatchPrologue } from "./call-dispatch-prologue";
import { throwAborted, throwNoDispatch, throwRetryBudgetExhausted } from "./call-dispatch-prologue";
import { MAX_COMPLETE_RETRY_ATTEMPTS, recordDispatchOutcome, resolveOpRetry } from "./call-resolvers";
import { runPostParse } from "./post-parse";
import type { CallContext, CompleteOperation } from "./types";

export interface CompleteDispatchParams<I, O, C> {
  readonly ctx: CallContext;
  readonly op: CompleteOperation<I, O, C>;
  readonly input: I;
  readonly prologue: DispatchPrologue<C>;
  readonly deps: CallOpDeps;
}

/** Dispatch a `kind:"complete"` op through completeAsWithFallback with retries. */
export async function dispatchCompleteOp<I, O, C>(params: CompleteDispatchParams<I, O, C>): Promise<O> {
  const { ctx, op, input, prologue, deps } = params;
  const { buildCtx, prompt, abortSignal, resolved, sessionRole } = prologue;
  const { agent: dispatchAgent } = prologue.target;

  const completeOptions = buildCompleteOptions(params);

  const retryStrategy = resolveOpRetry(op, input, buildCtx);
  let attempt = 0;
  while (attempt <= MAX_COMPLETE_RETRY_ATTEMPTS) {
    try {
      const completeOutcome = await ctx.runtime.agentManager.completeAsWithFallback(
        dispatchAgent,
        prompt,
        completeOptions,
      );
      // nax#1712: mirror the run branch at the bottom of the original dispatch — a swap
      // taken inside completeWithFallback is only attributable to a story here.
      recordDispatchOutcome(ctx, completeOutcome, resolved.modelTier, sessionRole);
      // US-001: zero-dispatch guard for complete-kind. Same placement rule
      // as the run branch — before parse, after recording, so the per-story
      // store still carries the failure that caused the zero-dispatch.
      if (completeOutcome.dispatchesCompleted === 0) {
        throwNoDispatch(op, ctx.storyId, dispatchAgent);
      }
      const raw = completeOutcome.result;
      const parsedComplete = op.parse(raw.output, input, buildCtx);
      return await runPostParse(op, parsedComplete, input, buildCtx);
    } catch (err) {
      const decision = decideCompleteRetry({ ctx, op, err, attempt, retryStrategy, dispatchAgent, abortSignal });
      if (decision === undefined) throw err;
      await deps.sleep(decision.delayMs, abortSignal);
      if (abortSignal?.aborted) {
        throwAborted(op, ctx.storyId, "aborted during retry sleep");
      }
      attempt++;
    }
  }
  getSafeLogger()?.error("callop", "Op retry budget exhausted", {
    storyId: ctx.storyId,
    opName: op.name,
    site: "complete" as const,
    attempt,
    totalAttempts: attempt + 1,
  });
  throwRetryBudgetExhausted(op, ctx.storyId, `exceeded MAX_COMPLETE_RETRY_ATTEMPTS (${MAX_COMPLETE_RETRY_ATTEMPTS})`);
}

/**
 * The completeOptions literal handed to completeAsWithFallback. sessionName is
 * computed explicitly so callers (e.g. mocks) see it without relying on the ACP
 * adapter's internal derivation — only set when both sessionRole and a
 * non-empty packageDir are available (mirrors the adapter-lifecycle logic).
 */
function buildCompleteOptions<I, O, C>(params: CompleteDispatchParams<I, O, C>): CompleteOptions {
  const { ctx, op, prologue } = params;
  const { callId, timeoutMs, sessionRole, effectiveModels, effectiveTier, defaultAgent, resolved } = prologue;
  const { agent: dispatchAgent, modelDef: dispatchModelDef } = prologue.target;
  const sessionName =
    sessionRole && ctx.packageDir
      ? computeAcpHandle(ctx.packageDir, ctx.featureName, ctx.storyId, sessionRole)
      : undefined;
  return {
    modelDef: dispatchModelDef,
    // nax#1739: `resolved.modelDef` belongs to `dispatchAgent`. When
    // completeWithFallback swaps agents it must dispatch the NEW agent's model,
    // or acpx receives a `--model` that agent never advertised. Mirrors the
    // run() path's pinnedModelAgent semantics (build-hop-callback.ts): a
    // caller-pinned `{ agent, model }` survives for its own agent, and any
    // other agent re-resolves from its own tier map.
    modelDefFor: (agent: string, tier?: string) =>
      agent === dispatchAgent && tier === undefined
        ? dispatchModelDef
        : resolveModelForAgent(effectiveModels, agent, tier ?? effectiveTier, defaultAgent),
    ...(resolved.modelTier !== undefined ? { modelTier: resolved.modelTier } : {}),
    pipelineStage: op.stage,
    storyId: ctx.storyId,
    workdir: storyExecRoot(ctx.packageView),
    featureName: ctx.featureName,
    callId,
    ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
    ...(sessionRole !== undefined ? { sessionRole } : {}),
    ...(sessionName !== undefined ? { sessionName } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/**
 * The catch-block policy for one failed complete attempt. Returns the decision
 * to retry with, or undefined when the error must propagate untouched — either
 * because no strategy is configured or because the strategy declined to retry.
 * Throws CALL_OP_ABORTED itself when the signal died before the sleep.
 */
function decideCompleteRetry<I, O, C>(args: {
  readonly ctx: CallContext;
  readonly op: CompleteOperation<I, O, C>;
  readonly err: unknown;
  readonly attempt: number;
  readonly retryStrategy: RetryStrategy | null;
  readonly dispatchAgent: string;
  readonly abortSignal: AbortSignal;
}): { readonly delayMs: number } | undefined {
  const { ctx, op, err, attempt, retryStrategy, dispatchAgent, abortSignal } = args;
  if (!retryStrategy) return undefined;
  const failure = err as Error;
  const decision = retryStrategy.shouldRetry(failure, attempt, {
    site: "complete",
    agentName: dispatchAgent,
    stage: op.stage,
    storyId: ctx.storyId,
  });
  if (!decision.retry) return undefined;
  if (abortSignal?.aborted) {
    throwAborted(op, ctx.storyId, "aborted before retry");
  }
  getSafeLogger()?.warn("callop", "Op retrying", {
    storyId: ctx.storyId,
    opName: op.name,
    site: "complete" as const,
    agentName: ctx.agentName,
    stage: op.stage,
    attempt,
    delayMs: decision.delayMs,
    promptTransformed: decision.nextPrompt !== undefined,
    failureKind: failure instanceof Error ? "error" : (failure as AdapterFailure).outcome,
    failureMessage: errorMessage(failure),
  });
  return { delayMs: decision.delayMs };
}
