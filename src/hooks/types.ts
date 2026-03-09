/**
 * Hook System Types
 *
 * Script-based lifecycle hooks configured via hooks.json.
 */

/** All supported hook events — runtime array used for validation */
export const HOOK_EVENTS = [
  "on-start",
  "on-story-start",
  "on-story-complete",
  "on-story-fail",
  "on-pause",
  "on-resume",
  "on-session-end",
  "on-all-stories-complete",
  "on-complete",
  "on-error",
  "on-final-regression-fail",
] as const;

/** All supported hook events */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Single hook definition */
export interface HookDef {
  /** Command to execute */
  command: string;
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Whether this hook is enabled (default: true) */
  enabled?: boolean;
  /** Interaction prompt (v0.15.0) */
  interaction?: {
    /** Interaction type */
    type: "confirm" | "choose" | "input" | "review" | "notify";
    /** Summary template (supports {{variable}} syntax) */
    summary: string;
    /** Detail template (optional) */
    detail?: string;
    /** Fallback behavior on timeout */
    fallback: "continue" | "skip" | "escalate" | "abort";
    /** Timeout in milliseconds (optional) */
    timeout?: number;
  };
}

/** hooks.json schema */
export interface HooksConfig {
  hooks: Partial<Record<HookEvent, HookDef>>;
}

/** Context passed to hooks via environment variables */
export interface HookContext {
  /** Event name */
  event: HookEvent;
  /** Feature name */
  feature: string;
  /** Current story ID */
  storyId?: string;
  /** Status (pass/fail/paused/error) */
  status?: string;
  /** Reason for pause/error */
  reason?: string;
  /** Accumulated cost (USD) */
  cost?: number;
  /** Current model */
  model?: string;
  /** Current agent */
  agent?: string;
  /** Current iteration number */
  iteration?: number;
  /** Number of failed tests (on-final-regression-fail) */
  failedTests?: number;
  /** Stories affected by regression failure (on-final-regression-fail) */
  affectedStories?: string[];
}
