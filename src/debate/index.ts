/**
 * Debate module barrel export
 */

export { DebateRunner } from "./runner";
export type { DebateRunnerOptions } from "./runner";
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
export type { DebateSessionOptions, ResolverContextInput, ResolveOutcome } from "./session-helpers";
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
