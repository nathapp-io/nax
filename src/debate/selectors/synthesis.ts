/**
 * Synthesis selector strategy.
 *
 * Extracted from src/debate/resolvers.ts synthesisResolver body.
 * resolvers.ts delegates to callSynthesisComplete for the compat wrapper.
 */

import type { IAgentManager } from "@/agents";
import type { CompleteOptions, CompleteResult } from "@/agents/types";
import { DEFAULT_CONFIG, resolveModelForAgent } from "@/config";
import { DebatePromptBuilder } from "@/prompts";
import { RESOLVER_FALLBACK_AGENT } from "../session-helpers";
import type { Debater } from "../types";
import type { Selector, SelectorContext, SelectorResult } from "./types";

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

export const synthesisSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const agentName = ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT;
  const proposals = ctx.proposals.map((p) => p.output);

  let modelDef: CompleteOptions["modelDef"];
  try {
    modelDef = resolveModelForAgent(
      DEFAULT_CONFIG.models,
      agentName,
      ctx.stageConfig.resolver.model ?? "fast",
      agentName,
    );
  } catch {
    modelDef = { provider: "unknown", model: ctx.stageConfig.resolver.model ?? "fast" };
  }

  const completeOptions: CompleteOptions = {
    modelDef,
    workdir: ctx.workdir,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
    timeoutMs: ctx.timeoutMs,
    pipelineStage: "run",
  };

  const result = await callSynthesisComplete(
    proposals,
    ctx.critiques,
    ctx.debaters,
    ctx.agentManager,
    agentName,
    completeOptions,
    ctx.promptSuffix,
  );

  return {
    outcome: result.output?.trim() ? "passed" : "failed",
    output: result.output,
    resolverCostUsd: result.exactCostUsd ?? result.estimatedCostUsd,
  };
};
