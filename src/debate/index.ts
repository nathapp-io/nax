/**
 * Debate module barrel export
 */

export { DebateRunner } from "./runner";
export { runHybrid } from "./runner-hybrid";
export type { HybridCtx } from "./runner-hybrid";
export type { DebateRunnerOptions } from "./runner";
export { _debateSessionDeps, resolveOutcome } from "./session-helpers";
export type {
  DebateSessionOptions,
  ResolveOutcome,
  SuccessfulProposal,
} from "./session-helpers";
export { parseFactsManifest, renderManifestSection } from "./facts-manifest";
export type { FactsManifest } from "./facts-manifest";
export { citationDistribution, citationRate, extractClaims } from "./citations";
export type { ParsedClaim } from "./citations";
export { _runPlanDeps } from "./runner-plan";
export { raceAgainstAbort } from "./utils";
export {
  registerSelector,
  resolveSelector,
  pickSelectorKind,
  pickBaseSelectorKind,
  judgeSelector,
  synthesisSelector,
  majorityFailClosedSelector,
  majorityFailOpenSelector,
  computeMajority,
  verifierPickSelector,
} from "./selectors";
export type { SelectorContext } from "./selectors";
export { registerPreDebatePhase, resolvePreDebatePhase } from "./pre-phase";
export type { PreDebatePhaseContext } from "./pre-phase";
export { grounderStrategy } from "./pre-phase/grounder";
export {
  registerPostDebateVerifier,
  resolvePostDebateVerifier,
  reviewGroundingFilterVerifier,
  planChecklistVerifier,
  _planChecklistDeps,
  checkFilesExist,
  checkAcAnchored,
  checkClaimsCited,
  checkNoContradictions,
  checkSpecCoverage,
} from "./verifiers";
export type { PostDebateVerifierContext, PostDebateVerifier, PostDebateVerifierResult, CheckDeps } from "./verifiers";
export {
  majorityResolver,
  synthesisResolver,
  judgeResolver,
  callJudgeComplete,
  callSynthesisComplete,
} from "./resolvers";
export { DebatePromptBuilder } from "../prompts";
export type { StageContext, PromptBuilderOptions, ReviewStoryContext } from "../prompts";
export { PERSONA_FRAGMENTS, buildDebaterLabel, buildPersonaBlock, resolvePersonas } from "./personas";
export type { DebaterPersona } from "./types";
export type {
  DebateConfig,
  DebateStageConfig,
  DebateResult,
  DebateMode,
  Debater,
  Proposal,
  Rebuttal,
  ResolverConfig,
  DebateResolverContext,
  ResolverType,
  SessionMode,
} from "./types";
