/**
 * Debate module barrel export
 */

export { DebateSession } from "./session";
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
export type { DebateSessionOptions, ResolverContextInput, ResolveOutcome } from "./session-helpers";
export { majorityResolver, synthesisResolver, judgeResolver } from "./resolvers";
export { DebatePromptBuilder } from "./prompt-builder";
export type { StageContext, PromptBuilderOptions } from "./prompt-builder";
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
  ResolverType,
  SessionMode,
} from "./types";
