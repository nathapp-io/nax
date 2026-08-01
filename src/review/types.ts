/**
 * Review Phase Types
 *
 * Post-implementation quality verification
 */

import type { Finding } from "../findings";

/** Review check name */
export type ReviewCheckName = "typecheck" | "lint" | "test" | "build" | "semantic" | "adversarial" | "git-clean";

/**
 * Diff context passed to debate resolver and prompt builders.
 * Discriminated on `mode` — prevents ambiguous routing when both
 * `diff` and `storyGitRef` are present.
 */
export type DiffContext =
  | { mode: "embedded"; diff: string; storyGitRef?: never; stat?: never }
  | {
      mode: "ref";
      storyGitRef: string;
      stat?: string;
      diff?: never;
      /**
       * Production-diff exclude pathspec derived from resolveTestFilePatterns() +
       * resolveReviewExcludePatterns(). Used by debate resolver prompts.
       */
      productionExcludePatterns?: readonly string[];
    };

/** Story fields required for semantic review */
export interface SemanticStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /**
   * Feature-level exclusions the spec declared out of scope, propagated onto
   * every story by `propagateOutOfScopeToStories` (src/prd/out-of-scope.ts).
   *
   * Structurally satisfied by `UserStory`, so callers keep passing the story
   * unchanged. Reviewers render this as its own list — it is NOT an acceptance
   * criterion and must never be quoted as one; a finding about excluded work
   * cites `scopeQuote`/`scopeIndex` against this array instead.
   */
  outOfScope?: string[];
}

/** Semantic review configuration */
export interface SemanticReviewConfig {
  /**
   * Model selector for semantic review (default: 'balanced').
   * Accepts a tier label ("fast" | "balanced" | "powerful") or an explicit
   * `{ agent, model }` pin for cross-agent overrides.
   */
  model: import("../config/schema-types").ConfiguredModel;
  /**
   * How the semantic reviewer accesses the git diff.
   * "embedded": pre-collected diff truncated at 50KB and embedded in prompt.
   * "ref" (default): only stat summary + storyGitRef passed; reviewer fetches full diff via tools.
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
  /** Controls bounded same-session recovery when verifiedBy.observed does not match disk. */
  substantiation?: {
    /** When true, ask the same reviewer session for one verbatim requote before downgrade. */
    requote: boolean;
    /** Maximum number of requote turns per semantic review. */
    maxRequotes: number;
  };
  /**
   * Git pathspec patterns to exclude from the semantic diff.
   * Optional — undefined means "derive from testFilePatterns + well-known noise dirs". (ADR-009 §4.4)
   */
  excludePatterns?: string[];
  /**
   * When true (default), after the first semantic pass, if all blocking findings
   * were dropped by AC-grounding (filterByAcGroundingMinimal) while no blocking
   * findings remain, issue one reprompt asking the reviewer to re-ground their
   * findings against the AC text.
   */
  acRegroundOnDrop?: boolean;
  /**
   * When true (default), a ref-mode empty-findings `passed:true` verdict with no
   * declared `inspectedFiles` triggers one same-session re-prompt demanding the
   * reviewer actually open the code before passing (#3A inspection-trail guard).
   */
  demandInspectionTrail?: boolean;
  /** Opt-in for semantic (default disabled) — see schemas-review.ts. */
  recurrenceDemotion?: { enabled: boolean; maxBlockingRounds: number };
}

/** Review check result */
export interface ReviewCheckResult {
  /** Check name */
  check: ReviewCheckName;
  /** Pass or fail */
  success: boolean;
  /** True when this check was intentionally not run (for example, gated by mechanical failures). */
  skipped?: boolean;
  /** Command that was run */
  command: string;
  /** Exit code */
  exitCode: number;
  /** Output from the command */
  output: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Blocking findings — severity at or above blockingThreshold (populated by LLM reviewers) — Finding[] per ADR-021 phase 7 */
  findings?: Finding[];
  /** Advisory findings — severity below blockingThreshold (populated by LLM reviewers) — Finding[] per ADR-021 phase 7 */
  advisoryFindings?: Finding[];
  /** LLM cost incurred for this check (populated by semantic review) */
  cost?: number;
  /** True when the LLM reviewer could not parse its response and fell back to success:true (fail-open).
   * Consumers in a retry context (autofixAttempt > 0) must treat this as a non-genuine pass. */
  failOpen?: boolean;
  /**
   * Set when the adversarial check passed because all blocking findings were
   * discarded as hallucinated AC quotes (ac_quote_not_substring). Consumers
   * in a retry context should treat this as a weaker pass signal than a genuine
   * adversarial pass.
   */
  passReason?: "ac_quote_not_substring_demoted";
  /**
   * Optional scoped-lint metadata for autofix/review consumers.
   * Provides explicit package grouping and structured out-of-scope status.
   */
  lintScope?: {
    status: "in_scope" | "out_of_scope" | "degraded";
    packageGroups: Array<{ packageDir: string; files: string[] }>;
    outOfScopeDiagnosticCount?: number;
  };
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
  /** Structured findings from the reviewer (optional) — Finding[] per ADR-021 phase 2 */
  findings?: import("../findings").Finding[];
}

/** Per-reviewer blocking/advisory finding counts for reviewSummary */
export interface ReviewerFindingSummary {
  /** Number of findings at or above blockingThreshold */
  blocking: number;
  /** Number of findings below blockingThreshold */
  advisory: number;
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
  /** Per-reviewer finding breakdown (populated when semantic/adversarial run) */
  reviewSummary?: {
    semantic?: ReviewerFindingSummary;
    adversarial?: ReviewerFindingSummary;
  };
}

/** Adversarial review configuration (when 'adversarial' is in checks) */
export interface AdversarialReviewConfig {
  /**
   * Model selector for adversarial review (default: 'balanced').
   * Accepts a tier label or an explicit `{ agent, model }` pin.
   */
  model: import("../config/schema-types").ConfiguredModel;
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
  /**
   * Pathspec exclusions for embedded mode.
   * Optional — undefined means "derive from testFilePatterns + noise dirs". (ADR-009 §4.4)
   */
  excludePatterns?: string[];
  /** When true, run semantic and adversarial concurrently. Default false. */
  parallel: boolean;
  /** Maximum combined reviewer sessions before falling back to sequential. Default 2. */
  maxConcurrentSessions: number;
  /** Controls bounded same-session recovery when verifiedBy.observed does not match disk. */
  substantiation?: {
    /** When true, ask the same reviewer session for one verbatim requote before downgrade. */
    requote: boolean;
    /** Maximum number of requote turns per adversarial review. */
    maxRequotes: number;
  };
  /**
   * When true (default), after the first adversarial pass, if all blocking findings
   * were dropped by AC-grounding while no blocking findings remain, issue one reprompt
   * asking the reviewer to re-ground their findings against the AC text.
   */
  acRegroundOnDrop?: boolean;
  /**
   * Phase 0 recurrence-demotion. Non-test-gap error findings demote to advisory
   * after recurring beyond `maxBlockingRounds` rounds; entry guard suppresses
   * flip-flops. Default `{ enabled: true, maxBlockingRounds: 2 }`.
   */
  recurrenceDemotion?: { enabled: boolean; maxBlockingRounds: number };
  /**
   * When true (default), a ref-mode empty-findings `passed:true` verdict with no
   * declared `inspectedFiles` triggers one same-session re-prompt demanding the
   * reviewer actually open the code before passing (#3A inspection-trail guard).
   */
  demandInspectionTrail?: boolean;
  /** ADR-024 — Non-blocking best-effort auto-fix over sub-threshold adversarial findings. */
  nonBlockingFix?: import("../config/selectors").NonBlockingFixConfig;
}

/** Review configuration */
export interface ReviewConfig {
  /** Enable review phase */
  enabled: boolean;
  /**
   * When true (default), semantic/adversarial checks run only after all enabled
   * mechanical checks pass.
   */
  gateLLMChecksOnMechanicalPass?: boolean;
  /** List of checks to run */
  checks: ReviewCheckName[];
  /** Custom commands per check */
  commands: {
    typecheck?: string;
    lint?: string;
    /** Scoped lint command template with {{files}} placeholder */
    lintScoped?: string;
    test?: string;
    build?: string;
    /** Auto-fix lint errors — used by autofix stage when lint fails */
    lintFix?: string;
    /** Scoped auto-fix lint command template with {{files}} placeholder */
    lintFixScoped?: string;
    /** Auto-fix formatting — used by autofix stage when lint fails */
    formatFix?: string;
    /** Scoped auto-format command template with {{files}} placeholder */
    formatFixScoped?: string;
  };
  /** Review audit configuration — saves parsed reviewer JSON to .nax/review-audit/ */
  audit?: { enabled: boolean };
  /**
   * Minimum severity that counts as a blocking finding for LLM-based checkers.
   * "error" (default): only error/critical block; warnings are advisory.
   * "warning": error, critical, and warning block; info is advisory.
   * "info": all findings block (strictest).
   * Mechanical checks (lint, typecheck, test, build) always block on failure.
   */
  blockingThreshold?: "error" | "warning" | "info";
  /**
   * How `IReviewPlugin` deferred reviewers affect run outcome. Defaults to "observational".
   * "observational": failures are logged but do NOT fail the run (ADR-023 D2, #1146).
   * "gating": any failing plugin reviewer marks the run failed (RunResult.success = false).
   */
  pluginMode: "observational" | "gating";
  /** Semantic review configuration (when 'semantic' is in checks) */
  semantic?: SemanticReviewConfig;
  /** Adversarial review configuration (when 'adversarial' is in checks) */
  adversarial?: AdversarialReviewConfig;
  /** Parsed oscillation circuit-breaker configuration. */
  conflictDetection: { enabled: boolean; maxOscillations: number };
}
