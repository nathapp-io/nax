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
 * Phase 3 providers for tdd-implementer — adds git history
 * (recent commits on touched files), code neighbors, and test coverage.
 */
const PHASE_3_TDD_IMPLEMENTER = [...PHASE_1_PROVIDERS, "git-history", "code-neighbor", "test-coverage"];

/**
 * Phase 3 providers for `context` plus the single-session execution strategy
 * stages (single-session, tdd-simple, no-test, batch) — same as
 * tdd-implementer, plus US-002 tool-diagnostics so the implementer sees
 * authoritative lint/typecheck output when retrying after a quality failure.
 */
const PHASE_3_IMPLEMENTATION = [
  ...PHASE_1_PROVIDERS,
  "git-history",
  "code-neighbor",
  "test-coverage",
  "tool-diagnostics",
];

/**
 * Phase 3 providers for rectify — code neighbors help the agent understand
 * the import graph when fixing failures; git history omitted (less relevant).
 * US-002 adds tool-diagnostics so the rectifier gets authoritative
 * lint/typecheck provenance instead of relying on agent self-reports.
 * US-003 adds prior-run-failure so the rectifier sees this story's historic
 * failed attempts and failing test files before retrying.
 * US-004 adds lint-config so the rectifier retrying a lint failure has the
 * package's lint settings — distilling the most retry-loop-relevant fields
 * (e.g. biome indentWidth) — without re-discovering the linter.
 */
const PHASE_3_RECTIFY = [...PHASE_1_PROVIDERS, "code-neighbor", "tool-diagnostics", "prior-run-failure", "lint-config"];

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
// A key in this map is only "live" — actually reaches an assembled bundle —
// if one of the three assembly sites selects it:
//   - src/pipeline/stages/context.ts:171 (always "context")
//   - src/pipeline/stages/prompt.ts (via executionContextStage)
//   - src/execution/story-orchestrator/run-phase.ts (via contextStageForOp)
// See test/unit/context/engine/stage-reachability.test.ts, which enforces
// this for every key that declares pullToolNames. See nax#1743.
export const STAGE_CONTEXT_MAP = {
  // Context stage — initial assembly before execution; uses git history + code neighbors
  // so the agent sees touched-file history and import-graph neighbors from the start.
  context: {
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: PHASE_3_IMPLEMENTATION,
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
    // US-005 AC11: query_scratch lets the rectifier read the prior
    // verify-result + tool-diagnostics record on demand instead of triaging
    // blind. Shared query_neighbor for cross-package import lookups.
    pullToolNames: ["query_neighbor", "query_scratch"],
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
  // Declared but not assembled by any site today — see nax#1743. Remains
  // #1743's untracked fourth key (nax#1758): deliberately unassembled,
  // declares no pull tools, so it is not subject to the pull-tool
  // reachability guard. Assembling it would change only role/budget/
  // providers, not pull-tool wiring — noted here so it is not rediscovered
  // as a mystery.
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

  // Single-session strategy — main single-session implementation path (no TDD split)
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  "single-session": {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_IMPLEMENTATION,
    // US-005 AC12: query_scratch lets the implementer re-read the prior
    // verify-result / tool-diagnostics record on retry without flooding
    // push context. Shared query_neighbor for cross-package import lookups.
    pullToolNames: ["query_neighbor", "query_scratch"],
    planDigestBoost: 1.5,
  },

  // TDD-simple strategy — same as single-session (simplified TDD with merged roles)
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  "tdd-simple": {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_IMPLEMENTATION,
    // query_scratch: see the US-005 AC12 rationale on "single-session" above.
    pullToolNames: ["query_neighbor", "query_scratch"],
    planDigestBoost: 1.5,
  },

  // No-test strategy — implementer role, moderate budget
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  // No pull tools: out of scope for nax#1743 (there is no verify/tool-diagnostics
  // record for a no-test story to re-read).
  "no-test": {
    role: "implementer",
    budgetTokens: 10_000,
    providerIds: PHASE_3_IMPLEMENTATION,
    planDigestBoost: 1.5,
  },

  // Batch strategy — implementer role, full budget (parallel stories)
  // planDigestBoost: compensates for absent cross-session digest (Amendment B AC-51)
  batch: {
    role: "implementer",
    budgetTokens: 12_000,
    providerIds: PHASE_3_IMPLEMENTATION,
    // query_scratch: see the US-005 AC12 rationale on "single-session" above.
    pullToolNames: ["query_neighbor", "query_scratch"],
    planDigestBoost: 1.5,
  },

  // Route — lightweight context for routing/classification; static rules only
  route: {
    role: "implementer",
    budgetTokens: 4_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Review dialogue — reviewer role.
  // Declared but not assembled by any site today — see nax#1743. nax#1758
  // resolved the pull-tool question: there is no dispatch seam
  // (src/review/semantic-debate.ts makes no callOp/assembleForStage call —
  // the debate builder owns those prompts), and query_feature_context is
  // already available to the two review stages that ARE assembled
  // (review-semantic, review-adversarial). Dropped pullToolNames rather
  // than building a dialogue seam for a capability nothing could deliver.
  "review-dialogue": {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },

  // Debate — reviewer role; static + feature context for multi-agent critique
  debate: {
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: PHASE_0_PROVIDERS,
  },
  // `satisfies`, not a `Record<string, StageContextConfig>` annotation: the
  // annotation would widen the key type to `string` and make `StageKey` below
  // vacuous (every string assignable), defeating the point of typing the
  // selector seams in phase-stage-map.ts. See nax#1743.
} satisfies Record<string, StageContextConfig>;

/**
 * The set of stage keys declared in {@link STAGE_CONTEXT_MAP}. Not every key
 * is "live" — see the reachability comment above the map.
 */
export type StageKey = keyof typeof STAGE_CONTEXT_MAP;

/**
 * Get the context config for a given stage name.
 * Falls back to DEFAULT_STAGE_CONFIG for unknown stages.
 *
 * Accepts `string`, not `StageKey`: callers pass raw `testStrategy` values
 * and other unvalidated strings, and unknown values must still fall back to
 * DEFAULT_STAGE_CONFIG rather than fail to compile.
 */
export function getStageContextConfig(stage: string): StageContextConfig {
  return (STAGE_CONTEXT_MAP as Record<string, StageContextConfig>)[stage] ?? DEFAULT_STAGE_CONFIG;
}
