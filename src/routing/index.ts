// Core types

export type { ComplexityMapping } from "./calibrate/band-stats";
// Calibration primitives (US-002 + US-003)
export { computeBandStats } from "./calibrate/band-stats";
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
export type { OperatingTierInput, OperatingTierResult } from "./operating-tier";
// SSOT for the profile/escalation/persisted tier precedence — shared by the
// routing stage and the executor's pre-classification preview (#1575).
export { resolveOperatingTier } from "./operating-tier";
export type { RoutingContext, RoutingDecision, RoutingStrategy } from "./router";
// Main routing functions
export {
  _tryLlmBatchRouteDeps,
  classifyComplexity,
  complexityToModelTier,
  determineTestStrategy,
  isSecurityCriticalStory,
  resolveRouting,
  routeStory,
  routeTask,
  tryLlmBatchRoute,
} from "./router";
// Shared prompt constants and cache management used by classifyRoute op and llm strategy
export { clearCache, ROUTING_INSTRUCTIONS } from "./strategies/llm";
// Shared validator used by classifyRoute op and llm parsing — single SSOT for
// LLM routing-decision validation (config-aware tier check + testStrategy derivation).
export { validateRoutingDecision } from "./strategies/llm-parsing";
