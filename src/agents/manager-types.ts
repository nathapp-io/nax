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
  /** The context bundle used by the final (successful or last failed) hop. */
  finalBundle?: ContextBundle;
  /** The prompt used by the final (successful or last failed) hop. */
  finalPrompt?: string;
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
  /**
   * Per-hop executor. When provided, replaces the internal adapter.run() call for every hop
   * (primary AND fallback). Called with:
   *   - agentName: which agent to use for this hop
   *   - bundle: the context bundle at the start of this hop (rebuilt between hops)
   *   - failure: the AdapterFailure that triggered this hop; undefined for the primary hop
   * Returns the agent result, the bundle used (may differ after rebuild), and the prompt used.
   * Used by execution stage to inject context rebuild, session handoff, and prompt building.
   */
  executeHop?: (
    agentName: string,
    bundle: ContextBundle | undefined,
    failure: AdapterFailure | undefined,
  ) => Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }>;
}

export interface IAgentManager {
  /** Resolve the default agent name. Reads config.agent.default (falls back to built-in "claude"). */
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

  /** Resolve the ordered fallback chain for a given agent given a failure. */
  resolveFallbackChain(agent: string, failure: AdapterFailure): string[];

  /**
   * Returns true when the manager should attempt a swap to a fallback agent.
   * Requires fallback.enabled, a context bundle, and an availability failure
   * (or quality failure when onQualityFailure is set), within the hop cap.
   */
  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, bundle: ContextBundle | undefined): boolean;

  /**
   * Returns the next candidate agent name for a given current agent and hop count,
   * excluding pruned (no credentials) and already-unavailable agents.
   * Returns null when no candidate is available.
   */
  nextCandidate(current: string, hopsSoFar: number): string | null;

  /**
   * Run the prompt with automatic agent-swap fallback on availability failures.
   * Implements exponential backoff for rate-limit errors when no swap candidate
   * is available (up to 3 attempts). Emits onSwapAttempt / onSwapExhausted events.
   */
  runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome>;

  /**
   * One-shot completion with cross-agent fallback.
   * Mirrors runWithFallback but for complete() calls.
   * Swaps on availability failures when agent.fallback.enabled.
   */
  completeWithFallback(prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome>;
}
