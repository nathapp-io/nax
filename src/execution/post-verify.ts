/**
 * Post-Agent Verification (ADR-003)
 *
 * Runs verification after the agent completes, reverts story state on failure.
 */

import { spawn } from "bun";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PRD, StructuredFailure, UserStory, VerificationStage } from "../prd";
import { getExpectedFiles, savePRD } from "../prd";
import type { TestFailure, VerificationResult } from "../verification";
import { parseBunTestOutput } from "../verification";
import { getTierConfig } from "./escalation";
import { revertStoriesOnFailure, runRectificationLoop } from "./post-verify-rectification";
import { appendProgress } from "./progress";
import { getEnvironmentalEscalationThreshold, parseTestOutput, runVerification } from "./verification";

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

/** Get test files changed since a git ref. Returns empty array if detection fails. */
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

/** Scope a test command to only run specific test files. */
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
  storyGitRef?: string;
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

  if (!config.quality.commands.test) return { passed: true, prd };

  // Scoped verification: only run test files changed by this story
  const changedTestFiles = await getChangedTestFiles(workdir, storyGitRef);
  const testCommand = scopeTestCommand(config.quality.commands.test, changedTestFiles);
  const timeoutRetryCount = timeoutRetryCountMap.get(story.id) || 0;

  const verificationResult = await _postVerifyDeps.runVerification({
    workingDirectory: workdir,
    expectedFiles: _postVerifyDeps.getExpectedFiles(story),
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

  const rectificationEnabled = config.execution.rectification?.enabled ?? false;

  if (verificationResult.success) {
    logger?.info("verification", "Scoped verification passed");
    if (verificationResult.output) {
      const analysis = _postVerifyDeps.parseTestOutput(verificationResult.output, 0);
      if (analysis.passCount > 0) {
        logger?.debug("verification", "Scoped test results", {
          passCount: analysis.passCount,
          failCount: analysis.failCount,
        });
      }
    }

    // Regression Gate (BUG-009): run full suite after scoped tests pass
    const regressionGateResult = await runRegressionGate(
      config,
      workdir,
      story,
      changedTestFiles,
      rectificationEnabled,
    );
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

  // --- Verification failed ---
  // Attempt rectification if enabled and tests failed (not timeout/env)
  const isTestFailure = verificationResult.status === "TEST_FAILURE" && verificationResult.output;
  if (rectificationEnabled && isTestFailure && verificationResult.output) {
    const fixed = await _postVerifyDeps.runRectificationLoop({
      config,
      workdir,
      story,
      testCommand,
      timeoutSeconds: config.execution.verificationTimeoutSeconds,
      testOutput: verificationResult.output,
    });
    if (fixed) return { passed: true, prd };
  }

  // Track timeout retries for --detectOpenHandles escalation
  if (verificationResult.status === "TIMEOUT") {
    timeoutRetryCountMap.set(story.id, timeoutRetryCount + 1);
  }

  logger?.warn("verification", `Verification ${verificationResult.status}`, {
    status: verificationResult.status,
    error: verificationResult.error?.split("\n")[0],
  });

  // Handle environmental failure escalation
  if (verificationResult.countsTowardEscalation && verificationResult.status === "ENVIRONMENTAL_FAILURE") {
    checkEnvironmentalEscalation(config, story, prd, logger);
  }

  // Revert stories and save
  const diagnosticContext = verificationResult.error || `Verification failed: ${verificationResult.status}`;
  const verifyFailure = buildStructuredFailure(story, "verify", verificationResult, diagnosticContext);
  const updatedPrd = await _postVerifyDeps.revertStoriesOnFailure({
    prd,
    prdPath,
    story,
    storiesToExecute,
    allStoryMetrics,
    featureDir,
    diagnosticContext,
    countsTowardEscalation: verificationResult.countsTowardEscalation ?? false,
    priorFailure: verifyFailure,
  });

  return { passed: false, prd: updatedPrd };
}

interface RegressionGateResult {
  status: "passed" | "skipped" | "failed";
  verificationResult?: VerificationResult;
}

/** Run regression gate (full suite) after scoped tests pass. */
async function runRegressionGate(
  config: NaxConfig,
  workdir: string,
  story: UserStory,
  changedTestFiles: string[],
  rectificationEnabled: boolean,
): Promise<RegressionGateResult> {
  const logger = getSafeLogger();
  const regressionGateEnabled = config.execution.regressionGate?.enabled ?? true;
  const scopedTestsWereRun = changedTestFiles.length > 0;

  if (!regressionGateEnabled || !scopedTestsWereRun) {
    if (regressionGateEnabled && !scopedTestsWereRun) {
      logger?.debug("regression-gate", "Skipping regression gate (full suite already run in scoped verification)");
    }
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
    logger?.warn("regression-gate", "[BUG-026] Full-suite regression gate timed out (accepted as pass)", {
      reason: "Timeout is not evidence of regression — scoped verification already passed",
    });
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
        "# REGRESSION: Cross-Story Test Failures\n\nYour changes passed scoped tests but broke unrelated tests. Fix these regressions.",
    });
    if (fixed) return { status: "passed" };
  }

  return { status: "failed", verificationResult: regressionResult };
}

/** Check if environmental failure should trigger early escalation. */
function checkEnvironmentalEscalation(
  config: NaxConfig,
  story: UserStory,
  prd: PRD,
  logger: ReturnType<typeof getSafeLogger>,
): void {
  const currentTier = story.routing?.modelTier || config.autoMode.escalation.tierOrder[0]?.tier;
  const tierCfg = currentTier
    ? _postVerifyDeps.getTierConfig(currentTier, config.autoMode.escalation.tierOrder)
    : undefined;
  if (!tierCfg) return;

  const threshold = _postVerifyDeps.getEnvironmentalEscalationThreshold(
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

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _postVerifyDeps = {
  parseBunTestOutput,
  parseTestOutput,
  runVerification,
  getExpectedFiles,
  savePRD,
  revertStoriesOnFailure,
  runRectificationLoop,
  appendProgress,
  getTierConfig,
  getEnvironmentalEscalationThreshold,
};
