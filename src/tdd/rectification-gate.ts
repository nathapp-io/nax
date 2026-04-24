/**
 * TDD Full-Suite Rectification Gate
 *
 * Extracted from orchestrator.ts: runFullSuiteGate
 * Runs the full test suite before the verifier session and performs
 * rectification retries if regressions are detected.
 */

import type { IAgentManager } from "../agents";
import { computeAcpHandle } from "../agents/acp/adapter";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { resolvePermissions } from "../config/permissions";
import type { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { FailureRecord } from "../prompts";
import { resolveQualityTestCommands } from "../quality/command-resolver";
import { autoCommitIfDirty, captureGitRef } from "../utils/git";
import {
  type RectificationState,
  executeWithTimeout as _executeWithTimeout,
  parseTestOutput as _parseTestOutput,
  shouldRetryRectification as _shouldRetryRectification,
  runSharedRectificationLoop,
} from "../verification";
import { buildFailureRecords } from "../verification/failure-records";
import { cleanupProcessTree } from "./cleanup";
import { verifyImplementerIsolation } from "./isolation";

/** Injectable deps for testability — avoids mock.module() contamination */
export const _rectificationGateDeps = {
  executeWithTimeout: _executeWithTimeout,
  parseTestOutput: _parseTestOutput,
  shouldRetryRectification: _shouldRetryRectification,
  resolveTestCommands: resolveQualityTestCommands,
};

/**
 * Return the set of files changed since `fromRef` via `git diff --name-only`.
 * Used to infer which failures the story is responsible for (BUG-TC-001).
 */
async function getStoryChangedFiles(workdir: string, fromRef: string): Promise<ReadonlySet<string>> {
  const result = await _rectificationGateDeps.executeWithTimeout(
    `git diff --name-only --relative ${fromRef} HEAD`,
    15,
    undefined,
    { cwd: workdir },
  );
  if (!result.output) return new Set();
  return new Set(
    result.output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Run full test suite gate before verifier session (v0.11 Rectification).
 *
 * @param storyFromRef - git ref captured before the story started (initialRef).
 *   When provided, failures in test files the story never touched are suppressed
 *   to prevent pre-existing failures from consuming rectification attempts (BUG-TC-001).
 */
export async function runFullSuiteGate(
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  agentManager: IAgentManager,
  implementerTier: ModelTier,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  featureName?: string,
  projectDir?: string,
  storyFromRef?: string,
): Promise<{ passed: boolean; cost: number }> {
  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  if (!rectificationEnabled) return { passed: false, cost: 0 };

  const rectificationConfig = config.execution.rectification;
  const fullSuiteTimeout = rectificationConfig.fullSuiteTimeoutSeconds;

  // Resolve test commands via SSOT — handles priority, {{package}}, and orchestrator promotion.
  const { testCommand: resolvedTestCmd } = await _rectificationGateDeps.resolveTestCommands(
    config,
    workdir,
    story.workdir,
  );
  const effectiveTestCmd = resolvedTestCmd ?? "bun test";

  logger.info("tdd", "-> Running full test suite gate (before Verifier)", {
    storyId: story.id,
    timeout: fullSuiteTimeout,
  });

  const fullSuiteResult = await _rectificationGateDeps.executeWithTimeout(
    effectiveTestCmd,
    fullSuiteTimeout,
    undefined,
    { cwd: workdir },
  );
  const fullSuitePassed = fullSuiteResult.success && fullSuiteResult.exitCode === 0;

  if (!fullSuitePassed && fullSuiteResult.output) {
    const testSummary = _rectificationGateDeps.parseTestOutput(fullSuiteResult.output);

    if (testSummary.failed > 0) {
      // Filter out failures in files the story never touched (pre-existing pollution).
      // Uses git diff since storyFromRef to identify story-owned files.
      // Only applies when structured failures are available — if failures[] is empty
      // (parser limitation / count-only output), fall through to rectification unchanged.
      let filteredFailures = testSummary.failures;
      if (storyFromRef && testSummary.failures.length > 0) {
        const storyFiles = await getStoryChangedFiles(workdir, storyFromRef);
        if (storyFiles.size > 0) {
          filteredFailures = testSummary.failures.filter((f) => storyFiles.has(f.file));
        }
      }
      const wasFiltered = filteredFailures.length < testSummary.failures.length;

      if (wasFiltered && filteredFailures.length === 0) {
        const uniqueSuppressedFiles = [...new Set(testSummary.failures.map((f) => f.file))];
        logger.info("tdd", "Full suite gate: all failures are pre-existing — accepting as pass", {
          storyId: story.id,
          suppressedFileCount: uniqueSuppressedFiles.length,
          suppressedTestCount: testSummary.failures.length,
          suppressedFiles: uniqueSuppressedFiles,
        });
        return { passed: true, cost: 0 };
      }

      if (wasFiltered) {
        logger.info("tdd", "Full suite gate: suppressed pre-existing failures", {
          storyId: story.id,
          total: testSummary.failures.length,
          suppressed: testSummary.failures.length - filteredFailures.length,
          remaining: filteredFailures.length,
        });
      }

      // Preserve the original failed count when no structured failures were available to filter
      const filteredSummary = {
        ...testSummary,
        failures: filteredFailures,
        failed: wasFiltered ? filteredFailures.length : testSummary.failed,
      };
      return await runRectificationLoop(
        story,
        config,
        workdir,
        agentManager,
        implementerTier,
        lite,
        logger,
        filteredSummary,
        rectificationConfig,
        effectiveTestCmd,
        fullSuiteTimeout,
        fullSuiteResult.output,
        featureName,
        projectDir,
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
      return { passed: true, cost: 0 };
    }

    // No tests passed AND no tests failed — output is likely truncated/crashed
    logger.warn("tdd", "Full suite gate inconclusive — no test results parsed from output (possible crash/OOM)", {
      storyId: story.id,
      exitCode: fullSuiteResult.exitCode,
      outputLength: fullSuiteResult.output.length,
      outputTail: fullSuiteResult.output.slice(-200),
    });
    return { passed: false, cost: 0 };
  }
  if (fullSuitePassed) {
    logger.info("tdd", "Full suite gate passed", { storyId: story.id });
    return { passed: true, cost: 0 };
  }
  logger.warn("tdd", "Full suite gate execution failed (no output)", {
    storyId: story.id,
    exitCode: fullSuiteResult.exitCode,
  });
  return { passed: false, cost: 0 };
}

/** Run the rectification retry loop when full suite gate detects regressions. */
async function runRectificationLoop(
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  agentManager: IAgentManager,
  implementerTier: ModelTier,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  testSummary: ReturnType<typeof _parseTestOutput>,
  rectificationConfig: NonNullable<NaxConfig["execution"]["rectification"]>,
  testCmd: string,
  fullSuiteTimeout: number,
  testOutput: string,
  featureName?: string,
  projectDir?: string,
): Promise<{ passed: boolean; cost: number }> {
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

  // Build session name once so all rectification attempts share the same ACP session.
  // This preserves full conversation context across retries (the agent knows what it already tried).
  const rectificationSessionName = computeAcpHandle(workdir, featureName, story.id, "implementer");
  logger.debug("tdd", "Rectification session name (shared across all attempts)", {
    storyId: story.id,
    sessionName: rectificationSessionName,
  });

  const loopState = {
    ...rectificationState,
    isolationPassed: true,
  };
  let gateCostAccum = 0;
  let currentTestOutput = testOutput;

  const fixed = await runSharedRectificationLoop({
    stage: "tdd",
    storyId: story.id,
    maxAttempts: rectificationConfig.maxRetries,
    state: loopState,
    logger,
    startMessage: "Full suite gate detected regressions",
    startData: {
      storyId: story.id,
      failedTests: testSummary.failed,
      passedTests: testSummary.passed,
    },
    attemptMessage: (attempt) => `-> Implementer rectification attempt ${attempt}/${rectificationConfig.maxRetries}`,
    attemptData: (state) => ({
      storyId: story.id,
      currentFailures: state.currentFailures,
    }),
    canContinue: (state) =>
      state.isolationPassed && _rectificationGateDeps.shouldRetryRectification(state, rectificationConfig),
    buildPrompt: async () => {
      const failureRecords: FailureRecord[] = buildFailureRecords(testSummary, currentTestOutput);
      return RectifierPromptBuilder.for("tdd-suite-failure")
        .story(story)
        .priorFailures(failureRecords)
        .testCommand(testCmd)
        .conventions()
        .task()
        .build();
    },
    runAttempt: async (attempt, rectificationPrompt) => {
      const isLastAttempt = attempt >= rectificationConfig.maxRetries;
      const rectifyBeforeRef = (await captureGitRef(workdir)) ?? "HEAD";

      const defaultAgent = agentManager.getDefault();
      const rectifyResult = await agentManager.run({
        runOptions: {
          prompt: rectificationPrompt,
          workdir,
          modelTier: implementerTier,
          modelDef: resolveModelForAgent(
            config.models,
            story.routing?.agent ?? defaultAgent,
            implementerTier,
            defaultAgent,
          ),
          timeoutSeconds: config.execution.sessionTimeoutSeconds,
          dangerouslySkipPermissions: resolvePermissions(config, "rectification").skipPermissions,
          pipelineStage: "rectification",
          config,
          projectDir,
          maxInteractionTurns: config.agent?.maxInteractionTurns,
          featureName,
          storyId: story.id,
          sessionRole: "implementer",
          keepOpen: !isLastAttempt,
        },
      });

      if (!rectifyResult.success && rectifyResult.pid) {
        await cleanupProcessTree(rectifyResult.pid);
      }

      gateCostAccum += rectifyResult.estimatedCost ?? 0;

      if (rectifyResult.success) {
        logger.info("tdd", "Rectification agent session complete", {
          storyId: story.id,
          attempt,
          cost: rectifyResult.estimatedCost,
        });
      } else {
        logger.warn("tdd", "Rectification agent session failed", {
          storyId: story.id,
          attempt,
          exitCode: rectifyResult.exitCode,
        });
      }

      await autoCommitIfDirty(workdir, "tdd", "rectification", story.id);

      // ADR-009: pass undefined when user hasn't configured patterns → broad regex fallback in isTestFile.
      const testFilePatterns =
        typeof config.execution?.smartTestRunner === "object"
          ? config.execution.smartTestRunner?.testFilePatterns
          : undefined;
      const rectifyIsolation = lite
        ? undefined
        : await verifyImplementerIsolation(workdir, rectifyBeforeRef, testFilePatterns);
      if (rectifyIsolation && !rectifyIsolation.passed) {
        loopState.isolationPassed = false;
        logger.error("tdd", "Rectification violated isolation", {
          storyId: story.id,
          attempt,
          violations: rectifyIsolation.violations,
        });
      }
    },
    checkResult: async (attempt, state) => {
      if (!state.isolationPassed) {
        return false;
      }

      const retryFullSuite = await _rectificationGateDeps.executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
        cwd: workdir,
      });
      const retrySuitePassed = retryFullSuite.success && retryFullSuite.exitCode === 0;

      if (retrySuitePassed) {
        logger.info("tdd", "Full suite gate passed after rectification!", {
          storyId: story.id,
          attempt,
        });
        return true;
      }

      if (retryFullSuite.output) {
        const newTestSummary = _rectificationGateDeps.parseTestOutput(retryFullSuite.output);
        currentTestOutput = retryFullSuite.output;
        state.currentFailures = newTestSummary.failed;
        testSummary.failures = newTestSummary.failures;
        testSummary.failed = newTestSummary.failed;
        testSummary.passed = newTestSummary.passed;
      }

      return false;
    },
    onAttemptFailure: (attempt, state) => {
      if (!state.isolationPassed) {
        return;
      }

      logger.warn("tdd", "Full suite still failing after rectification attempt", {
        storyId: story.id,
        attempt,
        remainingFailures: state.currentFailures,
      });
    },
  });

  if (fixed) {
    return { passed: true, cost: gateCostAccum };
  }

  const finalFullSuite = await _rectificationGateDeps.executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
    cwd: workdir,
  });
  const finalSuitePassed = finalFullSuite.success && finalFullSuite.exitCode === 0;

  if (!finalSuitePassed) {
    logger.warn("tdd", "[WARN] Full suite gate failed after rectification exhausted", {
      storyId: story.id,
      attempts: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
    });
    return { passed: false, cost: gateCostAccum };
  }
  logger.info("tdd", "Full suite gate passed", { storyId: story.id });
  return { passed: true, cost: gateCostAccum };
}
