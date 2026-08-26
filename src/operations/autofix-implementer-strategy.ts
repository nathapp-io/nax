import type { NaxConfig } from "../config/schema";
import type { AutofixConfig } from "../config/selectors";
import type { FixStrategyWithExtractApplied } from "../findings";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { findingsToFailedChecks } from "./_finding-to-check";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "./autofix-implementer";
import { implementerRectifyOp } from "./autofix-implementer";
import type { DeclarationSink } from "./declaration-sink";

const IMPLEMENTER_SOURCES = new Set(["lint", "typecheck", "semantic-review", "tdd-verifier"]);

/** Options controlling which findings the implementer rectifier claims. */
export interface AutofixImplementerStrategyOptions {
  /**
   * When true, the implementer also claims `adversarial-review` findings
   * regardless of their `fixTarget`. Used for single-session strategies
   * (tdd-simple / test-after / no-test) where there is no separate test-writer
   * session — the one warm implementer session owns both source and tests, so
   * routing adversarial findings to a fresh cold test-writer session (the
   * three-session default) is wrong. See build-plan-for-strategy.ts.
   * (default: false)
   */
  includeAdversarialReview?: boolean;
  /**
   * Restrict the implementer to claiming `adversarial-review` findings whose
   * `fixTarget` matches this value (e.g. `"source"`). When set, this supersedes
   * the blanket `includeAdversarialReview` for adversarial findings so that
   * fixTarget=test adversarial findings stay with the test-writer. Used in the
   * `triage` non-blocking fix scope so that source-targeted adversarial
   * findings go to the implementer and test-targeted findings go to the
   * test-writer without overlap.
   * (default: undefined — implementer does not claim adversarial findings
   * unless `includeAdversarialReview` is also true)
   */
  adversarialReviewByFixTarget?: "source" | "test";
  /**
   * Severity floor for findings rendered into the rectifier prompt. The prompt
   * builder drops findings below this floor (default `"error"`). The
   * non-blocking fix is seeded exclusively with advisory findings *below* the
   * run's blocking threshold, so without an explicit `"info"` floor every
   * seeded finding is filtered back out and the agent receives an empty
   * findings list. The non-blocking strategy set passes `"info"`.
   * (default: undefined → `config.review.blockingThreshold`)
   */
  promptSeverityFloor?: "error" | "warning" | "info";
}

export function makeAutofixImplementerStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
  opts: AutofixImplementerStrategyOptions = {},
): FixStrategyWithExtractApplied<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> {
  const claimsAdversarial = opts.includeAdversarialReview === true;
  const adversarialReviewByFixTarget = opts.adversarialReviewByFixTarget;
  const blockingThreshold = opts.promptSeverityFloor ?? config.review?.blockingThreshold;
  return {
    name: "autofix-implementer",
    appliesTo: (f) =>
      // lint and typecheck adapters leave fixTarget unset — assume source fix.
      // Edge case: lint/typecheck error on a test file routes here instead of
      // autofix-test-writer, but style fixes don't require test-writer context.
      ((f.fixTarget === "source" || f.fixTarget == null) && IMPLEMENTER_SOURCES.has(f.source)) ||
      // triage scope: claim only adversarial findings whose fixTarget matches
      // the requested target. Supersedes the blanket includeAdversarialReview
      // for adversarial findings so that fixTarget=test adversarial findings
      // stay with the test-writer.
      (adversarialReviewByFixTarget !== undefined &&
        f.source === "adversarial-review" &&
        f.fixTarget === adversarialReviewByFixTarget) ||
      (adversarialReviewByFixTarget === undefined && claimsAdversarial && f.source === "adversarial-review"),
    fixOp: implementerRectifyOp,
    buildInput: (findings, _prior, _cycleCtx): AutofixImplementerInput => ({
      failedChecks: findingsToFailedChecks(findings),
      story,
      findings,
      blockingThreshold,
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
