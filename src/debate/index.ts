/**
 * Debate module barrel export
 */

export { DebateSession } from "./session";
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
export type { DebateSessionOptions } from "./session-helpers";
export { majorityResolver, synthesisResolver, judgeResolver } from "./resolvers";
export { buildCritiquePrompt, buildSynthesisPrompt, buildJudgePrompt, buildRebuttalContext } from "./prompts";
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
