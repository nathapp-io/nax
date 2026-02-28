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
import { executeWithTimeout } from "../execution/verification";
import { parseBunTestOutput } from "../execution/test-output-parser";
import { shouldRetryRectification, createRectificationPrompt, type RectificationState } from "../execution/rectification";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { captureGitRef } from "../utils/git";
import { cleanupProcessTree } from "./cleanup";
import { getChangedFiles, verifyImplementerIsolation, verifyTestWriterIsolation } from "./isolation";
import {
  buildImplementerLitePrompt,
  buildImplementerPrompt,
  buildTestWriterLitePrompt,
  buildTestWriterPrompt,
  buildVerifierPrompt,
  buildImplementerRectificationPrompt,
} from "./prompts";
import type { FailureCategory, TddSessionResult, TddSessionRole, ThreeSessionTddResult } from "./types";
import { categorizeVerdict, cleanupVerdict, readVerdict } from "./verdict";

/**
 * Truncate test output to prevent context flooding.
 * Keeps first 10 lines and last 40 lines with a separator.
 */
function truncateTestOutput(output: string, maxLines = 50): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) {
    return output;
  }

  const headLines = 10;
  const tailLines = 40;
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const truncatedCount = lines.length - headLines - tailLines;

  return `${head}\n\n... (${truncatedCount} lines truncated) ...\n\n${tail}`;
}

/**
 * Rollback git changes to a specific ref.
 * Used when TDD fails to revert uncommitted/committed changes.
 *
 * @param workdir - Working directory
 * @param ref - Git ref to reset to (e.g., SHA from captureGitRef)
 * @returns Promise that resolves when rollback completes
 */
async function rollbackToRef(workdir: string, ref: string): Promise<void> {
  const logger = getLogger();
  logger.warn("tdd", "Rolling back git changes", { ref });

  // Hard reset to the initial ref
  const resetProc = Bun.spawn(["git", "reset", "--hard", ref], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await resetProc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(resetProc.stderr).text();
    logger.error("tdd", "Failed to rollback git changes", { ref, stderr });
    throw new Error(`Git rollback failed: ${stderr}`);
  }

  // Clean up untracked files
  const cleanProc = Bun.spawn(["git", "clean", "-fd"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const cleanExitCode = await cleanProc.exited;
  if (cleanExitCode !== 0) {
    const stderr = await new Response(cleanProc.stderr).text();
    logger.warn("tdd", "Failed to clean untracked files", { stderr });
  }

  logger.info("tdd", "Successfully rolled back git changes", { ref });
}

/** Run a single TDD session */
async function runTddSession(
  role: TddSessionRole,
  agent: AgentAdapter,
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  modelTier: ModelTier,
  beforeRef: string,
  contextMarkdown?: string,
  lite = false,
  skipIsolation = false,
): Promise<TddSessionResult> {
  const startTime = Date.now();

  // Build prompt based on role and mode (lite vs strict)
  let prompt: string;
  switch (role) {
    case "test-writer":
      prompt = lite
        ? buildTestWriterLitePrompt(story, contextMarkdown)
        : buildTestWriterPrompt(story, contextMarkdown);
      break;
    case "implementer":
      prompt = lite
        ? buildImplementerLitePrompt(story, contextMarkdown)
        : buildImplementerPrompt(story, contextMarkdown);
      break;
    case "verifier":
      prompt = buildVerifierPrompt(story);
      break;
  }

  const logger = getLogger();
  logger.info("tdd", `→ Session: ${role}`, { role, storyId: story.id, lite });

  // Run the agent
  const result = await agent.run({
    prompt,
    workdir,
    modelTier,
    modelDef: resolveModel(config.models[modelTier]),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
    dangerouslySkipPermissions: config.execution.dangerouslySkipPermissions,
  });

  // BUG-21 Fix: Clean up orphaned child processes if agent failed
  if (!result.success && result.pid) {
    await cleanupProcessTree(result.pid);
  }

  // Check isolation based on role and skipIsolation flag.
  // Verifier always runs isolation check regardless of lite mode.
  let isolation;
  if (!skipIsolation) {
    if (role === "test-writer") {
      const allowedPaths = config.tdd.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
      isolation = await verifyTestWriterIsolation(workdir, beforeRef, allowedPaths);
    } else if (role === "implementer" || role === "verifier") {
      isolation = await verifyImplementerIsolation(workdir, beforeRef);
    }
  }

  // Get changed files
  const filesChanged = await getChangedFiles(workdir, beforeRef);

  const durationMs = Date.now() - startTime;

  if (isolation && !isolation.passed) {
    logger.error("tdd", "✗ Isolation violated", {
      role,
      storyId: story.id,
      description: isolation.description,
      violations: isolation.violations,
    });
  } else if (isolation) {
    if (isolation.softViolations && isolation.softViolations.length > 0) {
      logger.warn("tdd", "[WARN] Isolation soft violations (allowed files modified)", {
        role,
        storyId: story.id,
        softViolations: isolation.softViolations,
      });
    }
    if (isolation.warnings && isolation.warnings.length > 0) {
      logger.warn("tdd", "[WARN] Isolation maintained with warnings", {
        role,
        storyId: story.id,
        warnings: isolation.warnings,
      });
    }
    if (!isolation.softViolations?.length && !isolation.warnings?.length) {
      logger.info("tdd", "✓ Isolation maintained", { role, storyId: story.id });
    }
  }

  return {
    role,
    success: result.success && (!isolation || isolation.passed),
    isolation,
    filesChanged,
    durationMs,
    estimatedCost: result.estimatedCost,
  };
}

/** Options for three-session TDD */
export interface ThreeSessionTddOptions {
  /** Agent adapter to use */
  agent: AgentAdapter;
  /** User story to implement */
  story: UserStory;
  /** Ngent configuration */
  config: NaxConfig;
  /** Working directory */
  workdir: string;
  /** Model tier for all sessions */
  modelTier: ModelTier;
  /** Optional context markdown */
  contextMarkdown?: string;
  /** Dry-run mode: log what would happen without executing */
  dryRun?: boolean;
  /** Lite mode: use relaxed prompts and skip test-writer/implementer isolation */
  lite?: boolean;
  /** Internal recursion depth (for preventing infinite loops) */
  _recursionDepth?: number;
}

/**
 * Run the full three-session TDD pipeline for a user story.
 *
 * Orchestrates the complete TDD workflow:
 * 1. Session 1 (test-writer): Agent writes tests only, no source changes
 * 2. Session 2 (implementer): Agent implements code to pass tests, no test changes
 * 3. Session 3 (verifier): Agent runs tests and verifies implementation quality
 *
 * Each session enforces file isolation via git diff checking. If any session fails
 * isolation or exits with error, the workflow stops and flags for human review.
 *
 * @param options - Three-session TDD options
 * @returns Three-session TDD result with success status, session details, and cost
 *
 * @example
 * ```ts
 * const result = await runThreeSessionTdd({
 *   agent: claudeAdapter,
 *   story: {
 *     id: "US-001",
 *     title: "Add user authentication",
 *     description: "Implement JWT-based authentication",
 *     acceptanceCriteria: ["Secure token storage", "Token refresh"],
 *     // ...
 *   },
 *   config,
 *   workdir: "/project",
 *   modelTier: "balanced",
 *   contextMarkdown: "## Dependencies\n- US-000: Database setup\n",
 *   dryRun: false,
 *   lite: false,
 * });
 *
 * if (result.success) {
 *   console.log(`✅ TDD complete, cost: $${result.totalCost.toFixed(4)}`);
 * } else if (result.needsHumanReview) {
 *   console.log(`⚠️ Needs review: ${result.reviewReason}`);
 * }
 * ```
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

  logger.info("tdd", "🔄 Three-Session TDD", { storyId: story?.id, title: story?.title, lite, recursionDepth: _recursionDepth });

  // Dry-run mode: log what would happen without executing
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

  // Capture initial git state (fallback to "HEAD" if git unavailable)
  // This will be used to rollback if TDD fails
  const initialRef = (await captureGitRef(workdir)) ?? "HEAD";
  const shouldRollbackOnFailure = config.tdd.rollbackOnFailure ?? true;

  // Session 1: Test Writer
  // In lite mode: use lite prompt and skip isolation check
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
    lite, // skipIsolation = lite (skip test-writer isolation in lite mode)
  );
  sessions.push(session1);

  if (!session1.success) {
    needsHumanReview = true;
    reviewReason = "Test writer session failed or violated isolation";
    // Distinguish isolation violation from crash/timeout
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
  // Check if any test files were created (*.test.ts, *.spec.ts, etc.)
  const testFilePatterns = /\.(test|spec)\.(ts|js|tsx|jsx)$/;
  const testFilesCreated = session1.filesChanged.filter((f) => testFilePatterns.test(f));

  if (testFilesCreated.length === 0) {
    // BUG-010: Zero-file fallback — return greenfield-no-tests instead of recursing to lite
    // This should be caught by routing stage greenfield detection, but we handle it here as a safety net
    needsHumanReview = true;
    reviewReason = "Test writer session created no test files (greenfield project)";
    logger.warn("tdd", "[WARN] Test writer created no test files - greenfield detected", {
      storyId: story.id,
      reviewReason,
      filesChanged: session1.filesChanged,
    });

    // Return early — no point running implementer without tests
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

  logger.info("tdd", "✓ Created test files", {
    storyId: story.id,
    testFilesCount: testFilesCreated.length,
    testFiles: testFilesCreated,
  });

  // Capture state after session 1 (fallback to "HEAD" if git unavailable)
  const session2Ref = (await captureGitRef(workdir)) ?? "HEAD";

  // Session 2: Implementer (uses story's routed tier by default)
  // In lite mode: use lite prompt and skip isolation check
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
    lite, // skipIsolation = lite (skip implementer isolation in lite mode)
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

  // ── Full-Suite Gate (v0.11 Rectification) ──────────────────────────────────
  // Before proceeding to Session 3 (Verifier), run the full test suite to catch
  // regressions introduced by the implementer. If regressions are found, trigger
  // the rectification loop on the implementer (max 2 retries).

  const rectificationEnabled = config.execution.rectification?.enabled ?? false;

  if (rectificationEnabled) {
    const rectificationConfig = config.execution.rectification;
    const testCmd = config.quality?.commands?.test ?? "bun test";
    const fullSuiteTimeout = rectificationConfig.fullSuiteTimeoutSeconds;

    logger.info("tdd", "→ Running full test suite gate (before Verifier)", {
      storyId: story.id,
      timeout: fullSuiteTimeout,
    });

    const fullSuiteResult = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
      cwd: workdir,
    });

    const fullSuitePassed = fullSuiteResult.success && fullSuiteResult.exitCode === 0;

    if (!fullSuitePassed && fullSuiteResult.output) {
      // Full suite failed — parse failures and start rectification
      const testSummary = parseBunTestOutput(fullSuiteResult.output);

      if (testSummary.failed > 0) {
        const rectificationState: RectificationState = {
          attempt: 0,
          initialFailures: testSummary.failed,
          currentFailures: testSummary.failed,
        };

        logger.warn("tdd", "Full suite gate detected regressions", {
          storyId: story.id,
          failedTests: testSummary.failed,
          passedTests: testSummary.passed,
        });

        // Rectification retry loop for Implementer
        while (shouldRetryRectification(rectificationState, rectificationConfig)) {
          rectificationState.attempt++;

          logger.info("tdd", `→ Implementer rectification attempt ${rectificationState.attempt}/${rectificationConfig.maxRetries}`, {
            storyId: story.id,
            currentFailures: rectificationState.currentFailures,
          });

          // Build rectification prompt for implementer
          const rectificationPrompt = buildImplementerRectificationPrompt(
            testSummary.failures,
            story,
            contextMarkdown,
            rectificationConfig,
          );

          // Capture git ref before rectification
          const rectifyBeforeRef = (await captureGitRef(workdir)) ?? "HEAD";

          // Run implementer session with rectification prompt
          const rectifyResult = await agent.run({
            prompt: rectificationPrompt,
            workdir,
            modelTier: implementerTier,
            modelDef: resolveModel(config.models[implementerTier]),
            timeoutSeconds: config.execution.sessionTimeoutSeconds,
            dangerouslySkipPermissions: config.execution.dangerouslySkipPermissions,
          });

          // BUG-21 Fix: Clean up orphaned child processes if agent failed
          if (!rectifyResult.success && rectifyResult.pid) {
            await cleanupProcessTree(rectifyResult.pid);
          }

          // Check isolation for rectification session (same as implementer)
          const rectifyIsolation = lite ? undefined : await verifyImplementerIsolation(workdir, rectifyBeforeRef);

          if (rectifyIsolation && !rectifyIsolation.passed) {
            logger.error("tdd", "✗ Rectification violated isolation", {
              storyId: story.id,
              attempt: rectificationState.attempt,
              violations: rectifyIsolation.violations,
            });
            // Isolation violation — abort rectification
            break;
          }

          // Re-run full suite after rectification
          const retryFullSuite = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
            cwd: workdir,
          });

          const retrySuitePassed = retryFullSuite.success && retryFullSuite.exitCode === 0;

          if (retrySuitePassed) {
            logger.info("tdd", "✓ Full suite gate passed after rectification!", {
              storyId: story.id,
              attempt: rectificationState.attempt,
              initialFailures: rectificationState.initialFailures,
            });
            break;
          }

          // Parse new failure count
          if (retryFullSuite.output) {
            const newTestSummary = parseBunTestOutput(retryFullSuite.output);
            rectificationState.currentFailures = newTestSummary.failed;

            logger.debug("tdd", "Rectification attempt result", {
              storyId: story.id,
              attempt: rectificationState.attempt,
              previousFailures: testSummary.failed,
              currentFailures: rectificationState.currentFailures,
            });

            // Update test summary for next iteration
            testSummary.failures = newTestSummary.failures;
            testSummary.failed = newTestSummary.failed;
            testSummary.passed = newTestSummary.passed;
          }
        }

        // Check final state after rectification loop
        const finalFullSuite = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
          cwd: workdir,
        });

        const finalSuitePassed = finalFullSuite.success && finalFullSuite.exitCode === 0;

        if (!finalSuitePassed) {
          logger.warn("tdd", "[WARN] Full suite gate failed after rectification exhausted", {
            storyId: story.id,
            attempts: rectificationState.attempt,
            remainingFailures: rectificationState.currentFailures,
          });

          // Don't fail the whole TDD workflow — let Verifier see the state
          // This allows the verifier to provide human-readable diagnostic
        } else {
          logger.info("tdd", "✓ Full suite gate passed", { storyId: story.id });
        }
      }
    } else if (fullSuitePassed) {
      logger.info("tdd", "✓ Full suite gate passed", { storyId: story.id });
    } else {
      logger.warn("tdd", "Full suite gate execution failed (no output)", {
        storyId: story.id,
        exitCode: fullSuiteResult.exitCode,
      });
    }
  }

  // ── End Full-Suite Gate ────────────────────────────────────────────────────

  // Capture state after session 2 (fallback to "HEAD" if git unavailable)
  const session3Ref = (await captureGitRef(workdir)) ?? "HEAD";

  // Session 3: Verifier — ALWAYS runs with isolation regardless of lite flag
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
    false, // verifier always uses strict prompt
    false, // verifier always runs isolation check
  );
  sessions.push(session3);

  // ── T9: Verdict-based post-TDD verification ──────────────────────────────
  // Read the verifier verdict file written by session 3, then clean it up.
  // If the verdict is available, use it to determine success/failure and
  // skip the independent test run (the verifier already ran the tests).
  // If no verdict (file missing or malformed), fall back to the original
  // BUG-22 independent test verification path.

  const verdict = await readVerdict(workdir);
  await cleanupVerdict(workdir);

  let allSuccessful = sessions.every((s) => s.success);
  let finalFailureCategory: FailureCategory | undefined;

  if (verdict !== null) {
    // ── Verdict path: verifier wrote a structured verdict file ──────────────
    // Use categorizeVerdict to interpret the verdict.
    // testsActuallyPass is derived from verdict.tests.allPassing since the
    // verifier already ran the tests; categorizeVerdict ignores this param
    // when a non-null verdict is provided, but we pass the verifier's own
    // test result for semantic clarity.
    const categorization = categorizeVerdict(verdict, verdict.tests.allPassing);

    if (categorization.success) {
      logger.info("tdd", "[OK] Verifier verdict: approved", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        testsAllPassing: verdict.tests.allPassing,
        passCount: verdict.tests.passCount,
        failCount: verdict.tests.failCount,
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
    // ── Fallback path: no verdict file (missing or malformed) ───────────────
    // BUG-22 Fix: Post-TDD independent test verification
    // If sessions had failures but we need to verify if tests actually pass,
    // run an independent test verification to check final state.
    if (!allSuccessful) {
      logger.info("tdd", "→ Running post-TDD test verification (no verdict file)", { storyId: story.id });

      const testCmd = config.quality?.commands?.test ?? "bun test";
      const timeoutSeconds = 120;

      const postVerify = await executeWithTimeout(testCmd, timeoutSeconds, undefined, {
        cwd: workdir,
      });
      const testsActuallyPass = postVerify.success && postVerify.exitCode === 0;

      // Truncate test output before logging to prevent context flooding
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
      // All sessions succeeded — no need for independent verification
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

  // Rollback git changes if TDD failed and rollback is enabled
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
