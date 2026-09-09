/** Fallback dispatch loop for AgentManager's session-based run path. */

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
  readonly isUnavailable: (agent: string, tier?: string) => boolean;
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
}

export async function runWithFallback(input: RunFallbackInput): Promise<AgentRunOutcome> {
  const { request, config, budget, logger } = input;
  const fallbacks: AgentFallbackRecord[] = [];
  const primaryAgent = input.primaryAgentOverride ?? input.getDefault();
  const storyId = request.runOptions.storyId;
  const start = resolveStartAgent(input, primaryAgent, config.agent?.fallback?.enabled, storyId, logger);
  let currentAgent = start.agent;
  let currentHopKind: HopKind = {
    kind: "primary",
    ...("tier" in start && start.tier !== undefined ? { tier: start.tier } : {}),
    ...("model" in start && start.model !== undefined ? { model: start.model } : {}),
  };
  let hopsSoFar = budget.spent(storyId);
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

  try {
    while (true) {
      const hop = await executeHop(input, currentAgent, currentBundle, currentHopKind, currentRunOptions);
      const { result } = hop;
      const updatedBundle = hop.bundle ?? currentBundle;
      finalPrompt = hop.prompt ?? finalPrompt;
      totalCostUsd += result.estimatedCostUsd ?? 0;
      if (result.success) {
        finalStatus = "ok";
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
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
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
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
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
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
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
      }

      const failure = result.adapterFailure ?? unknownFailure();
      // The primary hop carries no tier of its own, so record it at the tier the
      // caller actually dispatched. Without this its cooldown lands on the bare
      // agent key, which `CooldownStore._live` returns for any tier-less lookup
      // regardless of scope — which is what excluded every literal-pin rung (nax#1966).
      const failedTier = currentHopKind.tier ?? request.runOptions.modelTier;
      input.markUnavailable(currentAgent, failure, failedTier, currentHopKind.model);
      const next = input.nextCandidate(primaryAgent, hopsSoFar, currentAgent, failedTier, currentHopKind.model);
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
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
      }
      hopsSoFar = budget.spend(storyId, hopsSoFar);
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
      logger?.info("agent-manager", "Agent swap triggered", {
        storyId,
        fromAgent: currentAgent,
        toAgent: next.agent,
        hop: hopsSoFar,
      });
      agentChain.push(next.agent);
      currentAgent = next.agent;
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

async function executeHop(
  input: RunFallbackInput,
  agent: string,
  bundle: AgentRunRequest["bundle"],
  kind: HopKind,
  options: AgentRunOptions,
) {
  if (input.request.executeHop) return input.request.executeHop(agent, bundle, kind, options);
  if (!input.runHop) return { result: unboundResult(agent), bundle };
  const raw = await input.runHop(agent, options);
  const hop =
    "result" in raw && raw.result != null
      ? (raw as { result: AgentResult; prompt?: string })
      : { result: raw as unknown as AgentResult };
  return { ...hop, bundle };
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
