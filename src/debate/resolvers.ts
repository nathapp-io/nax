/**
 * Debate Resolvers — compat wrappers
 *
 * These functions keep their original public signatures for backwards compatibility.
 * The underlying logic now lives in src/debate/selectors/:
 * - majorityResolver → delegates to computeMajority (selectors/majority.ts)
 * - synthesisResolver → delegates to callSynthesisComplete (defined here)
 * - judgeResolver / callJudgeComplete — inlined here; judge.ts now dispatches via callOp
 *
 * callSynthesisComplete was moved here from selectors/synthesis.ts so that
 * synthesis.ts can dispatch via callOp without calling completeAs directly.
 */

import type { IAgentManager } from "../agents";
import type { CompleteOptions, CompleteResult } from "../agents/types";
import { DebatePromptBuilder } from "../prompts";
import { computeMajority } from "./selectors/majority";
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
 * Compat wrapper for synthesis resolution. Kept here so existing callers outside
 * the debate barrel continue to work unchanged. synthesisSelector (selectors/synthesis.ts)
 * now dispatches via callOp instead of calling this function directly.
 */
export async function callSynthesisComplete(
  proposals: string[],
  critiques: string[],
  debaters: Debater[] | undefined,
  agentManager: IAgentManager,
  agentName: string,
  completeOptions: CompleteOptions,
  promptSuffix?: string,
): Promise<CompleteResult> {
  const base = DebatePromptBuilder.resolverSynthesisPrompt(proposals, critiques, debaters);
  const prompt = promptSuffix ? `${base}\n\n${promptSuffix}` : base;
  return agentManager.completeAs(agentName, prompt, completeOptions);
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
 * Compat wrapper for judge resolution. Kept here so existing callers outside
 * the debate barrel (e.g. integration tests) continue to work unchanged.
 * judgeSelector (selectors/judge.ts) now dispatches via callOp instead of calling
 * this function directly.
 */
export async function callJudgeComplete(
  proposals: string[],
  critiques: string[],
  agentName: string,
  agentManager: IAgentManager,
  completeOptions: CompleteOptions,
  debaters?: Debater[],
): Promise<CompleteResult> {
  const prompt = DebatePromptBuilder.resolverJudgePrompt(proposals, critiques, debaters);
  return agentManager.completeAs(agentName, prompt, completeOptions);
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
