import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { Debater } from "../debate/types";
import { DebatePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface DebateJudgeInput {
  readonly proposals: string[];
  readonly critiques: string[];
  readonly debaters?: Debater[];
  readonly resolverAgent: string;
  readonly resolverModel: string;
  /** Debate stage timeout in seconds — passed from stageConfig so the op uses the correct stage's budget. */
  readonly timeoutSeconds?: number;
}

export const judgeOp: CompleteOperation<DebateJudgeInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-judge",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  model: (input) => ({ agent: input.resolverAgent, model: input.resolverModel }),
  timeoutMs: (input, ctx) => (input.timeoutSeconds ?? ctx.config.debate?.stages?.review?.timeoutSeconds ?? 600) * 1000,
  build(input, _ctx) {
    const prompt = DebatePromptBuilder.resolverJudgePrompt(input.proposals, input.critiques, input.debaters);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
