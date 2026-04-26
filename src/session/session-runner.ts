/**
 * Session Runner — shared types for per-story agent execution.
 *
 * `StoryRunOutcome` and `SessionRunnerContext` are consumed by
 * `ThreeSessionRunner` (TDD three-session strategy). This file only keeps
 * the shared types used by the concrete runner implementation.
 */

import type { AgentAdapter } from "../agents";
import type { IAgentManager } from "../agents";
import type { AgentFallbackRecord } from "../agents/manager-types";
import type { AgentResult } from "../agents/types";
import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outcome of one ThreeSessionRunner.run() call — one user story.
 *
 * Aggregates cost/tokens across the three sessions (test-writer, implementer,
 * verifier) and the final pass/fail decision.
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
 * Everything ThreeSessionRunner needs from the pipeline. Kept intentionally
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
  runOptions: import("../agents/types").AgentRunOptions;
  /** Context bundle used by the runner (may be rebuilt between swap hops). */
  bundle?: ContextBundle;
}
