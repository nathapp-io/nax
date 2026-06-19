import type { NaxConfig } from "../config/schema";
import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { findingsToFailedChecks } from "./_finding-to-check";
import type { AutofixTestWriterInput, AutofixTestWriterOutput } from "./autofix-test-writer";
import { testWriterRectifyOp } from "./autofix-test-writer";
import type { DeclarationSink } from "./declaration-sink";

/** Options controlling which findings the test-writer rectifier claims. */
export interface AutofixTestWriterStrategyOptions {
  /**
   * When `true` (default) the test-writer's `appliesTo` includes the blanket
   * `source === "adversarial-review"` clause so the test-writer owns every
   * adversarial finding regardless of `fixTarget`. This is the historical
   * behaviour preserved for the blocking three-session workflow.
   *
   * When `false`, the blanket clause is disabled and the test-writer will only
   * claim findings with `fixTarget === "test"` (or `mockHandoffs`). Used in
   * the `triage` non-blocking fix scope so that source-targeted adversarial
   * findings route exclusively to the implementer.
   * (default: true)
   */
  includeAdversarialReview?: boolean;
  /**
   * Severity floor for findings rendered into the rectifier prompt. The prompt
   * builder drops findings below this floor. Defaults (when undefined) to the
   * run's `review.blockingThreshold` (i.e. `"error"`), which is correct for the
   * blocking cycle but WRONG for the non-blocking fix: that path is seeded
   * exclusively with advisory findings *below* the blocking threshold
   * (`adversarial.ts` advisory filter), so the run threshold would strip every
   * finding back out and the agent receives an empty findings list. The
   * non-blocking strategy set passes `"info"` here so all seeded advisory
   * findings render. (default: undefined → `config.review.blockingThreshold`)
   */
  promptSeverityFloor?: "error" | "warning" | "info";
}

export function makeAutofixTestWriterStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
  opts: AutofixTestWriterStrategyOptions = {},
): FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> {
  const includeAdversarial = opts.includeAdversarialReview !== false;
  const blockingThreshold = opts.promptSeverityFloor ?? config.review?.blockingThreshold;
  return {
    name: "autofix-test-writer",
    appliesTo: (f) =>
      f.fixTarget === "test" ||
      (includeAdversarial && f.source === "adversarial-review") ||
      sink.mockHandoffs.length > 0,
    fixOp: testWriterRectifyOp,
    buildInput: (findings, _prior, _cycleCtx): AutofixTestWriterInput => {
      // Consume mock-structure handoffs from the shared sink (one-shot).
      if (sink.mockHandoffs.length > 0) {
        const handoffs = sink.mockHandoffs.splice(0);
        // Deduplicate FILES across all handoffs.
        const seenFiles = new Set<string>();
        const handoffFiles: string[] = [];
        for (const h of handoffs) {
          for (const f of h.files) {
            if (!seenFiles.has(f)) {
              seenFiles.add(f);
              handoffFiles.push(f);
            }
          }
        }
        const handoffReason = handoffs.map((h) => h.reasonDetail).join("\n---\n");
        return {
          failedChecks: findingsToFailedChecks(findings),
          story,
          mode: "mock-restructure",
          blockingThreshold,
          handoffReason,
          handoffFiles,
        };
      }
      return {
        failedChecks: findingsToFailedChecks(findings),
        story,
        blockingThreshold,
      };
    },
    maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
    coRun: "co-run-sequential",
  };
}
