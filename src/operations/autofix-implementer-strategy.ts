import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "./autofix-implementer";
import { implementerRectifyOp } from "./autofix-implementer";

const IMPLEMENTER_SOURCES = new Set(["lint", "typecheck", "semantic-review"]);

export function makeAutofixImplementerStrategy(
  story: UserStory,
): FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> {
  return {
    name: "autofix-implementer",
    appliesTo: (f) => f.fixTarget === "source" && IMPLEMENTER_SOURCES.has(f.source),
    fixOp: implementerRectifyOp,
    buildInput: (_findings, _prior, _cycleCtx): AutofixImplementerInput => ({
      failedChecks: [],
      story,
    }),
    extractApplied: (output) => ({
      summary: output.unresolvedReason ?? "",
      unresolved: output.unresolvedReason,
    }),
    maxAttempts: 3,
    coRun: "co-run-sequential",
  };
}
