/**
 * Review schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";
import { ConfiguredModelSchema } from "./schemas-model";

const SemanticReviewConfigSchema = z.object({
  /**
   * Model selector for semantic review. Tier label or `{ agent, model }` pin.
   * Renamed from `modelTier` (schema-types ConfiguredModel widening). Legacy
   * `modelTier` keys are migrated by `migrateLegacyReviewModelKey` in the
   * config loader and rejected if both keys are present.
   */
  model: ConfiguredModelSchema.default("balanced"),
  /**
   * How the semantic reviewer accesses the git diff.
   * "embedded": pre-collected diff truncated at 50KB and embedded in prompt.
   * "ref" (default): only stat summary + storyGitRef passed; reviewer fetches full diff via tools.
   */
  diffMode: z.enum(["embedded", "ref"]).default("ref"),
  /**
   * When true, clears storyGitRef on failed stories during re-run initialization so
   * the ref is re-captured at the next story start. Prevents cross-story diff pollution
   * when multiple stories exhaust all tiers and are re-run. Default false (current behaviour).
   */
  resetRefOnRerun: z.boolean().default(false),
  rules: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600_000),
  substantiation: z
    .object({
      requote: z.boolean().default(true),
      maxRequotes: z.number().int().min(0).max(50).default(5),
    })
    .default({
      requote: true,
      maxRequotes: 5,
    }),
  /**
   * Optional — undefined means "derive from testFilePatterns + well-known noise dirs".
   * Any user-set value (including []) is returned as-is. (ADR-009 §4.4)
   */
  excludePatterns: z.array(z.string()).optional(),
  /**
   * When true (default), a ref-mode empty-findings `passed:true` verdict with no
   * declared `inspectedFiles` triggers one same-session re-prompt demanding the
   * reviewer actually open the code before passing (#3A inspection-trail guard).
   * Mirrors the adversarial field so the guard is configurable on both reviewers.
   */
  demandInspectionTrail: z.boolean().default(true),
});

/**
 * Adversarial review config — ships off by default (opt-in via review.checks).
 * Destructive heuristics: finds what is missing or broken, not what is present.
 */
export const AdversarialReviewConfigSchema = z.object({
  /**
   * Model selector for adversarial review. Tier label or `{ agent, model }` pin.
   * See SemanticReviewConfigSchema.model for migration notes.
   */
  model: ConfiguredModelSchema.default("balanced"),
  /**
   * "ref" (default): reviewer self-serves the full diff via git tools — no 50KB cap,
   *   test files included. Instructs reviewer to run git diff commands.
   * "embedded": pre-collected full diff (no excludePatterns) embedded in prompt.
   */
  diffMode: z.enum(["embedded", "ref"]).default("ref"),
  /** Custom adversarial heuristic rules to append to the prompt. */
  rules: z.array(z.string()).default([]),
  /** LLM call timeout in milliseconds. Default 600s (matches semantic — no debate path but ref mode may need full tool traversal). */
  timeoutMs: z.number().int().positive().default(600_000),
  /**
   * Pathspec exclusions applied in embedded mode (to collectDiff) and in ref mode
   * (shown in the prompt's git commands).
   *
   * Optional — undefined means "derive from testFilePatterns + noise dirs" (adversarial
   * defaults to minimal exclusions so it sees test files). Any user-set value (including [])
   * is returned as-is. (ADR-009 §4.4)
   */
  excludePatterns: z.array(z.string()).optional(),
  /**
   * When true, run semantic and adversarial reviewers concurrently via Promise.all.
   * Default false (conservative rollout). Only activates when session count is within cap.
   */
  parallel: z.boolean().default(false),
  /** Maximum combined reviewer sessions before falling back to sequential. Default 2. */
  maxConcurrentSessions: z.number().int().min(1).max(4).default(2),
  /**
   * When true (default), after the first adversarial pass, if all blocking findings
   * were dropped by AC-grounding (filterByAcQuote) while no blocking findings remain,
   * issue one reprompt asking the reviewer to re-ground their findings against the
   * AC text. Preserves substantive reviewer judgment when failure is caused by AC-
   * grounding formatting errors rather than model reasoning failure.
   */
  acRegroundOnDrop: z.boolean().default(true),
  /**
   * Phase 0 recurrence-demotion (docs/superpowers/specs/2026-07-17-adversarial-recurrence-demotion-design.md).
   * A non-test-gap error finding blocks for at most `maxBlockingRounds` rounds; once its
   * fingerprint recurs beyond that it auto-demotes to advisory (coverage-gap). An entry
   * guard suppresses severity flip-flops. `enabled: false` restores legacy severity-only blocking.
   */
  recurrenceDemotion: z
    .object({
      enabled: z.boolean().default(true),
      maxBlockingRounds: z.number().int().min(1).default(2),
    })
    .default({ enabled: true, maxBlockingRounds: 2 }),
  /**
   * When true (default), in ref mode an empty-findings `passed:true` verdict that
   * reports no inspected files (`inspectedFiles` absent/empty) triggers exactly one
   * same-session re-prompt demanding the reviewer actually open the changed code
   * before passing. Guards against weaker agents rubber-stamping reviews with a bare
   * `{"passed":true,"findings":[]}` and zero investigation. See
   * docs/findings/2026-05-30-prompt-audit-analysis.md (#3A).
   */
  demandInspectionTrail: z.boolean().default(true),
  /** Controls bounded same-session recovery when verifiedBy.observed does not match disk. */
  substantiation: z
    .object({
      /** When true, ask the same reviewer session for one verbatim requote before downgrade. Default true. */
      requote: z.boolean().default(true),
      /** Maximum number of requote turns per adversarial review. Default 5. */
      maxRequotes: z.number().int().min(0).default(5),
    })
    .optional(),
  /**
   * ADR-024 — Non-blocking best-effort auto-fix over sub-threshold (warning/info)
   * adversarial findings, run after adversarial review passes. Never blocks the
   * story; restores to the adversarial-passed state on exhaustion.
   */
  nonBlockingFix: z
    .object({
      /** Master switch. Opt-in; ramp to true after validating signal quality. */
      enabled: z.boolean().default(false),
      /**
       * "source":  autofix-implementer only.
       * "both":    + autofix-test-writer (test edits allowed).
       * "triage":  route by finding fixTarget (implementer vs test-writer);
       *            bounded by `sourceDiffCap` to cap un-reviewed source edits.
       */
      scope: z.enum(["source", "both", "triage"]).default("both"),
      /** Fix attempts to clear a regression the best-effort fix introduced. */
      regressionAttempts: z.number().int().min(0).default(1),
      /**
       * When true (default) and a test edit occurs (scope "both" or "triage"), add
       * the verifier to deterministic revalidation as the replacement for the
       * stripped adversarial re-run. No-op when no verifier exists (single-session).
       */
      verifierGuard: z.boolean().default(true),
      /**
       * Maximum source-only diff size allowed under scope "triage". Safety rail
       * for the un-reviewed source edits triage newly enables. Absent or empty
       * means bounded by the schema defaults (maxFiles: 10, maxLines: 500).
       * `maxFiles` bounds the number of changed source files; `maxLines` bounds
       * the total added source lines. Test files are excluded via
       * `resolveTestFilePatterns` before comparison.
       */
      sourceDiffCap: z
        .object({
          maxFiles: z.number().int().min(0).default(10),
          maxLines: z.number().int().min(0).default(500),
        })
        .optional()
        .default({ maxFiles: 10, maxLines: 500 }),
    })
    .optional(),
});

export const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  gateLLMChecksOnMechanicalPass: z.boolean().default(true),
  checks: z.array(z.enum(["typecheck", "lint", "test", "build", "semantic", "adversarial"])),
  commands: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    lintScoped: z.string().optional(),
    test: z.string().optional(),
    build: z.string().optional(),
    lintFix: z.string().optional(),
    lintFixScoped: z.string().optional(),
    formatFix: z.string().optional(),
    formatFixScoped: z.string().optional(),
  }),
  audit: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /**
   * Minimum severity that counts as a blocking finding.
   * "error"   (default): only error/critical findings block; warnings are advisory.
   * "warning": error, critical, AND warning findings block; info is advisory.
   * "info":    all findings block (strictest mode).
   *
   * Hierarchy: info < warning < error < critical.
   * Applies only to LLM-based checkers (semantic, adversarial).
   * Mechanical checks (lint, typecheck, test, build) always block on failure.
   */
  blockingThreshold: z.enum(["error", "warning", "info"]).default("error"),
  /**
   * How `IReviewPlugin` deferred reviewers (run once at end-of-run) affect run outcome.
   * "observational" (default): failures are logged + surfaced in run status but do NOT
   *   fail the run — preserves the historical deferred-only behavior (ADR-023 D2, #1146).
   * "gating": any failing plugin reviewer marks the run failed (RunResult.success = false).
   * Note: this controls the deferred end-of-run review only. Per-story plugin gating
   * (issue #1146 G1) was intentionally not restored.
   */
  pluginMode: z.enum(["observational", "gating"]).default("observational"),
  semantic: SemanticReviewConfigSchema.optional(),
  adversarial: AdversarialReviewConfigSchema.optional(),
});
