import type { NaxConfig } from "../config/schema";
import type { TddConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { DeclarationSink } from "./declaration-sink";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from "./implement";

/**
 * Factory for the full-suite rectify strategy. Closes over `story` so `buildInput`
 * never reads from `ctx.story` (which is optional on CallContext and would crash
 * at runtime for ad-hoc / non-pipeline invocations).
 *
 * Call site: buildPlanForStrategy + run-regression.ts — the story is always available.
 */
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  _sink?: DeclarationSink,
): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> {
  return {
    name: "full-suite-rectify",
    appliesTo: (finding) =>
      finding.source === "test-runner" &&
      (finding.category === "failed-test" || finding.category === "execution-failed"),
    fixOp: implementerOp,
    buildInput: (findings) => ({
      story,
      contextMarkdown: RectifierPromptBuilder.failingTestContext(findings),
    }),
    extractApplied: () => ({ targetFiles: [], summary: "Fixed failing tests" }),
    maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
    coRun: "exclusive",
  };
}
