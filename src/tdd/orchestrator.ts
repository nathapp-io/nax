/** Three-Session TDD Orchestrator */

import { resolveDefaultAgent } from "../agents";
import { resolveModelForAgent } from "../config";
import { isGreenfieldStory } from "../context/greenfield";
import { getLogger } from "../logger";
import { isTestFile } from "../test-runners";
import { resolveTestFilePatterns } from "../test-runners/resolver";
import { errorMessage } from "../utils/errors";
import { captureGitRef } from "../utils/git";
import { executeWithTimeout } from "../verification";
import { runFullSuiteGate } from "./rectification-gate";
import { implementTddOp, runTddSessionOp, verifyTddOp, writeTddTestOp } from "./session-op";
import { rollbackToRef, truncateTestOutput } from "./session-runner";
import type { FailureCategory, TddSessionResult, ThreeSessionTddOptions, ThreeSessionTddResult } from "./types";
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
 * Run the full three-session TDD pipeline for a user story.
 */
export async function runThreeSessionTdd(options: ThreeSessionTddOptions): Promise<ThreeSessionTddResult> {
  const {
    agent,
    story,
    config,
    workdir,
    modelTier,
    featureName,
    tddContextBundles,
    getTddContextBundle,
    recordTddSessionOutcome,
    getTddSessionBinding,
    dryRun = false,
    lite = false,
    _recursionDepth = 0,
    projectDir,
    agentManager,
    runtime,
  } = options;
  const logger = getLogger();

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
    const testWriterBundle = (await getTddContextBundle?.("test-writer")) ?? tddContextBundles?.testWriter;
    session1 = await runTddSessionOp(
      writeTddTestOp,
      options,
      initialRef,
      testWriterBundle,
      getTddSessionBinding?.("test-writer"),
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
  const implementerBundle = (await getTddContextBundle?.("implementer")) ?? tddContextBundles?.implementer;
  const session2 = await runTddSessionOp(
    implementTddOp,
    options,
    session2Ref,
    implementerBundle,
    getTddSessionBinding?.("implementer"),
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
    implementerBinding?.sessionId,
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
  const verifierBundle = (await getTddContextBundle?.("verifier")) ?? tddContextBundles?.verifier;
  const session3 = await runTddSessionOp(
    verifyTddOp,
    options,
    session3Ref,
    verifierBundle,
    getTddSessionBinding?.("verifier"),
  );
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
