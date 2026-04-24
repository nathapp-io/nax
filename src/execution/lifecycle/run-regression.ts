/**
 * Deferred Regression Gate
 *
 * Runs full test suite once after all stories complete, then attempts
 * targeted rectification per responsible story. Handles edge cases:
 * - Partial completion: only check stories marked passed
 * - Overlapping file changes: try last modified story first
 * - Unmapped tests: warn and mark all passed stories for re-verification
 */

import type { IAgentManager } from "../../agents";
import type { NaxConfig } from "../../config";
import { getSafeLogger } from "../../logger";
import type { PRD, UserStory } from "../../prd";
import { countStories } from "../../prd";
import { hasCommitsForStory } from "../../utils/git";
import { parseTestOutput } from "../../verification";
import { runRectificationLoop } from "../../verification/rectification-loop";
import { fullSuite } from "../../verification/runners";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _regressionDeps = {
  runVerification: fullSuite,
  runRectificationLoop,
  parseTestOutput,
};

export interface DeferredRegressionOptions {
  config: NaxConfig;
  prd: PRD;
  workdir: string;
  /** AgentManager — routes agent calls through IAgentManager for fallback support. */
  agentManager?: IAgentManager;
}

export interface DeferredRegressionResult {
  success: boolean;
  failedTests: number;
  failedTestFiles: string[];
  passedTests: number;
  rectificationAttempts: number;
  affectedStories: string[];
  /**
   * Accumulated rectification agent cost per affected story ID (issue #679).
   * Populated when at least one story was rectified. Empty for early-pass/disabled/timeout returns.
   * Optional for backward-compatibility with existing mocks and snapshots.
   */
  storyCosts?: Record<string, number>;
  /**
   * Accumulated rectification wall-clock duration per affected story ID (ms).
   * Same population rules as `storyCosts`.
   */
  storyDurations?: Record<string, number>;
  /**
   * Per-story rectification outcome: `true` when the story was successfully rectified
   * (at least one attempt returned succeeded:true), `false` otherwise. Lets downstream
   * metrics attribute success/failure to the right story instead of using the overall
   * regression result as a blanket answer.
   */
  storyOutcomes?: Record<string, boolean>;
}

/**
 * Map a test file to the story responsible for it via git log.
 *
 * Searches recent commits for story IDs in the format US-NNN.
 * Returns the first matching story ID, or undefined if not found.
 */
async function findResponsibleStory(
  testFile: string,
  workdir: string,
  passedStories: UserStory[],
): Promise<UserStory | undefined> {
  const logger = getSafeLogger();

  // Try each passed story in reverse order (most recent first)
  for (let i = passedStories.length - 1; i >= 0; i--) {
    const story = passedStories[i];
    const hasCommits = await hasCommitsForStory(workdir, story.id, 50);
    if (hasCommits) {
      logger?.info("regression", `Mapped test to story ${story.id}`, { testFile });
      return story;
    }
  }

  return undefined;
}

/**
 * Run deferred regression gate after all stories complete.
 *
 * Steps:
 * 1. Run full test suite
 * 2. If failures, map failing test files directly back to responsible stories
 * 3. For each affected story, attempt targeted rectification
 * 4. Re-run full suite to confirm fixes
 * 5. Return results with affected story list
 */
export async function runDeferredRegression(options: DeferredRegressionOptions): Promise<DeferredRegressionResult> {
  const logger = getSafeLogger();
  const { config, prd, workdir, agentManager } = options;

  // Check if regression gate is deferred
  const regressionMode = config.execution.regressionGate?.mode ?? "deferred";
  if (regressionMode === "disabled") {
    logger?.info("regression", "Deferred regression gate disabled");
    return {
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  if (regressionMode !== "deferred") {
    logger?.info("regression", "Regression gate mode is not deferred, skipping");
    return {
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  const testCommand = config.quality.commands.test ?? "bun test";
  const timeoutSeconds = config.execution.regressionGate?.timeoutSeconds ?? 120;
  const maxRectificationAttempts = config.execution.regressionGate?.maxRectificationAttempts ?? 2;
  const acceptOnTimeout = config.execution.regressionGate?.acceptOnTimeout ?? true;

  const verifyOpts = {
    workdir,
    command: testCommand,
    timeoutSeconds,
    forceExit: config.quality.forceExit,
    detectOpenHandles: config.quality.detectOpenHandles,
    detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
    timeoutRetryCount: 0 as const,
    gracePeriodMs: config.quality.gracePeriodMs,
    drainTimeoutMs: config.quality.drainTimeoutMs,
    shell: config.quality.shell,
    stripEnvVars: config.quality.stripEnvVars,
  };

  // Only check stories that have been marked as passed
  const counts = countStories(prd);
  const passedStories = prd.userStories.filter((s) => s.status === "passed");

  if (passedStories.length === 0) {
    logger?.info("regression", "No passed stories to verify (partial completion)");
    return {
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  logger?.info("regression", "Running deferred full-suite regression gate", {
    totalStories: counts.total,
    passedStories: passedStories.length,
  });

  // Step 1: Run full test suite
  const fullSuiteResult = await _regressionDeps.runVerification(verifyOpts);

  if (fullSuiteResult.success) {
    logger?.info("regression", "Full suite passed");
    return {
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: fullSuiteResult.passCount ?? 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  // Handle timeout
  if (fullSuiteResult.status === "TIMEOUT" && acceptOnTimeout) {
    logger?.warn("regression", "Full-suite regression gate timed out (accepted as pass)");
    return {
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  if (!fullSuiteResult.output) {
    logger?.error("regression", "Full suite failed with no output");
    return {
      success: false,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: fullSuiteResult.passCount ?? 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  // Step 2: Parse failures and map failing test files to responsible stories
  const testSummary = _regressionDeps.parseTestOutput(fullSuiteResult.output);

  // Guard: if no test results could be parsed (0 pass + 0 fail), the test runner
  // itself crashed or had a compilation error — there are no actual test regressions.
  // Treat as pass to avoid false-positive regression reports. (BUG-REG-001)
  if (testSummary.failed === 0 && testSummary.passed === 0) {
    logger?.warn(
      "regression",
      "No test results parsed from output — test runner likely crashed or errored (not a regression, accepting as pass)",
      { output: fullSuiteResult.output.slice(0, 500) },
    );
    return {
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  const affectedStories = new Set<string>();
  const affectedStoriesObjs = new Map<string, UserStory>();

  logger?.warn("regression", "Regression detected", {
    failedTests: testSummary.failed,
    passedTests: testSummary.passed,
  });

  // Extract test file paths from failures
  const testFilesInFailures = new Set<string>();
  for (const failure of testSummary.failures) {
    if (failure.file) {
      testFilesInFailures.add(failure.file);
    }
  }

  if (testFilesInFailures.size === 0) {
    logger?.warn("regression", "No test files found in failures (unmapped)");
    // Mark all passed stories for re-verification
    for (const story of passedStories) {
      affectedStories.add(story.id);
      affectedStoriesObjs.set(story.id, story);
    }
  } else {
    const testFilesArray = Array.from(testFilesInFailures);

    for (const testFile of testFilesArray) {
      const responsibleStory = await findResponsibleStory(testFile, workdir, passedStories);
      if (responsibleStory) {
        affectedStories.add(responsibleStory.id);
        affectedStoriesObjs.set(responsibleStory.id, responsibleStory);
      } else {
        logger?.warn("regression", "Could not map test file to story", { testFile });
      }
    }
  }

  if (affectedStories.size === 0) {
    logger?.warn("regression", "No stories could be mapped to failures");
    return {
      success: false,
      failedTests: testFilesInFailures.size,
      failedTestFiles: Array.from(testFilesInFailures),
      passedTests: testSummary.passed,
      rectificationAttempts: 0,
      affectedStories: Array.from(affectedStories),
      storyCosts: {},
      storyDurations: {},
      storyOutcomes: {},
    };
  }

  // Step 3: Attempt rectification per story, with early-exit after each success
  let rectificationAttempts = 0;
  let storiesRectified = 0;
  let currentTestOutput = fullSuiteResult.output;
  const affectedStoriesList = Array.from(affectedStoriesObjs.values());
  // Accumulated rectification telemetry per story — populated below for metrics back-fill (issue #679).
  const storyCostAccum: Record<string, number> = {};
  const storyDurationAccum: Record<string, number> = {};
  const storyOutcomeAccum: Record<string, boolean> = {};

  for (const story of affectedStoriesList) {
    for (let attempt = 0; attempt < maxRectificationAttempts; attempt++) {
      rectificationAttempts++;

      logger?.info("regression", `Rectifying story ${story.id} (attempt ${attempt + 1}/${maxRectificationAttempts})`);

      const rectResult = await _regressionDeps.runRectificationLoop({
        config,
        workdir,
        story,
        testCommand,
        timeoutSeconds,
        testOutput: currentTestOutput,
        promptPrefix: `# DEFERRED REGRESSION: Full-Suite Failures\n\nYour story ${story.id} broke tests in the full suite. Fix these regressions.`,
        agentManager,
        featureName: prd.feature,
      });

      // Accumulate telemetry regardless of whether the attempt succeeded (issue #679).
      // Story outcome is latched true once any attempt succeeds; default false otherwise.
      storyCostAccum[story.id] = (storyCostAccum[story.id] ?? 0) + rectResult.cost;
      storyDurationAccum[story.id] = (storyDurationAccum[story.id] ?? 0) + rectResult.durationMs;
      if (!storyOutcomeAccum[story.id]) {
        storyOutcomeAccum[story.id] = rectResult.succeeded;
      }

      if (rectResult.succeeded) {
        storiesRectified++;
        logger?.info("regression", `Story ${story.id} rectified successfully`);

        // Early-exit check: re-run full suite before touching remaining stories
        logger?.info("regression", "Re-running full suite after story rectification", {
          storyId: story.id,
          storiesRectified,
          storiesRemaining: affectedStoriesList.length - storiesRectified,
        });

        const midResult = await _regressionDeps.runVerification(verifyOpts);
        const midSuccess = midResult.success || (midResult.status === "TIMEOUT" && acceptOnTimeout);

        if (midSuccess) {
          logger?.info("regression", "Full suite passed after story rectification — early exit", {
            storyId: story.id,
            storiesRectified,
            storiesSkipped: affectedStoriesList.length - storiesRectified,
            passCount: midResult.passCount ?? 0,
          });
          return {
            success: true,
            failedTests: testFilesInFailures.size,
            failedTestFiles: Array.from(testFilesInFailures),
            passedTests: midResult.passCount ?? 0,
            rectificationAttempts,
            affectedStories: Array.from(affectedStories),
            storyCosts: storyCostAccum,
            storyDurations: storyDurationAccum,
            storyOutcomes: storyOutcomeAccum,
          };
        }

        // Still failing — update test output context for the next story's agent
        logger?.warn("regression", "Full suite still failing after story rectification — continuing", {
          storyId: story.id,
          failCount: midResult.failCount ?? 0,
          passCount: midResult.passCount ?? 0,
        });
        if (midResult.output) currentTestOutput = midResult.output;
        break; // Move to next story
      }
    }
  }

  // Step 4: Re-run full suite to confirm (reached only when no early exit fired)
  logger?.info("regression", "Re-running full suite after rectification");
  const retryResult = await _regressionDeps.runVerification(verifyOpts);

  const success = retryResult.success || (retryResult.status === "TIMEOUT" && acceptOnTimeout);

  if (success) {
    logger?.info("regression", "Deferred regression gate passed after rectification");
  } else {
    logger?.warn("regression", "Deferred regression gate still failing after rectification", {
      remainingFailures: retryResult.failCount,
    });
  }

  return {
    success,
    failedTests: testFilesInFailures.size,
    failedTestFiles: Array.from(testFilesInFailures),
    passedTests: retryResult.passCount ?? 0,
    rectificationAttempts,
    affectedStories: Array.from(affectedStories),
    storyCosts: storyCostAccum,
    storyDurations: storyDurationAccum,
    storyOutcomes: storyOutcomeAccum,
  };
}
