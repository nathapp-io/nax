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
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 provider set
// ─────────────────────────────────────────────────────────────────────────────

/** Providers available in Phase 0 */
const PHASE_0_PROVIDERS = ["static-rules", "feature-context"];

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
  // Main implementation — full budget, implementer role
  execution: {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // TDD sub-sessions — each gets implementer role, moderate budget
  "tdd-test-writer": {
    role: "tdd",
    budgetTokens: 8_000,
    providerIds: PHASE_0_PROVIDERS,
  },
  "tdd-implementer": {
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: PHASE_0_PROVIDERS,
  },
  "tdd-verifier": {
    role: "tdd",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Verify — small budget, knows about test failures
  verify: {
    role: "implementer",
    budgetTokens: 4_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Rectify — medium budget, needs feature context for fix attempts
  rectify: {
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Review — reviewer role, sees reviewer-tagged chunks
  review: {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
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
};

/**
 * Get the context config for a given stage name.
 * Falls back to DEFAULT_STAGE_CONFIG for unknown stages.
 */
export function getStageContextConfig(stage: string): StageContextConfig {
  return STAGE_CONTEXT_MAP[stage] ?? DEFAULT_STAGE_CONFIG;
}
