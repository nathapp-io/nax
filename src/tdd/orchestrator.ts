/**
 * Three-Session TDD Orchestrator
 *
 * Orchestrates the three-session TDD pipeline:
 * 1. Session 1 (test-writer): Write tests only
 * 2. Session 2 (implementer): Implement code to pass tests
 * 3. Session 3 (verifier): Verify tests pass and changes are legitimate
 */

import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModel } from "../config";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { captureGitRef } from "../utils/git";
import { executeWithTimeout } from "../verification";
import { runFullSuiteGate } from "./rectification-gate";
import { rollbackToRef, runTddSession, truncateTestOutput } from "./session-runner";
import type { FailureCategory, TddSessionResult, ThreeSessionTddResult } from "./types";
import { categorizeVerdict, cleanupVerdict, readVerdict } from "./verdict";

/** Options for three-session TDD */
export interface ThreeSessionTddOptions {
  agent: AgentAdapter;
  story: UserStory;
  config: NaxConfig;
  workdir: string;
  modelTier: ModelTier;
  contextMarkdown?: string;
  dryRun?: boolean;
  lite?: boolean;
  _recursionDepth?: number;
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
    contextMarkdown,
    dryRun = false,
    lite = false,
    _recursionDepth = 0,
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
    const modelDef = resolveModel(config.models[modelTier]);
    logger.info("tdd", "[DRY RUN] Would run 3-session TDD", {
      storyId: story.id,
      lite,
      session1: { role: "test-writer", model: modelDef.model },
      session2: { role: "implementer", model: modelDef.model },
      session3: { role: "verifier", model: modelDef.model },
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
  const session1Ref = initialRef;
  const testWriterTier = config.tdd.sessionTiers?.testWriter ?? "balanced";
  const session1 = await runTddSession(
    "test-writer",
    agent,
    story,
    config,
    workdir,
    testWriterTier,
    session1Ref,
    contextMarkdown,
    lite,
    lite,
  );
  sessions.push(session1);

  if (!session1.success) {
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
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  // BUG-20 Fix: Verify that test-writer session actually created test files
  const testFilePatterns = /\.(test|spec)\.(ts|js|tsx|jsx)$/;
  const testFilesCreated = session1.filesChanged.filter((f) => testFilePatterns.test(f));

  if (testFilesCreated.length === 0) {
    needsHumanReview = true;
    reviewReason = "Test writer session created no test files (greenfield project)";
    logger.warn("tdd", "[WARN] Test writer created no test files - greenfield detected", {
      storyId: story.id,
      reviewReason,
      filesChanged: session1.filesChanged,
    });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      failureCategory: "greenfield-no-tests",
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  logger.info("tdd", "Created test files", {
    storyId: story.id,
    testFilesCount: testFilesCreated.length,
    testFiles: testFilesCreated,
  });

  const session2Ref = (await captureGitRef(workdir)) ?? "HEAD";

  // Session 2: Implementer
  const implementerTier = config.tdd.sessionTiers?.implementer ?? modelTier;
  const session2 = await runTddSession(
    "implementer",
    agent,
    story,
    config,
    workdir,
    implementerTier,
    session2Ref,
    contextMarkdown,
    lite,
    lite,
  );
  sessions.push(session2);

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
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  // Full-Suite Gate (v0.11 Rectification)
  await runFullSuiteGate(story, config, workdir, agent, implementerTier, contextMarkdown, lite, logger);

  // Session 3: Verifier
  const session3Ref = (await captureGitRef(workdir)) ?? "HEAD";
  const verifierTier = config.tdd.sessionTiers?.verifier ?? "fast";
  const session3 = await runTddSession(
    "verifier",
    agent,
    story,
    config,
    workdir,
    verifierTier,
    session3Ref,
    undefined,
    false,
    false,
  );
  sessions.push(session3);

  // T9: Verdict-based post-TDD verification
  const verdict = await readVerdict(workdir);
  await cleanupVerdict(workdir);

  let allSuccessful = sessions.every((s) => s.success);
  let finalFailureCategory: FailureCategory | undefined;

  if (verdict !== null) {
    const categorization = categorizeVerdict(verdict, verdict.tests.allPassing);

    if (categorization.success) {
      logger.info("tdd", "[OK] Verifier verdict: approved", {
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

  const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCost, 0);

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
  if (!allSuccessful && shouldRollbackOnFailure) {
    try {
      await rollbackToRef(workdir, initialRef);
      logger.info("tdd", "Rolled back git changes due to TDD failure", {
        storyId: story.id,
        failureCategory: finalFailureCategory,
      });
    } catch (error) {
      logger.error("tdd", "Failed to rollback git changes after TDD failure", {
        storyId: story.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    success: allSuccessful,
    sessions,
    needsHumanReview,
    reviewReason,
    ...(finalFailureCategory !== undefined ? { failureCategory: finalFailureCategory } : {}),
    verdict,
    totalCost,
    lite,
  };
}
