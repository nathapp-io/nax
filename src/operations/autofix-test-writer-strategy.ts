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
   * When true, disables the blanket `source === "adversarial-review"` clause.
   * The test-writer will only claim findings with `fixTarget === "test"` (or
   * mockHandoffs). Used in the `triage` non-blocking fix scope so that
   * source-targeted adversarial findings route exclusively to the implementer.
   * (default: false)
   */
  disableBlanketAdversarial?: boolean;
}

export function makeAutofixTestWriterStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
  opts: AutofixTestWriterStrategyOptions = {},
): FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> {
  const disableBlanket = opts.disableBlanketAdversarial === true;
  return {
    name: "autofix-test-writer",
    appliesTo: (f) =>
      f.fixTarget === "test" || (!disableBlanket && f.source === "adversarial-review") || sink.mockHandoffs.length > 0,
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
          blockingThreshold: config.review?.blockingThreshold,
          handoffReason,
          handoffFiles,
        };
      }
      return {
        failedChecks: findingsToFailedChecks(findings),
        story,
        blockingThreshold: config.review?.blockingThreshold,
      };
    },
    maxAttempts: config.execution.rectification.maxAttemptsPerStrategy,
    coRun: "co-run-sequential",
  };
}
