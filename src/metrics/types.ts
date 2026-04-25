/**
 * Metrics Tracking Types
 *
 * Structured cost and performance metrics for tracking agent execution.
 */

/**
 * Token usage metrics for LLM calls
 */
export interface TokenUsage {
  /** Number of input tokens consumed */
  inputTokens: number;
  /** Number of output tokens generated */
  outputTokens: number;
  /** Number of input tokens read from cache (optional, omitted when 0) */
  cacheReadInputTokens?: number;
  /** Number of input tokens used for cache creation (optional, omitted when 0) */
  cacheCreationInputTokens?: number;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: TokenUsage must be both an interface (for type checking) and a class (for runtime construction with toJSON)
export class TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;

  constructor(data: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }) {
    this.inputTokens = data.inputTokens;
    this.outputTokens = data.outputTokens;
    this.cacheReadInputTokens = data.cacheReadInputTokens;
    this.cacheCreationInputTokens = data.cacheCreationInputTokens;
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
    if (this.cacheReadInputTokens !== 0) {
      result.cacheReadInputTokens = this.cacheReadInputTokens;
    }
    if (this.cacheCreationInputTokens !== 0) {
      result.cacheCreationInputTokens = this.cacheCreationInputTokens;
    }
    return result;
  }
}

/**
 * Aggregated context provider metrics across all pipeline stages for a story.
 */
export interface ContextProviderMetrics {
  tokensProduced: number;
  chunksProduced: number;
  chunksKept: number;
  wallClockMs: number;
  timedOut: boolean;
  failed: boolean;
  /**
   * Total LLM cost in USD for this provider across all pipeline stages (AC-25).
   * Absent when the provider reported no chunk costs (free providers).
   */
  costUsd?: number;
}

/**
 * A single agent-swap hop recorded by the execution stage (AC-41).
 * Collected into ctx.agentFallbacks and surfaced in StoryMetrics.fallback.hops.
 */
export interface AgentFallbackHop {
  storyId: string;
  priorAgent: string;
  newAgent: string;
  /** adapterFailure.outcome — machine-readable failure code */
  outcome: string;
  /** adapterFailure.category — "availability" | "quality" */
  category: string;
  /** 1-indexed hop counter within this story's pipeline run */
  hop: number;
  /**
   * Cost incurred on the hop that FAILED (the attempt on `priorAgent` that triggered
   * the swap to `newAgent`). Sourced from the failing agent's `AgentResult.estimatedCost`.
   * Zero when the adapter did not report a cost. Summed across hops into
   * `RunMetrics.fallback.totalWastedCostUsd` (ADR-012 / review #2).
   */
  costUsd: number;
}

/**
 * Per-story execution metrics
 */
export interface StoryMetrics {
  /** Story ID */
  storyId: string;
  /** Classified complexity */
  complexity: string;
  /** Initial complexity from first classification — preserved across escalations */
  initialComplexity?: string;
  /** Initial model tier */
  modelTier: string;
  /** Actual model used (e.g., "claude-sonnet-4.5") */
  modelUsed: string;
  /** Agent used for this story (e.g., "claude", "codex") */
  agentUsed?: string;
  /** Number of attempts (includes escalations) */
  attempts: number;
  /** Final tier that succeeded */
  finalTier: string;
  /** Whether the story succeeded */
  success: boolean;
  /** Total cost for this story (including all attempts) */
  cost: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Whether it passed on the first attempt */
  firstPassSuccess: boolean;
  /** Timestamp when started */
  startedAt: string;
  /** Timestamp when completed */
  completedAt: string;
  /** Execution source — 'parallel' for batch dispatch, 'sequential' for single-story loop, 'rectification' for conflict resolution */
  source?: "parallel" | "sequential" | "rectification";
  /** Number of runtime crashes (RUNTIME_CRASH verify status) encountered for this story (BUG-070) */
  runtimeCrashes?: number;
  /** Whether TDD full-suite gate passed (only true for TDD strategies when gate passes) */
  fullSuiteGatePassed?: boolean;
  /** Cost incurred only during rectification (only set when source === 'rectification') */
  rectificationCost?: number;
  /** Token usage for this story */
  tokens?: TokenUsage;
  /** When ScopedStrategy.verify() falls back to full suite due to threshold (US-002) */
  scopeTestFallback?: boolean;
  /**
   * Per-provider context engine metrics aggregated across all pipeline stages.
   * Absent when context engine v2 was not active or no manifests were found.
   */
  context?: {
    providers: Record<string, ContextProviderMetrics>;
    /**
     * Aggregate pollution indicators (Amendment A AC-48).
     * Populated post-story when effectiveness annotation and staleness detection run.
     * Absent when no manifests were found or no effectiveness data exists.
     */
    pollution?: {
      /** Chunks dropped by the min-score threshold (noise gate). */
      droppedBelowMinScore: number;
      /** Included chunks flagged as staleness candidates (AC-46). */
      staleChunksInjected: number;
      /** Chunks whose advice was contradicted by a review finding (AC-45). */
      contradictedChunks: number;
      /** Chunks that appear to have been ignored by the agent (AC-45). */
      ignoredChunks: number;
      /**
       * Ratio of polluted context: (contradicted + ignored) / total included.
       * A value > 0.3 is surfaced as a warning in `nax status`.
       */
      pollutionRatio: number;
    };
  };
  /**
   * Agent-swap (fallback) hops recorded during execution (AC-41).
   * Absent when no swaps occurred.
   */
  fallback?: {
    hops: AgentFallbackHop[];
  };
  /**
   * Per-reviewer metrics for the review stage.
   * Populated when semantic or adversarial review runs.
   * Both sub-buckets are optional — callers only populate the ones they ran.
   */
  reviewMetrics?: {
    semantic?: {
      cost: number;
      wallClockMs: number;
      findingsCount: number;
      findingsBySeverity: Record<string, number>;
    };
    adversarial?: {
      cost: number;
      wallClockMs: number;
      findingsCount: number;
      findingsBySeverity: Record<string, number>;
      /** Adversarial-only: findings broken down by heuristic category */
      findingsByCategory: Record<string, number>;
    };
  };
}

/**
 * Run-level fallback aggregates (ADR-012 / review #3).
 *
 * Derived from `StoryMetrics.fallback.hops` via `deriveRunFallbackAggregates`.
 * Absent on `RunMetrics` when no swaps occurred in the run.
 */
export interface RunFallbackAggregate {
  /** Total number of hops across all stories in this run. */
  totalHops: number;
  /**
   * Hop count per `priorAgent->newAgent` transition. Key format is `${prior}->${new}`
   * (e.g. "codex->claude"). Useful for spotting adapter-specific instability.
   */
  perPair: Record<string, number>;
  /**
   * Story IDs where `AgentManager.runWithFallback` emitted `onSwapExhausted`
   * (i.e. ran out of candidates). Detected by the last hop's `outcome` being
   * an availability failure on a story that ultimately did not succeed.
   * Empty array when nothing exhausted.
   */
  exhaustedStories: string[];
  /**
   * Sum of `AgentFallbackHop.costUsd` across every hop in the run — the cost
   * the user paid on failed attempts that led to a swap. Never includes the
   * final (successful or last-attempted) hop's cost; that lives on `StoryMetrics.cost`.
   */
  totalWastedCostUsd: number;
}

/**
 * Per-run execution metrics
 */
export interface RunMetrics {
  /** Unique run ID */
  runId: string;
  /** Feature name */
  feature: string;
  /** Run start timestamp */
  startedAt: string;
  /** Run completion timestamp */
  completedAt: string;
  /** Total cost for the run */
  totalCost: number;
  /** Total number of stories in the run */
  totalStories: number;
  /** Number of stories completed successfully */
  storiesCompleted: number;
  /** Number of stories that failed */
  storiesFailed: number;
  /** Total duration in milliseconds */
  totalDurationMs: number;
  /** Per-story metrics */
  stories: StoryMetrics[];
  /** Total token usage for the run */
  totalTokens?: TokenUsage;
  /**
   * Run-level agent-swap aggregates (ADR-012).
   * Absent when no swaps occurred in this run.
   */
  fallback?: RunFallbackAggregate;
}

/**
 * Aggregate metrics across all runs
 */
export interface AggregateMetrics {
  /** Total number of runs */
  totalRuns: number;
  /** Total cost across all runs */
  totalCost: number;
  /** Total stories across all runs */
  totalStories: number;
  /** Percentage of stories passing on first attempt */
  firstPassRate: number;
  /** Percentage of stories needing escalation */
  escalationRate: number;
  /** Average cost per story */
  avgCostPerStory: number;
  /** Average cost per feature run */
  avgCostPerFeature: number;
  /** Per-model efficiency metrics */
  modelEfficiency: Record<
    string,
    {
      /** Total attempts with this model */
      attempts: number;
      /** Successful attempts */
      successes: number;
      /** Success rate (0-1) */
      passRate: number;
      /** Average cost per story */
      avgCost: number;
      /** Total cost for this model */
      totalCost: number;
    }
  >;
  /** Complexity prediction accuracy */
  complexityAccuracy: Record<
    string,
    {
      /** Number of stories predicted at this complexity */
      predicted: number;
      /** Most common final tier used */
      actualTierUsed: string;
      /** Rate at which prediction didn't match actual tier needed */
      mismatchRate: number;
    }
  >;
}
