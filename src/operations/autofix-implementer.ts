import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ReviewCheckResult } from "../review/types";
import type { RunOperation } from "./types";

export interface AutofixImplementerInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
}

export interface AutofixImplementerOutput {
  applied: true;
  /** Set when the agent emits UNRESOLVED: (REVIEW-003 reviewer contradiction). */
  unresolvedReason?: string;
}

export const implementerRectifyOp: RunOperation<AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> = {
  kind: "run",
  name: "autofix-implementer",
  stage: "rectification",
  session: { role: "implementer", lifetime: "fresh" },
  config: autofixConfigSelector,
  build(input, _ctx) {
    const prompt = RectifierPromptBuilder.reviewRectification(input.failedChecks, input.story);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const match = output.match(/^UNRESOLVED:\s*(.+)$/ms);
    return { applied: true, ...(match ? { unresolvedReason: match[1]?.trim() } : {}) };
  },
};
