/**
 * TUI-specific types for terminal user interface components.
 */

import type { PipelineEventEmitter } from "../pipeline/events";
import type { StoryRouting, UserStory } from "../prd/types";

/**
 * Story display state for the TUI.
 *
 * Extends UserStory with runtime state for visual rendering.
 */
export interface StoryDisplayState {
  /** Story data from PRD */
  story: UserStory;
  /** Current status for display */
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "retrying" | "paused";
  /** Routing result (if classified) */
  routing?: StoryRouting;
  /** Cost incurred for this story */
  cost?: number;
}

/**
 * Panel focus state.
 *
 * Determines which panel receives keyboard input.
 */
export enum PanelFocus {
  /** Stories panel is focused (default) */
  Stories = "stories",
  /** Agent panel is focused (input routed to PTY) */
  Agent = "agent",
}

/**
 * PTY spawn options for agent integration.
 */
export interface PtySpawnOptions {
  /** Command to execute (e.g., "claude") */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Terminal columns (default: 80) */
  cols?: number;
  /** Terminal rows (default: 24) */
  rows?: number;
}

/**
 * Props for the root TUI component.
 */
export interface TuiProps {
  /** Feature name */
  feature: string;
  /** All stories to display */
  stories: StoryDisplayState[];
  /** Current story being executed */
  currentStory?: UserStory;
  /** Current pipeline stage */
  currentStage?: string;
  /** Total cost accumulated */
  totalCost: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Pipeline event emitter for live updates */
  events: PipelineEventEmitter;
  /** Path to queue file for writing commands (optional) */
  queueFilePath?: string;
  /** PTY spawn options for agent session (optional) */
  ptyOptions?: PtySpawnOptions | null;
}
