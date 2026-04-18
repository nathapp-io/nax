import { getAgentProfile } from "./agent-profiles";

const RESERVED_NON_CONTEXT_TOKENS = 5_000;
const CONTEXT_WINDOW_SAFETY_RATIO = 0.1;

/**
 * Estimate remaining prompt room for context injection.
 *
 * This is a conservative upper bound used to thread `availableBudgetTokens`
 * into ContextRequest from prompt-building call sites.
 */
export function estimateAvailableBudgetTokens(agentId: string, existingPrompt?: string): number | undefined {
  const { profile } = getAgentProfile(agentId);
  const maxContextTokens = profile.caps.maxContextTokens;
  const existingPromptTokens = existingPrompt ? Math.ceil(existingPrompt.length / 4) : 0;
  const safetyMargin = Math.ceil(maxContextTokens * CONTEXT_WINDOW_SAFETY_RATIO);
  const remaining = maxContextTokens - RESERVED_NON_CONTEXT_TOKENS - existingPromptTokens - safetyMargin;
  return remaining > 0 ? remaining : undefined;
}
