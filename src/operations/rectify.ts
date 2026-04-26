import { rectifyConfigSelector } from "../config";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ReviewCheckResult } from "../review/types";
import type { RunOperation } from "./types";

export interface RectifyInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
}

export interface RectifyOutput {
  applied: true;
}

type RectifyConfig = ReturnType<typeof rectifyConfigSelector.select>;

export const rectifyOp: RunOperation<RectifyInput, RectifyOutput, RectifyConfig> = {
  kind: "run",
  name: "rectify",
  stage: "review",
  session: { role: "implementer", lifetime: "fresh" },
  config: rectifyConfigSelector,
  build(input, _ctx) {
    const prompt = RectifierPromptBuilder.reviewRectification(input.failedChecks, input.story);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};
