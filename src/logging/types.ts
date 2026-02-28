/**
 * Logging formatter types for human-readable output
 */

import type { LogEntry } from "../logger/types.js";

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
