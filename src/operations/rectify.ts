import { rectifyConfigSelector } from "../config";
import type { RectifyConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ReviewCheckResult } from "../review/types";
import { storyRoutingModel } from "./story-routing-model";
import type { RunOperation } from "./types";

export interface RectifyInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
}

export interface RectifyOutput {
  applied: true;
}

export const rectifyOp: RunOperation<RectifyInput, RectifyOutput, RectifyConfig> = {
  kind: "run",
  name: "rectify",
  stage: "review",
  session: { role: "implementer", lifetime: "fresh" },
  tools: [
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Delete",
    "Git",
    "RunCommand",
    "GitCommit",
    "Exec",
    "RequestCapability",
  ],
  config: rectifyConfigSelector,
  // Inherit the story's rung so an escalation or a profile pin reaches the fix
  // cycle too — without this the op fell through to callOp's literal "balanced".
  model: (input) => storyRoutingModel(input.story),
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
