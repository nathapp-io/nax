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
  /**
   * Optional — undefined means "derive from testFilePatterns + well-known noise dirs".
   * Any user-set value (including []) is returned as-is. (ADR-009 §4.4)
   */
  excludePatterns: z.array(z.string()).optional(),
});

export const ReviewDialogueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxClarificationsPerAttempt: z.number().int().min(0).max(10).default(2),
  maxDialogueMessages: z.number().int().min(5).max(100).default(20),
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
});

export const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  gateLLMChecksOnMechanicalPass: z.boolean().default(true),
  checks: z.array(z.enum(["typecheck", "lint", "test", "build", "semantic", "adversarial"])),
  commands: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
    build: z.string().optional(),
    lintFix: z.string().optional(),
    formatFix: z.string().optional(),
  }),
  pluginMode: z.enum(["per-story", "deferred"]).default("per-story"),
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
  semantic: SemanticReviewConfigSchema.optional(),
  adversarial: AdversarialReviewConfigSchema.optional(),
  dialogue: ReviewDialogueConfigSchema.default({
    enabled: false,
    maxClarificationsPerAttempt: 2,
    maxDialogueMessages: 20,
  }),
});
