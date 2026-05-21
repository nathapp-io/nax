/**
 * TDD-strategy-specific types.
 *
 * Wrapper-level types (TddSessionRole, FailureCategory, IsolationCheck,
 * TddSessionResult) are re-exported from src/execution/types — the canonical
 * owner is the wrapper layer (US-005 §5).
 */

import type { TokenUsage } from "../agents/cost";
import type { TddSessionResult } from "../execution/types";

export type {
  FailureCategory,
  IsolationCheck,
  TddSessionResult,
  TddSessionRole,
} from "../execution/types";

/**
 * Sum TokenUsage values across TDD session results (#590).
 * Returns undefined when no session reported usage — mirrors the adapter
 * contract so `metrics.tracker` can emit a tokens block only when real data exists.
 */
export function sumTddTokenUsage(sessions: TddSessionResult[]): TokenUsage | undefined {
  const usages = sessions.map((s) => s.tokenUsage).filter((u): u is TokenUsage => !!u);
  if (usages.length === 0) return undefined;
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const u of usages) {
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    total.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
  }
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    ...(total.cacheReadInputTokens > 0 && { cacheReadInputTokens: total.cacheReadInputTokens }),
    ...(total.cacheCreationInputTokens > 0 && { cacheCreationInputTokens: total.cacheCreationInputTokens }),
  };
}
