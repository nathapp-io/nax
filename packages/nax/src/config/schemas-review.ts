/**
 * Review schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";
import { QualityCommandSpecSchema } from "./schemas-execution";
import { ConfiguredModelSchema } from "./schemas-model";

export const SemanticReviewConfigSchema = z.object({
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
  /** LLM call timeout in milliseconds. Default 600s (matches semantic — both review paths may need full tool traversal). */
  timeoutMs: z.number().int().positive().default(600_000),
  /**
   * Pathspec exclusions for the review diff — in the (since deleted) embedded
   * mode they reached the `collectDiff` collector, in ref mode they appear in
   * the prompt's git commands.
   *
   * Optional — undefined means "derive from testFilePatterns + noise dirs" (adversarial
   * defaults to minimal exclusions so it sees test files). Any user-set value (including [])
   * is returned as-is. (ADR-009 §4.4)
   */
  excludePatterns: z.array(z.string()).optional(),
  /** Controls bounded same-session recovery when verifiedBy.observed does not match disk. */
  substantiation: z
    .object({
      /** When true, ask the same reviewer session for one verbatim requote before downgrade. Default true. */
      requote: z.boolean().default(true),
      /** Maximum number of requote turns per adversarial review. Default 5. */
      maxRequotes: z.number().int().min(0).default(5),
    })
    .optional(),
});

/**
 * US-001 (fix-review) — scoped review of a non-blocking fix's own delta.
 *
 * The NBF path stripped both seeded LLM reviews from its re-validation, so a
 * kept pass was guarded only by the deterministic gates; a fix review re-read
 * the fix's own diff against the story's ACs and description before the pass
 * was kept (nax#2229). The NBF path went with the story loop (B2b-1).
 */
export const FixReviewConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Optional; unset falls back to review.semantic.model, then "balanced". */
  model: ConfiguredModelSchema.optional(),
  timeoutMs: z.number().int().positive().default(600_000),
});

export const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  checks: z.array(z.enum(["typecheck", "lint", "test", "build", "semantic", "adversarial"])),
  commands: z.object({
    typecheck: QualityCommandSpecSchema.optional(),
    lint: QualityCommandSpecSchema.optional(),
    lintScoped: QualityCommandSpecSchema.optional(),
    test: QualityCommandSpecSchema.optional(),
    build: QualityCommandSpecSchema.optional(),
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
  /**
   * US-001 — scoped review of a fix's own delta, default-enabled. The
   * `.optional().default(...)` chain keeps the field permissive on input
   * (callers may omit it) while guaranteeing the block is populated on output. The default
   * value is `FixReviewConfigSchema.parse({})`, which carries the inner
   * schema's own defaults (SSOT — see the review literal in `schemas.ts`).
   */
  fixReview: FixReviewConfigSchema.optional().default(FixReviewConfigSchema.parse({})),
});
