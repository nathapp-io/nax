/**
 * Debate Resolvers — compat wrappers
 *
 * These functions keep their original public signatures for backwards compatibility.
 * The underlying logic now lives in src/debate/selectors/:
 * - majorityResolver → delegates to computeMajority (selectors/majority.ts)
 * - synthesisResolver → delegates to callSynthesisComplete (selectors/synthesis.ts)
 * - judgeResolver → delegates to callJudgeComplete (selectors/judge.ts)
 */

import type { IAgentManager } from "../agents";
import type { CompleteOptions, CompleteResult } from "../agents/types";
import { callJudgeComplete } from "./selectors/judge";
import { computeMajority } from "./selectors/majority";
import { callSynthesisComplete } from "./selectors/synthesis";
import type { Debater, ResolverConfig } from "./types";

const DEFAULT_FALLBACK_AGENT = "claude";

/**
 * Majority resolver — parses JSON pass/fail from each proposal.
 * Returns 'passed' when a strict majority pass. Fail-closed on tie.
 */
export function majorityResolver(proposals: string[], failOpen: boolean): "passed" | "failed" {
  return computeMajority(proposals, failOpen);
}

/**
 * Synthesis resolver — calls agentManager.completeAs() once with a synthesis prompt.
 * Returns the full completion result including output and cost metadata.
 */
export async function synthesisResolver(
  proposals: string[],
  critiques: string[],
  opts: {
    agentManager: IAgentManager;
    agentName: string;
    completeOptions: CompleteOptions;
    promptSuffix?: string;
    debaters?: Debater[];
  },
): Promise<CompleteResult> {
  return callSynthesisComplete(
    proposals,
    critiques,
    opts.debaters,
    opts.agentManager,
    opts.agentName,
    opts.completeOptions,
    opts.promptSuffix,
  );
}

/**
 * Judge resolver — calls agentManager.completeAs() once with a judge prompt.
 * Uses resolver.agent (or defaultAgentName) to pick the judge agent.
 * Returns the full completion result including output and cost metadata.
 */
export async function judgeResolver(
  proposals: string[],
  critiques: string[],
  resolverConfig: ResolverConfig,
  opts: {
    agentManager: IAgentManager;
    defaultAgentName?: string;
    completeOptions: CompleteOptions;
    debaters?: Debater[];
  },
): Promise<CompleteResult> {
  const agentName = resolverConfig.agent ?? opts.defaultAgentName ?? DEFAULT_FALLBACK_AGENT;
  return callJudgeComplete(proposals, critiques, agentName, opts.agentManager, opts.completeOptions, opts.debaters);
}
