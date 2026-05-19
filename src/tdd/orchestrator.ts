/** Three-Session TDD Orchestrator */

import { resolveDefaultAgent } from "../agents";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { isGreenfieldStory } from "../context/greenfield";
import { StoryOrchestratorBuilder } from "../execution/story-orchestrator";
import type { ExecutionPlan } from "../execution/story-orchestrator";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import { getLogger } from "../logger";
import type { CallContext, RunOperation } from "../operations";
import { implementerOp, testWriterOp, verifierOp } from "../operations";
import { createRuntime } from "../runtime";
import { isTestFile } from "../test-runners";
import { resolveTestFilePatterns } from "../test-runners/resolver";
import { errorMessage } from "../utils/errors";
import { captureGitRef } from "../utils/git";
import { executeWithTimeout } from "../verification";
import { runFullSuiteGate } from "./rectification-gate";
import { assembleTddSessionResult } from "./session-op";
import { rollbackToRef, truncateTestOutput } from "./session-runner";
import type {
  FailureCategory,
  ThreeSessionTddResult as StoryRunResult,
  TddSessionResult,
  TddSessionRole,
  ThreeSessionTddOptions,
} from "./types";
import { sumTddTokenUsage } from "./types";
import { categorizeVerdict, cleanupVerdict, readVerdict } from "./verdict";

export type { ThreeSessionTddOptions };

async function rollbackTddFailureIfNeeded(
  shouldRollback: boolean,
  workdir: string,
  initialRef: string,
  storyId: string,
  failureCategory: FailureCategory | undefined,
): Promise<void> {
  if (!shouldRollback) {
    return;
  }
  const logger = getLogger();
  try {
    await rollbackToRef(workdir, initialRef);
    logger.info("tdd", "Rolled back git changes due to TDD failure", {
      storyId,
      failureCategory,
    });
  } catch (error) {
    logger.error("tdd", "Failed to rollback git changes after TDD failure", {
      storyId,
      error: errorMessage(error),
    });
  }
}

/**
 * Run a single TDD phase via StoryOrchestratorBuilder (AC9).
 * Subscribes to dispatch events around the plan run to capture tokenUsage and
 * capturedResponse. Post-dispatch: autoCommitIfDirty, isolation, selfVerification.
 * AC10 responsibilities (rollback, verdict, greenfield, full-suite gate) stay in
 * runThreeSessionTdd.
 */
async function runTddSessionViaBuilder<I, O, C>(
  role: TddSessionRole,
  ctx: CallContext,
  op: RunOperation<I, O, C>,
  input: I,
  beforeRef: string,
  opts: {
    story: import("../prd").UserStory;
    workdir: string;
    config: NaxConfig;
    lite: boolean;
  },
): Promise<TddSessionResult> {
  const { runtime } = ctx;
  // Cost precedence: planResult.phaseCosts is authoritative (scoped via
  // costAggregator.openScope() inside the orchestrator). This unscoped
  // dispatchEvents subscription captures response/tokenUsage for the TDD
  // result envelope; capturedCostUsd is a best-effort fallback only.
  let capturedTokenUsage: import("../agents/cost").TokenUsage | undefined;
  let capturedResponse = "";
  let capturedCostUsd = 0;
  const startTime = Date.now();

  const unsubscribe =
    runtime.dispatchEvents?.onDispatch((event) => {
      if (event.tokenUsage) capturedTokenUsage = event.tokenUsage;
      if (event.response) capturedResponse = event.response;
      if (event.exactCostUsd !== undefined) capturedCostUsd += event.exactCostUsd;
      else if (event.estimatedCostUsd !== undefined) capturedCostUsd += event.estimatedCostUsd;
    }) ?? (() => {});

  type PhaseShape = {
    success: boolean;
    filesChanged: readonly string[];
    estimatedCostUsd: number;
    durationMs: number;
    isolation?: import("./types").IsolationCheck;
  };
  let phaseOutput: PhaseShape | undefined;
  let opCostUsd = 0;
  let planDurationMs = 0;

  try {
    const plan: ExecutionPlan = new StoryOrchestratorBuilder().addImplementer({ op, input }).build(ctx);
    const planResult = await plan.run();
    phaseOutput = planResult.phaseOutputs[op.name] as PhaseShape | undefined;
    opCostUsd = planResult.phaseCosts[op.name] ?? 0;
    planDurationMs = planResult.durationMs;
  } finally {
    unsubscribe();
  }

  // Synthesise an empty envelope when the plan returned no parsed output for
  // this op (e.g. callOp recover paths returned null).
  const opOutput: PhaseShape = phaseOutput ?? {
    success: false,
    filesChanged: [],
    estimatedCostUsd: 0,
    durationMs: 0,
  };

  return assembleTddSessionResult({
    role,
    story: opts.story,
    workdir: opts.workdir,
    config: opts.config,
    beforeRef,
    lite: opts.lite,
    opOutput,
    capturedResponse,
    ...(capturedTokenUsage ? { capturedTokenUsage } : {}),
    capturedCostUsd: capturedCostUsd || opCostUsd,
    startTime,
    planDurationMs,
  });
}

/**
 * Run the full three-session TDD pipeline for a user story.
 */
export async function runThreeSessionTdd(options: ThreeSessionTddOptions): Promise<StoryRunResult> {
  const {
    agent: _agent,
    story,
    config,
    workdir,
    modelTier,
    featureName,
    tddContextBundles: _tddContextBundles,
    getTddContextBundle,
    recordTddSessionOutcome,
    getTddSessionBinding,
    dryRun = false,
    lite = false,
    _recursionDepth = 0,
    projectDir,
    agentManager,
  } = options;
  const logger = getLogger();

  // Defensive runtime default: the type contract requires `runtime`, but TS
  // doesn't typecheck test files (tsconfig excludes `test/`), so integration
  // tests that omit it still need to work. Production callers always pass it
  // and the `??` is a no-op. When synthesised here, each invocation gets its
  // own isolated dispatchEvents bus and cost aggregator.
  const runtime =
    (options.runtime as import("../runtime").NaxRuntime | undefined) ??
    createRuntime(config, workdir, { agentManager });

  // MED-7: Recursion guard to prevent infinite loops
  const MAX_RECURSION_DEPTH = 2;
  if (_recursionDepth >= MAX_RECURSION_DEPTH) {
    logger.error("tdd", "Recursion depth limit reached", {
      storyId: story.id,
      depth: _recursionDepth,
      maxDepth: MAX_RECURSION_DEPTH,
    });
    return {
      success: false,
      sessions: [],
      needsHumanReview: true,
      reviewReason: "Recursion depth limit exceeded (max 2 fallbacks)",
      failureCategory: "session-failure",
      totalCost: 0,
      lite,
    };
  }

  logger.info("tdd", "Three-Session TDD", {
    storyId: story?.id,
    title: story?.title,
    lite,
    recursionDepth: _recursionDepth,
  });

  // Dry-run mode
  if (dryRun) {
    const { model } = resolveModelForAgent(
      config.models,
      story.routing?.agent ?? resolveDefaultAgent(config),
      modelTier,
      resolveDefaultAgent(config),
    );
    logger.info("tdd", "[DRY RUN] Would run 3-session TDD", {
      storyId: story.id,
      lite,
      session1: { role: "test-writer", model },
      session2: { role: "implementer", model },
      session3: { role: "verifier", model },
    });

    return {
      success: true,
      sessions: [],
      needsHumanReview: false,
      totalCost: 0,
      lite,
    };
  }

  // Base CallContext for builder dispatch (AC9). The builder stamps its own
  // scopeId on each phase; we omit scopeId here so the builder controls it.
  const packageView = runtime.packages.resolve(workdir);
  const agentNameForCtx = resolveDefaultAgent(runtime.configLoader.current());
  const baseCallCtx: CallContext = {
    runtime,
    packageView,
    packageDir: workdir,
    agentName: agentNameForCtx,
    storyId: story.id,
    featureName,
    story,
  };

  // interactionBridge for test-writer and implementer (verifier omits it).
  const sessionInteractionBridge = options.interactionChain
    ? buildInteractionBridge(options.interactionChain, { featureName, storyId: story.id, stage: "execution" })
    : undefined;
  const ctxWithBridge: CallContext = sessionInteractionBridge
    ? { ...baseCallCtx, interactionBridge: sessionInteractionBridge }
    : baseCallCtx;

  const sessions: TddSessionResult[] = [];
  let needsHumanReview = false;
  let reviewReason: string | undefined;

  const initialRef = (await captureGitRef(workdir)) ?? "HEAD";
  const shouldRollbackOnFailure = config.tdd.rollbackOnFailure ?? true;

  // Session 1: Test Writer
  // @design: BUG-018 / #410: Skip on retry (tests already exist) or review-stage escalation
  // (tests already passed). stage="review" is set by buildEscalationFailure when
  // reviewFindings are present (covers both review and autofix exhaustion).
  const hasReviewEscalation = (story.priorFailures ?? []).some((f) => f.stage === "review");
  const isRetry = (story.attempts ?? 0) > 0 || hasReviewEscalation;

  if (isRetry) {
    const skipReason =
      (story.attempts ?? 0) > 0
        ? "attempt > 0, tests already exist"
        : "escalation from review stage, tests already passed";
    logger.info("tdd", "Skipping test-writer on retry", {
      storyId: story.id,
      attempt: story.attempts,
      reason: skipReason,
    });
  }

  let session1: TddSessionResult | undefined;

  if (!isRetry) {
    // v2 bundles passed to getTddContextBundle but session op ignores bundle context;
    // keep the call so recordTddSessionOutcome triggers v2 digest writes.
    await getTddContextBundle?.("test-writer");

    session1 = await runTddSessionViaBuilder(
      "test-writer",
      ctxWithBridge,
      testWriterOp,
      {
        story,
        ...(options.contextMarkdown ? { contextMarkdown: options.contextMarkdown } : {}),
        ...(options.featureContextMarkdown ? { featureContextMarkdown: options.featureContextMarkdown } : {}),
        ...(options.constitution ? { constitution: options.constitution } : {}),
      },
      initialRef,
      { story, workdir, config, lite },
    );
    sessions.push(session1);
    await recordTddSessionOutcome?.(session1);
  }

  if (session1 && !session1.success) {
    needsHumanReview = true;
    reviewReason = "Test writer session failed or violated isolation";
    const failureCategory: FailureCategory =
      session1.isolation && !session1.isolation.passed ? "isolation-violation" : "session-failure";
    logger.warn("tdd", "[WARN] Test writer session failed", { storyId: story.id, reviewReason, failureCategory });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      failureCategory,
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
      lite,
    };
  }

  // @design: BUG-20 Fix: Verify test-writer created test files (isTestFile is language-agnostic).
  // ADR-009: pass user-configured testFilePatterns; undefined → broad regex fallback.
  const _tddTestFilePatterns =
    typeof config.execution?.smartTestRunner === "object" && config.execution.smartTestRunner !== null
      ? config.execution.smartTestRunner.testFilePatterns
      : undefined;
  const testFilesCreated = session1 ? session1.filesChanged.filter((f) => isTestFile(f, _tddTestFilePatterns)) : [];

  if (!isRetry && testFilesCreated.length === 0) {
    // @design: BUG-012 Fix: Before declaring greenfield, check if test files already exist in the repo.
    // The test-writer may have produced 0 new files because tests were pre-written and committed
    // separately (e.g. during dogfooding or manual setup). If tests already exist, skip
    // test-writer phase and proceed directly to the implementer.
    // Resolve effective test patterns via SSOT (ADR-009) — replaces deprecated testPattern read.
    const resolvedForGreenfield = await resolveTestFilePatterns(config, workdir);

    // Scan directly for existing test files — don't use isGreenfieldStory() here because its
    // "safe fallback" returns false (not greenfield) on scan errors, which would incorrectly
    // allow proceeding to the implementer when the workdir is unreadable.
    let hasPreExistingTests = false;
    try {
      // isGreenfieldStory returns true when NO tests exist; we want the inverse
      hasPreExistingTests = !(await isGreenfieldStory(story, workdir, resolvedForGreenfield.globs));
      // Sanity check: if workdir doesn't exist, isGreenfieldStory returns false (safe fallback),
      // meaning hasPreExistingTests = true — wrong. Validate by checking if workdir is readable.
      const dirCheck = Bun.spawn(["test", "-d", workdir], { stdout: "pipe", stderr: "pipe" });
      if ((await dirCheck.exited) !== 0) {
        hasPreExistingTests = false;
      }
    } catch {
      hasPreExistingTests = false;
    }

    if (hasPreExistingTests) {
      // Tests exist in repo — test-writer correctly produced no new files.
      // Skip the pause, proceed to implementer.
      logger.info(
        "tdd",
        "Test writer created no new files but tests already exist in repo — skipping test-writer, proceeding to implementer (BUG-012 fix)",
        {
          storyId: story.id,
        },
      );
    } else {
      // Genuinely greenfield — no tests anywhere. Pause for human review.
      needsHumanReview = true;
      reviewReason = "Test writer session created no test files (greenfield project)";
      logger.warn("tdd", "[WARN] Test writer created no test files - greenfield detected", {
        storyId: story.id,
        reviewReason,
        filesChanged: session1?.filesChanged,
      });

      return {
        success: false,
        sessions,
        needsHumanReview,
        reviewReason,
        failureCategory: "greenfield-no-tests",
        totalCost: sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
        lite,
      };
    }
  }

  logger.info("tdd", "Created test files", {
    storyId: story.id,
    testFilesCount: testFilesCreated.length,
    testFiles: testFilesCreated,
  });

  const session2Ref = (await captureGitRef(workdir)) ?? "HEAD";

  // Session 2: Implementer
  const implementerTier = config.tdd.sessionTiers?.implementer ?? modelTier;
  await getTddContextBundle?.("implementer");

  const session2 = await runTddSessionViaBuilder(
    "implementer",
    ctxWithBridge,
    implementerOp,
    {
      story,
      ...(options.contextMarkdown ? { contextMarkdown: options.contextMarkdown } : {}),
      ...(options.featureContextMarkdown ? { featureContextMarkdown: options.featureContextMarkdown } : {}),
      ...(options.constitution ? { constitution: options.constitution } : {}),
    },
    session2Ref,
    { story, workdir, config, lite },
  );
  sessions.push(session2);
  await recordTddSessionOutcome?.(session2);

  if (!session2.success) {
    needsHumanReview = true;
    reviewReason = "Implementer session failed or violated isolation";
    logger.warn("tdd", "[WARN] Implementer session failed", { storyId: story.id, reviewReason });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      failureCategory: "session-failure",
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
      lite,
    };
  }

  // Full-Suite Gate (v0.11 Rectification).
  // Baseline must be green entering the run; the gate treats any post-implementer
  // failure as story-caused (the file-modification filter from BUG-TC-001 was
  // removed — see rectification-gate.ts header for the rationale).
  const implementerBinding = getTddSessionBinding?.("implementer");
  const fullSuiteGate = await runFullSuiteGate(
    story,
    config,
    workdir,
    agentManager,
    implementerTier,
    lite,
    logger,
    featureName,
    projectDir,
    implementerBinding?.sessionManager,
    runtime,
  );
  const { cost: fullSuiteGateCost, fullSuiteGatePassed } = fullSuiteGate;

  if (fullSuiteGate.status === "rectification-exhausted") {
    const failureCategory: FailureCategory = "full-suite-gate-exhausted";
    const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0) + fullSuiteGateCost;
    const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    const totalTokenUsage = sumTddTokenUsage(sessions);
    const terminalReviewReason = "Full suite gate failed after rectification exhausted";
    logger.warn("tdd", "Stopping before verifier because full-suite gate rectification exhausted", {
      storyId: story.id,
      attempts: fullSuiteGate.attempts,
      failureCategory,
    });
    await rollbackTddFailureIfNeeded(shouldRollbackOnFailure, workdir, initialRef, story.id, failureCategory);
    return {
      success: false,
      sessions,
      needsHumanReview: true,
      reviewReason: terminalReviewReason,
      failureCategory,
      totalCost,
      totalDurationMs,
      ...(totalTokenUsage && { totalTokenUsage }),
      lite,
      fullSuiteGatePassed,
    };
  }

  // Session 3: Verifier
  const session3Ref = (await captureGitRef(workdir)) ?? "HEAD";
  await getTddContextBundle?.("verifier");

  const session3 = await runTddSessionViaBuilder("verifier", baseCallCtx, verifierOp, { story }, session3Ref, {
    story,
    workdir,
    config,
    lite,
  });
  sessions.push(session3);
  await recordTddSessionOutcome?.(session3);

  // T9: Verdict-based post-TDD verification
  const verdict = await readVerdict(workdir);
  await cleanupVerdict(workdir);

  let allSuccessful = sessions.every((s) => s.success);
  let finalFailureCategory: FailureCategory | undefined;

  if (verdict !== null) {
    const categorization = categorizeVerdict(verdict, verdict.tests.allPassing);

    if (categorization.success) {
      logger.info("tdd", "[OK] Verifier verdict: accepted", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        testsAllPassing: verdict.tests.allPassing,
      });
      allSuccessful = true;
      needsHumanReview = false;
      reviewReason = undefined;
    } else {
      logger.warn("tdd", "[WARN] Verifier verdict: rejected", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        failureCategory: categorization.failureCategory,
        reviewReason: categorization.reviewReason,
      });
      allSuccessful = false;
      finalFailureCategory = categorization.failureCategory;
      needsHumanReview = true;
      reviewReason = categorization.reviewReason;
    }
  } else {
    // Fallback path: no verdict file
    if (!allSuccessful) {
      logger.info("tdd", "-> Running post-TDD test verification (no verdict file)", { storyId: story.id });

      const testCmd = config.quality?.commands?.test ?? "bun test";
      const timeoutSeconds = 120;

      const postVerify = await executeWithTimeout(testCmd, timeoutSeconds, undefined, { cwd: workdir });
      const testsActuallyPass = postVerify.success && postVerify.exitCode === 0;

      const truncatedStdout = postVerify.output ? truncateTestOutput(postVerify.output) : "";
      const truncatedStderr = postVerify.error ? truncateTestOutput(postVerify.error) : "";

      if (testsActuallyPass) {
        logger.info("tdd", "Sessions had non-zero exits but tests pass - treating as success", {
          storyId: story.id,
          stdout: truncatedStdout,
        });
        allSuccessful = true;
        needsHumanReview = false;
        reviewReason = undefined;
      } else {
        logger.warn("tdd", "[WARN] Post-TDD verification: tests still failing", {
          storyId: story.id,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
        });
        needsHumanReview = true;
        reviewReason = "Verifier session identified issues and tests still fail";
        finalFailureCategory = "tests-failing";
      }
    } else {
      needsHumanReview = false;
    }
  }

  const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0) + fullSuiteGateCost;
  const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  // #590: sum tokenUsage across all sessions so metrics.tracker emits a tokens block
  // for TDD runs the same way single-session runs do.
  const totalTokenUsage = sumTddTokenUsage(sessions);

  logger.info("tdd", allSuccessful ? "[OK] Three-session TDD complete" : "[WARN] Three-session TDD needs review", {
    storyId: story.id,
    success: allSuccessful,
    totalCost,
    needsHumanReview,
    reviewReason,
    lite,
    verdictAvailable: verdict !== null,
  });

  // Rollback git changes if TDD failed
  await rollbackTddFailureIfNeeded(
    shouldRollbackOnFailure && !allSuccessful,
    workdir,
    initialRef,
    story.id,
    finalFailureCategory,
  );

  return {
    success: allSuccessful,
    sessions,
    needsHumanReview,
    reviewReason,
    ...(finalFailureCategory !== undefined ? { failureCategory: finalFailureCategory } : {}),
    verdict,
    totalCost,
    totalDurationMs,
    ...(totalTokenUsage && { totalTokenUsage }),
    lite,
    fullSuiteGatePassed,
  };
}
