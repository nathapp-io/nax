import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { PipelineContext } from "../pipeline/types";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "./autofix-implementer";
import { implementerRectifyOp } from "./autofix-implementer";

const IMPLEMENTER_SOURCES = new Set(["lint", "typecheck", "semantic-review"]);

export function makeAutofixImplementerStrategy(
  ctx: PipelineContext,
): FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> {
  return {
    name: "autofix-implementer",
    appliesTo: (f) => f.fixTarget === "source" && IMPLEMENTER_SOURCES.has(f.source),
    fixOp: implementerRectifyOp,
    buildInput: (_findings, _prior, _cycleCtx): AutofixImplementerInput => ({
      failedChecks: (ctx.reviewResult?.checks ?? []).filter((c) => !c.success),
      story: ctx.story,
    }),
    extractApplied: (output) => ({
      summary: output.unresolvedReason ?? "",
      unresolved: output.unresolvedReason,
    }),
    maxAttempts: 3,
    coRun: "co-run-sequential",
  };
}
