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
import { isThreeSessionStrategy, qualityConfigSelector } from "../config";
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
 * Whether the wrapper must capture an initial git ref before the plan runs.
 * Only TDD strategies require this — non-TDD strategies have no rollback path.
 * Extracted so pipeline/stages/execution.ts can stay strategy-blind beyond this call.
 *
 * Strategy classification (`isThreeSessionStrategy`) is the SSOT in
 * `src/config/test-strategy.ts` — do not re-declare the set here.
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

  // Path anchors shared by both the main-rectification postValidate and the nbf postValidate.
  // Computed once here; used in both closures below to avoid duplicate async FS reads.
  // ctx.packageDir = repo root (absolute); story.workdir = relative sub-path to package.
  const packageDir = join(ctx.packageDir, story.workdir ?? "");
  const resolvedTestPatterns = await resolveTestFilePatterns(config, ctx.packageDir, story.workdir);

  // Rectification: requires both config gate and typed inputs.
  // Assemble strategies: mechanical fixes first, then full-suite (TDD), then autofix agents.
  if (shouldRunRectification(config) && inputs.rectification) {
    // One shared sink for the implementer and test-writer strategies so
    // declarations accumulate and mock handoffs are consumed by postValidate.
    const sink = makeDeclarationSink();

    const strategies: FixStrategy<Finding, unknown, unknown, unknown>[] = [];

    // Use package-merged quality config so per-package lintFix/formatFix overrides are respected.
    const pkgQuality = ctx.packageView.select(qualityConfigSelector).quality;
    if (pkgQuality?.commands?.lintFix || pkgQuality?.commands?.lintFixScoped) {
      strategies.push(makeMechanicalLintFixStrategy() as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    if (pkgQuality?.commands?.formatFix || pkgQuality?.commands?.formatFixScoped) {
      strategies.push(makeMechanicalFormatFixStrategy() as FixStrategy<Finding, unknown, unknown, unknown>);
    }
    // full-suite-rectify is the ONLY strategy whose appliesTo matches
    // `source: "test-runner"` failing-test findings (category failed-test /
    // execution-failed). Load it whenever a phase can emit such a finding:
    //   - the full-suite gate (TDD always; non-TDD only when mode=per-story), OR
    //   - the scoped verify phase (single-session: tdd-simple / test-after / no-test).
    // Without the verify-scoped arm, a single-session scoped test failure had no
    // matching strategy, so the rectification cycle exited "no-strategy" at
    // iteration 0 and the story failed without a single fix attempt.
    const fullSuiteGatePhasePresent =
      Boolean(inputs.fullSuiteGate) && (isThreeSession || regressionMode === "per-story");
    const verifyScopedPhasePresent = !isThreeSession && Boolean(inputs.verifyScoped);
    if (fullSuiteGatePhasePresent || verifyScopedPhasePresent) {
      strategies.push(
        makeFullSuiteRectifyStrategy(story, config, sink) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
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

  // ADR-024 — non-blocking best-effort fix: config + scope-aware strategy set.
  // Only built when the adversarial review slot is present and the feature is enabled.
  const nbf = config.review?.adversarial?.nonBlockingFix;
  const nbStrategies: FixStrategy<Finding, unknown, unknown, unknown>[] = [];
  if (nbf?.enabled && inputs.adversarialReview) {
    const nbSink = makeDeclarationSink();

    // The non-blocking fix is seeded exclusively with advisory findings BELOW the
    // run's blocking threshold (adversarial.ts advisory filter). The rectifier
    // prompt builder filters by the same threshold, so without an explicit floor
    // every seeded finding is stripped back out and the agent gets an empty
    // findings list (then stalls asking the human for them). Pin the floor to
    // "info" so all advisory findings render. Blocking-cycle strategies above
    // are unaffected — they don't pass this option.
    if (!isThreeSession) {
      // Single-session strategies (tdd-simple / test-after / no-test) have no
      // separate test-writer session — the one warm implementer session authored
      // both source and tests. Route ALL advisory adversarial findings to that
      // implementer regardless of nbf.scope, instead of resuming a cold,
      // context-less test-writer session (which the three-session "both"/"triage"
      // scopes below do). Mirrors the main rectification's single-session carve-out
      // (`includeAdversarialReview: !isThreeSession`, test-writer gated on
      // isThreeSession). Without this, a single-session story's non-blocking fix
      // dispatched an `autofix-test-writer` strategy that woke a stale test-writer
      // session (#1276 follow-up: US-003 in the 2026-06-23 run log).
      nbStrategies.push(
        makeAutofixImplementerStrategy(story, config, nbSink, {
          includeAdversarialReview: true,
          promptSeverityFloor: "info",
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
    } else if (nbf.scope === "source") {
      // implementer claims adversarial findings in SOURCE scope (both session modes)
      nbStrategies.push(
        makeAutofixImplementerStrategy(story, config, nbSink, {
          includeAdversarialReview: true,
          promptSeverityFloor: "info",
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
    } else if (nbf.scope === "triage") {
      // triage scope: route by fixTarget — implementer owns source-targeted adversarial,
      // test-writer owns test-targeted adversarial; blanket clause disabled to prevent overlap.
      nbStrategies.push(
        makeAutofixImplementerStrategy(story, config, nbSink, {
          adversarialReviewByFixTarget: "source",
          promptSeverityFloor: "info",
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
        makeAutofixTestWriterStrategy(story, config, nbSink, {
          includeAdversarialReview: false,
          promptSeverityFloor: "info",
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
    } else {
      // "both" scope (default): implementer handles regression/source findings; test-writer owns adversarial
      nbStrategies.push(
        makeAutofixImplementerStrategy(story, config, nbSink, {
          includeAdversarialReview: false,
          promptSeverityFloor: "info",
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
        makeAutofixTestWriterStrategy(story, config, nbSink, {
          promptSeverityFloor: "info",
        }) as FixStrategy<Finding, unknown, unknown, unknown>,
      );
    }
    // Always: recover from a test regression that the best-effort fix introduces.
    // No `promptSeverityFloor` here on purpose: this strategy only claims
    // `source: "test-runner"` regression findings (never advisory adversarial
    // findings), and its prompt renders failing tests without a severity filter,
    // so a floor would be inert.
    nbStrategies.push(
      makeFullSuiteRectifyStrategy(story, config, nbSink) as FixStrategy<Finding, unknown, unknown, unknown>,
    );

    // Mirror the main rectification postValidate but bound to nbSink (#1227).
    const nbPostValidate = async (findings: Finding[], _validateCtx: FixCycleContext): Promise<Finding[]> => {
      if (nbSink.testEdits.length === 0 && nbSink.mockHandoffs.length === 0) return findings;

      const pendingMock: TestEditDeclaration[] = nbSink.mockHandoffs.map((h) => ({
        reason: "mock_structure" as const,
        file: h.files[0] ?? "",
        files: h.files,
        reasonDetail: h.reasonDetail,
      }));

      const { valid, invalid } = await validateMockStructureFiles(pendingMock, resolvedTestPatterns, packageDir);

      nbSink.mockHandoffs = valid.map((d) => ({ files: d.files ?? [], reasonDetail: d.reasonDetail ?? "" }));

      const allDeclarations = [...nbSink.testEdits, ...valid];
      nbSink.testEdits = [];

      return applyTestEditDeclarations(findings, allDeclarations, story, invalid);
    };

    builder.addNonBlockingFix(nbf, nbStrategies, nbPostValidate);
  }

  return builder.build(ctx, { isThreeSession });
}
