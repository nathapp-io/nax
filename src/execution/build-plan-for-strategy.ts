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

import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { TestStrategy } from "../config/schema-types";
import type { FixCycleContext } from "../findings/cycle-types";
import type { FixStrategy } from "../findings/cycle-types";
import type { Finding } from "../findings/types";
import {
  applyTestEditDeclarations,
  makeAutofixImplementerStrategy,
  makeAutofixTestWriterStrategy,
  makeDeclarationSink,
  makeMechanicalFormatFixStrategy,
  makeMechanicalLintFixStrategy,
  validateMockStructureFiles,
} from "../operations";
import type { TestEditDeclaration } from "../operations";
import { shouldRunRectification } from "../operations/execution-gates";
import { makeFullSuiteRectifyStrategy } from "../operations/full-suite-rectify";
import type { CallContext } from "../operations/types";
import type { UserStory } from "../prd/types";
import { resolveTestFilePatterns } from "../test-runners";
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
 * This function is async because it eagerly resolves test-file patterns
 * (needed for the postValidate closure that validates mock-structure handoffs
 * during the rectification cycle).
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
export async function buildPlanForStrategy(
  ctx: CallContext,
  story: UserStory,
  config: NaxConfig,
  testStrategy: TestStrategy,
  inputs: PlanInputs,
): Promise<ExecutionPlan> {
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

  // Full-suite gate: TDD always, non-TDD only when regressionGate.mode === "per-story" (issue #1116).
  const regressionMode = config.execution?.regressionGate?.mode ?? "deferred";
  if (inputs.fullSuiteGate && (isThreeSession || regressionMode === "per-story")) {
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
  if (inputs.semanticReview) {
    builder.addSemanticReview(inputs.semanticReview);
  }
  if (inputs.adversarialReview) {
    builder.addAdversarialReview(inputs.adversarialReview);
  }

  // Rectification: requires both config gate and typed inputs.
  // Assemble strategies: mechanical fixes first, then full-suite (TDD), then autofix agents.
  if (shouldRunRectification(config) && inputs.rectification) {
    // One shared sink for the implementer and test-writer strategies so
    // declarations accumulate and mock handoffs are consumed by postValidate.
    const sink = makeDeclarationSink();

    // Resolve test-file patterns once at plan-build time — postValidate uses
    // them to validate mock-structure file paths during the rectification cycle.
    // ctx.packageDir = repo root (absolute); story.workdir = relative sub-path to package.
    const packageDir = join(ctx.packageDir, story.workdir ?? "");
    const resolvedTestPatterns = await resolveTestFilePatterns(config, ctx.packageDir, story.workdir);

    const strategies: FixStrategy<Finding, unknown, unknown, unknown>[] = [];

    if (config.quality.commands.lintFix || config.quality.commands.lintFixScoped) {
      strategies.push(makeMechanicalLintFixStrategy() as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    if (config.quality.commands.formatFix || config.quality.commands.formatFixScoped) {
      strategies.push(makeMechanicalFormatFixStrategy() as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    // Mirror the primary gate condition: TDD always, non-TDD when mode=per-story.
    if (inputs.fullSuiteGate && (isThreeSession || regressionMode === "per-story")) {
      strategies.push(makeFullSuiteRectifyStrategy(story, config) as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    if (config.quality.autofix?.enabled !== false) {
      // Single-session strategies (tdd-simple / test-after / no-test) have no
      // separate test-writer session — the one warm implementer session authored
      // both source and tests. Route adversarial-review findings to that
      // implementer instead of spinning up a fresh, context-less test-writer.
      //
      // Note: AC-HOOK / AC-ERROR sentinel findings (test-runner, fixTarget=test)
      // are intentionally NOT re-routed here — they are owned by the acceptance
      // loop, not the per-story rectification cycle, and a cold test-writer never
      // resolved them usefully either.
      strategies.push(
        makeAutofixImplementerStrategy(story, config, sink, {
          includeAdversarialReview: !isThreeSession,
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
      // The autofix-test-writer strategy only belongs to three-session TDD,
      // where the test-writer phase itself exists (see gating above where
      // addTestWriter is conditioned on isThreeSession).
      if (isThreeSession) {
        strategies.push(
          makeAutofixTestWriterStrategy(story, config, sink) as FixStrategy<Finding, unknown, unknown, unknown>,
        );
      }
    }

    const postValidate = async (findings: Finding[], _validateCtx: FixCycleContext): Promise<Finding[]> => {
      if (sink.testEdits.length === 0 && sink.mockHandoffs.length === 0) return findings;

      // Wrap mock handoffs as TestEditDeclaration shape for validateMockStructureFiles.
      const pendingMock: TestEditDeclaration[] = sink.mockHandoffs.map((h) => ({
        reason: "mock_structure" as const,
        file: h.files[0] ?? "",
        files: h.files,
        reasonDetail: h.reasonDetail,
      }));

      const { valid, invalid } = await validateMockStructureFiles(pendingMock, resolvedTestPatterns, packageDir);

      // Replace sink.mockHandoffs with only valid entries for test-writer to consume.
      sink.mockHandoffs = valid.map((d) => ({ files: d.files ?? [], reasonDetail: d.reasonDetail ?? "" }));

      const allDeclarations = [...sink.testEdits, ...valid];
      sink.testEdits = []; // consumed

      return applyTestEditDeclarations(findings, allDeclarations, story, invalid);
    };

    const rectOpts: RectificationPhaseOptions = {
      ...inputs.rectification,
      strategies: [...strategies, ...inputs.rectification.strategies],
      postValidate,
    };
    builder.addRectification(rectOpts);
  }

  return builder.build(ctx, { isThreeSession });
}
