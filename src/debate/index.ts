/**
 * Debate module barrel export
 */

export { DebateRunner } from "./runner";
export type { DebateRunnerOptions } from "./runner";
export { _debateSessionDeps, resolveDebaterModel, resolveOutcome } from "./session-helpers";
export type {
  DebateSessionOptions,
  ResolverContextInput,
  ResolveOutcome,
  SuccessfulProposal,
} from "./session-helpers";
export { parseFactsManifest, renderManifestSection } from "./facts-manifest";
export type { FactsManifest } from "./facts-manifest";
export {
  registerSelector,
  resolveSelector,
  pickSelectorKind,
  pickBaseSelectorKind,
  judgeSelector,
  callJudgeComplete,
  synthesisSelector,
  callSynthesisComplete,
  majorityFailClosedSelector,
  majorityFailOpenSelector,
  computeMajority,
  verifierPickSelector,
} from "./selectors";
export type { SelectorContext } from "./selectors";
export { registerPreDebatePhase, resolvePreDebatePhase } from "./pre-phase";
export type { PreDebatePhaseContext } from "./pre-phase";
export { grounderStrategy } from "./pre-phase/grounder";
export { registerPostDebateVerifier, resolvePostDebateVerifier, reviewGroundingFilterVerifier } from "./verifiers";
export { majorityResolver, synthesisResolver, judgeResolver } from "./resolvers";
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
