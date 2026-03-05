/**
 * Post-Agent Verification (ADR-003)
 *
 * Runs verification after the agent completes, reverts story state on failure.
 */

import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PRD, StructuredFailure, UserStory, VerificationStage } from "../prd";
import { getExpectedFiles, savePRD } from "../prd";
import type { VerificationResult } from "../verification";
import { parseBunTestOutput } from "../verification";
import { revertStoriesOnFailure, runRectificationLoop } from "./post-verify-rectification";
import { runVerification } from "./verification";

/** Build a StructuredFailure from verification result and test output. */
function buildStructuredFailure(
  story: UserStory,
  stage: VerificationStage,
  verificationResult: VerificationResult,
  summary: string,
): StructuredFailure {
  const testFailures =
    verificationResult.status === "TEST_FAILURE" && verificationResult.output
      ? _postVerifyDeps.parseBunTestOutput(verificationResult.output).failures.map((f) => ({
          file: f.file,
          testName: f.testName,
          error: f.error,
          stackTrace: f.stackTrace,
        }))
      : undefined;

  return {
    attempt: (story.attempts ?? 0) + 1,
    modelTier: story.routing?.modelTier ?? "unknown",
    stage,
    summary,
    testFailures: testFailures && testFailures.length > 0 ? testFailures : undefined,
    timestamp: new Date().toISOString(),
  };
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
}

export interface PostVerifyResult {
  passed: boolean;
  prd: PRD;
}

/**
 * Run post-agent verification and handle failure state.
 *
 * @design Shell command in config.quality.commands.test is operator-controlled,
 * not user/PRD input. No shell injection risk from untrusted sources.
 */
export async function runPostAgentVerification(opts: PostVerifyOptions): Promise<PostVerifyResult> {
  const { config, prd, prdPath, workdir, featureDir, story, storiesToExecute, allStoryMetrics } = opts;

  if (!config.quality.commands.test) return { passed: true, prd };

  const rectificationEnabled = config.execution.rectification?.enabled ?? false;
  const regressionMode = config.execution.regressionGate?.mode ?? "deferred";

  // Skip per-story regression gate if mode is deferred
  if (regressionMode === "deferred") {
    return { passed: true, prd };
  }

  // Run full-suite regression gate (per-story mode)
  const regressionGateResult = await runRegressionGate(config, workdir, story, rectificationEnabled);

  if (regressionGateResult.status === "passed" || regressionGateResult.status === "skipped") {
    return { passed: true, prd };
  }

  // Regression failed -- build StructuredFailure and revert stories
  // verificationResult is always set when status === "failed" (see RegressionGateResult)
  const regressionVerificationResult = regressionGateResult.verificationResult ?? {
    status: "TEST_FAILURE" as const,
    success: false,
    countsTowardEscalation: true,
  };
  const regressionFailure = buildStructuredFailure(
    story,
    "regression",
    regressionVerificationResult,
    "Full-suite regression detected",
  );
  const updatedPrd = await _postVerifyDeps.revertStoriesOnFailure({
    prd,
    prdPath,
    story,
    storiesToExecute,
    allStoryMetrics,
    featureDir,
    diagnosticContext: "REGRESSION: full-suite regression detected",
    countsTowardEscalation: true,
    priorFailure: regressionFailure,
  });
  return { passed: false, prd: updatedPrd };
}

interface RegressionGateResult {
  status: "passed" | "skipped" | "failed";
  verificationResult?: VerificationResult;
}

/** Run full-suite regression gate. */
async function runRegressionGate(
  config: NaxConfig,
  workdir: string,
  story: UserStory,
  rectificationEnabled: boolean,
): Promise<RegressionGateResult> {
  const logger = getSafeLogger();
  const regressionGateEnabled = config.execution.regressionGate?.enabled ?? true;

  if (!regressionGateEnabled) {
    return { status: "skipped" };
  }

  logger?.info("regression-gate", "Running full-suite regression gate");
  const fullSuiteCommand = config.quality.commands.test ?? "bun test";
  const regressionResult = await _postVerifyDeps.runVerification({
    workingDirectory: workdir,
    expectedFiles: _postVerifyDeps.getExpectedFiles(story),
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

  if (regressionResult.success) {
    logger?.info("regression-gate", "Full-suite regression gate passed");
    return { status: "passed" };
  }

  // Handle timeout: accept as pass if configured (BUG-026)
  const acceptOnTimeout = config.execution.regressionGate?.acceptOnTimeout ?? true;
  if (regressionResult.status === "TIMEOUT" && acceptOnTimeout) {
    logger?.warn("regression-gate", "[BUG-026] Full-suite regression gate timed out (accepted as pass)");
    return { status: "passed" };
  }

  logger?.warn("regression-gate", "Full-suite regression detected", { status: regressionResult.status });

  // Attempt rectification on regression failures
  const isTestFailure = regressionResult.status === "TEST_FAILURE" && regressionResult.output;
  if (rectificationEnabled && isTestFailure && regressionResult.output) {
    const fixed = await _postVerifyDeps.runRectificationLoop({
      config,
      workdir,
      story,
      testCommand: fullSuiteCommand,
      timeoutSeconds: config.execution.regressionGate.timeoutSeconds,
      testOutput: regressionResult.output,
      promptPrefix:
        "# REGRESSION: Full-Suite Test Failures\n\nYour changes broke tests in the full suite. Fix these regressions.",
    });
    if (fixed) return { status: "passed" };
  }

  return { status: "failed", verificationResult: regressionResult };
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _postVerifyDeps = {
  parseBunTestOutput,
  runVerification,
  getExpectedFiles,
  savePRD,
  revertStoriesOnFailure,
  runRectificationLoop,
};
