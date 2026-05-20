import type { TddConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from "./implement";

/**
 * Factory for the full-suite rectify strategy. Closes over `story` so `buildInput`
 * never reads from `ctx.story` (which is optional on CallContext and would crash
 * at runtime for ad-hoc / non-pipeline invocations).
 *
 * Call site: buildPlanForStrategy — the story is always available there.
 */
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> {
  return {
    name: "full-suite-rectify",
    appliesTo: (finding) => finding.source === "test-runner" && finding.category === "failed-test",
    fixOp: implementerOp,
    buildInput: (findings) => ({
      story,
      contextMarkdown: RectifierPromptBuilder.failingTestContext(findings),
    }),
    extractApplied: () => ({ targetFiles: [], summary: "Fixed failing tests" }),
    maxAttempts: 3,
    coRun: "exclusive",
  };
}
