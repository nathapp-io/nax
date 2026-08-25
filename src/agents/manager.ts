/**
 * AgentManager — owns agent lifecycle and fallback policy (ADR-012).
 *
 * Phase 4: implements real shouldSwap, nextCandidate, runWithFallback, and
 * completeWithFallback. Adapter-owned fallback state removed.
 */

import { EventEmitter } from "node:events";
import { trackedSpawnDeadlines } from "@/config";
import type { AgentManagerConfig } from "@/config/selectors";
import { resolvePermissions } from "../config/permissions";
import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import type { PidRegistry } from "../execution/pid-registry";
import { getSafeLogger } from "../logger";
// Leaf import to avoid barrel cycle:
// src/runtime/index.ts → internal/agent-manager-factory → agents/factory → agents/manager → runtime/index.ts
import { MiddlewareChain } from "../runtime/agent-middleware";
import type { MiddlewareContext } from "../runtime/agent-middleware";
import type { IDispatchEventBus } from "../runtime/dispatch-events";
import { DispatchEventBus } from "../runtime/dispatch-events";
import { formatSessionName } from "../runtime/session-name";
import { cancellableDelay } from "../utils/bun-deps";
import { classifyCompleteException } from "./complete-exception-classifier";
import { buildCompleteEvent, buildDispatchErrorEvent, buildSessionTurnEvent } from "./manager-dispatch";
import type {
  AgentCompleteOutcome,
  AgentFallbackRecord,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  IAgentManager,
  RunAsSessionOpts,
  SessionRunHopFn,
} from "./manager-types";
import { createAgentRegistry } from "./registry";
import type { AgentRegistry } from "./registry";
import { defaultRetryStrategy } from "./retry/default-strategy";
import { type SameAgentRetryState, describeRetryLogEvent, trySameAgentRetry } from "./retry/hop-retry-policy";
import type { RetryContext, RetryStrategy } from "./retry/types";
import type { AgentResult, AgentRunOptions, CompleteOptions, CompleteResult, ResolvedCompleteOptions } from "./types";

type LoggerLike = {
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => void;
  info: (scope: string, msg: string, data?: Record<string, unknown>) => void;
};

/**
 * Upper bound on dispatch-event listeners before EventEmitter warns of a leak.
 * A single run legitimately attaches several listeners per concurrent story
 * (parallel mode), so the Node default of 10 is too low. We raise the ceiling
 * but deliberately keep it finite — `setMaxListeners(0)` (unlimited) would
 * disable the very warning that surfaces a genuine listener leak.
 */
const MAX_EMITTER_LISTENERS = 100;

export type SendPromptFn = (
  handle: import("./types").SessionHandle,
  prompt: string,
  opts: RunAsSessionOpts,
) => Promise<import("./types").TurnResult>;

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
  private readonly _config: AgentManagerConfig;
  private _registry: AgentRegistry | undefined;
  private readonly _unavailable = new Map<string, AdapterFailure>();
  private readonly _prunedFallback = new Set<string>();
  private readonly _emitter = (() => {
    const ee = new EventEmitter();
    ee.setMaxListeners(MAX_EMITTER_LISTENERS);
    return ee;
  })();
  private readonly _logger: LoggerLike;
  private _middleware: MiddlewareChain;
  private _runId: string;
  private _sendPrompt: SendPromptFn | undefined;
  private _runHop: SessionRunHopFn | undefined;
  private _dispatchEvents: IDispatchEventBus;
  private _pidRegistry: PidRegistry | undefined;
  private readonly _retryStrategy: RetryStrategy;
  readonly events: AgentManagerEvents;

  constructor(
    config: AgentManagerConfig,
    registry?: AgentRegistry,
    opts?: {
      logger?: LoggerLike;
      middleware?: MiddlewareChain;
      runId?: string;
      sendPrompt?: SendPromptFn;
      runHop?: SessionRunHopFn;
      dispatchEvents?: IDispatchEventBus;
      retryStrategy?: RetryStrategy;
    },
  ) {
    this._config = config;
    this._registry = registry;
    this._logger = opts?.logger ?? getSafeLogger() ?? { warn: () => {}, info: () => {} };
    this._middleware = opts?.middleware ?? MiddlewareChain.empty();
    this._runId = opts?.runId ?? crypto.randomUUID();
    this._sendPrompt = opts?.sendPrompt;
    this._runHop = opts?.runHop;
    this._dispatchEvents = opts?.dispatchEvents ?? new DispatchEventBus();
    this._retryStrategy = opts?.retryStrategy ?? defaultRetryStrategy;
    this.events = {
      on: (event, listener) => {
        this._emitter.on(event as AgentManagerEventName, listener as (...args: unknown[]) => void);
      },
    };
  }

  configureRuntime(opts: {
    middleware?: MiddlewareChain;
    runId?: string;
    sendPrompt?: SendPromptFn;
    runHop?: SessionRunHopFn;
    dispatchEvents?: IDispatchEventBus;
    pidRegistry?: PidRegistry;
  }): void {
    if (opts.middleware) this._middleware = opts.middleware;
    if (opts.runId) this._runId = opts.runId;
    if (opts.sendPrompt) this._sendPrompt = opts.sendPrompt;
    if (opts.runHop) this._runHop = opts.runHop;
    if (opts.dispatchEvents) this._dispatchEvents = opts.dispatchEvents;
    if (opts.pidRegistry) this._pidRegistry = opts.pidRegistry;
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
  resetTransientUnavailable(): void {
    for (const [agent, failure] of this._unavailable) {
      if (failure.outcome !== "fail-auth" && failure.outcome !== "fail-quota") this._unavailable.delete(agent);
    }
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

  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, hasBundle: boolean): boolean {
    if (!failure) return false;
    // abort = no swap (teardown); timeout = no swap (US-001 AC11, pool poison).
    if (failure.outcome === "fail-aborted" || failure.outcome === "fail-timeout") return false;
    const fallback = this._config.agent?.fallback;
    if (!fallback?.enabled) return false;
    if (!hasBundle) return false;
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

  // Swap hops produced here reach StoryMetrics.fallback via the run-scoped
  // ctx.runtime.agentFallbacks sink, written by recordAgentFallbacks at the
  // callOp seam (#1707) — result-side data never back-flows through
  // CallContext, per .claude/rules/adapter-wiring.md Rule 6.
  async runWithFallback(request: AgentRunRequest, primaryAgentOverride?: string): Promise<AgentRunOutcome> {
    const logger = getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    const primaryAgent = primaryAgentOverride ?? this.getDefault();
    let currentAgent = primaryAgent;
    let hopsSoFar = 0;
    let rateLimitRetry = 0;
    let staleRetryAttempts = 0;
    let timeoutRetryAttempts = 0;
    let adapterErrorRetries = 0;
    let currentBundle = request.bundle;
    let currentRunOptions: AgentRunOptions = request.runOptions;
    let currentHopKind: import("./manager-types").HopKind = { kind: "primary" };
    let finalPrompt: string | undefined;

    const _opStartMs = Date.now();
    const _agentChain: string[] = [primaryAgent];
    let _finalStatus: "ok" | "exhausted" | "cancelled" | "error" = "error";
    let _totalCostUsd = 0;

    try {
      while (true) {
        let result: AgentResult;
        let updatedBundle = currentBundle;

        if (request.executeHop) {
          const hopOut = await request.executeHop(currentAgent, currentBundle, currentHopKind, currentRunOptions);
          result = hopOut.result;
          updatedBundle = hopOut.bundle ?? currentBundle;
          finalPrompt = hopOut.prompt ?? finalPrompt;
        } else {
          if (!this._runHop) {
            const unboundResult: AgentResult = {
              success: false,
              exitCode: 1,
              output: `AgentManager run hop is not wired for agent "${currentAgent}"`,
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
            };
            _finalStatus = "error";
            return { result: unboundResult, fallbacks, finalBundle: currentBundle, finalPrompt };
          }
          const rawHopOut = await this._runHop(currentAgent, currentRunOptions);
          // Normalize: support both wrapped SessionRunHopResult and flat AgentResult (test injection)
          const hopOut =
            "result" in rawHopOut && rawHopOut.result != null
              ? (rawHopOut as { result: AgentResult; prompt?: string })
              : { result: rawHopOut as unknown as AgentResult, prompt: undefined };
          result = hopOut.result;
          finalPrompt = hopOut.prompt ?? finalPrompt;
        }

        _totalCostUsd += result.estimatedCostUsd ?? 0;

        if (result.success) {
          _finalStatus = "ok";
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
        }

        const bundleForSwapCheck = updatedBundle ?? request.bundle;

        const isFailStale = result.adapterFailure?.outcome === "fail-stale";

        const retryState: SameAgentRetryState = {
          staleRetryAttempts,
          timeoutRetryAttempts,
          adapterErrorRetries,
          currentRunOptions,
        };
        const retryDecision = trySameAgentRetry(result, retryState, {
          config: this._config,
          requestRunOptions: request.runOptions,
          signal: request.signal,
        });

        if (retryDecision) {
          staleRetryAttempts =
            retryDecision.outcome === "stale-retry" ? retryDecision.staleRetryAttempts : staleRetryAttempts;
          timeoutRetryAttempts =
            retryDecision.outcome === "timeout-retry" ? retryDecision.timeoutRetryAttempts : timeoutRetryAttempts;
          adapterErrorRetries =
            retryDecision.outcome === "adapter-error" ? retryDecision.adapterErrorRetries : adapterErrorRetries;
          currentRunOptions =
            retryDecision.outcome === "timeout-retry" ? retryDecision.currentRunOptions : currentRunOptions;

          const retryHop: AgentFallbackRecord = {
            storyId: request.runOptions.storyId,
            priorAgent: currentAgent,
            newAgent: currentAgent,
            hop: retryDecision.kind.attempt,
            outcome: retryDecision.fallbackRecord.outcome,
            category: retryDecision.fallbackRecord.category,
            timestamp: new Date().toISOString(),
            costUsd: retryDecision.fallbackRecord.costUsd,
          };
          const logEvent = describeRetryLogEvent(retryDecision, request.runOptions.storyId, currentAgent);
          if (logEvent.recordFallback) {
            fallbacks.push(retryHop);
            this._emitter.emit("onSwapAttempt", retryHop);
          }
          if (logEvent.level === "warn") {
            logger?.warn("agent-manager", logEvent.message, logEvent.fields);
          } else {
            logger?.info("agent-manager", logEvent.message, logEvent.fields);
          }
          currentHopKind = retryDecision.kind;
          continue;
        }

        // Op-level opt-out (TDD ops per ADR-018 §5.2). Returns the primary-agent
        // result without entering the swap branch. Same-agent retries (fail-stale,
        // fail-timeout, fail-adapter-error) fire before this gate so single-agent
        // ops still benefit from bounded retry; only the swap path is suppressed.
        if (request.noFallback) {
          _finalStatus = "error";
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
        }

        // For fail-stale, treat hasBundle as true: session restarts don't require
        // context rebuild to decide whether to swap to a fallback agent.
        const hasBundleForSwap = !!bundleForSwapCheck || isFailStale;

        if (!this.shouldSwap(result.adapterFailure, hopsSoFar, hasBundleForSwap)) {
          // For fail-stale with no swap available: exit immediately without backoff.
          // The session was stale — retrying with backoff won't help if no fallback exists.
          if (isFailStale) {
            logger?.warn("agent-manager", "fail-stale: no swap candidate, returning terminal failure", {
              storyId: request.runOptions.storyId,
            });
            _finalStatus = "error";
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
          }
          // Preserve legacy rate-limit backoff when no swap candidates are available.
          // #585 Path B: race the sleep against the shutdown signal — an abort during
          // backoff settles within milliseconds instead of the full exponential wait.
          if (result.adapterFailure) {
            const retryCtx: RetryContext = {
              site: "run",
              agentName: currentAgent,
              stage: request.runOptions.pipelineStage ?? "run",
              storyId: request.runOptions.storyId,
            };
            const decision = this._retryStrategy.shouldRetry(result.adapterFailure, rateLimitRetry, retryCtx);
            if (decision.retry) {
              if (request.signal?.aborted) {
                logger?.info("agent-manager", "Rate-limited backoff aborted — shutdown in progress", {
                  storyId: request.runOptions.storyId,
                });
                _finalStatus = "cancelled";
                return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
              }
              rateLimitRetry += 1;
              logger?.info("agent-manager", "Rate-limited with no swap candidate — backing off", {
                storyId: request.runOptions.storyId,
                attempt: rateLimitRetry,
                backoffMs: decision.delayMs,
              });
              await _agentManagerDeps.sleep(decision.delayMs, request.signal);
              if (request.signal?.aborted) {
                _finalStatus = "cancelled";
                return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
              }
              continue;
            }
          }
          if (hopsSoFar > 0) {
            this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
            _finalStatus = "exhausted";
          } else {
            _finalStatus = "error";
          }
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
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
          _finalStatus = "exhausted";
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
        }
        hopsSoFar += 1;
        // Reset per-agent rate-limit counter so the new agent gets its own backoff budget.
        rateLimitRetry = 0;
        currentBundle = updatedBundle;
        currentHopKind = { kind: "swap", failure: adapterFailure };

        const hop: AgentFallbackRecord = {
          storyId: request.runOptions.storyId,
          priorAgent: currentAgent,
          newAgent: next,
          hop: hopsSoFar,
          outcome: adapterFailure.outcome,
          category: adapterFailure.category,
          timestamp: new Date().toISOString(),
          costUsd: result.estimatedCostUsd ?? 0,
        };
        fallbacks.push(hop);
        this._emitter.emit("onSwapAttempt", hop);

        logger?.info("agent-manager", "Agent swap triggered", {
          storyId: request.runOptions.storyId,
          fromAgent: currentAgent,
          toAgent: next,
          hop: hopsSoFar,
        });

        _agentChain.push(next);
        currentAgent = next;
      }
    } finally {
      this._dispatchEvents.emitOperationCompleted({
        kind: "operation-completed",
        operation: "run-with-fallback",
        agentChain: _agentChain,
        hopCount: hopsSoFar,
        fallbackTriggered: fallbacks.length > 0,
        totalElapsedMs: Date.now() - _opStartMs,
        totalCostUsd: _totalCostUsd,
        finalStatus: _finalStatus,
        storyId: request.runOptions.storyId,
        stage: request.runOptions.pipelineStage ?? "run",
        timestamp: Date.now(),
        ...(request.runOptions.callId !== undefined ? { callId: request.runOptions.callId } : {}),
        ...(request.runOptions.scopeId !== undefined ? { scopeId: request.runOptions.scopeId } : {}),
      });
    }
  }

  async completeWithFallback(
    prompt: string,
    options: ResolvedCompleteOptions,
    primaryAgentOverride?: string,
  ): Promise<AgentCompleteOutcome> {
    const logger = getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    const primaryAgent = primaryAgentOverride ?? this.getDefault();
    let currentAgent = primaryAgent;
    let hopsSoFar = 0;
    let staleRetryAttempts = 0;
    const maxStaleRetries = this._config.agent?.idleWatchdog?.maxRetryAttempts ?? 3;

    const _opStartMs = Date.now();
    const _agentChain: string[] = [primaryAgent];
    let _finalStatus: "ok" | "exhausted" | "cancelled" | "error" = "error";
    let _totalCostUsd = 0;

    try {
      while (true) {
        const adapter = this._resolveRegistry().getAgent(currentAgent);
        if (!adapter) {
          _finalStatus = "error";
          throw new NaxError(`Agent "${currentAgent}" not found in registry`, "AGENT_NOT_FOUND", {
            stage: "complete",
            agentName: currentAgent,
          });
        }

        let result: CompleteResult;
        try {
          const optionsWithLifecycle: ResolvedCompleteOptions = this._pidRegistry
            ? {
                ...options,
                onPidSpawned: (pid: number) => this._pidRegistry?.register(pid),
                onPidExited: (pid: number) => this._pidRegistry?.unregister(pid),
              }
            : options;
          result = await adapter.complete(prompt, optionsWithLifecycle);
        } catch (err) {
          result = {
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            adapterFailure: classifyCompleteException(err),
          };
        }

        _totalCostUsd += result.estimatedCostUsd;

        // Synthesize fail-stale when agent returns empty output with no pre-existing failure.
        // Mirrors sendWithFileOutput synthesis in call.ts for run-kind ops (spec §B2).
        if (!result.adapterFailure && !result.output?.trim()) {
          result = {
            ...result,
            adapterFailure: {
              outcome: "fail-stale",
              category: "availability",
              retriable: true,
              message: "[completeWithFallback] agent returned no output",
              reason: "empty-output",
            },
          };
        }

        if (!result.adapterFailure) {
          _finalStatus = "ok";
          return { result, fallbacks };
        }

        // fail-stale same-agent retry (mirrors runWithFallback pattern at manager.ts:275-298).
        const isFailStale = result.adapterFailure.outcome === "fail-stale";
        if (isFailStale && result.adapterFailure.retriable && staleRetryAttempts < maxStaleRetries) {
          staleRetryAttempts++;
          const retryHop: AgentFallbackRecord = {
            storyId: options.storyId,
            priorAgent: currentAgent,
            newAgent: currentAgent,
            hop: staleRetryAttempts,
            outcome: result.adapterFailure.outcome,
            category: result.adapterFailure.category,
            timestamp: new Date().toISOString(),
            costUsd: result.estimatedCostUsd,
          };
          fallbacks.push(retryHop);
          this._emitter.emit("onSwapAttempt", retryHop);
          logger?.info("agent-manager", "completeWithFallback: fail-stale same-agent retry", {
            storyId: options.storyId,
            attempt: staleRetryAttempts,
            agent: currentAgent,
            reason: result.adapterFailure.reason,
          });
          continue;
        }

        // completeWithFallback has no ContextBundle object, but swap is still allowed on
        // availability failures — pass true so the hasBundle guard does not block swapping.
        if (!this.shouldSwap(result.adapterFailure, hopsSoFar, true)) {
          _finalStatus = hopsSoFar > 0 ? "exhausted" : "error";
          return { result, fallbacks };
        }

        // Mark unavailable before nextCandidate so the filter excludes the just-failed agent.
        this.markUnavailable(currentAgent, result.adapterFailure);
        const next = this.nextCandidate(primaryAgent, hopsSoFar);
        if (!next) {
          _finalStatus = "exhausted";
          return { result, fallbacks };
        }

        hopsSoFar += 1;

        const hop: AgentFallbackRecord = {
          priorAgent: currentAgent,
          newAgent: next,
          hop: hopsSoFar,
          outcome: result.adapterFailure.outcome,
          category: result.adapterFailure.category,
          timestamp: new Date().toISOString(),
          costUsd: result.estimatedCostUsd,
        };
        fallbacks.push(hop);
        this._emitter.emit("onSwapAttempt", hop);

        logger?.info("agent-manager", "complete() swap triggered", {
          storyId: options.storyId,
          fromAgent: currentAgent,
          toAgent: next,
          hop: hopsSoFar,
        });

        _agentChain.push(next);
        currentAgent = next;
      }
    } finally {
      this._dispatchEvents.emitOperationCompleted({
        kind: "operation-completed",
        operation: "complete-with-fallback",
        agentChain: _agentChain,
        hopCount: hopsSoFar,
        fallbackTriggered: fallbacks.length > 0,
        totalElapsedMs: Date.now() - _opStartMs,
        totalCostUsd: _totalCostUsd,
        finalStatus: _finalStatus,
        storyId: options.storyId,
        stage: options.pipelineStage ?? "complete",
        timestamp: Date.now(),
        ...(options.callId !== undefined ? { callId: options.callId } : {}),
        ...(options.scopeId !== undefined ? { scopeId: options.scopeId } : {}),
      });
    }
  }

  async run(request: AgentRunRequest): Promise<AgentResult> {
    return this.runAs(this.getDefault(), request);
  }

  async complete(prompt: string, options: CompleteOptions): Promise<CompleteResult> {
    return this.completeAs(this.getDefault(), prompt, options);
  }

  getAgent(name: string): import("./types").AgentAdapter | undefined {
    return this._resolveRegistry().getAgent(name);
  }

  async runAs(agentName: string, request: AgentRunRequest): Promise<AgentResult> {
    const runConfig = request.runOptions.config ?? this._config;
    const resolvedPermissions = resolvePermissions(runConfig, request.runOptions.pipelineStage ?? "run");
    const augmented: AgentRunRequest = {
      ...request,
      runOptions: { ...request.runOptions, resolvedPermissions },
    };
    // runBefore retained for cancellationMiddleware — the only remaining middleware after ADR-020 Wave 1.
    const ctx: MiddlewareContext = {
      runId: this._runId,
      agentName,
      kind: "run",
      request: augmented,
      config: runConfig,
      signal: request.signal ?? request.runOptions.abortSignal,
      resolvedPermissions,
      storyId: request.runOptions.storyId,
      stage: request.runOptions.pipelineStage,
    };
    await this._middleware.runBefore(ctx);
    if (!request.executeHop && !this._runHop && !this._resolveRegistry().getAgent(agentName)) {
      throw new NaxError(`Agent "${agentName}" not found in registry`, "AGENT_NOT_FOUND", {
        stage: "run",
        agentName,
      });
    }
    const outcome = await this.runWithFallback(augmented, agentName);
    return { ...outcome.result, agentFallbacks: outcome.fallbacks };
  }

  async runAsSession(
    agentName: string,
    handle: import("./types").SessionHandle,
    prompt: string,
    opts: RunAsSessionOpts,
  ): Promise<import("./types").TurnResult> {
    if (!this._sendPrompt) {
      throw new NaxError(
        "AgentManager.runAsSession: _sendPrompt is not wired — pass sendPrompt at construction via NaxRuntime",
        "SEND_PROMPT_UNAVAILABLE",
        { stage: opts.pipelineStage ?? "run", agentName },
      );
    }
    const stage = opts.pipelineStage ?? "run";
    // SEC-3: per-package permissionProfile (monorepo). Per plan §3.3 Note: needs full NaxConfig.
    const resolvedPermissions = resolvePermissions(opts.config ?? this._config, stage);
    const sessionRole = handle.role ?? opts.sessionRole ?? "main";
    const start = Date.now();
    try {
      const rawResult = await this._sendPrompt(handle, prompt, opts);
      const result = {
        ...rawResult,
        protocolIds: rawResult.protocolIds ?? handle.protocolIds,
      };
      const event = buildSessionTurnEvent({
        handle,
        sessionRole,
        prompt,
        result,
        agentName,
        stage,
        opts,
        resolvedPermissions,
        profile: this._config.profile,
        startedAt: start,
      });
      this._dispatchEvents.emitDispatch(event);
      return result;
    } catch (err) {
      const errEvent = buildDispatchErrorEvent({
        origin: "runAsSession",
        agentName,
        stage,
        storyId: opts.storyId,
        error: err,
        prompt,
        resolvedPermissions,
        callId: opts.callId,
        scopeId: opts.scopeId,
        startedAt: start,
      });
      this._dispatchEvents.emitDispatchError(errEvent);
      throw err;
    }
  }

  async completeAs(agentName: string, prompt: string, options: CompleteOptions): Promise<CompleteResult> {
    const stage = options.pipelineStage ?? "complete";
    const resolvedPermissions = resolvePermissions(options.config ?? this._config, stage);
    const augmented: ResolvedCompleteOptions = {
      ...options,
      resolvedPermissions,
      promptRetries: this._config.agent?.acp?.promptRetries,
      ...trackedSpawnDeadlines(this._config),
    };
    const sessionName =
      options.sessionName ??
      formatSessionName({
        workdir: options.workdir ?? "",
        featureName: options.featureName,
        storyId: options.storyId,
        role: options.sessionRole,
      });
    const start = Date.now();
    try {
      const outcome = await this.completeWithFallback(prompt, augmented, agentName);
      const event = buildCompleteEvent({
        sessionName,
        prompt,
        response: outcome.result.output,
        agentName,
        stage,
        options,
        resolvedPermissions,
        tokenUsage: outcome.result.tokenUsage,
        estimatedCostUsd: outcome.result.estimatedCostUsd,
        exactCostUsd: outcome.result.exactCostUsd,
        profile: this._config.profile,
        startedAt: start,
      });
      this._dispatchEvents.emitDispatch(event);
      return outcome.result;
    } catch (err) {
      const errEvent = buildDispatchErrorEvent({
        origin: "completeAs",
        agentName,
        stage,
        storyId: options.storyId,
        error: err,
        prompt,
        resolvedPermissions,
        callId: options.callId,
        scopeId: options.scopeId,
        startedAt: start,
      });
      this._dispatchEvents.emitDispatchError(errEvent);
      throw err;
    }
  }

  close(): void {
    this._emitter.removeAllListeners();
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
