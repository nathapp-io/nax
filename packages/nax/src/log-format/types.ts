/**
 * Logging formatter types for human-readable output
 */

/**
 * Verbosity mode for log formatting
 */
export type VerbosityMode = "quiet" | "normal" | "verbose" | "json";

/**
 * Emoji indicators for different log events
 */
export const EMOJI = {
  // Status indicators
  success: "✓",
  failure: "✗",
  warning: "⚠",
  info: "ℹ",
  skip: "⊘",

  // Stage/process indicators
  routing: "🎯",
  execution: "⚙️",
  review: "🔍",
  tdd: "🔄",
  agent: "🤖",
  cost: "💰",
  duration: "⏱️",

  // Story progress
  storyStart: "▶",
  storyComplete: "●",
  retry: "↻",
} as const;

/**
 * Run summary statistics
 */
export interface RunSummary {
  authRelogins?: readonly string[];
  /** Total stories in run */
  total: number;
  /** Stories that passed */
  passed: number;
  /** Stories that failed */
  failed: number;
  /** Stories that were skipped */
  skipped: number;
  /** Total run duration in milliseconds */
  durationMs: number;
  /** Total cost in dollars */
  totalCost: number;
  /** Run start timestamp */
  startedAt: string;
  /** Run completion timestamp */
  completedAt?: string;
  /** The part of `durationMs` spent in the story loops (workflow mode, and pipeline mode with an end phase). */
  storiesDurationMs?: number;
  /** Workflow mode: the part of `durationMs` spent in the feature workflow (gates, branch review/fix, publish). */
  featureWorkflowDurationMs?: number;
  /** Pipeline mode: the part of `durationMs` spent in the end phase (finish, ...). */
  endPhaseDurationMs?: number;
  /** Workflow mode: the workflow section printed under the summary. */
  workflow?: WorkflowSummaryView;
}

/** Tokens and cost of one workflow role, summed over the run. */
export interface WorkflowRoleUsage {
  role: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  /** US-005 (nax#2525): prompt-cache reads/writes; absent when the role saw no cache traffic. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** What the end-of-run summary shows for a workflow-mode run (nax#2491 P5). */
export interface WorkflowSummaryView {
  storiesDurationMs: number;
  featureWorkflowDurationMs: number;
  roles: readonly WorkflowRoleUsage[];
  stories: readonly { id: string; rounds: number; maxRounds: number; state?: string }[];
  /** Absent when the feature workflow never ran. */
  branch?: { found: number; fixed: number; left: number; minorsLeft: number; fixRounds?: number } | undefined;
  /** The feature workflow ran but its branch review did not. */
  branchReviewSkipped?: { minorsLeft: number } | undefined;
  finalGates?: "green" | "red" | undefined;
  /** nax#2548: repair rounds run for final gates the branch fix turned red. Absent when none ran. */
  gateRepairRounds?: number | undefined;
  /** US-008: repair rounds run for a failed CI on the published PR. Absent when none ran. */
  ciRepairRounds?: number | undefined;
  /**
   * US-005: the concerns the CI repair replies raised, one `r<N>: <concerns>` entry per round.
   * Absent when no round raised one, so its presence alone means a repair admitted something it
   * could not check.
   */
  ciRepairConcerns?: readonly string[] | undefined;
  publish?: { outcome: string; url?: string; reasons: readonly string[] } | undefined;
  /** US-005: the rulings flagged for a human, plus the command that lists them. Absent when none. */
  flagged?: { ids: readonly string[]; hint: string } | undefined;
}

/**
 * Story start event data
 */
export interface StoryStartData {
  storyId: string;
  title: string;
  complexity?: string;
  modelTier?: string;
  attempt?: number;
}

/**
 * Stage result event data
 */
export interface StageResultData {
  stage: string;
  success: boolean;
  action?: "continue" | "skip" | "fail" | "escalate" | "pause";
  reason?: string;
  cost?: number;
  durationMs?: number;
}

/**
 * Formatter options
 */
export interface FormatterOptions {
  /** Verbosity mode */
  mode: VerbosityMode;
  /** Whether to use color/emoji (default: true) */
  useColor?: boolean;
  /** Timezone for timestamp formatting (default: system timezone) */
  timezone?: string;
}
