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
import type {
  AgentCompleteOutcome,
  AgentFallbackRecord,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  IAgentManager,
} from "./manager-types";
import type { AgentRegistry } from "./registry";
import type { AgentResult, CompleteOptions, CompleteResult } from "./types";

type LoggerLike = {
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => void;
  info: (scope: string, msg: string, data?: Record<string, unknown>) => void;
};

/** Injectable deps for testability (sleep). */
export const _agentManagerDeps = {
  sleep: (ms: number) => Bun.sleep(ms),
};

export class AgentManager implements IAgentManager {
  private readonly _config: NaxConfig;
  private readonly _registry: AgentRegistry | undefined;
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
    return this._config.autoMode.defaultAgent;
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
      const adapter = this._registry?.getAgent(name);
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
    const fallback = this._config.agent?.fallback;
    if (!fallback?.enabled) return false;
    if (!bundle) return false;
    if (hopsSoFar >= (fallback.maxHopsPerStory ?? 2)) return false;
    if (failure.category === "availability") return true;
    return fallback.onQualityFailure ?? false;
  }

  nextCandidate(current: string, hopsSoFar: number): string | null {
    const map = (this._config.agent?.fallback?.map ?? {}) as Record<string, string[]>;
    const candidates = (map[current] ?? []).filter((a) => !this._prunedFallback.has(a) && !this.isUnavailable(a));
    // Index by hopsSoFar: works correctly when `current` stays the default agent throughout the chain.
    // Multi-hop chains (claude→codex, codex→gemini with separate map entries) are not yet supported —
    // hop 1 would index map["codex"][1] and skip index 0. Operators should use a flat map for now:
    // { claude: ["codex", "gemini"] }.
    return candidates[hopsSoFar] ?? null;
  }

  async runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome> {
    const logger = getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    let currentAgent = this.getDefault();
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
        const adapter = this._registry?.getAgent(currentAgent);
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
        // Preserve legacy rate-limit backoff when no swap candidates are available
        if (result.adapterFailure?.outcome === "fail-rate-limit" && rateLimitRetry < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetry += 1;
          const backoffMs = 2 ** rateLimitRetry * 1000;
          logger?.info("agent-manager", "Rate-limited with no swap candidate — backing off", {
            storyId: request.runOptions.storyId,
            attempt: rateLimitRetry,
            backoffMs,
          });
          await _agentManagerDeps.sleep(backoffMs);
          continue;
        }
        if (hopsSoFar > 0) {
          this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
        }
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
      }

      const next = this.nextCandidate(currentAgent, hopsSoFar);
      if (!next) {
        this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
      }

      const adapterFailure = result.adapterFailure ?? {
        category: "quality" as const,
        outcome: "fail-unknown" as const,
        retriable: false,
        message: "",
      };
      this.markUnavailable(currentAgent, adapterFailure);
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

  async completeWithFallback(prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome> {
    const logger = getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    let currentAgent = this.getDefault();
    let hopsSoFar = 0;

    while (true) {
      const adapter = this._registry?.getAgent(currentAgent);
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

      const next = this.nextCandidate(currentAgent, hopsSoFar);
      if (!next) return { result, fallbacks };

      this.markUnavailable(currentAgent, result.adapterFailure);
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
