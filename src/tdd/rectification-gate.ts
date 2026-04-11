/**
 * TDD Full-Suite Rectification Gate
 *
 * Extracted from orchestrator.ts: runFullSuiteGate
 * Runs the full test suite before the verifier session and performs
 * rectification retries if regressions are detected.
 */

import type { AgentAdapter } from "../agents";
import { buildSessionName } from "../agents/acp/adapter";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { resolvePermissions } from "../config/permissions";
import type { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import { resolveQualityTestCommands } from "../quality/command-resolver";
import { autoCommitIfDirty, captureGitRef } from "../utils/git";
import {
  type RectificationState,
  executeWithTimeout as _executeWithTimeout,
  parseTestOutput as _parseTestOutput,
  shouldRetryRectification as _shouldRetryRectification,
  runSharedRectificationLoop,
} from "../verification";
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
  projectDir?: string,
): Promise<{ passed: boolean; cost: number }> {
  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  if (!rectificationEnabled) return { passed: false, cost: 0 };

  const rectificationConfig = config.execution.rectification;
  const fullSuiteTimeout = rectificationConfig.fullSuiteTimeoutSeconds;

  // Resolve test commands via SSOT — handles priority, {{package}}, and orchestrator promotion.
  const { testCommand: resolvedTestCmd, testScopedTemplate: effectiveScopedTemplate } =
    await _rectificationGateDeps.resolveTestCommands(config, workdir, story.workdir);
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
        effectiveTestCmd,
        fullSuiteTimeout,
        featureName,
        projectDir,
        effectiveScopedTemplate,
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
  agent: AgentAdapter,
  implementerTier: ModelTier,
  _contextMarkdown: string | undefined,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  testSummary: ReturnType<typeof _parseTestOutput>,
  rectificationConfig: NonNullable<NaxConfig["execution"]["rectification"]>,
  testCmd: string,
  fullSuiteTimeout: number,
  featureName?: string,
  projectDir?: string,
  testScopedTemplate?: string,
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
  const rectificationSessionName = buildSessionName(workdir, featureName, story.id, "implementer");
  logger.debug("tdd", "Rectification session name (shared across all attempts)", {
    storyId: story.id,
    sessionName: rectificationSessionName,
  });

  const loopState = {
    ...rectificationState,
    isolationPassed: true,
  };
  let gateCostAccum = 0;

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
    buildPrompt: () =>
      RectifierPromptBuilder.for("tdd-suite-failure")
        .story(story)
        .priorFailures(testSummary.failures, rectificationConfig)
        .testCommand(testCmd)
        .scopeThreshold(config.quality?.scopeTestThreshold)
        .testScopedTemplate(testScopedTemplate)
        .build(),
    runAttempt: async (attempt, rectificationPrompt) => {
      const isLastAttempt = attempt >= rectificationConfig.maxRetries;
      const rectifyBeforeRef = (await captureGitRef(workdir)) ?? "HEAD";

      const rectifyResult = await agent.run({
        prompt: rectificationPrompt,
        workdir,
        modelTier: implementerTier,
        modelDef: resolveModelForAgent(
          config.models,
          story.routing?.agent ?? config.autoMode.defaultAgent,
          implementerTier,
          config.autoMode.defaultAgent,
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
        acpSessionName: rectificationSessionName,
        keepSessionOpen: !isLastAttempt,
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

      const rectifyIsolation = lite ? undefined : await verifyImplementerIsolation(workdir, rectifyBeforeRef);
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
