import type { IAgentManager } from "../agents";
import type { SessionHandle } from "../agents/types";
import type { SuccessfulProposal } from "./session-helpers";
import { pipelineStageForDebate } from "./session-helpers";
import type { Debater } from "./types";

interface StatefulTurnCtx {
  readonly storyId: string;
  readonly stage: string;
}

export async function runStatefulTurn(
  ctx: StatefulTurnCtx,
  agentManager: IAgentManager,
  agentName: string,
  debater: Debater,
  prompt: string,
  handle: SessionHandle,
): Promise<SuccessfulProposal> {
  const turnResult = await agentManager.runAsSession(agentName, handle, prompt, {
    storyId: ctx.storyId,
    pipelineStage: pipelineStageForDebate(ctx.stage),
  });

  return {
    debater,
    agentName,
    output: turnResult.output,
    cost: turnResult.estimatedCostUsd ?? 0,
  };
}
