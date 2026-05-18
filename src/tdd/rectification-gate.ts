/**
 * TDD Full-Suite Rectification Gate
 *
 * Extracted from orchestrator.ts: runFullSuiteGate
 * Runs the full test suite before the verifier session and performs
 * rectification retries if regressions are detected.
 */

import type { IAgentManager } from "../agents";
import { resolveModelForAgent } from "../config";
import type { ModelTier } from "../config";
import type { RectificationGateConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import type { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import { resolveQualityTestCommands } from "../quality/command-resolver";
import type { ISessionManager } from "../session";
import { formatSessionName } from "../session/naming";
import { SessionKeeper } from "../session/session-keeper";
import { autoCommitIfDirty, captureGitRef } from "../utils/git";
import {
  executeWithTimeout as _executeWithTimeout,
  parseTestOutput as _parseTestOutput,
  shouldRetryRectification as _shouldRetryRectification,
  runRetryLoop,
} from "../verification";
import { buildFailureRecords } from "../verification/failure-records";
import { verifyImplementerIsolation } from "./isolation";

/** Failure snapshot for the TDD rectification gate retry loop. */
interface TddRectificationFailure {
  testSummary: ReturnType<typeof _parseTestOutput>;
  testOutput: string;
  isolationPassed: boolean;
}

/** Result from one TDD rectification attempt. */
interface TddRectificationAttemptResult {
  agentSuccess: boolean;
  cost: number;
  isolationPassed: boolean;
}

export type FullSuiteGateStatus =
  | "disabled"
  | "passed"
  | "passed-with-nonzero-exit"
  | "deferred-unattributable"
  | "inconclusive"
  | "execution-failed"
  | "rectification-exhausted";

export interface FullSuiteGateResult {
  passed: boolean;
  cost: number;
  fullSuiteGatePassed: boolean;
  status: FullSuiteGateStatus;
  attempts?: number;
}

/** Injectable deps for testability — avoids mock.module() contamination */
export const _rectificationGateDeps = {
  executeWithTimeout: _executeWithTimeout,
  parseTestOutput: _parseTestOutput,
  shouldRetryRectification: _shouldRetryRectification,
  resolveTestCommands: resolveQualityTestCommands,
};

/**
 * Run full test suite gate before verifier session (v0.11 Rectification).
 *
 * Pre-condition: the baseline test suite is green at the start of the run.
 * Any failure observed here is treated as story-caused and routed to the
 * rectification loop. The previous file-modification-based filter (BUG-TC-001 /
 * PR #656) silently suppressed real regressions whenever a story changed source
 * code that broke a sibling spec it didn't author (e.g. editing rag.service.ts
 * breaking rag.service.spec.ts), so it has been removed. The deferred regression
 * gate in execution/lifecycle/run-regression.ts is the run-level safety net.
 */
export async function runFullSuiteGate(
  story: UserStory,
  config: RectificationGateConfig,
  workdir: string,
  agentManager: IAgentManager,
  implementerTier: ModelTier,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  featureName: string | undefined,
  projectDir: string | undefined,
  sessionManager: ISessionManager | undefined,
  runtime: import("../runtime").NaxRuntime,
): Promise<FullSuiteGateResult> {
  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  if (!rectificationEnabled) {
    return { passed: false, cost: 0, fullSuiteGatePassed: false, status: "disabled" };
  }

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
      if (testSummary.failures.length === 0) {
        logger.warn("tdd", "Full suite gate found unattributable failures — deferring to run-level regression", {
          storyId: story.id,
          failedTests: testSummary.failed,
          passedTests: testSummary.passed,
          outputLength: fullSuiteResult.output.length,
          outputTail: fullSuiteResult.output.slice(-200),
        });
        return { passed: true, cost: 0, fullSuiteGatePassed: false, status: "deferred-unattributable" };
      }

      return await runRectificationLoop(
        story,
        config,
        workdir,
        agentManager,
        implementerTier,
        lite,
        logger,
        testSummary,
        rectificationConfig,
        effectiveTestCmd,
        fullSuiteTimeout,
        fullSuiteResult.output,
        runtime,
        featureName,
        projectDir,
        sessionManager,
      );
    }

    // @design: BUG-059 / BUG-060 defense: parser counter mismatch (failed===0
    // but failures.length>0) is an unreliable signal — we can't determine the
    // true failure count so we fail the gate without entering the rectification
    // loop. The run-level regression gate is the safety net for these cases.
    if (testSummary.failures.length > 0) {
      logger.warn("tdd", "Full suite gate: parser counter mismatch — failing gate (unreliable failure count)", {
        storyId: story.id,
        failedCounter: testSummary.failed,
        failuresLength: testSummary.failures.length,
        exitCode: fullSuiteResult.exitCode,
      });
      return { passed: false, cost: 0, fullSuiteGatePassed: false, status: "execution-failed" };
    }

    // @design: BUG-059: Non-zero exit with 0 parsed failures could mean:
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
      return { passed: true, cost: 0, fullSuiteGatePassed: true, status: "passed-with-nonzero-exit" };
    }

    // No tests passed AND no tests failed — output is likely truncated/crashed
    logger.warn("tdd", "Full suite gate inconclusive — no test results parsed from output (possible crash/OOM)", {
      storyId: story.id,
      exitCode: fullSuiteResult.exitCode,
      outputLength: fullSuiteResult.output.length,
      outputTail: fullSuiteResult.output.slice(-200),
    });
    return { passed: false, cost: 0, fullSuiteGatePassed: false, status: "inconclusive" };
  }
  if (fullSuitePassed) {
    logger.info("tdd", "Full suite gate passed", { storyId: story.id });
    return { passed: true, cost: 0, fullSuiteGatePassed: true, status: "passed" };
  }
  logger.warn("tdd", "Full suite gate execution failed (no output)", {
    storyId: story.id,
    exitCode: fullSuiteResult.exitCode,
  });
  return { passed: false, cost: 0, fullSuiteGatePassed: false, status: "execution-failed" };
}

/** Run the rectification retry loop when full suite gate detects regressions. */
async function runRectificationLoop(
  story: UserStory,
  config: RectificationGateConfig,
  workdir: string,
  agentManager: IAgentManager,
  implementerTier: ModelTier,
  lite: boolean,
  logger: ReturnType<typeof getLogger>,
  testSummary: ReturnType<typeof _parseTestOutput>,
  rectificationConfig: NonNullable<RectificationGateConfig["execution"]["rectification"]>,
  testCmd: string,
  fullSuiteTimeout: number,
  testOutput: string,
  runtime: import("../runtime").NaxRuntime,
  featureName?: string,
  projectDir?: string,
  sessionManager?: ISessionManager,
): Promise<FullSuiteGateResult> {
  logger.warn("tdd", "Full suite gate detected regressions", {
    storyId: story.id,
    failedTests: testSummary.failed,
    passedTests: testSummary.passed,
  });

  let gateCostAccum = 0;
  let currentAttempt = 0;

  const rectificationSessionName = formatSessionName({
    workdir,
    featureName,
    storyId: story.id,
    role: "implementer",
  });

  // ADR-008 §6 / ADR-018 §7 Pattern B: hold the implementer session open across
  // all attempts in this rectification cycle so the agent retains conversation
  // history between attempts. SessionKeeper manages the handle lifecycle.
  const defaultAgent = agentManager.getDefault();
  const keeper = new SessionKeeper(runtime.sessionManager, agentManager, {
    sessionName: rectificationSessionName,
    defaultAgent,
    role: "implementer",
    pipelineStage: "rectification",
    storyId: story.id,
    featureName: featureName ?? "",
    workdir,
    projectDir,
    modelDef: resolveModelForAgent(config.models, story.routing?.agent ?? defaultAgent, implementerTier, defaultAgent),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
    signal: runtime.signal,
    maxTurns: config.agent?.maxInteractionTurns,
    retryStrategy: {
      shouldRetry(_err, attempt) {
        const maxRetries = config.execution?.sessionErrorRetryableMaxRetries ?? 3;
        if (attempt < maxRetries) {
          getSafeLogger()?.warn("tdd", "fail-adapter-error: same-agent retry with fresh session", {
            storyId: story.id,
            attempt: attempt + 1,
            maxAttempts: maxRetries,
            retriable: true,
          });
          return { retry: true, delayMs: 0 };
        }
        return { retry: false };
      },
    },
  });

  const initialFailure: TddRectificationFailure = {
    testSummary,
    testOutput,
    isolationPassed: true,
  };

  const outcome = await runRetryLoop<TddRectificationFailure, TddRectificationAttemptResult>({
    stage: "rectification",
    storyId: story.id,
    packageDir: workdir,
    maxAttempts: rectificationConfig.maxRetries,
    failure: initialFailure,
    previousAttempts: [],
    buildPrompt: (failure) => {
      const failureRecords = buildFailureRecords(failure.testSummary, failure.testOutput);
      return RectifierPromptBuilder.regressionFailure({
        story,
        failures: failureRecords,
        testCommand: testCmd,
        conventions: true,
      });
    },
    execute: async (prompt) => {
      currentAttempt++;
      const rectifyBeforeRef = (await captureGitRef(workdir)) ?? "HEAD";

      // ADR-020 single-emission invariant: each runAsSession emits one
      // session-turn event for audit/cost subscribers, regardless of handle
      // reuse across attempts.
      const turn = await keeper.send({ prompt });
      const rectifyResult = {
        success: true,
        exitCode: 0,
        output: turn.output,
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: turn.estimatedCostUsd,
        ...(turn.exactCostUsd !== undefined && { exactCostUsd: turn.exactCostUsd }),
        ...(turn.tokenUsage && { tokenUsage: turn.tokenUsage }),
      };

      // G5: bind updated protocolIds after each rectification attempt so the session descriptor
      // reflects the session that actually ran (may change after internal session retries).
      // Only binds when the optional sessionManager was explicitly provided by the caller.
      keeper.bindProtocolIdsTo(sessionManager);

      const editReasonMatch = rectifyResult.output?.match(/TEST_EDIT_REASON:\s*(\w+)/);
      if (editReasonMatch) {
        getSafeLogger()?.info("tdd", "test_edit_declared", {
          storyId: story.id,
          reason: editReasonMatch[1],
        });
      }

      gateCostAccum += rectifyResult.estimatedCostUsd ?? 0;

      logger.info("tdd", "Rectification agent session complete", {
        storyId: story.id,
        cost: rectifyResult.estimatedCostUsd,
      });

      await autoCommitIfDirty(workdir, "tdd", "rectification", story.id);

      const testFilePatterns =
        typeof config.execution?.smartTestRunner === "object"
          ? config.execution.smartTestRunner?.testFilePatterns
          : undefined;
      const rectifyIsolation = lite
        ? undefined
        : await verifyImplementerIsolation(workdir, rectifyBeforeRef, testFilePatterns);
      const isolationPassed = !rectifyIsolation || rectifyIsolation.passed;

      return {
        agentSuccess: rectifyResult.success,
        cost: rectifyResult.estimatedCostUsd ?? 0,
        isolationPassed,
      };
    },
    verify: async (result) => {
      if (!result.isolationPassed) {
        return {
          passed: false,
          newFailure: {
            testSummary: initialFailure.testSummary,
            testOutput: initialFailure.testOutput,
            isolationPassed: false,
          },
        };
      }

      const retryFullSuite = await _rectificationGateDeps.executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
        cwd: workdir,
      });
      if (retryFullSuite.success && retryFullSuite.exitCode === 0) {
        logger.info("tdd", "Full suite gate passed after rectification!", {
          storyId: story.id,
        });
        return { passed: true };
      }

      const newTestSummary = _rectificationGateDeps.parseTestOutput(retryFullSuite.output ?? "");
      return {
        passed: false,
        newFailure: {
          testSummary: newTestSummary,
          testOutput: retryFullSuite.output ?? "",
          isolationPassed: true,
        },
      };
    },
  }).finally(async () => {
    // ADR-008 §6: close the held implementer session at loop exit. Best-effort.
    await keeper.close();
  });

  const fixed = outcome.outcome === "fixed";

  if (fixed) {
    return { passed: true, cost: gateCostAccum, fullSuiteGatePassed: true, status: "passed" };
  }

  logger.warn("tdd", "[WARN] Full suite gate failed after rectification exhausted", {
    storyId: story.id,
    attempts: outcome.attempts,
  });
  return {
    passed: false,
    cost: gateCostAccum,
    fullSuiteGatePassed: false,
    status: "rectification-exhausted",
    attempts: outcome.attempts,
  };
}
