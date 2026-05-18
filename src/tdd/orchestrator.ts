/** Three-Session TDD Orchestrator */

import { resolveDefaultAgent } from "../agents";
import { createConfigLoader, resolveModelForAgent } from "../config";
import { isGreenfieldStory } from "../context/greenfield";
import { StoryOrchestratorBuilder } from "../execution/story-orchestrator";
import type { ExecutionPlan } from "../execution/story-orchestrator";
import { getLogger } from "../logger";
import type { RunOperation } from "../operations";
import { implementTddOp, verifyTddOp, writeTddTestOp } from "../operations";
import { isTestFile } from "../test-runners";
import { resolveTestFilePatterns } from "../test-runners/resolver";
import { errorMessage } from "../utils/errors";
import { captureGitRef } from "../utils/git";
import { executeWithTimeout } from "../verification";
import { runFullSuiteGate } from "./rectification-gate";
import { runTddSessionOp } from "./session-op";
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
  const implementerTier = config.tdd.sessionTiers?.implementer ?? modelTier;

  // @design: BUG-018 / #410: Skip on retry (tests already exist) or review-stage escalation
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

  // Shared mutable state captured across builder slot runners
  const sharedState: {
    session1: TddSessionResult | undefined;
    session2: TddSessionResult | undefined;
    session3: TddSessionResult | undefined;
    earlyExitResult: ThreeSessionTddResult | undefined;
    fullSuiteGatePassed: boolean;
    fullSuiteGateCost: number;
  } = {
    session1: undefined,
    session2: undefined,
    session3: undefined,
    earlyExitResult: undefined,
    fullSuiteGatePassed: false,
    fullSuiteGateCost: 0,
  };

  // Build execution plan using StoryOrchestratorBuilder for phase sequencing
  const builder = new StoryOrchestratorBuilder();

  // Test-writer slot (skipped on retry)
  if (!isRetry) {
    builder.addTestWriter({
      op: writeTddTestOp as unknown as RunOperation<unknown, unknown, unknown>,
      input: {},
      runner: async (_ctx) => {
        const testWriterBundle = (await getTddContextBundle?.("test-writer")) ?? tddContextBundles?.testWriter;
        const session1 = await runTddSessionOp(
          writeTddTestOp,
          options,
          initialRef,
          testWriterBundle,
          getTddSessionBinding?.("test-writer"),
        );
        sharedState.session1 = session1;
        sessions.push(session1);
        await recordTddSessionOutcome?.(session1);

        if (!session1.success) {
          needsHumanReview = true;
          reviewReason = "Test writer session failed or violated isolation";
          const failureCategory: FailureCategory =
            session1.isolation && !session1.isolation.passed ? "isolation-violation" : "session-failure";
          logger.warn("tdd", "[WARN] Test writer session failed", { storyId: story.id, reviewReason, failureCategory });
          sharedState.earlyExitResult = {
            success: false,
            sessions,
            needsHumanReview,
            reviewReason,
            failureCategory,
            totalCost: sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
            lite,
          };
          throw new Error("test-writer failed");
        }

        // @design: BUG-20 Fix: Verify test-writer created test files
        const _tddTestFilePatterns =
          typeof config.execution?.smartTestRunner === "object" && config.execution.smartTestRunner !== null
            ? config.execution.smartTestRunner.testFilePatterns
            : undefined;
        const testFilesCreated = session1.filesChanged.filter((f) => isTestFile(f, _tddTestFilePatterns));

        if (testFilesCreated.length === 0) {
          // @design: BUG-012 Fix: Check if test files already exist before declaring greenfield
          const resolvedForGreenfield = await resolveTestFilePatterns(config, workdir);
          let hasPreExistingTests = false;
          try {
            hasPreExistingTests = !(await isGreenfieldStory(story, workdir, resolvedForGreenfield.globs));
            const dirCheck = Bun.spawn(["test", "-d", workdir], { stdout: "pipe", stderr: "pipe" });
            if ((await dirCheck.exited) !== 0) {
              hasPreExistingTests = false;
            }
          } catch {
            hasPreExistingTests = false;
          }

          if (hasPreExistingTests) {
            logger.info(
              "tdd",
              "Test writer created no new files but tests already exist in repo — skipping test-writer, proceeding to implementer (BUG-012 fix)",
              { storyId: story.id },
            );
          } else {
            needsHumanReview = true;
            reviewReason = "Test writer session created no test files (greenfield project)";
            logger.warn("tdd", "[WARN] Test writer created no test files - greenfield detected", {
              storyId: story.id,
              reviewReason,
              filesChanged: session1.filesChanged,
            });
            sharedState.earlyExitResult = {
              success: false,
              sessions,
              needsHumanReview,
              reviewReason,
              failureCategory: "greenfield-no-tests",
              totalCost: sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
              lite,
            };
            throw new Error("greenfield no tests");
          }
        }

        logger.info("tdd", "Created test files", {
          storyId: story.id,
          testFilesCount: testFilesCreated.length,
          testFiles: testFilesCreated,
        });

        return { output: session1, costUsd: session1.estimatedCostUsd };
      },
    });
  }

  // Implementer slot
  builder.addImplementer({
    op: implementTddOp as unknown as RunOperation<unknown, unknown, unknown>,
    input: {},
    runner: async (_ctx) => {
      if (sharedState.earlyExitResult) throw new Error("early exit");

      const session2Ref = (await captureGitRef(workdir)) ?? "HEAD";
      const implementerBundle = (await getTddContextBundle?.("implementer")) ?? tddContextBundles?.implementer;
      const session2 = await runTddSessionOp(
        implementTddOp,
        options,
        session2Ref,
        implementerBundle,
        getTddSessionBinding?.("implementer"),
      );
      sharedState.session2 = session2;
      sessions.push(session2);
      await recordTddSessionOutcome?.(session2);

      if (!session2.success) {
        needsHumanReview = true;
        reviewReason = "Implementer session failed or violated isolation";
        logger.warn("tdd", "[WARN] Implementer session failed", { storyId: story.id, reviewReason });
        sharedState.earlyExitResult = {
          success: false,
          sessions,
          needsHumanReview,
          reviewReason,
          failureCategory: "session-failure",
          totalCost: sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
          lite,
        };
        throw new Error("implementer failed");
      }

      return { output: session2, costUsd: session2.estimatedCostUsd };
    },
  });

  // Verifier slot — also runs the full-suite gate before the verifier session
  builder.addVerifier({
    op: verifyTddOp as unknown as RunOperation<unknown, unknown, unknown>,
    input: {},
    runner: async (_ctx) => {
      if (sharedState.earlyExitResult) throw new Error("early exit");

      // Full-Suite Gate (v0.11 Rectification) runs before the verifier session
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
      sharedState.fullSuiteGateCost = fullSuiteGate.cost;
      sharedState.fullSuiteGatePassed = fullSuiteGate.fullSuiteGatePassed;

      if (fullSuiteGate.status === "rectification-exhausted") {
        const failureCategory: FailureCategory = "full-suite-gate-exhausted";
        const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0) + fullSuiteGate.cost;
        const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
        const totalTokenUsage = sumTddTokenUsage(sessions);
        const terminalReviewReason = "Full suite gate failed after rectification exhausted";
        logger.warn("tdd", "Stopping before verifier because full-suite gate rectification exhausted", {
          storyId: story.id,
          attempts: fullSuiteGate.attempts,
          failureCategory,
        });
        sharedState.earlyExitResult = {
          success: false,
          sessions,
          needsHumanReview: true,
          reviewReason: terminalReviewReason,
          failureCategory,
          totalCost,
          totalDurationMs,
          ...(totalTokenUsage && { totalTokenUsage }),
          lite,
          fullSuiteGatePassed: sharedState.fullSuiteGatePassed,
        };
        throw new Error("full-suite gate exhausted");
      }

      const session3Ref = (await captureGitRef(workdir)) ?? "HEAD";
      const verifierBundle = (await getTddContextBundle?.("verifier")) ?? tddContextBundles?.verifier;
      const session3 = await runTddSessionOp(
        verifyTddOp,
        options,
        session3Ref,
        verifierBundle,
        getTddSessionBinding?.("verifier"),
      );
      sharedState.session3 = session3;
      sessions.push(session3);
      await recordTddSessionOutcome?.(session3);

      return { output: session3, costUsd: session3.estimatedCostUsd + sharedState.fullSuiteGateCost };
    },
  });

  // Construct CallContext for the builder
  const callCtx = {
    runtime:
      (runtime as import("../runtime").NaxRuntime | undefined) ??
      ({
        configLoader: createConfigLoader(config),
        agentManager,
        sessionManager: {} as import("../session/types").ISessionManager,
        projectDir: projectDir ?? workdir,
        signal: new AbortController().signal,
      } as import("../runtime").NaxRuntime),
    packageView: (runtime as import("../runtime").NaxRuntime | undefined)?.packages?.repo() ?? {
      packageDir: workdir,
      relativeFromRoot: "",
      config,
      select<C>(selector: import("../config").ConfigSelector<C>): C {
        return selector.select(config);
      },
    },
    packageDir: workdir,
    agentName: resolveDefaultAgent(config),
  };

  const plan: ExecutionPlan = builder.build(callCtx);
  const result = await plan.run();

  // Handle early exit from any slot
  if (sharedState.earlyExitResult) {
    await rollbackTddFailureIfNeeded(
      shouldRollbackOnFailure,
      workdir,
      initialRef,
      story.id,
      sharedState.earlyExitResult.failureCategory as FailureCategory | undefined,
    );
    return sharedState.earlyExitResult;
  }

  // AC7: Read phaseOutputs["verifier"] then apply readVerdict() and categorizeVerdict()
  const verifierOutput = result.phaseOutputs.verifier as TddSessionResult | undefined;

  const verdict = await readVerdict(workdir);
  await cleanupVerdict(workdir);

  // Use verifier phase output as the primary success signal; fall back to session aggregate
  let allSuccessful = verifierOutput !== undefined ? verifierOutput.success : sessions.every((s) => s.success);
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

  const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCostUsd, 0) + sharedState.fullSuiteGateCost;
  const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  // #590: sum tokenUsage across all sessions so metrics.tracker emits a tokens block
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

  // Rollback on failure if configured
  if (!result.success && config.tdd.rollbackOnFailure) {
    await rollbackToRef(workdir, initialRef);
  } else if (!allSuccessful && shouldRollbackOnFailure) {
    await rollbackTddFailureIfNeeded(true, workdir, initialRef, story.id, finalFailureCategory);
  }

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
    fullSuiteGatePassed: sharedState.fullSuiteGatePassed,
  };
}
