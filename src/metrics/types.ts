/**
 * Metrics Tracking Types
 *
 * Structured cost and performance metrics for tracking agent execution.
 */

/**
 * Per-story execution metrics
 */
export interface StoryMetrics {
  /** Story ID */
  storyId: string;
  /** Classified complexity */
  complexity: string;
  /** Initial model tier */
  modelTier: string;
  /** Actual model used (e.g., "claude-sonnet-4.5") */
  modelUsed: string;
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
