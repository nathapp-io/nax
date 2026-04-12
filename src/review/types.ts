/**
 * Review Phase Types
 *
 * Post-implementation quality verification
 */

/** Review check name */
export type ReviewCheckName = "typecheck" | "lint" | "test" | "build" | "semantic" | "adversarial";

/**
 * Diff context passed to debate resolver and prompt builders.
 * Discriminated on `mode` — prevents ambiguous routing when both
 * `diff` and `storyGitRef` might be present in a ResolverContext spread.
 */
export type DiffContext =
  | { mode: "embedded"; diff: string; storyGitRef?: never; stat?: never }
  | { mode: "ref"; storyGitRef: string; stat?: string; diff?: never };

/** Story fields required for semantic review */
export interface SemanticStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/** Semantic review configuration */
export interface SemanticReviewConfig {
  /** Model tier for semantic review (default: 'balanced') */
  modelTier: import("../config/schema-types").ModelTier;
  /**
   * How the semantic reviewer accesses the git diff.
   * "embedded" (default): pre-collected diff truncated at 50KB and embedded in prompt.
   * "ref": only stat summary + storyGitRef passed; reviewer fetches full diff via tools.
   */
  diffMode: "embedded" | "ref";
  /**
   * When true, clears storyGitRef on failed stories during re-run initialization so
   * the ref is re-captured at the next story start. Prevents cross-story diff pollution
   * when multiple stories exhaust all tiers and are re-run. Default false.
   */
  resetRefOnRerun: boolean;
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
  /** LLM cost incurred for this check (populated by semantic review) */
  cost?: number;
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

/** Adversarial review configuration (when 'adversarial' is in checks) */
export interface AdversarialReviewConfig {
  /** Model tier for adversarial review (default: 'balanced') */
  modelTier: import("../config/schema-types").ModelTier;
  /**
   * "ref" (default): reviewer self-serves the full diff via git tools — no 50KB cap,
   *   test files included.
   * "embedded": full diff (no excludePatterns) embedded in prompt.
   */
  diffMode: "embedded" | "ref";
  /** Custom adversarial heuristic rules to append to the prompt */
  rules: string[];
  /** Timeout in milliseconds (default: 600_000) */
  timeoutMs: number;
  /** Pathspec exclusions for embedded mode. Default empty (adversarial sees test files). */
  excludePatterns: string[];
  /** When true, run semantic and adversarial concurrently. Default false. */
  parallel: boolean;
  /** Maximum combined reviewer sessions before falling back to sequential. Default 2. */
  maxConcurrentSessions: number;
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
    /** Auto-fix lint errors — used by autofix stage when lint fails */
    lintFix?: string;
    /** Auto-fix formatting — used by autofix stage when lint fails */
    formatFix?: string;
  };
  /** When to run plugin reviewers: per-story (default) or deferred (skip per-story, run once at end) */
  pluginMode?: "per-story" | "deferred";
  /** Semantic review configuration (when 'semantic' is in checks) */
  semantic?: SemanticReviewConfig;
  /** Adversarial review configuration (when 'adversarial' is in checks) */
  adversarial?: AdversarialReviewConfig;
  /** Reviewer-implementer dialogue configuration */
  dialogue?: ReviewDialogueConfig;
}
