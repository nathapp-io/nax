/** Fallback dispatch loop for AgentManager's session-based run path. */

import type { ModelDef } from "@/config/schema-types";
import type { AgentManagerConfig } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";
import type { IDispatchEventBus } from "@/runtime/dispatch-events";
import type { SessionRunHopFn } from "@/runtime/session-run-hop";
import { resolveStartAgent, type StoryHopBudget } from "./hop-budget";
import { buildFallbackRecord } from "./manager-dispatch";
import type { ManagerExhaustionOptions } from "./manager-exhaustion";
import type { AgentFallbackRecord, AgentRunOutcome, AgentRunRequest, HopKind } from "./manager-types";
import { describeRetryLogEvent, type SameAgentRetryState, trySameAgentRetry } from "./retry/hop-retry-policy";
import { decideSwap, type FallbackTarget, logSwapDecline } from "./swap-decision";
import type { AgentResult, AgentRunOptions } from "./types";

type LoggerLike = {
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => void;
  info: (scope: string, msg: string, data?: Record<string, unknown>) => void;
};

type ExhaustionInput = Omit<ManagerExhaustionOptions, "retryStrategy" | "sleep" | "onExhausted">;

export interface RunFallbackInput {
  readonly request: AgentRunRequest;
  readonly primaryAgentOverride?: string;
  readonly config: AgentManagerConfig;
  readonly budget: StoryHopBudget;
  readonly runHop: SessionRunHopFn | undefined;
  readonly dispatchEvents: IDispatchEventBus;
  readonly logger: LoggerLike | null | undefined;
  readonly getDefault: () => string;
  readonly isUnavailable: (agent: string, tier?: string, model?: string) => boolean;
  readonly markUnavailable: (agent: string, failure: AdapterFailure, tier?: string, model?: string) => void;
  readonly nextCandidate: (
    current: string,
    hops: number,
    exclude?: string,
    excludeTier?: string,
    excludeModel?: string,
  ) => FallbackTarget | null;
  readonly resolveExhaustion: (options: ExhaustionInput) => Promise<"retry" | "exhausted" | "cancelled">;
  readonly emitSwapAttempt: (fallback: AgentFallbackRecord) => void;
  /** Ladder index of `target` on `agent`'s ladder — `agent` must be the ladder ROOT
   * being walked (`primaryAgent` below), not `getDefault()`: a sticky slot's
   * primaryAgentOverride routinely differs from the configured default (nax#1965
   * fix-round-1 CRITICAL 1). */
  readonly depthOf: (agent: string, target: FallbackTarget) => number;
}

export async function runWithFallback(input: RunFallbackInput): Promise<AgentRunOutcome> {
  const { request, config, budget, logger } = input;
  const fallbacks: AgentFallbackRecord[] = [];
  const primaryAgent = input.primaryAgentOverride ?? input.getDefault();
  const storyId = request.runOptions.storyId;
  const start = resolveStartAgent(input, primaryAgent, config.agent?.fallback?.enabled, storyId, logger, {
    tier: request.runOptions.modelTier,
    model: request.runOptions.modelDef?.model,
  });
  let currentAgent = start.agent;
  let currentTarget: FallbackTarget = { ...start };
  let currentHopKind: HopKind = {
    kind: "primary",
    ...("tier" in start && start.tier !== undefined ? { tier: start.tier } : {}),
    ...("model" in start && start.model !== undefined ? { model: start.model } : {}),
  };
  // Ladder index, not a swap counter: an op that starts on rung k IS at depth k.
  let hopsSoFar = request.startDepth ?? budget.spent(storyId);
  let rateLimitRetry = 0;
  let staleRetryAttempts = 0;
  let timeoutRetryAttempts = 0;
  let adapterErrorRetries = 0;
  let currentBundle = request.bundle;
  let currentRunOptions: AgentRunOptions = request.runOptions;
  let finalPrompt: string | undefined;
  const startedAt = Date.now();
  const agentChain: string[] = [primaryAgent];
  let finalStatus: "ok" | "exhausted" | "cancelled" | "error" = "error";
  let totalCostUsd = 0;
  let didSwap = false;
  // Count of hops that returned a turn — successful or not — across every retry
  // and fallback attempt. `executeHop` stamps the `dispatched` flag on every
  // return: `true` on the success path of `buildHopCallback` /
  // `createSessionRunHop` (a turn was returned, even empty), `false` on every
  // catch path (rate-limit, auth, unresolvable model, declined fallback swap,
  // coding-tool setup failure, NativeSessionUnsupportedError) and on the
  // `unboundResult` fallback (no `request.executeHop` and no `input.runHop`
  // — wiring failure). The catch-path false values are the analog of the
  // required `AgentRunOutcome.dispatchesCompleted` field's "0 means no hop
  // reached a model" semantic. `callOp` raises `CALL_OP_NO_DISPATCH` when this
  // is `0`, so this counter is the only writer of the zero-dispatch signal.
  let dispatchesCompleted = 0;

  try {
    while (true) {
      const hop = await executeHop(input, currentAgent, currentBundle, currentHopKind, currentRunOptions);
      // Increment only when the hop actually reached an adapter. The
      // `dispatched` flag is authoritative — set by buildHopCallback's
      // success / catch returns and by the runHop seam's success / catch
      // returns, with `true` as the default for stubs that don't set it.
      if (hop.dispatched === true) {
        dispatchesCompleted += 1;
      }
      const { result } = hop;
      // The endpoint this hop dispatched — the identity a failure must be recorded
      // against. `currentHopKind.model` is a DECLARED literal pin and stays
      // authoritative when present; otherwise the dispatched model id is the truth.
      const dispatchedModel = currentHopKind.model ?? hop.endpoint?.modelDef.model;
      const updatedBundle = hop.bundle ?? currentBundle;
      finalPrompt = hop.prompt ?? finalPrompt;
      totalCostUsd += result.estimatedCostUsd ?? 0;
      if (result.success) {
        finalStatus = "ok";
        return {
          result,
          fallbacks,
          didSwap,
          finalBundle: updatedBundle,
          finalPrompt,
          finalAgent: currentAgent,
          finalTarget: currentTarget,
          finalDepth: hopsSoFar,
          dispatchesCompleted,
        };
      }

      const retry = trySameAgentRetry(
        result,
        {
          staleRetryAttempts,
          timeoutRetryAttempts,
          adapterErrorRetries,
          currentRunOptions,
          tier: currentHopKind.tier,
          model: currentHopKind.model,
        },
        { config, requestRunOptions: request.runOptions, signal: request.signal },
      );
      if (retry) {
        ({ staleRetryAttempts, timeoutRetryAttempts, adapterErrorRetries, currentRunOptions } = applyRetry(retry, {
          staleRetryAttempts,
          timeoutRetryAttempts,
          adapterErrorRetries,
          currentRunOptions,
        }));
        recordRetry(input, fallbacks, retry, currentAgent, storyId);
        currentHopKind = retry.kind;
        continue;
      }
      if (request.noFallback) {
        finalStatus = "error";
        return {
          result,
          fallbacks,
          didSwap,
          finalBundle: updatedBundle,
          finalPrompt,
          finalAgent: currentAgent,
          finalTarget: currentTarget,
          finalDepth: hopsSoFar,
          dispatchesCompleted,
        };
      }

      const swap = decideSwap(result.adapterFailure, hopsSoFar, config.agent?.fallback);
      if (!swap.swap) {
        logSwapDecline(logger, swap.reason, {
          storyId,
          agent: currentAgent,
          hopsSoFar,
          failure: result.adapterFailure,
        });
        if (result.adapterFailure?.outcome === "fail-stale") {
          logger?.warn("agent-manager", "fail-stale: no swap candidate, returning terminal failure", { storyId });
          finalStatus = "error";
          return {
            result,
            fallbacks,
            didSwap,
            finalBundle: updatedBundle,
            finalPrompt,
            finalAgent: currentAgent,
            finalTarget: currentTarget,
            finalDepth: hopsSoFar,
            dispatchesCompleted,
          };
        }
        const outcome = await input.resolveExhaustion({
          failure: result.adapterFailure,
          hopsSoFar,
          attempt: rateLimitRetry,
          swapWasPossible: swap.reason === "hop-cap-reached",
          agent: currentAgent,
          site: "run",
          storyId,
          stage: request.runOptions.pipelineStage ?? "run",
          signal: request.signal,
        });
        if (outcome === "retry") {
          rateLimitRetry += 1;
          continue;
        }
        finalStatus = outcome === "cancelled" ? "cancelled" : hopsSoFar > 0 ? "exhausted" : "error";
        return {
          result,
          fallbacks,
          didSwap,
          finalBundle: updatedBundle,
          finalPrompt,
          finalAgent: currentAgent,
          finalTarget: currentTarget,
          finalDepth: hopsSoFar,
          dispatchesCompleted,
        };
      }

      const failure = result.adapterFailure ?? unknownFailure();
      // currentHopKind.tier is the tier of the hop that just failed — mark and
      // exclude by that identity, not the bare agent name, so a same-agent,
      // different-tier fallback target survives (see swap-decision.ts). Deliberately
      // NOT defaulted to currentRunOptions.modelTier when unset (the healthy primary's
      // first hop): that would narrow markUnavailable's cooldown key from bare-agent to
      // agent+tier, and the bare-agent key is what still matters for an agent-wide
      // fault. `resolveStartAgent`'s start probe (hop-budget.ts) is now
      // endpoint-scoped, not tier-less — it queries `isUnavailable(primary, tier,
      // model)` for the endpoint the NEXT operation would actually dispatch to. The
      // very first, tier-less primary hop still writes a bare-agent key here because
      // there is no tier to name yet; that bare key is exactly what `CooldownStore`
      // needs for a genuinely agent-wide failure (fail-auth, missing binary, ...) to
      // blanket every endpoint of the agent — `_live()` treats a bare key as
      // blanket-agent only when the failure's own `cooldownScope` is `"agent"`, so a
      // model-scoped failure recorded here (thanks to `dispatchedModel` below, when a
      // hop reports its endpoint) still lands narrow rather than blanket. Model-identity
      // exclusion therefore engages once a tier is NAMED by a hop (a swap target, or a
      // dead-primary start that named one) — not retroactively for the very first,
      // tier-less hop. `currentHopKind.model` still threads through: a literal-pin swap
      // target DOES carry a tier-less model, and that pin's own identity is what
      // nax#1966 needed — see fallback-model-identity.ts.
      const currentTier = currentHopKind.tier;
      input.markUnavailable(currentAgent, failure, currentTier, dispatchedModel);
      const next = input.nextCandidate(primaryAgent, hopsSoFar, currentAgent, currentTier, dispatchedModel);
      if (!next) {
        const outcome = await input.resolveExhaustion({
          failure,
          hopsSoFar,
          attempt: rateLimitRetry,
          swapWasPossible: true,
          agent: currentAgent,
          site: "run",
          storyId,
          stage: request.runOptions.pipelineStage ?? "run",
          signal: request.signal,
        });
        if (outcome === "retry") {
          rateLimitRetry += 1;
          continue;
        }
        finalStatus = outcome === "cancelled" ? "cancelled" : "exhausted";
        return {
          result,
          fallbacks,
          didSwap,
          finalBundle: updatedBundle,
          finalPrompt,
          finalAgent: currentAgent,
          finalTarget: currentTarget,
          finalDepth: hopsSoFar,
          dispatchesCompleted,
        };
      }
      // The new position IS the rung's index — not "one more than before". A hop
      // may skip cooling rungs, so incrementing would under-count the descent.
      // `primaryAgent` is the ladder root nextCandidate walked — NOT getDefault().
      hopsSoFar = input.depthOf(primaryAgent, next);
      budget.record(storyId, hopsSoFar);
      rateLimitRetry = 0;
      currentBundle = updatedBundle;
      currentHopKind = {
        kind: "swap",
        failure,
        ...(next.tier ? { tier: next.tier } : {}),
        ...(next.model ? { model: next.model } : {}),
      };
      const fallback = buildFallbackRecord({
        storyId,
        priorAgent: currentAgent,
        newAgent: next.agent,
        hop: hopsSoFar,
        failure,
        costUsd: result.estimatedCostUsd ?? 0,
      });
      fallbacks.push(fallback);
      input.emitSwapAttempt(fallback);
      didSwap = true;
      logger?.info("agent-manager", "Agent swap triggered", {
        storyId,
        fromAgent: currentAgent,
        toAgent: next.agent,
        hop: hopsSoFar,
      });
      agentChain.push(next.agent);
      currentAgent = next.agent;
      currentTarget = next;
    }
  } finally {
    input.dispatchEvents.emitOperationCompleted({
      kind: "operation-completed",
      operation: "run-with-fallback",
      agentChain,
      hopCount: hopsSoFar,
      fallbackTriggered: fallbacks.length > 0,
      totalElapsedMs: Date.now() - startedAt,
      totalCostUsd,
      finalStatus,
      storyId,
      stage: request.runOptions.pipelineStage ?? "run",
      timestamp: Date.now(),
      ...(request.runOptions.callId !== undefined ? { callId: request.runOptions.callId } : {}),
      ...(request.runOptions.scopeId !== undefined ? { scopeId: request.runOptions.scopeId } : {}),
    });
  }
}

/** Mirrors the `endpoint` shape `AgentRunRequest.executeHop` reports (manager-types.ts). */
type HopEndpointLike = { readonly modelDef: ModelDef; readonly modelTier?: string };

/** Internal shape returned by `executeHop`. Public callback results are spread into it. */
interface HopResult {
  result: AgentResult;
  bundle?: AgentRunRequest["bundle"];
  prompt?: string;
  endpoint?: HopEndpointLike;
  /** True only when the hop reached a real adapter — false on the `unboundResult` fallback. */
  dispatched?: boolean;
}

async function executeHop(
  input: RunFallbackInput,
  agent: string,
  bundle: AgentRunRequest["bundle"],
  kind: HopKind,
  options: AgentRunOptions,
): Promise<HopResult> {
  if (input.request.executeHop) {
    const userResult = await input.request.executeHop(agent, bundle, kind, options);
    // US-001: the user callback is authoritative on whether a dispatch
    // happened. `buildHopCallback` and `session-run-hop.ts` set `dispatched`
    // explicitly — true on the success path that returned a turn (even empty),
    // false on the catch path that synthesised a failure from a thrown
    // `runAsSession` / `sendPrompt` (no model reached). Stubs and test
    // callbacks that omit the field default to `true` so the original
    // "callback IS a dispatch" assumption is preserved. The `unboundResult`
    // branch below is the ONLY path where we set `dispatched: false` ourselves
    // — no callback ran, no dispatch happened.
    return { ...userResult, dispatched: userResult.dispatched ?? true };
  }
  if (!input.runHop) return { result: unboundResult(agent), bundle, dispatched: false };
  const raw = await input.runHop(agent, options);
  const hop: HopResult =
    "result" in raw && raw.result != null ? (raw as HopResult) : { result: raw as unknown as AgentResult };
  // The `runHop` seam (SessionRunHopFn) reports no `endpoint` at all (nax#1965) — only
  // `executeHop` does. Default it from `options.modelDef` ONLY for a `primary` hop:
  // on a primary hop `options` IS, by construction, what this call was dispatched
  // with (a pin wins per resolveHopEndpoint), so the default is accurate. After a
  // swap, `options.modelDef` is stale — `currentRunOptions` is never rebuilt against
  // the new agent's own resolution in this loop (only a timeout-retry reassigns it)
  // — so defaulting there would report the OLD primary's identity as what the NEW
  // agent dispatched, cooling a live endpoint while leaving the actually-dead one
  // selectable. Reporting no identity (the pre-existing behavior) is safer: it just
  // degrades `dispatchedModel` to `currentHopKind.model ?? undefined`, same as
  // before this fix. Production is unaffected either way — `callOp` always supplies
  // `request.executeHop`, which resolves a real endpoint per hop via
  // `resolveHopEndpoint`, so this default only matters for the bare `runHop` seam.
  const endpoint: HopEndpointLike | undefined =
    hop.endpoint ?? (kind.kind === "primary" && options.modelDef ? { modelDef: options.modelDef } : undefined);
  // US-001: same default as the `request.executeHop` branch — the user's
  // `runHop` (typically `createSessionRunHop` in production) is authoritative.
  // Its catch path sets `dispatched: false` when `sendPrompt` throws without
  // reaching a model; its success path sets `dispatched: true`. Stubs that
  // omit the field default to `true`.
  return { ...hop, bundle, endpoint, dispatched: hop.dispatched ?? true };
}

function unboundResult(agent: string): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output: `AgentManager run hop is not wired for agent "${agent}"`,
    rateLimited: false,
    durationMs: 0,
    estimatedCostUsd: 0,
  };
}

function unknownFailure(): AdapterFailure {
  return { category: "quality", outcome: "fail-unknown", retriable: false, message: "" };
}

function applyRetry(retry: ReturnType<typeof trySameAgentRetry> & {}, state: SameAgentRetryState): SameAgentRetryState {
  return {
    staleRetryAttempts: retry.outcome === "stale-retry" ? retry.staleRetryAttempts : state.staleRetryAttempts,
    timeoutRetryAttempts: retry.outcome === "timeout-retry" ? retry.timeoutRetryAttempts : state.timeoutRetryAttempts,
    adapterErrorRetries: retry.outcome === "adapter-error" ? retry.adapterErrorRetries : state.adapterErrorRetries,
    currentRunOptions: retry.outcome === "timeout-retry" ? retry.currentRunOptions : state.currentRunOptions,
    tier: state.tier,
  };
}

function recordRetry(
  input: RunFallbackInput,
  fallbacks: AgentFallbackRecord[],
  retry: NonNullable<ReturnType<typeof trySameAgentRetry>>,
  agent: string,
  storyId: string | undefined,
): void {
  const fallback = buildFallbackRecord({
    storyId,
    priorAgent: agent,
    newAgent: agent,
    hop: retry.kind.attempt,
    failure: retry.fallbackRecord,
    costUsd: retry.fallbackRecord.costUsd,
  });
  const event = describeRetryLogEvent(retry, storyId, agent);
  if (event.recordFallback) {
    fallbacks.push(fallback);
    input.emitSwapAttempt(fallback);
  }
  input.logger?.[event.level]("agent-manager", event.message, event.fields);
}
