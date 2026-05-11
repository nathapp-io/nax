/**
 * Verifier-pick selector strategy.
 *
 * Ranks proposals by mechanical signals (citations, distribution, coverage, context validity)
 * and optionally applies a patch step if enabled and AC overlap is below threshold.
 */

import type { SuccessfulProposal } from "../session-helpers";
import type { Selector, SelectorContext, SelectorResult } from "./types";

// Score weight constants — documented linear combination
export const SCORE_WEIGHTS = {
  citationRate: 0.4,
  citationDistributionScore: 0.3,
  failureModesCovered: 0.15,
  contextFilesValidRate: 0.15,
} as const;

export const verifierPickSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  // TODO: Implement verifier-pick selector
  // 1. Extract manifest from context
  // 2. Score proposals using mechanical signals
  // 3. Sort by score
  // 4. Check if patching is enabled and overlap is low
  // 5. If patching needed, invoke runPatchStep
  // 6. Return highest-scoring proposal output

  if (ctx.proposals.length === 0) {
    return { outcome: "failed", resolverCostUsd: 0 };
  }

  const winner = ctx.proposals[0];
  return {
    outcome: "passed",
    output: winner.output,
    resolverCostUsd: 0,
  };
};

export async function runPatchStep(
  ctx: SelectorContext,
  winner: SuccessfulProposal,
  runnerUp: SuccessfulProposal,
  maxDeltas: number,
): Promise<{ output: string; cost: number }> {
  // TODO: Implement patch step
  // 1. Extract distinct ACs between winner and runner-up
  // 2. Build patch prompt
  // 3. Call ctx.agentManager.runAsSession with winner's handle
  // 4. Return patched output and cost

  return { output: winner.output, cost: 0 };
}
