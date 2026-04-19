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

export class AgentManager implements IAgentManager {
  private readonly _config: NaxConfig;
  private readonly _registry: AgentRegistry | undefined;
  private readonly _unavailable = new Map<string, AdapterFailure>();
  private readonly _emitter = new EventEmitter();
  readonly events: AgentManagerEvents;

  constructor(config: NaxConfig, registry?: AgentRegistry) {
    this._config = config;
    this._registry = registry;
    this.events = {
      on: (event, listener) => {
        this._emitter.on(event as AgentManagerEventName, listener as (...args: unknown[]) => void);
      },
    };
  }

  getDefault(): string {
    // config.agent?.default is added in Task 8 — cast until then (Phase-1 accommodation)
    const fromAgent = (this._config as { agent?: { default?: string } } & NaxConfig).agent?.default;
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
  }

  async validateCredentials(): Promise<void> {
    // Phase 2 — full implementation lands in Task 11.
    return;
  }

  resolveFallbackChain(_agent: string, _failure: AdapterFailure): string[] {
    return [];
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
  _emit(event: AgentManagerEventName, payload: AgentFallbackRecord | unknown): void {
    this._emitter.emit(event, payload);
  }
}
