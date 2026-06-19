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
  /** Populated when the agent emits UNRESOLVED: — triggers agent-gave-up exit in the findings cycle. */
  unresolvedReason?: string;
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
    const unresolvedMatch = output.match(/^UNRESOLVED:\s*(.+)$/m);
    return {
      applied: true,
      testEditDeclarations: declarations,
      ...(unresolvedMatch ? { unresolvedReason: unresolvedMatch[1]?.trim() } : {}),
    };
  },
};
