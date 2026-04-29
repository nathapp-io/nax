/**
 * Session Runner — shared types for per-story agent execution.
 *
 * `StoryRunOutcome` and `SessionRunnerContext` are shared types for
 * execution strategies. This file only keeps the shared types.
 */

import type { AgentAdapter } from "../agents";
import type { IAgentManager } from "../agents";
import type { AgentFallbackRecord } from "../agents/manager-types";
import type { AgentResult } from "../agents/types";
import type { ContextBundle } from "../context/engine";
import type { AdapterFailure } from "../context/engine/types";
import type { DispatchContext } from "../runtime/dispatch-context";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outcome of one per-story execution run.
 *
 * Aggregates cost/tokens across all sessions and the final pass/fail decision.
 */
export interface StoryRunOutcome {
  /** Whether the story's agent work succeeded overall. */
  success: boolean;
  /** Primary agent result — used by downstream pipeline stages for auto-commit, merge detection, etc. */
  primaryResult: AgentResult;
  /** Sum of estimatedCostUsd across all sessions run. */
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
 * Execution context passed to per-story runners. Kept intentionally
 * narrow — runners should not depend on the full PipelineContext.
 */
export interface SessionRunnerContext extends DispatchContext {
  /**
   * Pre-created session descriptor id (CREATED state) when session bookkeeping
   * is active. Optional for backward compatibility with pipeline tests that
   * execute the stage without a SessionManager; when absent, the runner falls
   * back to a direct runner call and skips lifecycle bookkeeping.
   */
  sessionId?: string;
  /** Pre-resolved primary agent adapter. */
  agent: AgentAdapter;
  /** Default agent name (for model resolution across hops). */
  defaultAgent: string;
  /** Base run options — runner augments with prompt / contextTools / keepOpen per session. */
  runOptions: import("../agents/types").AgentRunOptions;
  /** Context bundle used by the runner (may be rebuilt between swap hops). */
  bundle?: ContextBundle;
}
