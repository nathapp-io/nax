import type { NaxConfig } from "../config/schema";
import type { AutofixConfig } from "../config/selectors";
import type { TddConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { DeclarationSink } from "./declaration-sink";
import type { FullSuiteRectifyInput, FullSuiteRectifyOutput } from "./full-suite-rectify-op";
import { fullSuiteRectifyOp } from "./full-suite-rectify-op";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from "./implement";

/**
 * Factory for the full-suite rectify strategy. Closes over `story` so `buildInput`
 * never reads from `ctx.story` (which is optional on CallContext and would crash
 * at runtime for ad-hoc / non-pipeline invocations).
 *
 * Call site: buildPlanForStrategy + run-regression.ts — the story is always available.
 *
 * When `sink` is provided the strategy switches to `fullSuiteRectifyOp` and
 * `extractApplied` pushes parsed declarations into the shared sink for downstream
 * processing (mock_structure → mockHandoffs, others → testEdits).
 */
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
): FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig>;
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig>;
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  sink?: DeclarationSink,
):
  | FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig>
  | FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> {
  const appliesTo = (finding: Finding): boolean =>
    finding.source === "test-runner" && (finding.category === "failed-test" || finding.category === "execution-failed");

  if (sink) {
    return {
      name: "full-suite-rectify",
      appliesTo,
      fixOp: fullSuiteRectifyOp,
      buildInput: (findings) => ({ story, findings }),
      extractApplied: (output: FullSuiteRectifyOutput) => {
        for (const d of output.testEditDeclarations) {
          if (d.reason === "mock_structure" && d.files && d.files.length > 0) {
            sink.mockHandoffs.push({ files: d.files, reasonDetail: d.reasonDetail ?? "" });
          } else if (d.reason !== "mock_structure") {
            sink.testEdits.push(d);
          }
        }
        // Only propagate `unresolved` (triggering agent-gave-up exit) when there
        // are no testEditDeclarations. If the agent emitted UNRESOLVED alongside an
        // Exception 4(b) declaration, the declaration takes priority so postValidate
        // can still invoke the test-writer handoff to fix the broken test.
        const hasDeclarations = output.testEditDeclarations.length > 0;
        return {
          targetFiles: [],
          summary: output.unresolvedReason ?? "Fixed failing tests",
          ...(output.unresolvedReason && !hasDeclarations ? { unresolved: output.unresolvedReason } : {}),
        };
      },
      maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
      coRun: "exclusive",
    };
  }

  return {
    name: "full-suite-rectify",
    appliesTo,
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
