/**
 * Judge selector strategy.
 *
 * Extracted from src/debate/resolvers.ts judgeResolver body.
 * resolvers.ts delegates to callJudgeComplete for the compat wrapper.
 */

import { type IAgentManager, resolveDefaultAgent } from "@/agents";
import type { CompleteOptions, CompleteResult } from "@/agents/types";
import { DEFAULT_CONFIG, resolveConfiguredModel } from "@/config";
import type { ModelDef } from "@/config/schema-types";
import { DebatePromptBuilder } from "@/prompts";
import { formatSessionName } from "@/runtime";
import type { Debater } from "../types";
import type { Selector, SelectorContext, SelectorResult } from "./types";

const RESOLVER_FALLBACK_AGENT = "synthesis";

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

export const judgeSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const agentName = ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT;
  const proposals = ctx.proposals.map((p) => p.output);

  let modelDef: CompleteOptions["modelDef"];
  try {
    const configModels = ctx.config.models ?? DEFAULT_CONFIG.models;
    const configDefaultAgent = resolveDefaultAgent(ctx.config);
    const resolverSelection = { agent: agentName, model: ctx.stageConfig.resolver.model ?? "fast" };
    modelDef = resolveConfiguredModel(configModels, agentName, resolverSelection, configDefaultAgent).modelDef;
  } catch {
    modelDef = { provider: "unknown", model: ctx.stageConfig.resolver.model ?? "fast" } as ModelDef;
  }

  const sessionName =
    ctx.workdir.length > 0
      ? formatSessionName({
          workdir: ctx.workdir,
          featureName: ctx.featureName || undefined,
          storyId: ctx.storyId || undefined,
          role: "judge",
        })
      : undefined;
  const completeOptions: CompleteOptions = {
    modelDef,
    workdir: ctx.workdir,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
    timeoutMs: ctx.timeoutMs,
    pipelineStage: "run",
    sessionRole: "judge",
    ...(sessionName !== undefined && { sessionName }),
  };

  const result = await callJudgeComplete(
    proposals,
    ctx.critiques,
    agentName,
    ctx.agentManager,
    completeOptions,
    ctx.debaters,
  );

  return {
    outcome: result.output?.trim() ? "passed" : "failed",
    output: result.output,
    resolverCostUsd: result.exactCostUsd ?? result.estimatedCostUsd,
  };
};
