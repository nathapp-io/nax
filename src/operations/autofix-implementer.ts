import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ReviewCheckResult } from "../review/types";
import { type TestEditDeclaration, parseTestEditDeclarations } from "./test-edit-declaration";
import type { RunOperation } from "./types";

export interface AutofixImplementerInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
}

export interface AutofixImplementerOutput {
  applied: true;
  /** Set when the agent emits UNRESOLVED: (REVIEW-003 reviewer contradiction). */
  unresolvedReason?: string;
  /** Parsed TEST_EDIT_REASON blocks. Empty when no escape valve was invoked. */
  testEditDeclarations: TestEditDeclaration[];
  /** Shorthand for a single mock_structure handoff; bypasses testEditDeclarations flow. */
  mockStructureDeclaration?: { files: string[]; reasonDetail: string };
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
  parse(output, input, _ctx) {
    const unresolvedMatch = output.match(/^UNRESOLVED:\s*(.+)$/m);
    const allDeclarations = parseTestEditDeclarations(output);
    const mockDecl = allDeclarations.find((d) => d.reason === "mock_structure");
    const declarations = allDeclarations.filter((d) => d.reason !== "mock_structure");
    for (const d of declarations) {
      getSafeLogger()?.info("autofix", "test_edit_declared", {
        storyId: input.story.id,
        reason: d.reason,
        file: d.file,
      });
    }
    return {
      applied: true,
      testEditDeclarations: declarations,
      ...(mockDecl?.files && mockDecl?.reasonDetail
        ? { mockStructureDeclaration: { files: mockDecl.files, reasonDetail: mockDecl.reasonDetail } }
        : {}),
      ...(unresolvedMatch ? { unresolvedReason: unresolvedMatch[1]?.trim() } : {}),
    };
  },
};
