/**
 * AgentManager types — see ADR-012, SPEC-agent-manager-integration.md.
 * Separated from manager.ts to keep imports cycle-free.
 */

import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";
import type { AgentResult, AgentRunOptions, CompleteOptions, CompleteResult } from "./types";

export interface AgentFallbackRecord {
  storyId?: string;
  priorAgent: string;
  newAgent: string;
  hop: number;
  outcome: AdapterFailure["outcome"];
  category: AdapterFailure["category"];
  timestamp: string;
  costUsd: number;
}

export interface AgentRunOutcome {
  result: AgentResult;
  fallbacks: AgentFallbackRecord[];
}

export interface AgentCompleteOutcome {
  result: CompleteResult;
  fallbacks: AgentFallbackRecord[];
}

export type AgentManagerEventName = "onAgentSelected" | "onSwapAttempt" | "onAgentUnavailable" | "onSwapExhausted";

export interface AgentManagerEvents {
  on(event: "onAgentSelected", listener: (e: { agent: string; reason: string }) => void): void;
  on(event: "onSwapAttempt", listener: (e: AgentFallbackRecord) => void): void;
  on(event: "onAgentUnavailable", listener: (e: { agent: string; failure: AdapterFailure }) => void): void;
  on(event: "onSwapExhausted", listener: (e: { storyId?: string; hops: number }) => void): void;
}

export interface AgentRunRequest {
  runOptions: AgentRunOptions;
  bundle?: ContextBundle;
  sessionId?: string;
}

export interface IAgentManager {
  /** Resolve the default agent name. Reads config.agent.default, falls back to config.autoMode.defaultAgent during Phase 1-5. */
  getDefault(): string;

  /** True if the agent has been marked unavailable for this run. */
  isUnavailable(agent: string): boolean;

  /** Mark an agent unavailable for this run (auth/quota/service-down). */
  markUnavailable(agent: string, reason: AdapterFailure): void;

  /** Reset per-run state. Called at run boundary. */
  reset(): void;

  /**
   * Validate credentials for the default agent and every agent referenced in
   * agent.fallback.map. Prunes fallback candidates with missing credentials;
   * throws NaxError if the primary agent has no credentials. (#518)
   */
  validateCredentials(): Promise<void>;

  /** Event surface. */
  readonly events: AgentManagerEvents;

  /*
   * Methods below are Phase-1 skeletons. Full behaviour lands in later phases.
   */

  /** Resolve the ordered fallback chain for a given agent given a failure. Phase 1: returns []. */
  resolveFallbackChain(agent: string, failure: AdapterFailure): string[];

  /** Phase 1: returns false unconditionally. Full logic in Phase 5. */
  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, bundle: ContextBundle | undefined): boolean;

  /** Phase 1: returns null. Full logic in Phase 5. */
  nextCandidate(current: string, hopsSoFar: number): string | null;

  /**
   * Phase 1: thin wrapper that calls adapter.run() once and returns {result, fallbacks: []}.
   * Full loop logic lands in Phase 5.
   */
  runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome>;

  /**
   * One-shot completion with cross-agent fallback.
   * Mirrors runWithFallback but for complete() calls.
   * Swaps on availability failures when agent.fallback.enabled.
   */
  completeWithFallback(prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome>;
}
