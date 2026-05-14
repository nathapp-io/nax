import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { Debater } from "../debate/types";
import { DebatePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface DebateSynthesisInput {
  readonly proposals: string[];
  readonly critiques: string[];
  readonly debaters?: Debater[];
  readonly resolverAgent: string;
  readonly resolverModel: string;
  readonly promptSuffix?: string;
}

export const synthesisOp: CompleteOperation<DebateSynthesisInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-synthesis",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  model: (input) => ({ agent: input.resolverAgent, model: input.resolverModel }),
  build(input, _ctx) {
    const base = DebatePromptBuilder.resolverSynthesisPrompt(input.proposals, input.critiques, input.debaters);
    const content = input.promptSuffix ? `${base}\n\n${input.promptSuffix}` : base;
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
