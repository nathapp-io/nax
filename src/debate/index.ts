/**
 * Debate module barrel export
 */

export { DebateSession, _debateSessionDeps } from "./session";
export type { DebateSessionOptions } from "./session";
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
