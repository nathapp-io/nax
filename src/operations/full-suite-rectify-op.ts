import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import { type TestEditDeclaration, parseTestEditDeclarations } from "./test-edit-declaration";
import type { RunOperation } from "./types";

export interface FullSuiteRectifyInput {
  story: UserStory;
  findings: readonly Finding[];
}

export interface FullSuiteRectifyOutput {
  applied: true;
  testEditDeclarations: TestEditDeclaration[];
}

export const fullSuiteRectifyOp: RunOperation<FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig> = {
  kind: "run",
  name: "full-suite-rectify",
  stage: "rectification",
  session: { role: "implementer", lifetime: "warm" },
  config: autofixConfigSelector,
  build(input, _ctx) {
    const prompt = RectifierPromptBuilder.failingTestRectification(input.findings as Finding[], input.story);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const declarations = parseTestEditDeclarations(output);
    return { applied: true, testEditDeclarations: declarations };
  },
};
