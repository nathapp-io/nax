/**
 * AgentManager types — see ADR-012, SPEC-agent-manager-integration.md.
 * Separated from manager.ts to keep imports cycle-free.
 */

import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";
import type {
  AgentAdapter,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  CompleteResult,
  DecomposeOptions,
  DecomposeResult,
  PlanOptions,
  PlanResult,
} from "./types";

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
  /** The agent that actually executed the final hop (may differ from the initial agent after a swap). */
  finalAgent?: string;
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
   * Shutdown / cancellation signal (#585 Path B). When aborted, runWithFallback
   * races the rate-limit backoff sleep against it and returns `fail-aborted`
   * without issuing further hops. Fires on SIGTERM / SIGINT / user abort.
   */
  signal?: AbortSignal;
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
    resolvedRunOptions: AgentRunOptions,
  ) => Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }>;
}

/** Options for AgentManager.runAsSession — caller-managed session (Phase C). */
export interface RunAsSessionOpts {
  storyId?: string;
  pipelineStage?: import("../config/permissions").PipelineStage;
  signal?: AbortSignal;
  /** Context-engine pull tools to expose during this turn. */
  contextPullTools?: import("../context/engine").ToolDescriptor[];
  /** Server-side runtime for resolving context-engine pull tool calls. */
  contextToolRuntime?: { callTool(name: string, input: unknown): Promise<string> };
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
   * Requires fallback.enabled, a truthy bundle (hasBundle=true), and an availability
   * failure (or quality failure when onQualityFailure is set), within the hop cap.
   * completeWithFallback passes false — it has no context bundle.
   */
  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, hasBundle: boolean): boolean;

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

  // ─── ADR-013 Phase 1: uniform call surface ───────────────────────────────

  /**
   * Long-running session call with automatic agent-swap fallback.
   * Delegates to runWithFallback and surfaces AgentFallbackRecord[] via
   * result.agentFallbacks. This is the method SessionManager.runInSession
   * and ISessionRunner implementations call — never adapter.run() directly.
   */
  run(request: AgentRunRequest): Promise<AgentResult>;

  /**
   * One-shot LLM call with cross-agent fallback.
   * Delegates to completeWithFallback. Callers that need the full fallback
   * record list should use completeWithFallback directly.
   */
  complete(prompt: string, options: CompleteOptions): Promise<CompleteResult>;

  /**
   * Resolve a specific adapter by name.
   * Returns undefined when no registry is set or the name is not registered.
   * Internal use by subsystems that need to call adapter-level operations
   * (e.g. deriveSessionName, closeSession) without bypassing AgentManager.
   */
  getAgent(name: string): AgentAdapter | undefined;

  // ─── ADR-013 Phase 5: pinned-agent + plan/decompose surface ─────────────────

  /**
   * Run against a specific agent (not getDefault()), still honoring the fallback
   * chain rooted at agentName. Used by debate debaters and other callers that
   * need a non-default agent without bypassing AgentManager.
   */
  runAs(agentName: string, request: AgentRunRequest): Promise<AgentResult>;

  /**
   * One-shot completion pinned to a specific agent. Used by debate resolvers
   * that intentionally call a specific judge/synthesis model.
   */
  completeAs(agentName: string, prompt: string, options: CompleteOptions): Promise<CompleteResult>;

  /**
   * Send one prompt against a caller-managed session handle (Phase C).
   * The caller opens the handle via SessionManager.openSession; AgentManager
   * applies the middleware envelope (audit, cost, cancellation, logging) around
   * the dispatch. Does NOT iterate the fallback chain — the caller (buildHopCallback)
   * manages fallback externally via runWithFallback.
   *
   * Returns TurnResult (output + tokenUsage + cost + internalRoundTrips).
   * Throws NaxError SEND_PROMPT_UNAVAILABLE if _sendPrompt is not wired.
   */
  runAsSession(
    agentName: string,
    handle: import("./types").SessionHandle,
    prompt: string,
    opts: RunAsSessionOpts,
  ): Promise<import("./types").TurnResult>;

  /**
   * Plan mode — feature spec generation via default agent with fallback.
   * Routes through the fallback chain; availability failures swap agents.
   */
  plan(options: PlanOptions): Promise<PlanResult>;

  /** Plan mode pinned to a specific agent (debate plan debaters). */
  planAs(agentName: string, options: PlanOptions): Promise<PlanResult>;

  /**
   * Decompose mode — story splitting via default agent with fallback.
   * Routes through the fallback chain; availability failures swap agents.
   */
  decompose(options: DecomposeOptions): Promise<DecomposeResult>;

  /** Decompose mode pinned to a specific agent. */
  decomposeAs(agentName: string, options: DecomposeOptions): Promise<DecomposeResult>;
}
