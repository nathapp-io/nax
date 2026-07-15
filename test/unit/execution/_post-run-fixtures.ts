/**
 * Shared fixtures for post-run inspection tests.
 *
 * Extracted so the post-run-inspection test suite can be split by concern
 * (base helpers vs. rectification-exhaustion routing) without duplicating the
 * plan-result / inspection-opts factories or the finding constants.
 *
 * Not a `.test.ts` file — holds no tests, only factories/constants.
 */

import type { InspectionOptions, StoryOrchestratorResult } from "@/execution";
import type { Finding } from "@/findings/types";
import { implementerOp } from "@/operations";

export function makePlanResult(overrides: Record<string, unknown> = {}): StoryOrchestratorResult {
  return {
    success: false,
    phaseCosts: {},
    totalCostUsd: 0,
    durationMs: 100,
    phaseOutputs: {
      [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
    },
    ...overrides,
  } as StoryOrchestratorResult;
}

export function makeInspectionOpts(overrides: Partial<InspectionOptions> = {}): InspectionOptions {
  return {
    capturedResponse: "",
    capturedCostUsd: 0,
    tddMode: null,
    initialRef: null,
    ...overrides,
  };
}

export const LINT_FINDING: Finding = { source: "lint", severity: "error", message: "unused var", category: "lint" };
export const TYPECHECK_FINDING: Finding = {
  source: "typecheck",
  severity: "error",
  message: "type error",
  category: "type",
};
export const TEST_RUNNER_FINDING: Finding = {
  source: "test-runner",
  severity: "error",
  message: "test failed",
  category: "test",
};
export const SEMANTIC_REVIEW_FINDING: Finding = {
  source: "semantic-review",
  severity: "error",
  message: "semantic review failed",
  category: "ac-coverage",
  fixTarget: "source",
};
// Advisory leftover that no fix strategy's `appliesTo` claims — "plugin" is
// claimed by no strategy, and the severity is below the default "error" blocking
// threshold. Regression fixture for the advisory-only exhaustion escape: see the
// event-bus-idempotency-dlq US-004 no-strategy failure where a green story was
// failed on exactly this shape. That case was a `source:"autofix"` declaration
// diagnostic; #1327 removed those at the mint site, but sources like "plugin"
// can still orphan, so the escape stays.
export const ADVISORY_LEFTOVER_FINDING: Finding = {
  source: "plugin",
  severity: "warning",
  message: "plugin check reported a non-blocking issue",
  category: "plugin-advisory",
  fixTarget: "source",
};
