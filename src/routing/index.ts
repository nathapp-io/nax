// Core types
export type { RoutingDecision, RoutingStrategy, RoutingContext } from "./router";

// Shared prompt constants and cache management used by classifyRoute op and llm strategy
export { ROUTING_INSTRUCTIONS, clearCache } from "./strategies/llm";

// Shared validator used by classifyRoute op and llm parsing — single SSOT for
// LLM routing-decision validation (config-aware tier check + testStrategy derivation).
export { validateRoutingDecision } from "./strategies/llm-parsing";

// Main routing functions
export {
  resolveRouting,
  routeStory,
  routeTask,
  classifyComplexity,
  determineTestStrategy,
  isSecurityCriticalStory,
  complexityToModelTier,
  tryLlmBatchRoute,
  _tryLlmBatchRouteDeps,
} from "./router";

// SSOT for the profile/escalation/persisted tier precedence — shared by the
// routing stage and the executor's pre-classification preview (#1575).
export { resolveOperatingTier } from "./operating-tier";
export type { OperatingTierInput, OperatingTierResult } from "./operating-tier";

// Calibration primitives (US-002 + US-003)
export { computeBandStats } from "./calibrate/band-stats";
export type { ComplexityMapping } from "./calibrate/band-stats";
export { buildProposalArtifact, proposeAdjustments } from "./calibrate/propose";
export type {
  BandStat,
  CalibrationProposal,
  CalibrationThresholds,
  KeywordHint,
  ProposalArtifact,
  SkippedBand,
  TierAdjustment,
} from "./calibrate/types";
