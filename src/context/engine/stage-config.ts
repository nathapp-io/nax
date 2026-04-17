/**
 * Context Engine v2 — Stage Context Map
 *
 * Default configuration for each pipeline stage: which providers to use,
 * token budget, caller role, and kind weights.
 *
 * Stages not listed here get the DEFAULT_STAGE_CONFIG.
 * Provider IDs listed here correspond to IContextProvider.id values.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Stage Context Map
 */

import type { ChunkRole } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-stage context configuration */
export interface StageContextConfig {
  /**
   * Caller role passed to the orchestrator.
   * Controls role-filter and score adjustment.
   */
  role: ChunkRole;
  /**
   * Token budget for the push markdown.
   * "static" + "feature" floor items are always included even if exceeded.
   */
  budgetTokens: number;
  /**
   * Provider IDs to include for this stage.
   * Phase 0: ["static-rules", "feature-context"]
   * Phase 1+: more providers added here.
   */
  providerIds: string[];
  /**
   * Pull tool names to activate for this stage (Phase 4+).
   * Absent or empty = pull tools disabled for this stage.
   * The orchestrator filters these through PULL_TOOL_REGISTRY and the
   * per-request pullConfig.allowedTools allowlist.
   */
  pullToolNames?: string[];
  /**
   * Plan digest score multiplier (Amendment B AC-51).
   * When > 1.0, the plan digest is injected as a scored RawChunk with
   * rawScore = 0.9 * planDigestBoost instead of raw markdown rendering.
   * Applied for single-session modes to compensate for absent cross-session digest.
   * Default: absent (treated as 1.0, raw markdown rendering used).
   */
  planDigestBoost?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 provider set
// ─────────────────────────────────────────────────────────────────────────────

/** Providers available in Phase 0 (static rules + feature context) */
const PHASE_0_PROVIDERS = ["static-rules", "feature-context"];

/**
 * Phase 1 providers — adds session scratch for stages that need it.
 * verify and rectify read scratch entries written by the prior run.
 */
const PHASE_1_PROVIDERS = ["static-rules", "feature-context", "session-scratch"];

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 provider sets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 3 providers for tdd-test-writer — adds code neighbors so the
 * test writer can see sibling tests and related imports.
 */
const PHASE_3_TDD_TEST_WRITER = [...PHASE_1_PROVIDERS, "code-neighbor"];

/**
 * Phase 3 providers for tdd-implementer and execution — adds git history
 * (recent commits on touched files) and code neighbors.
 */
const PHASE_3_TDD_IMPLEMENTER = [...PHASE_1_PROVIDERS, "git-history", "code-neighbor"];

/**
 * Phase 3 providers for execution stage — same as tdd-implementer.
 */
const PHASE_3_EXECUTION = [...PHASE_1_PROVIDERS, "git-history", "code-neighbor"];

/**
 * Phase 3 providers for rectify — code neighbors help the agent understand
 * the import graph when fixing failures; git history omitted (less relevant).
 */
const PHASE_3_RECTIFY = [...PHASE_1_PROVIDERS, "code-neighbor"];

// ─────────────────────────────────────────────────────────────────────────────
// Stage map
// ─────────────────────────────────────────────────────────────────────────────

/** Default config for stages not explicitly listed */
export const DEFAULT_STAGE_CONFIG: StageContextConfig = {
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: PHASE_0_PROVIDERS,
};

/**
 * Stage-by-stage context configuration.
 * Based on the stage context map in SPEC-context-engine-v2.md.
 */
export const STAGE_CONTEXT_MAP: Record<string, StageContextConfig> = {
  // Context stage — initial assembly before execution; uses git history + code neighbors
  // so the agent sees touched-file history and import-graph neighbors from the start.
  context: {
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: PHASE_3_EXECUTION,
  },

  // Main implementation — full budget, implementer role
  execution: {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_EXECUTION,
  },

  // TDD sub-sessions — each gets implementer role, moderate budget
  "tdd-test-writer": {
    role: "tdd",
    budgetTokens: 8_000,
    providerIds: PHASE_3_TDD_TEST_WRITER,
    pullToolNames: ["query_neighbor"],
  },
  "tdd-implementer": {
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: PHASE_3_TDD_IMPLEMENTER,
    pullToolNames: ["query_neighbor"],
  },
  "tdd-verifier": {
    role: "tdd",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Verify — small budget, reads session scratch to surface prior failures
  verify: {
    role: "implementer",
    budgetTokens: 4_000,
    providerIds: PHASE_1_PROVIDERS,
  },

  // Rectify — medium budget, needs feature context + prior verify failures + code neighbors
  rectify: {
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: PHASE_3_RECTIFY,
    pullToolNames: ["query_neighbor"],
  },

  // Review — reviewer role, sees reviewer-tagged chunks
  review: {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Semantic review — reviewer role; query_feature_context lets the reviewer
  // check design decisions and prior conventions in the feature context.
  "review-semantic": {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
    pullToolNames: ["query_feature_context"],
  },

  // Adversarial review — same pull tool access as semantic review.
  "review-adversarial": {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
    pullToolNames: ["query_feature_context"],
  },

  // Autofix — implementer role, tight budget (mechanical fixes)
  autofix: {
    role: "implementer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Acceptance — implementer role, small budget
  acceptance: {
    role: "implementer",
    budgetTokens: 4_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Planning — implementer role, full budget
  plan: {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Single-session strategy — same as execution (no TDD split)
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  "single-session": {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_EXECUTION,
    pullToolNames: ["query_neighbor"],
    planDigestBoost: 1.5,
  },

  // TDD-simple strategy — same as single-session (simplified TDD with merged roles)
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  "tdd-simple": {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_EXECUTION,
    pullToolNames: ["query_neighbor"],
    planDigestBoost: 1.5,
  },

  // No-test strategy — implementer role, moderate budget
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  "no-test": {
    role: "implementer",
    budgetTokens: 10_000,
    providerIds: PHASE_3_EXECUTION,
    planDigestBoost: 1.5,
  },

  // Batch strategy — implementer role, full budget (parallel stories)
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  batch: {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_EXECUTION,
    pullToolNames: ["query_neighbor"],
    planDigestBoost: 1.5,
  },

  // Route — lightweight context for routing/classification; static rules only
  route: {
    role: "implementer",
    budgetTokens: 4_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Review dialogue — reviewer role; same pull access as semantic review
  "review-dialogue": {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
    pullToolNames: ["query_feature_context"],
  },

  // Debate — reviewer role; static + feature context for multi-agent critique
  debate: {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },
};

/**
 * Get the context config for a given stage name.
 * Falls back to DEFAULT_STAGE_CONFIG for unknown stages.
 */
export function getStageContextConfig(stage: string): StageContextConfig {
  return STAGE_CONTEXT_MAP[stage] ?? DEFAULT_STAGE_CONFIG;
}
