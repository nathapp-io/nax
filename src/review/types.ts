/**
 * Review Phase Types
 *
 * Post-implementation quality verification
 */

/** Review check name */
export type ReviewCheckName = "typecheck" | "lint" | "test" | "build" | "semantic";

/** Semantic review configuration */
export interface SemanticReviewConfig {
  /** Model tier for semantic review (default: 'balanced') */
  modelTier: import("../config/schema-types").ModelTier;
  /** Custom semantic review rules */
  rules: string[];
  /** Timeout in milliseconds for the LLM call (default: 600_000) */
  timeoutMs: number;
  /** Git pathspec patterns to exclude from the semantic diff (e.g. ':!test/', ':!*.test.ts') */
  excludePatterns: string[];
}

/** Review check result */
export interface ReviewCheckResult {
  /** Check name */
  check: ReviewCheckName;
  /** Pass or fail */
  success: boolean;
  /** Command that was run */
  command: string;
  /** Exit code */
  exitCode: number;
  /** Output from the command */
  output: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Structured findings (populated by semantic review when LLM returns findings) */
  findings?: import("../plugins/types").ReviewFinding[];
}

/** Plugin reviewer result */
export interface PluginReviewerResult {
  /** Plugin reviewer name */
  name: string;
  /** Pass or fail */
  passed: boolean;
  /** Output from the reviewer */
  output: string;
  /** Exit code (if applicable) */
  exitCode?: number;
  /** Error message if reviewer threw an exception */
  error?: string;
  /** Structured findings from the reviewer (optional) */
  findings?: import("../plugins/types").ReviewFinding[];
}

/** Review phase result */
export interface ReviewResult {
  /** All checks passed */
  success: boolean;
  /** Individual check results */
  checks: ReviewCheckResult[];
  /** Total duration */
  totalDurationMs: number;
  /** First failure reason (if any) */
  failureReason?: string;
  /** Plugin reviewer results (if any) */
  pluginReviewers?: PluginReviewerResult[];
}

/** Reviewer-implementer dialogue configuration */
export interface ReviewDialogueConfig {
  /** Enable reviewer-implementer dialogue mode */
  enabled: boolean;
  /** Maximum clarification exchanges per attempt */
  maxClarificationsPerAttempt: number;
  /** Maximum total messages in a dialogue session */
  maxDialogueMessages: number;
}

/** Review configuration */
export interface ReviewConfig {
  /** Enable review phase */
  enabled: boolean;
  /** List of checks to run */
  checks: ReviewCheckName[];
  /** Custom commands per check */
  commands: {
    typecheck?: string;
    lint?: string;
    test?: string;
    build?: string;
  };
  /** When to run plugin reviewers: per-story (default) or deferred (skip per-story, run once at end) */
  pluginMode?: "per-story" | "deferred";
  /** Semantic review configuration (when 'semantic' is in checks) */
  semantic?: SemanticReviewConfig;
  /** Reviewer-implementer dialogue configuration */
  dialogue?: ReviewDialogueConfig;
}
