/**
 * Hook System Types
 *
 * Script-based lifecycle hooks configured via hooks.json.
 */

/** All supported hook events */
export type HookEvent =
  | "on-start"
  | "on-story-start"
  | "on-story-complete"
  | "on-story-fail"
  | "on-pause"
  | "on-resume"
  | "on-session-end"
  | "on-complete"
  | "on-error";

/** Single hook definition */
export interface HookDef {
  /** Command to execute */
  command: string;
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Whether this hook is enabled (default: true) */
  enabled?: boolean;
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
}
