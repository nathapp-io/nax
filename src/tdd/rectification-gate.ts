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
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { captureGitRef } from "../utils/git";
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
): Promise<void> {
  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  if (!rectificationEnabled) return;

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
      await runRectificationLoop(
        story, config, workdir, agent, implementerTier,
        contextMarkdown, lite, logger, testSummary,
        rectificationConfig, testCmd, fullSuiteTimeout,
      );
    }
  } else if (fullSuitePassed) {
    logger.info("tdd", "Full suite gate passed", { storyId: story.id });
  } else {
    logger.warn("tdd", "Full suite gate execution failed (no output)", {
      storyId: story.id,
      exitCode: fullSuiteResult.exitCode,
    });
  }
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
): Promise<void> {
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
    });

    if (!rectifyResult.success && rectifyResult.pid) {
      await cleanupProcessTree(rectifyResult.pid);
    }

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
      break;
    }

    if (retryFullSuite.output) {
      const newTestSummary = parseBunTestOutput(retryFullSuite.output);
      rectificationState.currentFailures = newTestSummary.failed;
      testSummary.failures = newTestSummary.failures;
      testSummary.failed = newTestSummary.failed;
      testSummary.passed = newTestSummary.passed;
    }
  }

  const finalFullSuite = await executeWithTimeout(testCmd, fullSuiteTimeout, undefined, { cwd: workdir });
  const finalSuitePassed = finalFullSuite.success && finalFullSuite.exitCode === 0;

  if (!finalSuitePassed) {
    logger.warn("tdd", "[WARN] Full suite gate failed after rectification exhausted", {
      storyId: story.id,
      attempts: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
    });
  } else {
    logger.info("tdd", "Full suite gate passed", { storyId: story.id });
  }
}
