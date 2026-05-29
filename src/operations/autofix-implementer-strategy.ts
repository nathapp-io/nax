import type { NaxConfig } from "../config/schema";
import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { findingsToFailedChecks } from "./_finding-to-check";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "./autofix-implementer";
import { implementerRectifyOp } from "./autofix-implementer";
import type { DeclarationSink } from "./declaration-sink";

const IMPLEMENTER_SOURCES = new Set(["lint", "typecheck", "semantic-review", "tdd-verifier"]);

export function makeAutofixImplementerStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
): FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> {
  return {
    name: "autofix-implementer",
    appliesTo: (f) => f.fixTarget === "source" && IMPLEMENTER_SOURCES.has(f.source),
    fixOp: implementerRectifyOp,
    buildInput: (findings, _prior, _cycleCtx): AutofixImplementerInput => ({
      failedChecks: findingsToFailedChecks(findings),
      story,
    }),
    extractApplied: (output) => {
      // Accumulate test-edit declarations and mock handoffs into the shared sink
      // so postValidate can inspect them after each validate() pass.
      for (const decl of output.testEditDeclarations) {
        if (decl.reason === "mock_structure" && decl.files && decl.reasonDetail) {
          sink.mockHandoffs.push({ files: decl.files, reasonDetail: decl.reasonDetail });
        } else if (decl.reason !== "mock_structure") {
          sink.testEdits.push(decl);
        }
      }
      return {
        summary: output.unresolvedReason ?? "",
        unresolved: output.unresolvedReason,
      };
    },
    maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
    coRun: "co-run-sequential",
  };
}
