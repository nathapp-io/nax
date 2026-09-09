/** AgentManager owns agent lifecycle and fallback policy (ADR-012). */

import { EventEmitter } from "node:events";
import type { ModelsConfig } from "@/config/schema-types";
import type { AgentManagerConfig } from "@/config/selectors";
import { resolvePermissions } from "../config/permissions";
import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import type { PidRegistry } from "../execution/pid-registry";
import { getSafeLogger } from "../logger";
import type { MiddlewareContext } from "../runtime/agent-middleware";
// Leaf import to avoid barrel cycle:
// src/runtime/index.ts → internal/agent-manager-factory → agents/factory → agents/manager → runtime/index.ts
import { MiddlewareChain } from "../runtime/agent-middleware";
import type { IDispatchEventBus } from "../runtime/dispatch-events";
import { DispatchEventBus } from "../runtime/dispatch-events";
// Nested-barrel alias, not the parent barrel — the parent closes a runtime import cycle (check:import-cycles).
import { resolveIdleWatchdogSettings } from "../runtime/middleware/idle-watchdog";
import { cancellableDelay } from "../utils/bun-deps";
import { classifyCompleteException } from "./complete-exception-classifier";
import { CooldownStore } from "./cooldown-store";
import { resolveFallbackDispatchTarget, resolveFallbackModelId, sameFallbackHop } from "./fallback-model-identity";
import { StoryHopBudget } from "./hop-budget";
import {
  buildCompleteCallPreamble,
  buildCompleteEvent,
  buildCompleteOutcome,
  buildDispatchErrorEvent,
  buildFallbackRecord,
  buildSessionTurnEvent,
  resolveFinalDispatch,
  resolveHopCompleteOptions,
  validateAgentCredentials,
} from "./manager-dispatch";
import { type ManagerExhaustionOptions, resolveManagerExhaustion } from "./manager-exhaustion";
import { runWithFallback } from "./manager-run-fallback";
import type {
  AgentCompleteOutcome,
  AgentFallbackRecord,
  AgentManagerCtorOpts,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  IAgentManager,
  LoggerLike,
  RunAsSessionOpts,
  SendPromptFn,
  SessionRunHopFn,
} from "./manager-types";
import type { AgentRegistry } from "./registry";
import { createAgentRegistry } from "./registry";
import { defaultRetryStrategy } from "./retry/default-strategy";
import type { RetryStrategy } from "./retry/types";
import {
  availableCandidates,
  credentialCandidates,
  decideSwap,
  type FallbackTarget,
  logSwapDecline,
} from "./swap-decision";
import type { AgentResult, CompleteOptions, CompleteResult, ResolvedCompleteOptions } from "./types";

/** Finite listener ceiling: concurrent stories exceed Node's default of 10. */
const MAX_EMITTER_LISTENERS = 100;

/** Injectable deps for testability. */
export const _agentManagerDeps = {
  /** Cancellable backoff delay, injectable for tests. */
  sleep: (ms: number, signal?: AbortSignal) => cancellableDelay(ms, signal),
  /** Injectable clock for cooldown expiry tests. */
  now: () => Date.now(),
};

export class AgentManager implements IAgentManager {
  private readonly _config: AgentManagerConfig;
  private _registry: AgentRegistry | undefined;
  private readonly _cooldowns = new CooldownStore(() => _agentManagerDeps.now());
  private readonly _prunedFallback = new Set<string>();
  private readonly _budget = new StoryHopBudget();
  private readonly _emitter = (() => {
    const ee = new EventEmitter();
    ee.setMaxListeners(MAX_EMITTER_LISTENERS);
    return ee;
  })();
  private readonly _logger: LoggerLike;
  private readonly _loggerOverride: LoggerLike | undefined;
  private _middleware: MiddlewareChain;
  private _runId: string;
  private _sendPrompt: SendPromptFn | undefined;
  private _runHop: SessionRunHopFn | undefined;
  private _dispatchEvents: IDispatchEventBus;
  private _pidRegistry: PidRegistry | undefined;
  private readonly _retryStrategy: RetryStrategy;
  private readonly _models: ModelsConfig | undefined;
  readonly events: AgentManagerEvents;

  constructor(config: AgentManagerConfig, registry?: AgentRegistry, opts?: AgentManagerCtorOpts) {
    this._config = config;
    this._registry = registry;
    this._loggerOverride = opts?.logger;
    this._logger = opts?.logger ?? getSafeLogger() ?? { warn: () => {}, info: () => {} };
    this._middleware = opts?.middleware ?? MiddlewareChain.empty();
    this._runId = opts?.runId ?? crypto.randomUUID();
    this._sendPrompt = opts?.sendPrompt;
    this._runHop = opts?.runHop;
    this._dispatchEvents = opts?.dispatchEvents ?? new DispatchEventBus();
    this._retryStrategy = opts?.retryStrategy ?? defaultRetryStrategy;
    this._models = opts?.models;
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

  isUnavailable(agent: string, tier?: string, model?: string): boolean {
    return this._cooldowns.isCooling(agent, tier, this._modelId(agent, tier, model));
  }

  markUnavailable(agent: string, reason: AdapterFailure, tier?: string, model?: string): void {
    this._cooldowns.mark(agent, reason, tier, this._modelId(agent, tier, model));
    this._emitter.emit("onAgentUnavailable", { agent, tier, failure: reason });
  }

  reset(): void {
    this._cooldowns.clear();
    this._prunedFallback.clear();
    this._budget.clear();
  }

  resetTransientUnavailable(): void {
    this._cooldowns.sweepTransient();
  }
  async validateCredentials(): Promise<void> {
    const primary = this.getDefault();
    const { pruned } = await validateAgentCredentials({
      primary,
      candidates: credentialCandidates(this._config.agent?.fallback?.map, primary),
      getAgent: (name) => this._resolveRegistry().getAgent(name),
      logger: this._logger,
    });
    for (const name of pruned) this._prunedFallback.add(name);
  }

  private readonly _modelId = (agent: string, tier?: string, model?: string): string | undefined =>
    resolveFallbackModelId(this._models, agent, tier, this.getDefault(), model);
  private readonly _isExcluded = (c: string, t?: string, m?: string): boolean =>
    this._prunedFallback.has(c) || this._cooldowns.isCooling(c, t, this._modelId(c, t, m));
  private readonly _sameHop = (a: string, b: string | undefined, at?: string, am?: string, bt?: string, bm?: string) =>
    sameFallbackHop(this._models, this.getDefault(), a, b, at, am, bt, bm);

  /** Folds a `{ agent, model }` target naming a tier into `{ agent, tier }`. */
  private readonly _resolveTarget = (t: FallbackTarget): FallbackTarget =>
    resolveFallbackDispatchTarget(this._models, this.getDefault(), t);

  resolveFallbackChain(agent: string, _failure: AdapterFailure): import("./swap-decision").FallbackTarget[] {
    return availableCandidates(this._config.agent?.fallback?.map, agent, this._isExcluded, this._resolveTarget);
  }

  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number): boolean {
    return decideSwap(failure, hopsSoFar, this._config.agent?.fallback).swap;
  }

  nextCandidate(cur: string, _hops: number, exclude?: string, tier?: string, model?: string): FallbackTarget | null {
    const excluded = (c: string, t?: string, m?: string): boolean =>
      this._sameHop(c, exclude, t, m, tier, model) || this._isExcluded(c, t, m);
    return availableCandidates(this._config.agent?.fallback?.map, cur, excluded, this._resolveTarget)[0] ?? null;
  }

  async runWithFallback(request: AgentRunRequest, primaryAgentOverride?: string): Promise<AgentRunOutcome> {
    return runWithFallback({
      request,
      primaryAgentOverride,
      config: this._config,
      budget: this._budget,
      runHop: this._runHop,
      dispatchEvents: this._dispatchEvents,
      logger: this._loggerOverride ?? getSafeLogger(),
      getDefault: () => this.getDefault(),
      isUnavailable: (agent, tier) => this.isUnavailable(agent, tier),
      markUnavailable: (agent, failure, tier, model) => this.markUnavailable(agent, failure, tier, model),
      nextCandidate: (cur, hops, exclude, tier, model) => this.nextCandidate(cur, hops, exclude, tier, model),
      resolveExhaustion: (options) => this._resolveExhaustion(options),
      emitSwapAttempt: (fallback) => this._emitter.emit("onSwapAttempt", fallback),
    });
  }

  async completeWithFallback(
    prompt: string,
    options: ResolvedCompleteOptions,
    primaryAgentOverride?: string,
  ): Promise<AgentCompleteOutcome> {
    const logger = this._loggerOverride ?? getSafeLogger();
    const fallbacks: AgentFallbackRecord[] = [];
    const primaryAgent = primaryAgentOverride ?? this.getDefault();
    let currentAgent = primaryAgent;
    let currentTier: string | undefined;
    let currentModel: string | undefined;
    let currentTarget: FallbackTarget = { agent: primaryAgent };
    let hopsSoFar = this._budget.spent(options.storyId);
    let staleRetryAttempts = 0;
    let rateLimitRetry = 0;
    const maxStaleRetries = resolveIdleWatchdogSettings(this._config.agent?.idleWatchdog).maxRetryAttempts;

    const _opStartMs = Date.now();
    const _agentChain: string[] = [primaryAgent];
    let _finalStatus: "ok" | "exhausted" | "cancelled" | "error" = "error";
    let _totalCostUsd = 0;

    try {
      while (true) {
        const hopOptions = resolveHopCompleteOptions(options, currentAgent, primaryAgent, currentTier, currentModel);
        const adapter = this._resolveRegistry().getAgent(currentAgent);
        if (!adapter) {
          _finalStatus = "error";
          throw new NaxError(`Agent "${currentAgent}" not found in registry`, "AGENT_NOT_FOUND", {
            stage: "complete",
            agentName: currentAgent,
            modelDef: hopOptions.modelDef,
            modelTier: currentTier,
          });
        }

        let result: CompleteResult;
        try {
          const optionsWithLifecycle: ResolvedCompleteOptions = this._pidRegistry
            ? {
                ...hopOptions,
                onPidSpawned: (pid: number) => this._pidRegistry?.register(pid),
                onPidExited: (pid: number) => this._pidRegistry?.unregister(pid),
              }
            : hopOptions;
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
          return buildCompleteOutcome(result, fallbacks, currentTier, currentTarget);
        }

        const isFailStale = result.adapterFailure.outcome === "fail-stale";
        if (isFailStale && result.adapterFailure.retriable && staleRetryAttempts < maxStaleRetries) {
          staleRetryAttempts++;
          const retryHop = buildFallbackRecord({
            storyId: options.storyId,
            priorAgent: currentAgent,
            newAgent: currentAgent,
            hop: staleRetryAttempts,
            failure: result.adapterFailure,
            costUsd: result.estimatedCostUsd,
          });
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

        const dec = decideSwap(result.adapterFailure, hopsSoFar, this._config.agent?.fallback);
        if (!dec.swap) {
          logSwapDecline(logger, dec.reason, {
            storyId: options.storyId,
            agent: currentAgent,
            hopsSoFar,
            failure: result.adapterFailure,
          });
          const outcome = await this._resolveExhaustion({
            failure: result.adapterFailure,
            hopsSoFar,
            attempt: rateLimitRetry,
            swapWasPossible: dec.reason === "hop-cap-reached",
            agent: currentAgent,
            site: "complete",
            storyId: options.storyId,
            stage: options.pipelineStage ?? "run",
            signal: options.signal,
          });
          if (outcome === "cancelled") {
            _finalStatus = "cancelled";
            return buildCompleteOutcome(result, fallbacks, currentTier, currentTarget);
          }
          if (outcome === "retry") {
            rateLimitRetry += 1;
            continue;
          }
          _finalStatus = hopsSoFar > 0 ? "exhausted" : "error";
          return buildCompleteOutcome(result, fallbacks, currentTier, currentTarget);
        }

        this.markUnavailable(currentAgent, result.adapterFailure, currentTier, undefined);
        const next = this.nextCandidate(primaryAgent, hopsSoFar, currentAgent, currentTier, undefined);
        if (!next) {
          const outcome = await this._resolveExhaustion({
            failure: result.adapterFailure,
            hopsSoFar,
            attempt: rateLimitRetry,
            swapWasPossible: true,
            agent: currentAgent,
            site: "complete",
            storyId: options.storyId,
            stage: options.pipelineStage ?? "run",
            signal: options.signal,
          });
          if (outcome === "cancelled") {
            _finalStatus = "cancelled";
            return buildCompleteOutcome(result, fallbacks, currentTier, currentTarget);
          }
          if (outcome === "retry") {
            rateLimitRetry += 1;
            continue;
          }
          _finalStatus = "exhausted";
          return buildCompleteOutcome(result, fallbacks, currentTier, currentTarget);
        }

        hopsSoFar = this._budget.spend(options.storyId, hopsSoFar);

        const hop = buildFallbackRecord({
          storyId: options.storyId,
          priorAgent: currentAgent,
          newAgent: next.agent,
          hop: hopsSoFar,
          failure: result.adapterFailure,
          costUsd: result.estimatedCostUsd,
        });
        fallbacks.push(hop);
        this._emitter.emit("onSwapAttempt", hop);

        logger?.info("agent-manager", "complete() swap triggered", {
          storyId: options.storyId,
          fromAgent: currentAgent,
          toAgent: next.agent,
          hop: hopsSoFar,
        });

        _agentChain.push(next.agent);
        [currentAgent, currentTier, currentModel] = [next.agent, next.tier, next.model];
        currentTarget = next;
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
    const sendPrompt: SendPromptFn = this._sendPrompt;
    const stage = opts.pipelineStage ?? "run";
    // SEC-3: per-package permissionProfile (monorepo). Per plan §3.3 Note: needs full NaxConfig.
    const resolvedPermissions = resolvePermissions(opts.config ?? this._config, stage);
    const sessionRole = handle.role ?? opts.sessionRole ?? "main";
    const start = Date.now();
    try {
      const rawResult = await sendPrompt(handle, prompt, opts);
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
      // US-001: forward handle.modelDef/modelTier so the error event records the same model attribution the success path would have.
      const errEvent = buildDispatchErrorEvent({
        origin: "runAsSession",
        agentName,
        stage,
        error: err,
        prompt,
        resolvedPermissions,
        startedAt: start,
        dispatchOptions: { ...opts, sessionRole, modelDef: handle.modelDef, modelTier: handle.modelTier },
      });
      this._dispatchEvents.emitDispatchError(errEvent);
      throw err;
    }
  }

  /** One-shot completion pinned to an agent, surfacing its agent-swap records (nax#1712). */
  async completeAsWithFallback(
    agentName: string,
    prompt: string,
    options: CompleteOptions,
  ): Promise<AgentCompleteOutcome> {
    const stage = options.pipelineStage ?? "complete";
    const { resolvedPermissions, augmented, sessionName } = buildCompleteCallPreamble({
      options,
      config: this._config,
      stage,
    });
    const start = Date.now();
    try {
      const outcome = await this.completeWithFallback(prompt, augmented, agentName);
      const event = buildCompleteEvent({
        sessionName,
        prompt,
        response: outcome.result.output,
        ...resolveFinalDispatch(augmented, agentName, outcome.fallbacks, outcome.finalTier),
        stage,
        resolvedPermissions,
        tokenUsage: outcome.result.tokenUsage,
        estimatedCostUsd: outcome.result.estimatedCostUsd,
        exactCostUsd: outcome.result.exactCostUsd,
        profile: this._config.profile,
        startedAt: start,
        sessionId: outcome.result.sessionId,
        ...(outcome.result.pricingSource !== undefined ? { pricingSource: outcome.result.pricingSource } : {}),
      });
      this._dispatchEvents.emitDispatch(event);
      return outcome;
    } catch (err) {
      const errorContext = err instanceof NaxError ? err.context : undefined;
      const dispatch = errorContext as
        | { agentName?: string; modelDef?: ResolvedCompleteOptions["modelDef"]; modelTier?: string }
        | undefined;
      const errEvent = buildDispatchErrorEvent({
        origin: "completeAs",
        agentName: dispatch?.agentName ?? agentName,
        stage,
        error: err,
        prompt,
        resolvedPermissions,
        startedAt: start,
        dispatchOptions: {
          ...options,
          ...(dispatch?.modelDef !== undefined ? { modelDef: dispatch.modelDef } : {}),
          ...(dispatch?.modelTier !== undefined ? { modelTier: dispatch.modelTier } : {}),
        },
      });
      this._dispatchEvents.emitDispatchError(errEvent);
      throw err;
    }
  }

  async completeAs(agentName: string, prompt: string, options: CompleteOptions): Promise<CompleteResult> {
    return (await this.completeAsWithFallback(agentName, prompt, options)).result;
  }

  private _resolveExhaustion(options: Omit<ManagerExhaustionOptions, "retryStrategy" | "sleep" | "onExhausted">) {
    return resolveManagerExhaustion({
      ...options,
      retryStrategy: this._retryStrategy,
      sleep: _agentManagerDeps.sleep,
      onExhausted: (hops) => this._emitter.emit("onSwapExhausted", { storyId: options.storyId, hops }),
    });
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
