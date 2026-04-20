/**
 * AgentManager — owns agent lifecycle and fallback policy (ADR-012).
 *
 * Phase 4: implements real shouldSwap, nextCandidate, runWithFallback, and
 * completeWithFallback. Adapter-owned fallback state removed.
 */

import { EventEmitter } from "node:events";
import type { NaxConfig } from "../config";
import type { AdapterFailure, ContextBundle } from "../context/engine";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { cancellableDelay } from "../utils/bun-deps";
import type {
  AgentCompleteOutcome,
  AgentFallbackRecord,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  IAgentManager,
} from "./manager-types";
import { createAgentRegistry } from "./registry";
import type { AgentRegistry } from "./registry";
import type {
  AgentResult,
  CompleteOptions,
  CompleteResult,
  DecomposeOptions,
  DecomposeResult,
  PlanOptions,
  PlanResult,
} from "./types";

type LoggerLike = {
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => void;
  info: (scope: string, msg: string, data?: Record<string, unknown>) => void;
};

/** Injectable deps for testability. */
export const _agentManagerDeps = {
  /**
   * Cancellable backoff delay. Delegates to the canonical helper in
   * `src/utils/bun-deps.ts` — see there for the rationale and the
   * coding-standards §6 reference. Exposed on `_deps` so tests can mock it.
   */
  sleep: (ms: number, signal?: AbortSignal) => cancellableDelay(ms, signal),
};

export class AgentManager implements IAgentManager {
  private readonly _config: NaxConfig;
  private _registry: AgentRegistry | undefined;
  private readonly _unavailable = new Map<string, AdapterFailure>();
  private readonly _prunedFallback = new Set<string>();
  private readonly _emitter = new EventEmitter();
  private readonly _logger: LoggerLike;
  readonly events: AgentManagerEvents;

  constructor(config: NaxConfig, registry?: AgentRegistry, opts?: { logger?: LoggerLike }) {
    this._config = config;
    this._registry = registry;
    this._logger = opts?.logger ?? getSafeLogger() ?? { warn: () => {}, info: () => {} };
    this.events = {
      on: (event, listener) => {
        this._emitter.on(event as AgentManagerEventName, listener as (...args: unknown[]) => void);
      },
    };
  }

  getDefault(): string {
    const fromAgent = this._config.agent?.default;
    if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
    return "claude";
  }

  isUnavailable(agent: string): boolean {
    return this._unavailable.has(agent);
  }

  markUnavailable(agent: string, reason: AdapterFailure): void {
    this._unavailable.set(agent, reason);
    this._emitter.emit("onAgentUnavailable", { agent, failure: reason });
  }

  reset(): void {
    this._unavailable.clear();
    this._prunedFallback.clear();
  }

  async validateCredentials(): Promise<void> {
    const primary = this.getDefault();
    const map = (this._config.agent?.fallback?.map ?? {}) as Record<string, string[]>;
    const candidates = new Set<string>([primary]);
    for (const [from, tos] of Object.entries(map)) {
      candidates.add(from);
      for (const to of tos) candidates.add(to);
    }
    for (const name of candidates) {
      const adapter = this._resolveRegistry().getAgent(name);
      if (!adapter || typeof adapter.hasCredentials !== "function") continue;
      const ok = await adapter.hasCredentials();
      if (ok) continue;
      if (name === primary) {
        throw new NaxError(`Primary agent "${name}" has no usable credentials`, "AGENT_CREDENTIALS_MISSING", {
          stage: "run-setup",
          agent: name,
        });
      }
      this._logger.warn("agent-manager", "Fallback candidate pruned — missing credentials", {
        primary,
        pruned: name,
      });
      this._prunedFallback.add(name);
    }
  }

  resolveFallbackChain(agent: string, _failure: AdapterFailure): string[] {
    const map = (this._config.agent?.fallback?.map ?? {}) as Record<string, string[]>;
    const raw = map[agent] ?? [];
    return raw.filter((a) => !this._prunedFallback.has(a) && !this.isUnavailable(a));
  }

  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, bundle: ContextBundle | undefined): boolean {
    if (!failure) return false;
    // Aborted runs (shutdown in progress) must not trigger fallback —
    // swapping to another agent would spawn fresh work during teardown.
    if (failure.outcome === "fail-aborted") return false;
    const fallback = this._config.agent?.fallback;
    if (!fallback?.enabled) return false;
    if (!bundle) return false;
    if (hopsSoFar >= (fallback.maxHopsPerStory ?? 2)) return false;
    if (failure.category === "availability") return true;
    return fallback.onQualityFailure ?? false;
  }

  nextCandidate(current: string, _hopsSoFar: number): string | null {
    const map = (this._config.agent?.fallback?.map ?? {}) as Record<string, string[]>;
    // Filter out pruned and already-unavailable candidates; return the first available one.
    // Callers pass the primary agent (not the most-recently-failed agent) so flat maps like
    // { claude: ["codex", "gemini"] } work correctly: unavailable agents are filtered out and
    // the next available candidate in order is returned.
    const candidates = (map[current] ?? []).filter((a) => !this._prunedFallback.has(a) && !this.isUnavailable(a));
    return candidates[0] ?? null;
  }

  async runWithFallback(request: AgentRunRequest, primaryAgentOverride?: string): Promise<AgentRunOutcome> {
    const logger = getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    const primaryAgent = primaryAgentOverride ?? this.getDefault();
    let currentAgent = primaryAgent;
    let hopsSoFar = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;
    let rateLimitRetry = 0;
    let currentBundle = request.bundle;
    let currentFailure: AdapterFailure | undefined;
    let finalPrompt: string | undefined;

    while (true) {
      let result: AgentResult;
      let updatedBundle = currentBundle;

      if (request.executeHop) {
        const hopOut = await request.executeHop(currentAgent, currentBundle, currentFailure);
        result = hopOut.result;
        updatedBundle = hopOut.bundle ?? currentBundle;
        finalPrompt = hopOut.prompt ?? finalPrompt;
      } else {
        const adapter = this._resolveRegistry().getAgent(currentAgent);
        if (!adapter) {
          logger?.warn("agent-manager", "No adapter available", {
            storyId: request.runOptions.storyId,
            agent: currentAgent,
          });
          const noAdapterResult: AgentResult = {
            success: false,
            exitCode: 1,
            output: `Agent "${currentAgent}" not found in registry`,
            rateLimited: false,
            durationMs: 0,
            estimatedCost: 0,
          };
          return { result: noAdapterResult, fallbacks, finalBundle: currentBundle, finalPrompt };
        }
        try {
          result = await adapter.run(request.runOptions);
        } catch (err) {
          result = {
            success: false,
            exitCode: 1,
            output: err instanceof Error ? err.message : String(err),
            rateLimited: false,
            durationMs: 0,
            estimatedCost: 0,
            adapterFailure: {
              category: "quality",
              outcome: "fail-unknown",
              retriable: false,
              message: String(err).slice(0, 500),
            },
          };
        }
      }

      if (result.success) return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };

      const bundleForSwapCheck = updatedBundle ?? request.bundle;

      if (!this.shouldSwap(result.adapterFailure, hopsSoFar, bundleForSwapCheck)) {
        // Preserve legacy rate-limit backoff when no swap candidates are available.
        // #585 Path B: race the sleep against the shutdown signal — an abort during
        // backoff settles within milliseconds instead of the full exponential wait.
        if (result.adapterFailure?.outcome === "fail-rate-limit" && rateLimitRetry < MAX_RATE_LIMIT_RETRIES) {
          if (request.signal?.aborted) {
            logger?.info("agent-manager", "Rate-limited backoff aborted — shutdown in progress", {
              storyId: request.runOptions.storyId,
            });
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
          }
          rateLimitRetry += 1;
          const backoffMs = 2 ** rateLimitRetry * 1000;
          logger?.info("agent-manager", "Rate-limited with no swap candidate — backing off", {
            storyId: request.runOptions.storyId,
            attempt: rateLimitRetry,
            backoffMs,
          });
          await _agentManagerDeps.sleep(backoffMs, request.signal);
          if (request.signal?.aborted) {
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
          }
          continue;
        }
        if (hopsSoFar > 0) {
          this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
        }
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
      }

      const adapterFailure = result.adapterFailure ?? {
        category: "quality" as const,
        outcome: "fail-unknown" as const,
        retriable: false,
        message: "",
      };
      // Mark the current agent unavailable BEFORE calling nextCandidate so the filter
      // in nextCandidate excludes the just-failed agent and selects the true next one.
      this.markUnavailable(currentAgent, adapterFailure);

      // Look up the fallback chain by the primary agent so flat maps like
      // { claude: ["codex", "gemini"] } work correctly across multiple hops.
      const next = this.nextCandidate(primaryAgent, hopsSoFar);
      if (!next) {
        this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
      }
      hopsSoFar += 1;
      // Reset per-agent rate-limit counter so the new agent gets its own backoff budget.
      rateLimitRetry = 0;
      currentBundle = updatedBundle;
      currentFailure = adapterFailure;

      const hop: AgentFallbackRecord = {
        storyId: request.runOptions.storyId,
        priorAgent: currentAgent,
        newAgent: next,
        hop: hopsSoFar,
        outcome: adapterFailure.outcome,
        category: adapterFailure.category,
        timestamp: new Date().toISOString(),
        costUsd: result.estimatedCost ?? 0,
      };
      fallbacks.push(hop);
      this._emitter.emit("onSwapAttempt", hop);

      logger?.info("agent-manager", "Agent swap triggered", {
        storyId: request.runOptions.storyId,
        fromAgent: currentAgent,
        toAgent: next,
        hop: hopsSoFar,
      });

      currentAgent = next;
    }
  }

  async completeWithFallback(
    prompt: string,
    options: CompleteOptions,
    primaryAgentOverride?: string,
  ): Promise<AgentCompleteOutcome> {
    const logger = getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    const primaryAgent = primaryAgentOverride ?? this.getDefault();
    let currentAgent = primaryAgent;
    let hopsSoFar = 0;

    while (true) {
      const adapter = this._resolveRegistry().getAgent(currentAgent);
      if (!adapter) {
        return {
          result: { output: "", costUsd: 0, source: "fallback" },
          fallbacks,
        };
      }

      let result: CompleteResult;
      try {
        result = await adapter.complete(prompt, options);
      } catch (err) {
        result = {
          output: "",
          costUsd: 0,
          source: "fallback",
          adapterFailure: {
            category: "quality",
            outcome: "fail-unknown",
            retriable: false,
            message: String(err).slice(0, 500),
          },
        };
      }

      if (!result.adapterFailure) return { result, fallbacks };

      // Pass a truthy sentinel bundle so shouldSwap's !bundle guard passes.
      // completeWithFallback never rebuilds context (no bundle in complete flow).
      if (!this.shouldSwap(result.adapterFailure, hopsSoFar, {} as ContextBundle)) {
        return { result, fallbacks };
      }

      // Mark unavailable before nextCandidate so the filter excludes the just-failed agent.
      this.markUnavailable(currentAgent, result.adapterFailure);
      const next = this.nextCandidate(primaryAgent, hopsSoFar);
      if (!next) return { result, fallbacks };

      hopsSoFar += 1;

      const hop: AgentFallbackRecord = {
        priorAgent: currentAgent,
        newAgent: next,
        hop: hopsSoFar,
        outcome: result.adapterFailure.outcome,
        category: result.adapterFailure.category,
        timestamp: new Date().toISOString(),
        costUsd: result.costUsd ?? 0,
      };
      fallbacks.push(hop);
      this._emitter.emit("onSwapAttempt", hop);

      logger?.info("agent-manager", "complete() swap triggered", {
        storyId: options.storyId,
        fromAgent: currentAgent,
        toAgent: next,
        hop: hopsSoFar,
      });

      currentAgent = next;
    }
  }

  async run(request: AgentRunRequest): Promise<import("./types").AgentResult> {
    const outcome = await this.runWithFallback(request);
    return { ...outcome.result, agentFallbacks: outcome.fallbacks };
  }

  async complete(
    prompt: string,
    options: import("./types").CompleteOptions,
  ): Promise<import("./types").CompleteResult> {
    const outcome = await this.completeWithFallback(prompt, options);
    return outcome.result;
  }

  getAgent(name: string): import("./types").AgentAdapter | undefined {
    return this._resolveRegistry().getAgent(name);
  }

  async runAs(agentName: string, request: AgentRunRequest): Promise<AgentResult> {
    const outcome = await this.runWithFallback(request, agentName);
    return { ...outcome.result, agentFallbacks: outcome.fallbacks };
  }

  async completeAs(agentName: string, prompt: string, options: CompleteOptions): Promise<CompleteResult> {
    const outcome = await this.completeWithFallback(prompt, options, agentName);
    return outcome.result;
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    return this.planAs(this.getDefault(), options);
  }

  async planAs(agentName: string, options: PlanOptions): Promise<PlanResult> {
    const adapter = this._resolveRegistry().getAgent(agentName);
    if (!adapter) return { specContent: `Agent "${agentName}" not found` };
    return adapter.plan(options);
  }

  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    return this.decomposeAs(this.getDefault(), options);
  }

  async decomposeAs(agentName: string, options: DecomposeOptions): Promise<DecomposeResult> {
    const adapter = this._resolveRegistry().getAgent(agentName);
    if (!adapter) return { stories: [] };
    return adapter.decompose(options);
  }

  private _resolveRegistry(): AgentRegistry {
    this._registry ??= createAgentRegistry(this._config);
    return this._registry;
  }

  /** @internal — test helper */
  _emit(
    event: AgentManagerEventName,
    payload:
      | AgentFallbackRecord
      | { agent: string; failure: AdapterFailure }
      | { agent: string; reason: string }
      | { storyId?: string; hops: number },
  ): void {
    this._emitter.emit(event, payload);
  }
}
