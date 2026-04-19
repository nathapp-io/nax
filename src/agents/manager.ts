/**
 * AgentManager — owns agent lifecycle and fallback policy (ADR-012).
 *
 * Phase 1: skeleton only. Methods that will later drive cross-agent swap
 * (shouldSwap, nextCandidate, runWithFallback) are intentional pass-throughs
 * that preserve existing adapter behaviour. Phase 5 replaces them with real logic.
 */

import { EventEmitter } from "node:events";
import type { NaxConfig } from "../config";
import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import type {
  AgentFallbackRecord,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  IAgentManager,
} from "./manager-types";
import type { AgentRegistry } from "./registry";
import type { AgentResult } from "./types";

type LoggerLike = { warn: (scope: string, msg: string, data?: Record<string, unknown>) => void };

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
    this._logger = opts?.logger ?? getSafeLogger() ?? { warn: () => {} };
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
        throw new NaxError(
          `Primary agent "${name}" has no usable credentials`,
          "AGENT_CREDENTIALS_MISSING",
          { stage: "run-setup", agent: name },
        );
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

  shouldSwap(_failure: AdapterFailure | undefined, _hopsSoFar: number, _bundle: ContextBundle | undefined): boolean {
    return false;
  }

  nextCandidate(_current: string, _hopsSoFar: number): string | null {
    return null;
  }

  async runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome> {
    const logger = getSafeLogger();
    const agent = this._registry?.getAgent(this.getDefault());
    if (!agent) {
      logger?.warn("agent-manager", "No adapter available", {
        storyId: request.runOptions.storyId,
        agent: this.getDefault(),
      });
      const result: AgentResult = {
        success: false,
        exitCode: 1,
        output: "no adapter available",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      };
      return { result, fallbacks: [] };
    }
    const result = await agent.run(request.runOptions);
    return { result, fallbacks: [] };
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
