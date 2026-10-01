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
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const u of usages) {
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.cacheReadTokens += u.cacheReadTokens ?? 0;
    total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  }
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    ...(total.cacheReadTokens > 0 && { cacheReadTokens: total.cacheReadTokens }),
    ...(total.cacheWriteTokens > 0 && { cacheWriteTokens: total.cacheWriteTokens }),
  };
}
