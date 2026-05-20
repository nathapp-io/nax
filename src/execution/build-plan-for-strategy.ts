/**
 * Build Plan for Strategy
 *
 * Builds an ExecutionPlan directly from strategy, story, config, and typed inputs.
 * Eliminates the PlanForStrategy boolean-bag and the two-sequencing-wrapper anti-pattern.
 *
 * AC4: buildPlanForStrategy(ctx, story, config, testStrategy, inputs): ExecutionPlan
 * AC1: testStrategy is an explicit parameter — never read from NaxConfig or story.routing
 * AC2: Fresh/retry detection is derived from story state — not from external isFreshRun flag
 * AC3: TDD strategies include full-suite-gate and verifier; non-TDD omit them
 * AC4: Review phase selection controlled by config.review.checks membership
 * AC5: Rectification gated by shouldRunRectification(config) + inputs.rectification presence
 */

import type { NaxConfig } from "../config";
import type { TestStrategy } from "../config/schema-types";
import { shouldRunRectification } from "../operations/execution-gates";
import type { CallContext } from "../operations/types";
import type { UserStory } from "../prd/types";
import type { PlanInputs } from "./plan-inputs";
import { type ExecutionPlan, StoryOrchestratorBuilder } from "./story-orchestrator";

const TDD_STRATEGIES = new Set<TestStrategy>(["tdd-simple", "three-session-tdd", "three-session-tdd-lite"]);

export function isTddStrategy(strategy: TestStrategy): boolean {
  return TDD_STRATEGIES.has(strategy);
}

function hasReviewCheck(config: NaxConfig, check: "semantic" | "adversarial"): boolean {
  if (config.review?.enabled !== true) return false;
  const checks = config.review?.checks;
  return Array.isArray(checks) && checks.includes(check);
}

/**
 * Returns true when the story is a fresh run — attempts=0 and no prior review failure.
 * A review escalation is treated as a retry so the test-writer and greenfield-gate
 * phases are omitted (tests already exist from the prior attempt).
 */
function isFreshRun(story: UserStory): boolean {
  const hasAttempts = (story.attempts ?? 0) > 0;
  const hasReviewEscalation = (story.priorFailures ?? []).some((f) => f.stage === "review");
  return !hasAttempts && !hasReviewEscalation;
}

/**
 * Build an ExecutionPlan from strategy + story state + typed inputs.
 *
 * Slot inclusion is determined by:
 *   1. test strategy (which phases are eligible)
 *   2. story state (fresh vs. retry — derived, never passed externally)
 *   3. config (review checks, rectification flag)
 *   4. input presence (ops only added when inputs.X is defined)
 *
 * Canonical phase order (CANONICAL_ORDER in story-orchestrator.ts):
 *   test-writer → greenfield-gate → implementer → full-suite-gate →
 *   verifier → semantic-review → adversarial-review
 *
 * Rectification runs after all phases if both config.execution.rectification.enabled
 * and inputs.rectification are defined.
 */
export function buildPlanForStrategy(
  ctx: CallContext,
  story: UserStory,
  config: NaxConfig,
  testStrategy: TestStrategy,
  inputs: PlanInputs,
): ExecutionPlan {
  const isTdd = isTddStrategy(testStrategy);
  const freshRun = isFreshRun(story);

  const builder = new StoryOrchestratorBuilder();

  // Fresh TDD run: include test-writer + greenfield-gate (skipped on retry)
  if (isTdd && freshRun && inputs.testWriter) {
    builder.addTestWriter(inputs.testWriter);
  }
  if (isTdd && freshRun && inputs.greenfieldGate) {
    builder.addGreenfieldGate(inputs.greenfieldGate);
  }

  // Always: implementer
  if (inputs.implementer) {
    builder.addImplementer(inputs.implementer);
  }

  // TDD: full-suite-gate + verifier
  if (isTdd && inputs.fullSuiteGate) {
    builder.addFullSuiteGate(inputs.fullSuiteGate);
  }
  if (isTdd && inputs.verifier) {
    builder.addVerifier(inputs.verifier);
  }

  // Review phases (strategy-agnostic — controlled by config.review.checks)
  if (hasReviewCheck(config, "semantic") && inputs.semanticReview) {
    builder.addSemanticReview(inputs.semanticReview);
  }
  if (hasReviewCheck(config, "adversarial") && inputs.adversarialReview) {
    builder.addAdversarialReview(inputs.adversarialReview);
  }

  // Rectification: requires both config gate and typed inputs
  if (shouldRunRectification(config) && inputs.rectification) {
    builder.addRectification(inputs.rectification);
  }

  return builder.build(ctx);
}
