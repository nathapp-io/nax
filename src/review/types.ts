/**
 * Review Phase Types
 *
 * Post-implementation quality verification
 */

/** Review check name */
export type ReviewCheckName = "typecheck" | "lint" | "test";

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
  };
}
