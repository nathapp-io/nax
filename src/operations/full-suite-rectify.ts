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
 *
 * `hasTestWriterDrainer` (sink variant only) gates the mock-structure handoff
 * short-circuit. When `true`, this exclusive strategy stops claiming failing-test
 * findings while a mock_structure handoff is pending (`sink.mockHandoffs.length > 0`),
 * so `selectExecutionGroup` falls through to the co-run `autofix-test-writer` that
 * drains the handoff — instead of re-invoking the implementer up to its per-strategy
 * cap to re-declare the identical handoff (#1352). The suppression is self-limiting:
 * the test-writer drains `sink.mockHandoffs` in one iteration, after which this
 * strategy reclaims normally. Pass `true` ONLY where an `autofix-test-writer` is
 * registered on the same sink; otherwise suppressing here orphans the finding
 * (`exitReason: "no-strategy"` — #1330/#1327).
 */
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
  hasTestWriterDrainer?: boolean,
): FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig>;
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig>;
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
  config: NaxConfig,
  sink?: DeclarationSink,
  hasTestWriterDrainer?: boolean,
):
  | FixStrategy<Finding, FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig>
  | FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> {
  const claimsFailingTest = (finding: Finding): boolean =>
    finding.source === "test-runner" && (finding.category === "failed-test" || finding.category === "execution-failed");

  if (sink) {
    // While a mock_structure handoff is pending AND a test-writer is registered to
    // drain it, stop claiming — hand selection to the co-run `autofix-test-writer`
    // this iteration instead of re-running the implementer (#1352).
    const appliesTo = (finding: Finding): boolean =>
      claimsFailingTest(finding) && !(hasTestWriterDrainer === true && sink.mockHandoffs.length > 0);

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
        const unresolved = output.unresolvedReason && !hasDeclarations ? output.unresolvedReason : undefined;
        return {
          targetFiles: [],
          // Mirror `unresolved`: when a declaration suppresses the give-up, the iteration
          // is a handoff, not a give-up — don't label the summary with the UNRESOLVED text.
          summary: unresolved ?? "Fixed failing tests",
          ...(unresolved ? { unresolved } : {}),
        };
      },
      maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
      coRun: "exclusive",
    };
  }

  return {
    name: "full-suite-rectify",
    appliesTo: claimsFailingTest,
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
