import { ParseValidationError, makeParseRetryStrategy } from "../agents/retry";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding, Iteration } from "../findings";
import { AdversarialReviewPromptBuilder, ReviewPromptBuilder } from "../prompts";
import type { TestInventory } from "../prompts";
import {
  isBlockingSeverity,
  toAdversarialReviewFindings,
  validateAdversarialShape,
} from "../review/adversarial-helpers";
import type { AdversarialReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export type { AdversarialReviewConfig, SemanticStory, TestInventory };

export interface AdversarialReviewInput {
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  testInventory?: TestInventory;
  testGlobs?: readonly string[];
  excludePatterns?: string[];
  refExcludePatterns?: readonly string[];
  /** Pre-built, role-filtered context prefix to prepend to the review prompt. */
  featureCtxBlock?: string;
  /** Prior adversarial review iterations to carry forward into this round (ADR-022 phase 5). */
  priorAdversarialIterations?: Iteration[];
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
}

export interface AdversarialReviewOutput {
  passed: boolean;
  /** Raw AdversarialLLMFinding[]. Consumed by `src/review/adversarial.ts`. */
  findings: unknown[];
  /**
   * Source-tagged Finding[] (`source: "adversarial-review"`), used by the rectification
   * cycle's `extractPhaseFindings` → strategy `appliesTo` routing. Empty for fail-open
   * / looksLikeFail outcomes.
   */
  normalizedFindings: Finding[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false`.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
}

const FAIL_OPEN: AdversarialReviewOutput = { passed: true, findings: [], normalizedFindings: [], failOpen: true };

const adversarialParseRetry = (input: AdversarialReviewInput) =>
  makeParseRetryStrategy({
    validate: (parsed) => validateAdversarialShape(parsed) !== null,
    reviewerKind: "adversarial",
    maxAttempts: 2,
    prompts: {
      invalid: () => ReviewPromptBuilder.jsonRetry(),
      truncated: () => ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: input.blockingThreshold }),
    },
    exhaustedFallback: (lastOutput) =>
      /"passed"\s*:\s*false/.test(lastOutput)
        ? { passed: false, findings: [], normalizedFindings: [], looksLikeFail: true }
        : FAIL_OPEN,
    logContext: { blockingThreshold: input.blockingThreshold ?? "error" },
  });

export const adversarialReviewOp: RunOperation<AdversarialReviewInput, AdversarialReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "adversarial-review",
  stage: "review",
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  config: reviewConfigSelector,
  // Issue #725 — per-call tier from user-configured AdversarialReviewConfig.model.
  model: (input) => input.adversarialConfig.model,
  timeoutMs: (input) => input.adversarialConfig.timeoutMs,
  retry: (input) => adversarialParseRetry(input),
  build(input, _ctx) {
    const base = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(
      input.story,
      input.adversarialConfig,
      {
        mode: input.mode,
        diff: input.diff,
        storyGitRef: input.storyGitRef,
        stat: input.stat,
        testInventory: input.testInventory,
        excludePatterns: input.excludePatterns,
        testGlobs: input.testGlobs,
        refExcludePatterns: input.refExcludePatterns,
        priorAdversarialIterations: input.priorAdversarialIterations,
        blockingThreshold: input.blockingThreshold,
      },
    );
    const content = input.featureCtxBlock ? `${input.featureCtxBlock}${base}` : base;
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = validateAdversarialShape(raw);
    if (parsed) {
      // Match the wrapper's advisory split (src/review/adversarial.ts) so the
      // orchestrator-direct path doesn't push below-threshold findings into the
      // rectification cycle.
      const threshold = input.blockingThreshold ?? "error";
      const blocking = parsed.findings.filter((f) => isBlockingSeverity(f.severity, threshold));
      return {
        passed: parsed.passed,
        findings: parsed.findings,
        normalizedFindings: toAdversarialReviewFindings(blocking),
      };
    }
    if (/"passed"\s*:\s*false/.test(output) && !/"findings"\s*:\s*\[\s*\{/.test(output)) {
      return { passed: false, findings: [], normalizedFindings: [], looksLikeFail: true };
    }
    throw new ParseValidationError("[adversarial-review] parse failed: invalid JSON shape");
  },
};
