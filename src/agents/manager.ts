/**
 * AgentManager — owns agent lifecycle and fallback policy (ADR-012).
 *
 * Phase 4: implements real shouldSwap, nextCandidate, runWithFallback, and
 * completeWithFallback. Adapter-owned fallback state removed.
 */

import { EventEmitter } from "node:events";
import type { NaxConfig } from "../config";
import { resolvePermissions } from "../config/permissions";
import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
// Leaf import to avoid barrel cycle:
// src/runtime/index.ts → internal/agent-manager-factory → agents/factory → agents/manager → runtime/index.ts
import { MiddlewareChain } from "../runtime/agent-middleware";
import type { MiddlewareContext } from "../runtime/agent-middleware";
import { cancellableDelay } from "../utils/bun-deps";
import { buildContextToolPreamble, buildRunInteractionHandler, computeAcpHandle } from "./acp/adapter";
import type {
  AgentCompleteOutcome,
  AgentFallbackRecord,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  IAgentManager,
  RunAsSessionOpts,
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
import { SessionFailureError } from "./types";

type LoggerLike = {
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => void;
  info: (scope: string, msg: string, data?: Record<string, unknown>) => void;
};

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
  private readonly _config: NaxConfig;
  private _registry: AgentRegistry | undefined;
  private readonly _unavailable = new Map<string, AdapterFailure>();
  private readonly _prunedFallback = new Set<string>();
  private readonly _emitter = new EventEmitter();
  private readonly _logger: LoggerLike;
  private readonly _middleware: MiddlewareChain;
  private readonly _runId: string;
  private readonly _sendPrompt: SendPromptFn | undefined;
  readonly events: AgentManagerEvents;

  constructor(
    config: NaxConfig,
    registry?: AgentRegistry,
    opts?: { logger?: LoggerLike; middleware?: MiddlewareChain; runId?: string; sendPrompt?: SendPromptFn },
  ) {
    this._config = config;
    this._registry = registry;
    this._logger = opts?.logger ?? getSafeLogger() ?? { warn: () => {}, info: () => {} };
    this._middleware = opts?.middleware ?? MiddlewareChain.empty();
    this._runId = opts?.runId ?? crypto.randomUUID();
    this._sendPrompt = opts?.sendPrompt;
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

  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, hasBundle: boolean): boolean {
    if (!failure) return false;
    // Aborted runs (shutdown in progress) must not trigger fallback —
    // swapping to another agent would spawn fresh work during teardown.
    if (failure.outcome === "fail-aborted") return false;
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
        const hopOut = await request.executeHop(currentAgent, currentBundle, currentFailure, request.runOptions);
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
        const startMs = Date.now();
        try {
          const opts = request.runOptions;
          const resolvedPerm =
            opts.resolvedPermissions ??
            resolvePermissions((opts.config as NaxConfig | undefined) ?? this._config, opts.pipelineStage ?? "run");
          const sessionName =
            opts.sessionHandle ??
            computeAcpHandle(opts.workdir ?? ".", opts.featureName, opts.storyId, opts.sessionRole);
          const handle = await adapter.openSession(sessionName, {
            agentName: adapter.name,
            workdir: opts.workdir,
            resolvedPermissions: resolvedPerm,
            modelDef: opts.modelDef,
            timeoutSeconds: opts.timeoutSeconds,
            onPidSpawned: opts.onPidSpawned,
            onSessionEstablished: opts.onSessionEstablished,
            signal: opts.abortSignal,
          });
          try {
            const hasContextTools = Boolean(opts.contextToolRuntime && (opts.contextPullTools?.length ?? 0) > 0);
            const maxTurns =
              opts.interactionBridge || hasContextTools
                ? (opts.maxInteractionTurns ?? 10)
                : (opts.maxInteractionTurns ?? 1);
            const turnResult = await adapter.sendTurn(handle, buildContextToolPreamble(opts), {
              interactionHandler: buildRunInteractionHandler(opts),
              signal: opts.abortSignal,
              maxTurns,
            });
            result = {
              success: true,
              exitCode: 0,
              output: turnResult.output,
              rateLimited: false,
              durationMs: Date.now() - startMs,
              estimatedCost: turnResult.cost?.total ?? 0,
              tokenUsage: turnResult.tokenUsage,
            };
          } finally {
            await adapter.closeSession(handle).catch(() => {});
          }
        } catch (err) {
          const sessionFailure = err instanceof SessionFailureError ? err.adapterFailure : undefined;
          result = {
            success: false,
            exitCode: 1,
            output: err instanceof Error ? err.message : String(err),
            rateLimited: sessionFailure?.outcome === "fail-rate-limit",
            durationMs: Date.now() - startMs,
            estimatedCost: 0,
            adapterFailure: sessionFailure ?? {
              category: "quality",
              outcome: "fail-unknown",
              retriable: false,
              message: String(err).slice(0, 500),
            },
          };
        }
      }

      if (result.success)
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };

      const bundleForSwapCheck = updatedBundle ?? request.bundle;

      if (!this.shouldSwap(result.adapterFailure, hopsSoFar, !!bundleForSwapCheck)) {
        // Preserve legacy rate-limit backoff when no swap candidates are available.
        // #585 Path B: race the sleep against the shutdown signal — an abort during
        // backoff settles within milliseconds instead of the full exponential wait.
        if (result.adapterFailure?.outcome === "fail-rate-limit" && rateLimitRetry < MAX_RATE_LIMIT_RETRIES) {
          if (request.signal?.aborted) {
            logger?.info("agent-manager", "Rate-limited backoff aborted — shutdown in progress", {
              storyId: request.runOptions.storyId,
            });
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
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
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
          }
          continue;
        }
        if (hopsSoFar > 0) {
          this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
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
        return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
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

      // completeWithFallback has no ContextBundle object, but swap is still allowed on
      // availability failures — pass true so the hasBundle guard does not block swapping.
      if (!this.shouldSwap(result.adapterFailure, hopsSoFar, true)) {
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
    const resolvedPermissions = resolvePermissions(
      (request.runOptions.config as NaxConfig | undefined) ?? this._config,
      request.runOptions.pipelineStage ?? "run",
    );
    const augmented: AgentRunRequest = {
      ...request,
      runOptions: { ...request.runOptions, resolvedPermissions },
    };
    const ctx: MiddlewareContext = {
      runId: this._runId,
      agentName,
      kind: "run",
      request: augmented,
      prompt: null,
      config: this._config,
      signal: request.signal ?? request.runOptions.abortSignal,
      resolvedPermissions,
      storyId: request.runOptions.storyId,
      stage: request.runOptions.pipelineStage,
    };
    const start = Date.now();
    await this._middleware.runBefore(ctx);
    try {
      if (!request.executeHop && !this._resolveRegistry().getAgent(agentName)) {
        throw new NaxError(`Agent "${agentName}" not found in registry`, "AGENT_NOT_FOUND", {
          stage: "run",
          agentName,
        });
      }
      const outcome = await this.runWithFallback(augmented, agentName);
      const result = { ...outcome.result, agentFallbacks: outcome.fallbacks };
      // Update context to reflect the actual final hop's agent and prompt so that
      // cost/audit middleware attributes the result to the agent that produced it,
      // not the initial agent that may have been swapped out by the fallback chain.
      const hopCtx: MiddlewareContext =
        outcome.finalAgent !== undefined || outcome.finalPrompt !== undefined
          ? { ...ctx, agentName: outcome.finalAgent ?? agentName, prompt: outcome.finalPrompt ?? ctx.prompt }
          : ctx;
      await this._middleware.runAfter(hopCtx, result, Date.now() - start);
      return result;
    } catch (err) {
      await this._middleware.runOnError(ctx, err, Date.now() - start);
      throw err;
    }
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
    const resolvedPermissions = resolvePermissions(this._config, opts.pipelineStage ?? "run");
    const ctx: MiddlewareContext = {
      runId: this._runId,
      agentName,
      kind: "run",
      request: null,
      prompt,
      config: this._config,
      signal: opts.signal,
      resolvedPermissions,
      storyId: opts.storyId,
      stage: opts.pipelineStage,
      sessionHandle: handle,
    };
    const start = Date.now();
    await this._middleware.runBefore(ctx);
    try {
      const result = await this._sendPrompt(handle, prompt, opts);
      await this._middleware.runAfter(ctx, result, Date.now() - start);
      return result;
    } catch (err) {
      await this._middleware.runOnError(ctx, err, Date.now() - start);
      throw err;
    }
  }

  async completeAs(agentName: string, prompt: string, options: CompleteOptions): Promise<CompleteResult> {
    const resolvedPermissions = resolvePermissions(
      (options.config as NaxConfig | undefined) ?? this._config,
      options.pipelineStage ?? "complete",
    );
    const augmented: CompleteOptions = { ...options, resolvedPermissions };
    const ctx: MiddlewareContext = {
      runId: this._runId,
      agentName,
      kind: "complete",
      request: null,
      prompt,
      config: this._config,
      resolvedPermissions,
      storyId: options.storyId,
      stage: options.pipelineStage,
    };
    const start = Date.now();
    await this._middleware.runBefore(ctx);
    try {
      const outcome = await this.completeWithFallback(prompt, augmented, agentName);
      await this._middleware.runAfter(ctx, outcome.result, Date.now() - start);
      return outcome.result;
    } catch (err) {
      await this._middleware.runOnError(ctx, err, Date.now() - start);
      throw err;
    }
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    return this.planAs(this.getDefault(), options);
  }

  async planAs(agentName: string, options: PlanOptions): Promise<PlanResult> {
    const resolvedPermissions = resolvePermissions((options.config as NaxConfig | undefined) ?? this._config, "plan");
    const augmented: PlanOptions = { ...options, resolvedPermissions };
    const adapter = this._resolveRegistry().getAgent(agentName);
    if (!adapter) return { specContent: `Agent "${agentName}" not found` };
    return adapter.plan(augmented);
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
