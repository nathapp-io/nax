/**
 * Debate module barrel export
 */

export { DebateSession } from "./session";
export { _debateSessionDeps, resolveDebaterModel } from "./session-helpers";
export type { DebateSessionOptions } from "./session-helpers";
export { majorityResolver, synthesisResolver, judgeResolver } from "./resolvers";
export { buildCritiquePrompt, buildSynthesisPrompt, buildJudgePrompt } from "./prompts";
export type {
  DebateConfig,
  DebateStageConfig,
  DebateResult,
  Debater,
  Proposal,
  ResolverConfig,
  ResolverType,
  SessionMode,
} from "./types";
