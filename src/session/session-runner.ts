/**
 * Session Runner — Strategy pattern for per-story agent execution.
 *
 * Motivation:
 *   execution.ts (single-session) and tdd/session-runner.ts (three-session)
 *   have diverged repeatedly on cross-cutting concerns:
 *     - state transitions (#589)
 *     - token propagation (#590)
 *     - protocolIds capture (#591)
 *     - bindHandle wiring (#541)
 *     - descriptor persistence (#522)
 *     - abort signal plumbing (#585, #593)
 *   Each new concern has to be added twice. The fix is to consolidate the
 *   bookkeeping into one place.
 *
 * Architecture (two layers):
 *   1. `SessionManager.runInSession(id, runFn, options)` — per-session
 *      primitive. Owns state transitions, handle binding, token passthrough
 *      for ONE session. Both runners use this internally.
 *   2. `ISessionRunner.run(ctx)` — per-story strategy. `SingleSessionRunner`
 *      uses one session + runWithFallback; `ThreeSessionRunner` (Phase 2)
 *      creates and sequences three sessions (test-writer, implementer,
 *      verifier).
 *
 * Callers (execution.ts) pick the runner based on routing strategy and
 * delegate. No knowledge of session bookkeeping leaves the runner module.
 */

import type { AgentAdapter } from "../agents";
import type { IAgentManager } from "../agents";
import type { AgentFallbackRecord } from "../agents/manager-types";
import type { AgentResult, AgentRunOptions } from "../agents/types";
import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Low-level runner function — one invocation of an agent for one session.
 * Returns the agent's result verbatim (protocolIds / tokenUsage / failure
 * pass through untouched).
 *
 * Two concrete shapes in production:
 *   - `(opts) => adapter.run(opts)` — direct adapter call (TDD per-role)
 *   - `(opts) => agentManager.runWithFallback({ runOptions: opts, bundle })`
 *     — with swap-on-availability-failure (single-session main)
 */
export type AgentRunner = (options: AgentRunOptions) => Promise<AgentResult>;

/**
 * Outcome of one `ISessionRunner.run()` call — one user story.
 *
 * Aggregates cost/tokens across however many sessions the runner needed
 * (one for SingleSessionRunner, three for ThreeSessionRunner) and the
 * final pass/fail decision.
 */
export interface StoryRunOutcome {
  /** Whether the story's agent work succeeded overall. */
  success: boolean;
  /** Primary agent result — used by downstream pipeline stages for auto-commit, merge detection, etc. */
  primaryResult: AgentResult;
  /** Sum of estimatedCost across all sessions run. */
  totalCost: number;
  /** Sum of tokenUsage across all sessions run (undefined if nothing reported). */
  totalTokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /** Agent swap history when the runner delegates to AgentManager. Empty for direct-adapter runners. */
  fallbacks: AgentFallbackRecord[];
  /** Final context bundle (may differ from ctx.bundle after a rebuild-on-swap). */
  finalBundle?: ContextBundle;
  /** Final prompt actually sent (may differ from baseRunOptions.prompt after a swap-handoff rewrite). */
  finalPrompt?: string;
  /** Structured failure reason when success=false. */
  adapterFailure?: AdapterFailure;
}

/**
 * Everything a session runner needs from the pipeline. Kept intentionally
 * narrow — runners should not depend on the full PipelineContext.
 */
export interface SessionRunnerContext {
  /**
   * Pre-created session descriptor id (CREATED state) when session bookkeeping
   * is active. Optional for backward compatibility with pipeline tests that
   * execute the stage without a SessionManager; when absent, the runner falls
   * back to a direct runner call and skips lifecycle bookkeeping.
   */
  sessionId?: string;
  /** Session manager — owns state transitions, handle binding, persistence. Paired with sessionId. */
  sessionManager?: import("./types").ISessionManager;
  /** Agent manager for fallback-on-availability-failure. Optional for direct-adapter runners. */
  agentManager?: IAgentManager;
  /** Pre-resolved primary agent adapter. */
  agent: AgentAdapter;
  /** Default agent name (for model resolution across hops). */
  defaultAgent: string;
  /** Base run options — runner augments with prompt / contextTools / keepOpen per session. */
  runOptions: AgentRunOptions;
  /** Context bundle used by the runner (may be rebuilt between swap hops). */
  bundle?: ContextBundle;
}

/**
 * Strategy interface — one implementation per per-story execution shape.
 *
 * Implementations live next to their domain:
 *   - SingleSessionRunner — src/session/runners/single-session-runner.ts
 *   - ThreeSessionRunner  — src/tdd/three-session-runner.ts (Phase 2)
 *
 * Invariant: every `run()` path must leave every session it touched in a
 * terminal state (COMPLETED or FAILED) before returning. Implementations
 * MUST go through `sessionManager.runInSession` for each session — that
 * wrapper provides the guarantee.
 */
export interface ISessionRunner {
  /** Stable identifier used for logging/metrics only. */
  readonly name: string;
  /** Execute one user story. Contract: on return, all sessions are terminal. */
  run(context: SessionRunnerContext): Promise<StoryRunOutcome>;
}
