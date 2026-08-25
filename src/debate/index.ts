/**
 * Debate module barrel export
 */

export type { PromptBuilderOptions, ReviewStoryContext, StageContext } from "../prompts";
export { DebatePromptBuilder } from "../prompts";
export type { ParsedClaim } from "./citations";
export { citationDistribution, citationRate, extractClaims } from "./citations";
export type { FactsManifest } from "./facts-manifest";
export { parseFactsManifest, renderManifestSection } from "./facts-manifest";
export { buildDebaterLabel, buildPersonaBlock, PERSONA_FRAGMENTS, resolvePersonas } from "./personas";
export type { PreDebatePhaseContext } from "./pre-phase";
export { registerPreDebatePhase, resolvePreDebatePhase } from "./pre-phase";
export { grounderStrategy } from "./pre-phase/grounder";
export {
  callJudgeComplete,
  callSynthesisComplete,
  judgeResolver,
  majorityResolver,
  synthesisResolver,
} from "./resolvers";
export type { DebateRunnerOptions } from "./runner";
export { DebateRunner } from "./runner";
export type { HybridCtx } from "./runner-hybrid";
export { runHybrid } from "./runner-hybrid";
export { _runPlanDeps } from "./runner-plan";
export type { SelectorContext } from "./selectors";
export {
  computeMajority,
  judgeSelector,
  majorityFailClosedSelector,
  majorityFailOpenSelector,
  pickBaseSelectorKind,
  pickSelectorKind,
  registerSelector,
  resolveSelector,
  synthesisSelector,
  verifierPickSelector,
} from "./selectors";
export type {
  DebateSessionOptions,
  ResolveOutcome,
  SuccessfulProposal,
} from "./session-helpers";
export { _debateSessionDeps, resolveOutcome } from "./session-helpers";
export type {
  DebateConfig,
  DebateMode,
  DebateResolverContext,
  DebateResult,
  Debater,
  DebaterPersona,
  DebateStageConfig,
  Proposal,
  Rebuttal,
  ResolverConfig,
  ResolverType,
  SessionMode,
} from "./types";
export { raceAgainstAbort } from "./utils";
export type { CheckDeps, PostDebateVerifier, PostDebateVerifierContext, PostDebateVerifierResult } from "./verifiers";
export {
  _planChecklistDeps,
  checkAcAnchored,
  checkClaimsCited,
  checkFilesExist,
  checkNoContradictions,
  checkSpecCoverage,
  planChecklistVerifier,
  registerPostDebateVerifier,
  resolvePostDebateVerifier,
  reviewGroundingFilterVerifier,
} from "./verifiers";
