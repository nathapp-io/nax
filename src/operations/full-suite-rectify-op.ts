import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder, repoScopedRectification } from "../prompts";
import { type TestEditDeclaration, parseTestEditDeclarations } from "./test-edit-declaration";
import type { RunOperation } from "./types";

export interface FullSuiteRectifyInput {
  story: UserStory;
  findings: readonly Finding[];
  /**
   * Which mandate to send (#1654). `"story"` (the default) forbids touching
   * anything outside the story; `"repo"` lifts that for the fallthrough
   * dispatch after the story-scoped attempt declined the findings as
   * out-of-scope. Only the prompt differs — the UNRESOLVED protocol and the
   * declaration parser are shared, which is why this is a field rather than a
   * second op.
   */
  scope?: "story" | "repo";
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
  // The repo-scoped dispatch runs under its own session role and gets a single
  // attempt, so nothing resumes its session — keeping it warm would strand one.
  // The story-scoped dispatch keeps the op's declared `warm` lifetime.
  keepOpen: (input) => input.scope !== "repo",
  build(input, _ctx) {
    const prompt =
      input.scope === "repo"
        ? repoScopedRectification(input.findings as Finding[], input.story)
        : RectifierPromptBuilder.failingTestRectification(input.findings as Finding[], input.story);
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
