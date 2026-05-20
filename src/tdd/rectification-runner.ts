/**
 * TDD Rectification Runner
 *
 * Extracted from rectification-gate.ts: the inner runRectificationLoop function.
 * Called from full-suite-gate.ts via _fullSuiteGateDeps.runRectificationLoop.
 */

import type { IAgentManager } from "../agents";
import { resolveModelForAgent } from "../config";
import type { ModelTier } from "../config";
import type { RectificationGateConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import { formatSessionName } from "../runtime/session-name";
import type { ISessionManager } from "../session";
import { SessionKeeper } from "../session/session-keeper";
import { autoCommitIfDirty, captureGitRef } from "../utils/git";
import {
  executeWithTimeout as _executeWithTimeout,
  parseTestOutput as _parseTestOutput,
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

export interface RunRectificationLoopOptions {
  story: UserStory;
  config: RectificationGateConfig;
  workdir: string;
  agentManager: IAgentManager;
  implementerTier: ModelTier;
  lite: boolean;
  testSummary: ReturnType<typeof _parseTestOutput>;
  testCmd: string;
  fullSuiteTimeout: number;
  testOutput: string;
  runtime: import("../runtime").NaxRuntime;
  featureName?: string;
  projectDir?: string;
  sessionManager?: ISessionManager;
}

export interface RunRectificationLoopResult {
  exhausted: boolean;
  attempts: number;
  cost: number;
}

/** Injectable deps for testability */
export const _rectificationRunnerDeps = {
  executeWithTimeout: _executeWithTimeout,
  parseTestOutput: _parseTestOutput,
};

/** Run the rectification retry loop when full suite gate detects regressions. */
export async function runRectificationLoop(opts: RunRectificationLoopOptions): Promise<RunRectificationLoopResult> {
  const {
    story,
    config,
    workdir,
    agentManager,
    implementerTier,
    lite,
    testSummary,
    testCmd,
    fullSuiteTimeout,
    testOutput,
    runtime,
    featureName,
    projectDir,
    sessionManager,
  } = opts;

  const logger = getSafeLogger();
  const rectificationConfig = config.execution?.rectification ?? {};

  logger?.warn("tdd", "Full suite gate detected regressions", {
    storyId: story.id,
    failedTests: testSummary.failed,
    passedTests: testSummary.passed,
  });

  let gateCostAccum = 0;

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
          logger?.warn("tdd", "fail-adapter-error: same-agent retry with fresh session", {
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
        logger?.info("tdd", "test_edit_declared", {
          storyId: story.id,
          reason: editReasonMatch[1],
        });
      }

      gateCostAccum += rectifyResult.estimatedCostUsd ?? 0;

      logger?.info("tdd", "Rectification agent session complete", {
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

      const retryFullSuite = await _rectificationRunnerDeps.executeWithTimeout(testCmd, fullSuiteTimeout, undefined, {
        cwd: workdir,
      });
      if (retryFullSuite.success && retryFullSuite.exitCode === 0) {
        logger?.info("tdd", "Full suite gate passed after rectification!", {
          storyId: story.id,
        });
        return { passed: true };
      }

      const newTestSummary = _rectificationRunnerDeps.parseTestOutput(retryFullSuite.output ?? "");
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
    return { exhausted: false, attempts: outcome.attempts, cost: gateCostAccum };
  }

  logger?.warn("tdd", "Full suite gate failed after rectification exhausted", {
    storyId: story.id,
    attempts: outcome.attempts,
    maxAttempts: rectificationConfig.maxRetries,
  });

  return { exhausted: true, attempts: outcome.attempts, cost: gateCostAccum };
}
