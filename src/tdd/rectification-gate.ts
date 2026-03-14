/**
 * TDD Full-Suite Rectification Gate
 *
 * Extracted from orchestrator.ts: runFullSuiteGate
 * Runs the full test suite before the verifier session and performs
 * rectification retries if regressions are detected.
 */

import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModel } from "../config";
import type { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { autoCommitIfDirty, captureGitRef } from "../utils/git";
import {
  type RectificationState,
  executeWithTimeout,
  parseBunTestOutput,
  shouldRetryRectification,
} from "../verification";
import { cleanupProcessTree } from "./cleanup";
import { verifyImplementerIsolation } from "./isolation";
import { buildImplementerRectificationPrompt } from "./prompts";

/**
 * Run full test suite gate before verifier session (v0.11 Rectification).
 */
export async function runFullSuiteGate(
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  agent: AgentAdapter,
  implementerTier: ModelTier,
  contextMarkdown: string | undefined,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  featureName?: string,
): Promise<boolean> {
  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  if (!rectificationEnabled) return false;

  const rectificationConfig = config.execution.rectification;
  const testCmd = config.quality?.commands?.test ?? "bun test";
  const fullSuiteTimeout = rectificationConfig.fullSuiteTimeoutSeconds;

  logger.info("tdd", "-> Running full test suite gate (before Verifier)", {
    storyId: story.id,
    timeout: fullSuiteTimeout,
  });

  const fullSuiteResult = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, { cwd: workdir });
  const fullSuitePassed = fullSuiteResult.success && fullSuiteResult.exitCode === 0;

  if (!fullSuitePassed && fullSuiteResult.output) {
    const testSummary = parseBunTestOutput(fullSuiteResult.output);

    if (testSummary.failed > 0) {
      return await runRectificationLoop(
        story,
        config,
        workdir,
        agent,
        implementerTier,
        contextMarkdown,
        lite,
        logger,
        testSummary,
        rectificationConfig,
        testCmd,
        fullSuiteTimeout,
        featureName,
      );
    }

    // BUG-059: Non-zero exit with 0 parsed failures could mean:
    // (a) Environmental noise (linter warning) — safe to pass
    // (b) Bun crashed/OOM mid-run — truncated output, parser found nothing
    // Distinguish by checking if any tests were actually detected in the output.
    if (testSummary.passed > 0) {
      // Tests ran and passed, but exit code was non-zero (environmental noise)
      logger.info("tdd", "Full suite gate passed (non-zero exit, 0 failures, tests detected)", {
        storyId: story.id,
        exitCode: fullSuiteResult.exitCode,
        passedTests: testSummary.passed,
      });
      return true;
    }

    // No tests passed AND no tests failed — output is likely truncated/crashed
    logger.warn("tdd", "Full suite gate inconclusive — no test results parsed from output (possible crash/OOM)", {
      storyId: story.id,
      exitCode: fullSuiteResult.exitCode,
      outputLength: fullSuiteResult.output.length,
      outputTail: fullSuiteResult.output.slice(-200),
    });
    return false;
  }
  if (fullSuitePassed) {
    logger.info("tdd", "Full suite gate passed", { storyId: story.id });
    return true;
  }
  logger.warn("tdd", "Full suite gate execution failed (no output)", {
    storyId: story.id,
    exitCode: fullSuiteResult.exitCode,
  });
  return false;
}

/** Run the rectification retry loop when full suite gate detects regressions. */
async function runRectificationLoop(
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  agent: AgentAdapter,
  implementerTier: ModelTier,
  contextMarkdown: string | undefined,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  testSummary: ReturnType<typeof parseBunTestOutput>,
  rectificationConfig: NonNullable<NaxConfig["execution"]["rectification"]>,
  testCmd: string,
  fullSuiteTimeout: number,
  featureName?: string,
): Promise<boolean> {
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

  while (shouldRetryRectification(rectificationState, rectificationConfig)) {
    rectificationState.attempt++;

    logger.info(
      "tdd",
      `-> Implementer rectification attempt ${rectificationState.attempt}/${rectificationConfig.maxRetries}`,
      { storyId: story.id, currentFailures: rectificationState.currentFailures },
    );

    const rectificationPrompt = buildImplementerRectificationPrompt(
      testSummary.failures,
      story,
      contextMarkdown,
      rectificationConfig,
    );

    const rectifyBeforeRef = (await captureGitRef(workdir)) ?? "HEAD";

    const rectifyResult = await agent.run({
      prompt: rectificationPrompt,
      workdir,
      modelTier: implementerTier,
      modelDef: resolveModel(config.models[implementerTier]),
      timeoutSeconds: config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: config.execution.dangerouslySkipPermissions,
      featureName,
      storyId: story.id,
      sessionRole: "implementer",
    });

    if (!rectifyResult.success && rectifyResult.pid) {
      await cleanupProcessTree(rectifyResult.pid);
    }

    if (rectifyResult.success) {
      logger.info("tdd", "Rectification agent session complete", {
        storyId: story.id,
        attempt: rectificationState.attempt,
        cost: rectifyResult.estimatedCost,
      });
    } else {
      logger.warn("tdd", "Rectification agent session failed", {
        storyId: story.id,
        attempt: rectificationState.attempt,
        exitCode: rectifyResult.exitCode,
      });
    }

    // BUG-063: Auto-commit after rectification agent — prevents uncommitted changes
    // from leaking into verifier/review stages. Same pattern as session-runner.ts.
    await autoCommitIfDirty(workdir, "tdd", "rectification", story.id);

    const rectifyIsolation = lite ? undefined : await verifyImplementerIsolation(workdir, rectifyBeforeRef);

    if (rectifyIsolation && !rectifyIsolation.passed) {
      logger.error("tdd", "Rectification violated isolation", {
        storyId: story.id,
        attempt: rectificationState.attempt,
        violations: rectifyIsolation.violations,
      });
      break;
    }

    const retryFullSuite = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, { cwd: workdir });
    const retrySuitePassed = retryFullSuite.success && retryFullSuite.exitCode === 0;

    if (retrySuitePassed) {
      logger.info("tdd", "Full suite gate passed after rectification!", {
        storyId: story.id,
        attempt: rectificationState.attempt,
      });
      return true;
    }

    if (retryFullSuite.output) {
      const newTestSummary = parseBunTestOutput(retryFullSuite.output);
      rectificationState.currentFailures = newTestSummary.failed;
      testSummary.failures = newTestSummary.failures;
      testSummary.failed = newTestSummary.failed;
      testSummary.passed = newTestSummary.passed;
    }

    logger.warn("tdd", "Full suite still failing after rectification attempt", {
      storyId: story.id,
      attempt: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
    });
  }

  const finalFullSuite = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, { cwd: workdir });
  const finalSuitePassed = finalFullSuite.success && finalFullSuite.exitCode === 0;

  if (!finalSuitePassed) {
    logger.warn("tdd", "[WARN] Full suite gate failed after rectification exhausted", {
      storyId: story.id,
      attempts: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
    });
    return false;
  }
  logger.info("tdd", "Full suite gate passed", { storyId: story.id });
  return true;
}
