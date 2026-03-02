/**
 * Interaction System Types (v0.15.0)
 *
 * Interactive pipeline core for user prompts, decision gates, and pause/resume.
 */

/** Interaction request types */
export type InteractionType = "confirm" | "choose" | "input" | "review" | "notify" | "webhook";

/** Pipeline stage where interaction occurs */
export type InteractionStage = "pre-flight" | "execution" | "review" | "merge" | "cost" | "custom";

/** Fallback behavior when interaction times out */
export type InteractionFallback = "continue" | "skip" | "escalate" | "abort";

/** Interaction request — sent to plugin */
export interface InteractionRequest {
  /** Unique request ID (e.g., 'ix-US003-review-1') */
  id: string;
  /** Type of interaction */
  type: InteractionType;
  /** Feature name */
  featureName: string;
  /** Story ID (optional, for story-level interactions) */
  storyId?: string;
  /** Pipeline stage */
  stage: InteractionStage;
  /** Human-readable question/summary */
  summary: string;
  /** Longer context/details (optional) */
  detail?: string;
  /** Options for choose type */
  options?: Array<{ key: string; label: string; description?: string }>;
  /** Timeout in milliseconds (optional) */
  timeout?: number;
  /** Fallback behavior on timeout */
  fallback: InteractionFallback;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Creation timestamp */
  createdAt: number;
}

/** Interaction response action */
export type InteractionAction = "approve" | "reject" | "choose" | "input" | "skip" | "abort";

/** Interaction response — returned from plugin */
export interface InteractionResponse {
  /** Request ID this response is for */
  requestId: string;
  /** Action taken */
  action: InteractionAction;
  /** Value (for choose/input types) */
  value?: string;
  /** Who responded (user, system, timeout, etc.) */
  respondedBy?: string;
  /** Response timestamp */
  respondedAt: number;
}

/** Interaction plugin interface */
export interface InteractionPlugin {
  /** Plugin name */
  name: string;
  /** Send interaction request to user */
  send(request: InteractionRequest): Promise<void>;
  /** Receive interaction response from user (blocking) */
  receive(requestId: string, timeout?: number): Promise<InteractionResponse>;
  /** Cancel a pending interaction (optional) */
  cancel?(requestId: string): Promise<void>;
  /** Initialize plugin with config (optional) */
  init?(config: Record<string, unknown>): Promise<void>;
  /** Teardown plugin (optional) */
  destroy?(): Promise<void>;
}

/** Built-in trigger names */
export type TriggerName =
  | "security-review" // abort (red) — critical security issues found
  | "cost-exceeded" // abort (red) — cost limit exceeded
  | "merge-conflict" // abort (red) — merge conflict detected
  | "cost-warning" // escalate (yellow) — approaching cost limit
  | "max-retries" // skip (yellow) — max retries reached
  | "pre-merge" // escalate (yellow) — before merging to main
  | "human-review" // skip (yellow) — human review required on max retries / critical failure
  | "story-ambiguity" // continue (green) — story requirements unclear
  | "review-gate"; // continue (green) — code review checkpoint

/** Trigger configuration */
export interface TriggerConfig {
  /** Whether trigger is enabled */
  enabled: boolean;
  /** Override default fallback behavior */
  fallback?: InteractionFallback;
  /** Override default timeout (ms) */
  timeout?: number;
  /** Custom summary template (supports {{variable}} syntax) */
  summary?: string;
  /** Custom detail template */
  detail?: string;
}

/** Safety tier for triggers */
export type TriggerSafety = "red" | "yellow" | "green";

/** Built-in trigger metadata */
export interface TriggerMetadata {
  /** Default fallback behavior */
  defaultFallback: InteractionFallback;
  /** Safety tier */
  safety: TriggerSafety;
  /** Default summary */
  defaultSummary: string;
}

/** Map of built-in triggers to their metadata */
export const TRIGGER_METADATA: Record<TriggerName, TriggerMetadata> = {
  "security-review": {
    defaultFallback: "abort",
    safety: "red",
    defaultSummary: "Security review failed — abort execution?",
  },
  "cost-exceeded": {
    defaultFallback: "abort",
    safety: "red",
    defaultSummary: "Cost limit exceeded ({{cost}} USD) — abort execution?",
  },
  "merge-conflict": {
    defaultFallback: "abort",
    safety: "red",
    defaultSummary: "Merge conflict detected in {{storyId}} — abort execution?",
  },
  "cost-warning": {
    defaultFallback: "escalate",
    safety: "yellow",
    defaultSummary: "Cost warning: {{cost}} USD / {{limit}} USD — escalate to higher tier?",
  },
  "max-retries": {
    defaultFallback: "skip",
    safety: "yellow",
    defaultSummary: "Max retries reached for {{storyId}} — skip story?",
  },
  "pre-merge": {
    defaultFallback: "escalate",
    safety: "yellow",
    defaultSummary: "Pre-merge checkpoint for {{storyId}} — proceed with merge?",
  },
  "human-review": {
    defaultFallback: "skip",
    safety: "yellow",
    defaultSummary: "Human review required for story {{storyId}} — skip and continue?",
  },
  "story-ambiguity": {
    defaultFallback: "continue",
    safety: "green",
    defaultSummary: "Story {{storyId}} requirements unclear — continue with best effort?",
  },
  "review-gate": {
    defaultFallback: "continue",
    safety: "green",
    defaultSummary: "Code review checkpoint for {{storyId}} — proceed?",
  },
};
