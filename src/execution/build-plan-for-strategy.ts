/**
 * Build Plan for Strategy
 *
 * Builds an ExecutionPlan directly from strategy, story, config, and typed inputs.
 * Eliminates the PlanForStrategy boolean-bag and the two-sequencing-wrapper anti-pattern.
 *
 * Spec mapping (docs/specs/SPEC-story-orchestrator-consolidation.md):
 *   AC#4: buildPlanForStrategy(ctx, story, config, testStrategy, inputs): ExecutionPlan
 *         — review-slot gating reads config.review.checks: ReviewCheckName[]
 *           membership (not nested .enabled flags); table-driven per
 *           (testStrategy, review.enabled, review.checks, rectification.enabled, isRetry)
 *   AC#5: pipeline/stages/execution.ts has no if (isThreeSessionStrategy) sequencing branch —
 *         this file is the SSOT for strategy-dependent slot decisions
 *
 * Inputs envelope shape: PlanInputs (./plan-inputs.ts) — each field matches the
 * addX(input: I) overload of StoryOrchestratorBuilder.
 */

import type { NaxConfig } from "../config";
import type { TestStrategy } from "../config/schema-types";
import type { FixStrategy } from "../findings/cycle-types";
import type { Finding } from "../findings/types";
import {
  makeAutofixImplementerStrategy,
  makeAutofixTestWriterStrategy,
  makeMechanicalFormatFixStrategy,
  makeMechanicalLintFixStrategy,
} from "../operations";
import { shouldRunRectification } from "../operations/execution-gates";
import { makeFullSuiteRectifyStrategy } from "../operations/full-suite-rectify";
import type { CallContext } from "../operations/types";
import type { PipelineContext } from "../pipeline/types";
import type { UserStory } from "../prd/types";
import type { PlanInputs } from "./plan-inputs";
import { type ExecutionPlan, type RectificationPhaseOptions, StoryOrchestratorBuilder } from "./story-orchestrator";

/**
 * Strategies that use the three-session TDD orchestration (test-writer +
 * implementer + verifier, with full-suite gate between implementer and verifier).
 *
 * `tdd-simple` is NOT in this set — it is a single-session strategy where one
 * agent writes tests AND implements within the same session. The pre-US-005
 * execution stage gated the three-session path on the same two strategies
 * (see src/metrics/tracker.ts:142-143 and the archived single-session branch
 * in execution.ts before commit d97e25ae).
 */
const THREE_SESSION_STRATEGIES = new Set<TestStrategy>(["three-session-tdd", "three-session-tdd-lite"]);

export function isThreeSessionStrategy(strategy: TestStrategy): boolean {
  return THREE_SESSION_STRATEGIES.has(strategy);
}

/**
 * Whether the wrapper must capture an initial git ref before the plan runs.
 * Only TDD strategies require this — non-TDD strategies have no rollback path.
 * Extracted so pipeline/stages/execution.ts can stay strategy-blind beyond this call.
 */
export function requiresInitialRefCapture(strategy: TestStrategy): boolean {
  return isThreeSessionStrategy(strategy);
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
  const isThreeSession = isThreeSessionStrategy(testStrategy);
  const freshRun = isFreshRun(story);

  const builder = new StoryOrchestratorBuilder();

  // Fresh TDD run: include test-writer + greenfield-gate (skipped on retry)
  if (isThreeSession && freshRun && inputs.testWriter) {
    builder.addTestWriter(inputs.testWriter);
  }
  if (isThreeSession && freshRun && inputs.greenfieldGate) {
    builder.addGreenfieldGate(inputs.greenfieldGate);
  }

  // Always: implementer
  if (inputs.implementer) {
    builder.addImplementer(inputs.implementer);
  }

  // TDD: full-suite-gate + verifier
  if (isThreeSession && inputs.fullSuiteGate) {
    builder.addFullSuiteGate(inputs.fullSuiteGate);
  }
  if (isThreeSession && inputs.verifier) {
    builder.addVerifier(inputs.verifier);
  }

  // Check phases: verifyScoped (non-TDD only), lintCheck, typecheckCheck
  if (!isThreeSession && inputs.verifyScoped) {
    builder.addVerifyScoped(inputs.verifyScoped);
  }
  if (inputs.lintCheck) {
    builder.addLintCheck(inputs.lintCheck);
  }
  if (inputs.typecheckCheck) {
    builder.addTypecheckCheck(inputs.typecheckCheck);
  }

  // Review phases (strategy-agnostic — controlled by config.review.checks)
  if (hasReviewCheck(config, "semantic") && inputs.semanticReview) {
    builder.addSemanticReview(inputs.semanticReview);
  }
  if (hasReviewCheck(config, "adversarial") && inputs.adversarialReview) {
    builder.addAdversarialReview(inputs.adversarialReview);
  }

  // Rectification: requires both config gate and typed inputs.
  // Assemble strategies: mechanical fixes first, then full-suite (TDD), then autofix agents.
  if (shouldRunRectification(config) && inputs.rectification) {
    const strategies: FixStrategy<Finding, unknown, unknown, unknown>[] = [];

    if (config.quality.commands.lintFix || config.quality.commands.lintFixScoped) {
      strategies.push(makeMechanicalLintFixStrategy() as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    if (config.quality.commands.formatFix || config.quality.commands.formatFixScoped) {
      strategies.push(makeMechanicalFormatFixStrategy() as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    if (isThreeSession && inputs.fullSuiteGate) {
      strategies.push(makeFullSuiteRectifyStrategy(story) as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    if (config.quality.autofix?.enabled !== false) {
      strategies.push(
        makeAutofixImplementerStrategy(ctx as unknown as PipelineContext) as FixStrategy<
          Finding,
          unknown,
          unknown,
          unknown
        >,
      );
      strategies.push(
        makeAutofixTestWriterStrategy(ctx as unknown as PipelineContext) as FixStrategy<
          Finding,
          unknown,
          unknown,
          unknown
        >,
      );
    }

    const rectOpts: RectificationPhaseOptions = {
      ...inputs.rectification,
      strategies: [...strategies, ...inputs.rectification.strategies],
    };
    builder.addRectification(rectOpts);
  }

  return builder.build(ctx, { isThreeSession });
}
