/**
 * AgentManager types — see ADR-012, SPEC-agent-manager-integration.md.
 * Separated from manager.ts to keep imports cycle-free.
 */

import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";
import type { SessionRole } from "../runtime/session-role";
import type { FallbackTarget } from "./swap-decision";

/**
 * Discriminates which kind of hop executeHop is being invoked for.
 * Replaces the old `failure: AdapterFailure | undefined` encoding, which
 * conflated "primary" and "stale-retry" as both `undefined`.
 */
export type HopKind =
  | { kind: "primary"; tier?: string } // tier present when an op started on a fallback that named one
  | { kind: "stale-retry"; attempt: number } // same agent, reuse existing session
  | { kind: "timeout-retry"; attempt: number } // same agent, fresh session after fail-timeout
  | { kind: "swap"; failure: AdapterFailure; tier?: string }; // new agent, fresh session

import type { SessionRunHopFn } from "../runtime/session-run-hop";
import type {
  AgentAdapter,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  CompleteResult,
  ResolvedCompleteOptions,
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
  /** Tier of the hop that actually ran, when a fallback target named one. */
  finalTier?: string;
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
   * Per-hop executor. When provided, replaces the internal openSession+sendTurn+closeSession
   * sequence for every hop (primary AND fallback). Called with:
   *   - agentName: which agent to use for this hop
   *   - bundle: the context bundle at the start of this hop (rebuilt between hops)
   *   - hopKind: discriminated union — `{kind:"primary"}`, `{kind:"stale-retry",attempt:n}`, or `{kind:"swap",failure}`
   * Returns the agent result, the bundle used (may differ after rebuild), and the prompt used.
   * Used by execution stage to inject context rebuild, session handoff, and prompt building.
   */
  executeHop?: (
    agentName: string,
    bundle: ContextBundle | undefined,
    hopKind: HopKind,
    resolvedRunOptions: AgentRunOptions,
  ) => Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }>;
  /**
   * When true, runWithFallback dispatches at most one hop on the primary agent
   * and never iterates the fallback chain. Used by ops that must preserve the
   * `fallbacks: []` invariant (TDD test-writer / implementer / verifier per
   * ADR-018 §5.2). Middleware still fires; rate-limit retry on the same agent
   * still applies.
   */
  noFallback?: boolean;
}

/** Options for AgentManager.runAsSession — caller-managed session (Phase C). */
export interface RunAsSessionOpts {
  storyId?: string;
  /** Feature name — forwarded to DispatchEvent.featureName for audit correlation. */
  featureName?: string;
  /** Working directory — forwarded to DispatchEvent.workdir. */
  workdir?: string;
  /** Project directory — forwarded to DispatchEvent.projectDir. */
  projectDir?: string;
  pipelineStage?: import("../config/permissions").PipelineStage;
  /** SEC-3: per-package effective config — iteration-runner threads this for monorepo batches. Falls back to AgentManager._config. */
  config?: import("../config/selectors").AgentManagerConfig;
  /** Session role — forwarded to DispatchEvent.sessionRole for audit/cost correlation. */
  sessionRole?: SessionRole;
  signal?: AbortSignal;
  /** Mid-turn interaction callback (context-tool calls, agent questions). */
  interactionHandler?: import("./interaction-handler").InteractionHandler;
  /** Max interaction round-trips per turn (default: 10). */
  maxTurns?: number;
  /** Context-engine pull tools to expose during this turn. */
  contextPullTools?: import("../context/engine").ToolDescriptor[];
  /** Server-side runtime for resolving context-engine pull tool calls. */
  contextToolRuntime?: { callTool(name: string, input: unknown): Promise<string> };
  /** Per-callOp invocation id forwarded to dispatch events. */
  readonly callId?: string;
  /** Caller-supplied region id forwarded to dispatch events. */
  readonly scopeId?: string;
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

  /** Clear transient failures at a story boundary while retaining permanent failures. */
  resetTransientUnavailable?(): void;

  /** Release internal resources (EventEmitter listeners). Called from NaxRuntime.close(). */
  close(): void;

  /**
   * Validate credentials for the default agent and every agent referenced in
   * agent.fallback.map. Prunes fallback candidates with missing credentials;
   * throws NaxError if the primary agent has no credentials. (#518)
   */
  validateCredentials(): Promise<void>;

  /** Event surface. */
  readonly events: AgentManagerEvents;

  /** Resolve the ordered fallback chain for a given agent given a failure. */
  resolveFallbackChain(agent: string, failure: AdapterFailure): FallbackTarget[];

  /**
   * Returns true when the manager should attempt a swap to a fallback agent.
   * Requires fallback.enabled and an availability failure (or a quality failure when
   * onQualityFailure is set), within the hop cap. nax#1722 removed the `hasBundle`
   * parameter: a swap carries no bundle requirement.
   */
  shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number): boolean;

  /**
   * Returns the next fallback target (agent, and its optional tier) for a given
   * current agent and hop count, excluding pruned (no credentials) and
   * already-unavailable agents. Returns null when no candidate is available.
   */
  nextCandidate(current: string, hopsSoFar: number): FallbackTarget | null;

  /**
   * Run the prompt with automatic agent-swap fallback on availability failures.
   * Implements exponential backoff for rate-limit errors when no swap candidate
   * is available (up to 3 attempts). Emits onSwapAttempt / onSwapExhausted events.
   */
  runWithFallback(request: AgentRunRequest, primaryAgentOverride?: string): Promise<AgentRunOutcome>;

  /**
   * One-shot completion with cross-agent fallback.
   * Mirrors runWithFallback but for complete() calls.
   * Swaps on availability failures when agent.fallback.enabled.
   */
  completeWithFallback(prompt: string, options: ResolvedCompleteOptions): Promise<AgentCompleteOutcome>;

  // ─── ADR-013 Phase 1: uniform call surface ───────────────────────────────

  /**
   * Long-running session call with automatic agent-swap fallback.
   * Delegates to runWithFallback and surfaces AgentFallbackRecord[] via
   * result.agentFallbacks. This is the method SessionManager.runInSession calls —
   * internally uses openSession+sendTurn+closeSession primitives.
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
   * (e.g. closeSession/force-close hooks) without bypassing AgentManager.
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
   * As `completeAs`, but surfaces the agent-swap records the call produced.
   *
   * nax#1712: callers that can attribute hops to a story (currently `callOp`'s
   * complete branch) use this and hand `outcome.fallbacks` to the run-scoped sink;
   * callers that cannot — the debate resolvers, `complete()` — keep using
   * `completeAs`, which unwraps this.
   */
  completeAsWithFallback(agentName: string, prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome>;

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
}

/**
 * The session-turn transport `AgentManager.runAsSession` dispatches through.
 * Lives here beside `SessionRunHopFn` rather than in manager.ts — Biome's
 * `useAwaitThenable` cannot infer through a function-type alias declared and
 * consumed in the same module as an optional class property.
 */
export type SendPromptFn = (
  handle: import("./types").SessionHandle,
  prompt: string,
  opts: RunAsSessionOpts,
) => Promise<import("./types").TurnResult>;

export type { SessionRunHopFn };
