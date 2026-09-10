import { autofixConfigSelector } from "@/config";
import type { AutofixConfig } from "@/config/selectors";
import type { UserStory } from "@/prd";
import { RectifierPromptBuilder } from "@/prompts";
import type { ReviewCheckResult } from "@/review/types";
import { storyRoutingModel } from "./story-routing-model";
import type { RunOperation } from "./types";

export interface AutofixTestWriterInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
  mode?: "fix-test-files" | "write-failing-test" | "mock-restructure";
  blockingThreshold?: "error" | "warning" | "info";
  handoffReason?: string;
  handoffFiles?: string[];
}

export interface AutofixTestWriterOutput {
  applied: true;
}

export const testWriterRectifyOp: RunOperation<AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> = {
  kind: "run",
  name: "autofix-test-writer",
  stage: "rectification",
  // warm: resume the open test-writer session (from the test-writer phase) and keep it
  // open across rectify iterations instead of `sessions ensure`-ing a cold session each
  // turn. Unconditional, mirroring autofix-implementer.ts (already mid-rectification).
  session: { role: "test-writer", lifetime: "warm" },
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
  config: autofixConfigSelector,
  // Inherit the story's rung so an escalation or a profile pin reaches the fix
  // cycle too — without this the op fell through to callOp's literal "balanced".
  model: (input) => storyRoutingModel(input.story),
  build(input, _ctx) {
    const prompt = RectifierPromptBuilder.testWriterRectification(input.failedChecks, input.story, {
      mode: input.mode,
      blockingThreshold: input.blockingThreshold,
      handoffReason: input.handoffReason,
      handoffFiles: input.handoffFiles,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};
