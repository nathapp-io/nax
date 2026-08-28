/**
 * Review Phase Types
 *
 * Post-implementation quality verification
 */

import type { z } from "zod";
import type {
  AdversarialReviewConfigSchema,
  ReviewConfigSchema,
  SemanticReviewConfigSchema,
} from "../config/schemas-review";
import type { Finding } from "../findings";

/** Review check name */
export type ReviewCheckName = "typecheck" | "lint" | "test" | "build" | "semantic" | "adversarial" | "git-clean";

/**
 * A prior finding the reviewer explicitly did NOT re-flag this round (#1423).
 *
 * The carry-forward verdict template asks the reviewer to classify every prior
 * finding as `addressed`, `still-blocking`, or `never-an-issue`. Only
 * `still-blocking` is a defect; the other two are bookkeeping. Before this
 * type existed the reviewer's only output channel was `findings`, so
 * acknowledgements were counted as findings — 2.2% of July's, all `info` —
 * and surfaced as the evidence samples in curator rule proposals.
 */
export interface ReviewAck {
  /** Short identifier of the prior finding: `file:line`, or a few words of its message. */
  priorFinding: string;
  /**
   * `unknown` when the reviewer supplied a status outside the schema — including
   * `still-blocking`, which belongs in `findings`, not here. Recorded rather than
   * coerced: an ack claiming a blocker was "addressed" when the reviewer meant
   * the opposite would affirmatively certify an unfixed defect as resolved, and
   * nothing downstream could ever detect it.
   */
  status: "addressed" | "never-an-issue" | "unknown";
  /** The diff line that resolves it, or why the prior judgment was wrong. */
  note?: string;
  /** The reviewer's literal `status` string, kept when it was not a known value. */
  rawStatus?: string;
}

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
  /**
   * Total call attempts (initial call + corrective re-prompts) the semantic/adversarial
   * parse-retry strategy gets before exhausting to its fallback. Default 3.
   */
  parseRetryMaxAttempts: number;
  /** Semantic review configuration (when 'semantic' is in checks) */
  semantic?: SemanticReviewConfig;
  /** Adversarial review configuration (when 'adversarial' is in checks) */
  adversarial?: AdversarialReviewConfig;
  /** Parsed oscillation + cross-attempt review-recurrence circuit-breaker configuration. */
  conflictDetection: { enabled: boolean; maxOscillations: number; maxCrossAttemptRecurrences: number };
}

/**
 * Compile-time drift guard (#1666).
 *
 * `ReviewConfig` above is hand-written rather than `z.infer<typeof
 * ReviewConfigSchema>` (src/config/schemas-review.ts) — this is a leaf
 * review-domain module and `src/config/` already imports FROM it
 * (config/runtime-types.ts), so deriving the type here would need a
 * value-level import back into `src/config/`, which the barrel-gate /
 * import-cycle ratchet treats as exactly the kind of edge to avoid (see
 * `.claude/rules/project-conventions.md`'s cycle-ratchet section). A
 * type-only import back is fine (erased, cannot participate in a runtime
 * cycle) and is all this guard needs.
 *
 * Without this, the two shapes can silently diverge — which they already had:
 * `SemanticReviewConfig.acRegroundOnDrop` existed here and was read
 * unconditionally by `src/operations/semantic-review.ts`, but the schema had
 * no such field, so it was always `undefined` at runtime and the knob could
 * never be disabled via config (fixed alongside this guard, see
 * schemas-review.ts). This assertion fails `bun run typecheck` the moment
 * `ReviewConfig` and the schema's inferred shape disagree in EITHER
 * direction, so that class of bug cannot reappear unnoticed.
 *
 * Both `extends` clauses are required — TypeScript's structural typing lets
 * a type with a superset of required fields (or narrower optionality)
 * satisfy `extends` against a looser type in one direction without the
 * reverse holding, so checking only one direction would miss a field ADDED
 * to just one side.
 */
type _ReviewConfigSchemaShape = z.infer<typeof ReviewConfigSchema>;
type _SemanticReviewConfigSchemaShape = z.infer<typeof SemanticReviewConfigSchema>;
type _AdversarialReviewConfigSchemaShape = z.infer<typeof AdversarialReviewConfigSchema>;

/**
 * Keys present on exactly one side of A/B — a field added to (or removed
 * from) only one of the two shapes. Deliberately KEYS-ONLY, not full
 * structural equality: many fields here are `.default()`-ed in the schema
 * (so required in its inferred OUTPUT type) but marked optional (`?`) in
 * these hand-written interfaces on purpose — that laxness lets tests build
 * partial fixtures without threading every default through, and is not the
 * hazard this guard exists for. The hazard is a field that exists on ONE
 * side ONLY — exactly what happened with #1666 Part C's `maxCrossAttemptRecurrences`
 * (added to the schema, forgotten here) and the pre-existing
 * `SemanticReviewConfig.acRegroundOnDrop` gap this same change fixes (existed
 * here, was missing from `SemanticReviewConfigSchema` — see schemas-review.ts).
 * A full mutual-`extends`/equality check was tried first and rejected: it
 * flags every one of those legitimate optional-vs-required differences,
 * which is a much larger, noisier ripple than the one real class of bug this
 * guard is for.
 */
type _KeyDrift<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>;

type _ReviewConfigKeyDrift = _KeyDrift<ReviewConfig, _ReviewConfigSchemaShape>;
type _SemanticReviewConfigKeyDrift = _KeyDrift<SemanticReviewConfig, _SemanticReviewConfigSchemaShape>;
type _AdversarialReviewConfigKeyDrift = _KeyDrift<AdversarialReviewConfig, _AdversarialReviewConfigSchemaShape>;

/**
 * Type-only assertion (fully erased, no runtime code) — `T extends never`
 * only resolves when the drift type argument actually has no members, i.e.
 * no drifted keys. Instantiating it below with each drift type is the
 * assertion; if any drifted key exists, TypeScript's "does not satisfy the
 * constraint 'never'" error names it right there.
 */
type _AssertNoKeyDrift<_T extends never> = true;

// If any of these three lines fails to typecheck, the error names the
// drifted key(s) — reconcile the interface (this file) and the matching
// schema (config/schemas-review.ts) before touching either one further. Do
// not silence this by widening either side to `unknown`/`any`.
type _reviewConfigKeyDriftCheck = _AssertNoKeyDrift<_ReviewConfigKeyDrift>;
type _semanticReviewConfigKeyDriftCheck = _AssertNoKeyDrift<_SemanticReviewConfigKeyDrift>;
type _adversarialReviewConfigKeyDriftCheck = _AssertNoKeyDrift<_AdversarialReviewConfigKeyDrift>;
