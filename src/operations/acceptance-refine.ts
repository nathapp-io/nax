import { parseRefinementResponse } from "../acceptance/refinement";
import type { RefinedCriterion } from "../acceptance/types";
import { acceptanceConfigSelector } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface AcceptanceRefineInput {
  criteria: string[];
  codebaseContext: string;
  storyId: string;
  testStrategy?: "unit" | "component" | "cli" | "e2e" | "snapshot";
  testFramework?: string;
  storyTitle?: string;
  storyDescription?: string;
}

export type AcceptanceRefineOutput = RefinedCriterion[];

type AcceptanceConfig = ReturnType<typeof acceptanceConfigSelector.select>;

export const acceptanceRefineOp: CompleteOperation<AcceptanceRefineInput, AcceptanceRefineOutput, AcceptanceConfig> = {
  kind: "complete",
  name: "acceptance-refine",
  stage: "acceptance",
  jsonMode: true,
  config: acceptanceConfigSelector,
  timeoutMs: (_input, ctx) => ctx.config.acceptance.timeoutMs,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildRefinementPrompt(input.criteria, input.codebaseContext, {
      testStrategy: input.testStrategy,
      testFramework: input.testFramework,
      storyTitle: input.storyTitle,
      storyDescription: input.storyDescription,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    const items = parseRefinementResponse(output, input.criteria);
    return items.map((item) => ({ ...item, storyId: item.storyId || input.storyId }));
  },
};
