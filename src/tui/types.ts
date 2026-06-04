/**
 * TUI-specific types for terminal user interface components.
 */

import type { PipelineEventEmitter } from "../pipeline/events";
import type { StoryRouting, UserStory } from "../prd/types";
import type { IAgentStreamEventBus } from "../runtime/agent-stream-events";

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
  /** Active model tier (from story:started) */
  modelTier?: string;
  /** Failure reason for display (from story:failed.reason, truncated) */
  failureReason?: string;
  /** Attempt iteration count — >1 means escalated (from story:started.iteration) */
  iteration?: number;
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
  cwd: string;
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
  /** nax version string (e.g. "0.68.7"), shown in the header */
  version?: string;
  /** All stories to display (initial state; updates come from pipeline bus) */
  stories: StoryDisplayState[];
  /** Pipeline event emitter for stage tracking (stage:enter/stage:exit) */
  events: PipelineEventEmitter;
  /** Path to queue file for writing commands (optional) */
  queueFilePath?: string;
  /** PTY spawn options — reserved for future PTY re-integration */
  ptyOptions?: PtySpawnOptions | null;
  /** Agent stream event bus for live call metadata (optional) */
  agentStreamEvents?: IAgentStreamEventBus | null;
}
