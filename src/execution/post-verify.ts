/**
 * Post-Agent Verification (ADR-003)
 *
 * Extracted from runner.ts to keep the main loop focused on orchestration.
 * Runs verification after the agent completes, reverts story state on failure.
 */

import { getAgent } from "../agents";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config";
import { getLogger, getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PRD, UserStory } from "../prd";
import { getExpectedFiles, savePRD } from "../prd";
import { captureGitRef } from "../utils/git";
import { getTierConfig } from "./escalation";
import { appendProgress } from "./progress";
import { type RectificationState, createRectificationPrompt, shouldRetryRectification } from "./rectification";
import { parseBunTestOutput } from "./test-output-parser";
import { getEnvironmentalEscalationThreshold, parseTestOutput, runVerification } from "./verification";

import { spawn } from "bun";

/**
 * Get test files changed since a git ref.
 * Returns empty array if detection fails (falls back to full suite).
 */
async function getChangedTestFiles(workdir: string, gitRef?: string): Promise<string[]> {
  if (!gitRef) return [];
  try {
    const proc = spawn({
      cmd: ["git", "diff", "--name-only", gitRef, "HEAD"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];
    const stdout = await new Response(proc.stdout).text();
    return stdout
      .trim()
      .split("\n")
      .filter(
        (f) =>
          f && (f.includes("test/") || f.includes("__tests__/") || f.endsWith(".test.ts") || f.endsWith(".spec.ts")),
      );
  } catch {
    return [];
  }
}

/**
 * Scope a test command to only run specific test files.
 * Returns original command if no test files provided.
 */
function scopeTestCommand(baseCommand: string, testFiles: string[]): string {
  if (testFiles.length === 0) return baseCommand;
  return `${baseCommand} ${testFiles.join(" ")}`;
}

export interface PostVerifyOptions {
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  workdir: string;
  featureDir?: string;
  story: UserStory;
  storiesToExecute: UserStory[];
  allStoryMetrics: StoryMetrics[];
  timeoutRetryCountMap: Map<string, number>;
  /** Git ref captured before story execution, for scoped verification */
  storyGitRef?: string;
}

export interface PostVerifyResult {
  passed: boolean;
  prd: PRD;
}

/**
 * Run post-agent verification and handle failure state.
 *
 * When verification fails:
 * - Reverts all batch stories from passed → pending
 * - Removes stale story metrics added by completionStage
 * - Tracks timeout retries for --detectOpenHandles escalation
 * - Appends diagnostic context to story.priorErrors
 * - Increments attempts (if countsTowardEscalation)
 *
 * @design Shell command in config.quality.commands.test is operator-controlled,
 * not user/PRD input. No shell injection risk from untrusted sources.
 */
export async function runPostAgentVerification(opts: PostVerifyOptions): Promise<PostVerifyResult> {
  const {
    config,
    prd,
    prdPath,
    workdir,
    featureDir,
    story,
    storiesToExecute,
    allStoryMetrics,
    timeoutRetryCountMap,
    storyGitRef,
  } = opts;
  const logger = getSafeLogger();

  if (!config.quality.commands.test) {
    return { passed: true, prd };
  }

  // Scoped verification: only run test files changed by this story
  const changedTestFiles = await getChangedTestFiles(workdir, storyGitRef);
  const testCommand = scopeTestCommand(config.quality.commands.test, changedTestFiles);

  logger?.debug("verification", "Running verification", {
    command: testCommand,
    scoped: changedTestFiles.length > 0,
    scopedFiles: changedTestFiles.length > 0 ? changedTestFiles : undefined,
  });

  const timeoutRetryCount = timeoutRetryCountMap.get(story.id) || 0;
  const verificationResult = await runVerification({
    workingDirectory: workdir,
    expectedFiles: getExpectedFiles(story),
    command: testCommand,
    timeoutSeconds: config.execution.verificationTimeoutSeconds,
    forceExit: config.quality.forceExit,
    detectOpenHandles: config.quality.detectOpenHandles,
    detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
    timeoutRetryCount,
    gracePeriodMs: config.quality.gracePeriodMs,
    drainTimeoutMs: config.quality.drainTimeoutMs,
    shell: config.quality.shell,
    stripEnvVars: config.quality.stripEnvVars,
  });

  // Declare rectification config once (used for both scoped and regression failures)
  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  const rectificationConfig = config.execution.rectification;

  if (verificationResult.success) {
    logger?.info("verification", "Scoped verification passed");
    if (verificationResult.output) {
      const analysis = parseTestOutput(verificationResult.output, 0);
      if (analysis.passCount > 0) {
        logger?.debug("verification", "Scoped test results", {
          passCount: analysis.passCount,
          failCount: analysis.failCount,
        });
      }
    }

    // ── Regression Gate (BUG-009) ──────────────────────────────────────────────
    // After scoped verification passes, run full suite to catch cross-story regressions.
    // Skip if scoped verification already ran the full suite (0 changed test files).

    const regressionGateEnabled = config.execution.regressionGate?.enabled ?? true;
    const scopedTestsWereRun = changedTestFiles.length > 0;

    if (regressionGateEnabled && scopedTestsWereRun) {
      logger?.info("regression-gate", "Running full-suite regression gate");

      const fullSuiteCommand = config.quality.commands.test;
      const regressionResult = await runVerification({
        workingDirectory: workdir,
        expectedFiles: getExpectedFiles(story),
        command: fullSuiteCommand,
        timeoutSeconds: config.execution.regressionGate.timeoutSeconds,
        forceExit: config.quality.forceExit,
        detectOpenHandles: config.quality.detectOpenHandles,
        detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
        timeoutRetryCount: 0,
        gracePeriodMs: config.quality.gracePeriodMs,
        drainTimeoutMs: config.quality.drainTimeoutMs,
        shell: config.quality.shell,
        stripEnvVars: config.quality.stripEnvVars,
      });

      if (!regressionResult.success) {
        logger?.warn("regression-gate", "Full-suite regression detected", {
          status: regressionResult.status,
        });

        // Feed regression failures into rectification loop
        const isTestFailure = regressionResult.status === "TEST_FAILURE" && regressionResult.output;

        if (rectificationEnabled && isTestFailure) {
          const testSummary = parseBunTestOutput(regressionResult.output!);

          // Initialize rectification state
          const rectificationState: RectificationState = {
            attempt: 0,
            initialFailures: testSummary.failed,
            currentFailures: testSummary.failed,
          };

          logger?.info("rectification", "Starting regression rectification loop", {
            storyId: story.id,
            initialFailures: rectificationState.initialFailures,
            maxRetries: rectificationConfig.maxRetries,
          });

          // Rectification retry loop
          while (shouldRetryRectification(rectificationState, rectificationConfig)) {
            rectificationState.attempt++;

            logger?.info(
              "rectification",
              `Regression rectification attempt ${rectificationState.attempt}/${rectificationConfig.maxRetries}`,
              {
                storyId: story.id,
                currentFailures: rectificationState.currentFailures,
              },
            );

            // Build rectification prompt with REGRESSION: prefix
            const basePrompt = createRectificationPrompt(testSummary.failures, story, rectificationConfig);
            const regressionPrompt = `# REGRESSION: Cross-Story Test Failures

Your changes passed scoped tests but broke unrelated tests. Fix these regressions.

${basePrompt}`;

            // Get agent and run with rectification prompt
            const agent = getAgent(config.autoMode.defaultAgent);
            if (!agent) {
              logger?.error("rectification", "Agent not found, cannot retry");
              break;
            }

            const modelTier = story.routing?.modelTier || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
            const modelDef = resolveModel(config.models[modelTier]);

            logger?.debug("rectification", "Running agent with regression rectification prompt", {
              storyId: story.id,
              modelTier,
              attempt: rectificationState.attempt,
            });

            const agentResult = await agent.run({
              prompt: regressionPrompt,
              workdir,
              modelTier,
              modelDef,
              timeoutSeconds: config.execution.sessionTimeoutSeconds,
              dangerouslySkipPermissions: config.execution.dangerouslySkipPermissions,
            });

            if (!agentResult.success) {
              logger?.warn("rectification", "Agent regression rectification session failed", {
                storyId: story.id,
                attempt: rectificationState.attempt,
              });
              // Don't break — still run verification to check if partial fix worked
            }

            // Re-run full-suite verification after rectification attempt
            const retryVerification = await runVerification({
              workingDirectory: workdir,
              expectedFiles: getExpectedFiles(story),
              command: fullSuiteCommand,
              timeoutSeconds: config.execution.regressionGate.timeoutSeconds,
              forceExit: config.quality.forceExit,
              detectOpenHandles: config.quality.detectOpenHandles,
              detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
              timeoutRetryCount: 0,
              gracePeriodMs: config.quality.gracePeriodMs,
              drainTimeoutMs: config.quality.drainTimeoutMs,
              shell: config.quality.shell,
              stripEnvVars: config.quality.stripEnvVars,
            });

            if (retryVerification.success) {
              logger?.info("rectification", "✓ Regression rectification succeeded!", {
                storyId: story.id,
                attempt: rectificationState.attempt,
                initialFailures: rectificationState.initialFailures,
              });
              return { passed: true, prd };
            }

            // Parse new failure count
            if (retryVerification.output) {
              const newTestSummary = parseBunTestOutput(retryVerification.output);
              rectificationState.currentFailures = newTestSummary.failed;

              logger?.debug("rectification", "Regression rectification attempt result", {
                storyId: story.id,
                attempt: rectificationState.attempt,
                previousFailures: testSummary.failed,
                currentFailures: rectificationState.currentFailures,
                progress:
                  testSummary.failed > rectificationState.currentFailures
                    ? "improved"
                    : testSummary.failed < rectificationState.currentFailures
                      ? "regressed"
                      : "unchanged",
              });

              // Update test summary for next iteration
              testSummary.failures = newTestSummary.failures;
              testSummary.failed = newTestSummary.failed;
              testSummary.passed = newTestSummary.passed;
            }
          }

          // Rectification exhausted or aborted
          if (rectificationState.attempt >= rectificationConfig.maxRetries) {
            logger?.warn("rectification", "Regression rectification exhausted max retries", {
              storyId: story.id,
              attempts: rectificationState.attempt,
              remainingFailures: rectificationState.currentFailures,
            });
          } else if (rectificationState.currentFailures > rectificationState.initialFailures) {
            logger?.warn("rectification", "Regression rectification aborted due to further regression", {
              storyId: story.id,
              initialFailures: rectificationState.initialFailures,
              currentFailures: rectificationState.currentFailures,
            });
          }
        }

        // Regression gate failed and rectification didn't fix it — revert to pending
        const storyIds = new Set(storiesToExecute.map((s) => s.id));
        for (let i = allStoryMetrics.length - 1; i >= 0; i--) {
          if (storyIds.has(allStoryMetrics[i].storyId)) {
            allStoryMetrics.splice(i, 1);
          }
        }

        const diagnosticContext = `REGRESSION: ${regressionResult.status}`;
        prd.userStories = prd.userStories.map((s) =>
          storyIds.has(s.id)
            ? {
                ...s,
                priorErrors: [...(s.priorErrors || []), diagnosticContext],
                status: "pending" as const,
                passes: false,
              }
            : s,
        );

        if (regressionResult.countsTowardEscalation) {
          prd.userStories = prd.userStories.map((s) => (s.id === story.id ? { ...s, attempts: s.attempts + 1 } : s));
        }

        await savePRD(prd, prdPath);

        if (featureDir) {
          await appendProgress(
            featureDir,
            story.id,
            "failed",
            `${story.title} — REGRESSION: ${regressionResult.status}`,
          );
        }

        return { passed: false, prd };
      }

      logger?.info("regression-gate", "Full-suite regression gate passed");
    } else if (regressionGateEnabled && !scopedTestsWereRun) {
      logger?.debug("regression-gate", "Skipping regression gate (full suite already run in scoped verification)");
    }

    // ── End Regression Gate ────────────────────────────────────────────────────

    return { passed: true, prd };
  }

  // --- Verification failed ---

  // ── Rectification Loop (v0.11) ─────────────────────────────────────────────
  // If rectification is enabled and tests failed (not timeout/env), attempt to
  // fix the failures by providing failure context to the agent and re-running.

  const isTestFailure = verificationResult.status === "TEST_FAILURE" && verificationResult.output;

  if (rectificationEnabled && isTestFailure) {
    const rectificationConfig = config.execution.rectification;
    const testSummary = parseBunTestOutput(verificationResult.output!);

    // Initialize rectification state
    const rectificationState: RectificationState = {
      attempt: 0,
      initialFailures: testSummary.failed,
      currentFailures: testSummary.failed,
    };

    logger?.info("rectification", "Starting rectification loop", {
      storyId: story.id,
      initialFailures: rectificationState.initialFailures,
      maxRetries: rectificationConfig.maxRetries,
    });

    // Rectification retry loop
    while (shouldRetryRectification(rectificationState, rectificationConfig)) {
      rectificationState.attempt++;

      logger?.info(
        "rectification",
        `Rectification attempt ${rectificationState.attempt}/${rectificationConfig.maxRetries}`,
        {
          storyId: story.id,
          currentFailures: rectificationState.currentFailures,
        },
      );

      // Build rectification prompt with failure context
      const rectificationPrompt = createRectificationPrompt(testSummary.failures, story, rectificationConfig);

      // Get agent and run with rectification prompt
      const agent = getAgent(config.autoMode.defaultAgent);
      if (!agent) {
        logger?.error("rectification", "Agent not found, cannot retry");
        break;
      }

      const modelTier = story.routing?.modelTier || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
      const modelDef = resolveModel(config.models[modelTier]);

      logger?.debug("rectification", "Running agent with rectification prompt", {
        storyId: story.id,
        modelTier,
        attempt: rectificationState.attempt,
      });

      const agentResult = await agent.run({
        prompt: rectificationPrompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds: config.execution.sessionTimeoutSeconds,
        dangerouslySkipPermissions: config.execution.dangerouslySkipPermissions,
      });

      if (!agentResult.success) {
        logger?.warn("rectification", "Agent rectification session failed", {
          storyId: story.id,
          attempt: rectificationState.attempt,
        });
        // Don't break — still run verification to check if partial fix worked
      }

      // Re-run verification after rectification attempt
      const retryVerification = await runVerification({
        workingDirectory: workdir,
        expectedFiles: getExpectedFiles(story),
        command: testCommand,
        timeoutSeconds: config.execution.verificationTimeoutSeconds,
        forceExit: config.quality.forceExit,
        detectOpenHandles: config.quality.detectOpenHandles,
        detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
        timeoutRetryCount: 0,
        gracePeriodMs: config.quality.gracePeriodMs,
        drainTimeoutMs: config.quality.drainTimeoutMs,
        shell: config.quality.shell,
        stripEnvVars: config.quality.stripEnvVars,
      });

      if (retryVerification.success) {
        logger?.info("rectification", "✓ Rectification succeeded!", {
          storyId: story.id,
          attempt: rectificationState.attempt,
          initialFailures: rectificationState.initialFailures,
        });
        return { passed: true, prd };
      }

      // Parse new failure count
      if (retryVerification.output) {
        const newTestSummary = parseBunTestOutput(retryVerification.output);
        rectificationState.currentFailures = newTestSummary.failed;

        logger?.debug("rectification", "Rectification attempt result", {
          storyId: story.id,
          attempt: rectificationState.attempt,
          previousFailures: testSummary.failed,
          currentFailures: rectificationState.currentFailures,
          progress:
            testSummary.failed > rectificationState.currentFailures
              ? "improved"
              : testSummary.failed < rectificationState.currentFailures
                ? "regressed"
                : "unchanged",
        });

        // Update test summary for next iteration
        testSummary.failures = newTestSummary.failures;
        testSummary.failed = newTestSummary.failed;
        testSummary.passed = newTestSummary.passed;
      }
    }

    // Rectification exhausted or aborted
    if (rectificationState.attempt >= rectificationConfig.maxRetries) {
      logger?.warn("rectification", "Rectification exhausted max retries", {
        storyId: story.id,
        attempts: rectificationState.attempt,
        remainingFailures: rectificationState.currentFailures,
      });
    } else if (rectificationState.currentFailures > rectificationState.initialFailures) {
      logger?.warn("rectification", "Rectification aborted due to regression", {
        storyId: story.id,
        initialFailures: rectificationState.initialFailures,
        currentFailures: rectificationState.currentFailures,
      });
    }
  }

  // ── End Rectification Loop ─────────────────────────────────────────────────

  // Undo story metrics added by completionStage (BUG-1 fix)
  const storyIds = new Set(storiesToExecute.map((s) => s.id));
  for (let i = allStoryMetrics.length - 1; i >= 0; i--) {
    if (storyIds.has(allStoryMetrics[i].storyId)) {
      allStoryMetrics.splice(i, 1);
    }
  }

  // Track timeout retries for --detectOpenHandles escalation
  if (verificationResult.status === "TIMEOUT") {
    timeoutRetryCountMap.set(story.id, timeoutRetryCount + 1);
  }

  // Revert ALL stories in this batch back to pending
  const diagnosticContext = verificationResult.error || `Verification failed: ${verificationResult.status}`;
  prd.userStories = prd.userStories.map((s) =>
    storyIds.has(s.id)
      ? { ...s, priorErrors: [...(s.priorErrors || []), diagnosticContext], status: "pending" as const, passes: false }
      : s,
  );

  logger?.warn("verification", `Verification ${verificationResult.status}`, {
    status: verificationResult.status,
    error: verificationResult.error?.split("\n")[0],
  });

  if (verificationResult.output && verificationResult.passCount !== undefined) {
    logger?.debug("verification", "Test results", {
      passCount: verificationResult.passCount,
      failCount: verificationResult.failCount,
    });
  }

  // Don't count toward escalation for timeouts (environmental issue)
  if (verificationResult.countsTowardEscalation) {
    // Increment attempts — this drives tier escalation
    prd.userStories = prd.userStories.map((s) => (s.id === story.id ? { ...s, attempts: s.attempts + 1 } : s));

    // Environmental failures escalate faster (ceil(tierAttempts / divisor))
    if (verificationResult.status === "ENVIRONMENTAL_FAILURE") {
      const currentTier = story.routing?.modelTier || config.autoMode.escalation.tierOrder[0]?.tier;
      const tierCfg = currentTier ? getTierConfig(currentTier, config.autoMode.escalation.tierOrder) : undefined;
      if (tierCfg) {
        const threshold = getEnvironmentalEscalationThreshold(
          tierCfg.attempts,
          config.quality.environmentalEscalationDivisor,
        );
        const currentAttempts = prd.userStories.find((s) => s.id === story.id)?.attempts ?? 0;
        if (currentAttempts >= threshold) {
          logger?.warn("verification", "Environmental failure hit early escalation threshold", {
            currentAttempts,
            threshold,
          });
        }
      }
    }
  }

  await savePRD(prd, prdPath);

  if (featureDir) {
    await appendProgress(
      featureDir,
      story.id,
      "failed",
      `${story.title} — ${verificationResult.status}: ${verificationResult.error?.split("\n")[0]}`,
    );
  }

  return { passed: false, prd };
}
