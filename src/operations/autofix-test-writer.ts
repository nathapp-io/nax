import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ReviewCheckResult } from "../review/types";
import type { RunOperation } from "./types";

export interface AutofixTestWriterInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
}

export interface AutofixTestWriterOutput {
  applied: true;
}

export const testWriterRectifyOp: RunOperation<AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> = {
  kind: "run",
  name: "autofix-test-writer",
  stage: "rectification",
  session: { role: "test-writer", lifetime: "fresh" },
  config: autofixConfigSelector,
  build(input, _ctx) {
    const prompt = RectifierPromptBuilder.testWriterRectification(input.failedChecks, input.story);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};
