import type { NaxConfig } from "../config/schema";
import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import type { AutofixTestWriterInput, AutofixTestWriterOutput } from "./autofix-test-writer";
import { testWriterRectifyOp } from "./autofix-test-writer";
import { findingsToFailedChecks } from "./_finding-to-check";

export function makeAutofixTestWriterStrategy(
  story: UserStory,
  config: NaxConfig,
): FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> {
  return {
    name: "autofix-test-writer",
    appliesTo: (f) => f.fixTarget === "test" || f.source === "adversarial-review",
    fixOp: testWriterRectifyOp,
    buildInput: (findings, _prior, _cycleCtx): AutofixTestWriterInput => ({
      failedChecks: findingsToFailedChecks(findings),
      story,
      blockingThreshold: config.review?.blockingThreshold,
    }),
    maxAttempts: 2,
    coRun: "co-run-sequential",
  };
}
