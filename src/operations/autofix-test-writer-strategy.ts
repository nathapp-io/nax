import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { PipelineContext } from "../pipeline/types";
import type { ReviewCheckResult } from "../review/types";
import type { AutofixTestWriterInput, AutofixTestWriterOutput } from "./autofix-test-writer";
import { testWriterRectifyOp } from "./autofix-test-writer";

export function makeAutofixTestWriterStrategy(
  ctx: PipelineContext,
): FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> {
  return {
    name: "autofix-test-writer",
    appliesTo: (f) => f.fixTarget === "test" || f.source === "adversarial-review",
    fixOp: testWriterRectifyOp,
    buildInput: (_findings, _prior, _cycleCtx): AutofixTestWriterInput => ({
      failedChecks: ((ctx as any).reviewResult?.checks ?? []).filter((c: ReviewCheckResult) => !c.success),
      story: (ctx as any).story,
      blockingThreshold: (ctx as any).config?.review?.blockingThreshold,
    }),
    maxAttempts: 2,
    coRun: "co-run-sequential",
  };
}
