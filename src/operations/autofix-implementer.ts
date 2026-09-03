import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ReviewCheckResult } from "../review/types";
import { parseTestEditDeclarations, type TestEditDeclaration } from "./test-edit-declaration";
import type { RunOperation } from "./types";

export interface AutofixImplementerInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
  blockingThreshold?: "error" | "warning" | "info";
  /** Raw findings — when all are from tdd-verifier, verifierContext prompt is used. */
  findings?: readonly Finding[];
}

export interface AutofixImplementerOutput {
  applied: true;
  /** Set when the agent emits UNRESOLVED: (REVIEW-003 reviewer contradiction). */
  unresolvedReason?: string;
  /** Parsed TEST_EDIT_REASON blocks. Empty when no escape valve was invoked. */
  testEditDeclarations: TestEditDeclaration[];
}

export const implementerRectifyOp: RunOperation<AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> = {
  kind: "run",
  name: "autofix-implementer",
  stage: "rectification",
  session: { role: "implementer", lifetime: "warm" },
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "RunCommand", "GitCommit"],
  config: autofixConfigSelector,
  build(input, _ctx) {
    const verifierFindings = input.findings?.filter((f) => f.source === "tdd-verifier");
    const useVerifierContext =
      verifierFindings !== undefined &&
      verifierFindings.length > 0 &&
      verifierFindings.length === input.findings?.length;
    const prompt = useVerifierContext
      ? RectifierPromptBuilder.verifierContext(verifierFindings as Finding[])
      : RectifierPromptBuilder.reviewRectification(input.failedChecks, input.story, {
          blockingThreshold: input.blockingThreshold,
        });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    const unresolvedMatch = output.match(/^UNRESOLVED:\s*(.+)$/m);
    const declarations = parseTestEditDeclarations(output);
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
      ...(unresolvedMatch ? { unresolvedReason: unresolvedMatch[1]?.trim() } : {}),
    };
  },
};
