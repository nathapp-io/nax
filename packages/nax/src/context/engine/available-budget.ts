import { getAgentProfile } from "./agent-profiles";

const RESERVED_NON_CONTEXT_TOKENS = 5_000;
const CONTEXT_WINDOW_SAFETY_RATIO = 0.1;

/**
 * Estimate remaining prompt room for context injection.
 *
 * Returns a numeric value in every case:
 *   - Positive: the remaining token budget for context injection
 *   - 0: the agent profile's window is exhausted by the existing prompt (a real
 *     zero ceiling, not undefined — callers must be able to pass this directly
 *     to packChunks as a ceiling).
 */
export function estimateAvailableBudgetTokens(agentId: string, existingPrompt?: string): number {
  const { profile } = getAgentProfile(agentId);
  const maxContextTokens = profile.caps.maxContextTokens;
  const existingPromptTokens = existingPrompt ? Math.ceil(existingPrompt.length / 4) : 0;
  const safetyMargin = Math.ceil(maxContextTokens * CONTEXT_WINDOW_SAFETY_RATIO);
  const remaining = maxContextTokens - RESERVED_NON_CONTEXT_TOKENS - existingPromptTokens - safetyMargin;
  return remaining > 0 ? remaining : 0;
}
