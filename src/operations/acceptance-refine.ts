import { parseRefinementResponse, refinementWouldFallback } from "../acceptance/refinement";
import type { RefinedCriterion } from "../acceptance/types";
import { acceptanceConfigSelector } from "../config";
import type { AcceptanceConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
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

export const acceptanceRefineOp: CompleteOperation<AcceptanceRefineInput, AcceptanceRefineOutput, AcceptanceConfig> = {
  kind: "complete",
  name: "acceptance-refine",
  stage: "acceptance",
  jsonMode: true,
  config: acceptanceConfigSelector,
  model: (_input, ctx) => ctx.config.acceptance.model,
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
    if (refinementWouldFallback(output)) {
      getSafeLogger()?.warn(
        "acceptance",
        "AC refinement returned no usable JSON — falling back to unrefined criteria",
        { storyId: input.storyId, criteriaCount: input.criteria.length, responseBytes: output?.length ?? 0 },
      );
    }
    const items = parseRefinementResponse(output, input.criteria);
    return items.map((item) => ({ ...item, storyId: item.storyId || input.storyId }));
  },
};
