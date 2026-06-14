/**
 * Deferred Regression Gate
 *
 * Runs full test suite once after all stories complete, then attempts
 * targeted rectification per responsible story. Handles edge cases:
 * - Partial completion: only check stories marked passed
 * - Overlapping file changes: try last modified story first
 * - Unmapped tests: warn and mark all passed stories for re-verification
 */

import type { NaxConfig } from "@/config";
import type { Finding, FixCycle, FixCycleContext, FixCycleResult } from "@/findings";
import { runFixCycle, testSummaryToFindings } from "@/findings";
import { getSafeLogger } from "@/logger";
import { makeFullSuiteRectifyStrategy } from "@/operations";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";
import { countStories } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import { parseTestOutput } from "@/test-runners";
import { hasCommitsForStory } from "@/utils/git";
import { fullSuite } from "@/verification";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _regressionDeps = {
  runVerification: fullSuite,
  runFixCycle: (cycle: FixCycle<Finding>, ctx: FixCycleContext, name: string): Promise<FixCycleResult<Finding>> =>
    runFixCycle(cycle, ctx, name),
  parseTestOutput,
};

/**
 * Per-story snapshot of which test files were failing after that story's
 * full-suite gate ran (post-rectification). Used to attribute an end-of-run
 * regression to the story where a test transitioned pass -> fail, instead of
 * the cruder git-recency heuristic. Only available when the per-story gate runs
 * (three-session strategies, or `regressionGate.mode === "per-story"`).
 */
export interface StorySnapshot {
  readonly storyId: string;
  /** ISO timestamp — used to order snapshots chronologically. */
  readonly completedAt: string;
  /** Test files failing at this story's gate. Absent when no gate ran. */
  readonly failingTestFiles?: readonly string[];
}

export interface DeferredRegressionOptions {
  config: NaxConfig;
  prd: PRD;
  workdir: string;
  /** NaxRuntime — provides agentManager, sessionManager, and signal for rectification. */
  runtime: NaxRuntime;
  /**
   * Per-story metrics from the main run, carrying per-story gate snapshots
   * (`failingTestFiles`). When present, regression blame is attributed via
   * gate transition (accurate) before falling back to the git heuristic.
   */
  storyMetrics?: readonly StorySnapshot[];
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
 * Attribute a failing test file to the story that introduced the regression,
 * using per-story gate snapshots.
 *
 * A snapshot records the tests failing AFTER each story's full-suite gate. The
 * earliest story (chronologically, by `completedAt`) whose snapshot contains
 * the failing test is treated as where it transitioned pass -> fail — i.e. the
 * story responsible for the regression. Unlike the git-recency heuristic in
 * {@link findResponsibleStory} (which blames whichever story most recently
 * committed, regardless of who broke the test), this follows the failing test.
 *
 * Assumptions / limitations (caller falls back to the git heuristic when this
 * returns `undefined`, so a miss degrades to prior behaviour, never worse):
 * - **Sequential only.** Callers must withhold snapshots for parallel runs:
 *   `completedAt` order is not causal there and worktrees isolate gate state.
 * - **Green baseline.** "Earliest containing" approximates a true pass -> fail
 *   edge; a failure pre-existing before the run is blamed on the first story to
 *   observe it. Pre-existing failures are normally caught earlier (greenfield
 *   gate), so this is acceptable for the regression-introduced-mid-run case.
 * - **Exact path match.** `testFile` must match the snapshot's stored path
 *   verbatim. Both sides derive from the same parser, but a monorepo package
 *   scope difference (`pkg/x/foo.test.ts` vs `foo.test.ts`) misses and falls
 *   back to the git heuristic.
 *
 * Returns the responsible story ID, or `undefined` when no snapshot shows the
 * test failing (caller should fall back to the git heuristic).
 */
export function findResponsibleStoryByTransition(
  testFile: string,
  snapshots: readonly StorySnapshot[],
): string | undefined {
  // Secondary sort by storyId keeps attribution deterministic when two stories
  // share a completedAt timestamp.
  const ordered = [...snapshots].sort(
    (a, b) => a.completedAt.localeCompare(b.completedAt) || a.storyId.localeCompare(b.storyId),
  );
  for (const snap of ordered) {
    if (snap.failingTestFiles?.includes(testFile)) {
      return snap.storyId;
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
  const { config, prd, workdir, runtime } = options;

  // The deferred regression runs for both 'deferred' and 'per-story' modes
  // ('per-story' is a superset: per-story gate during the loop + deferred at end-of-run).
  // Only 'disabled' suppresses it entirely.
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

  const testCommand = config.quality.commands.test ?? "bun test";
  const timeoutSeconds = config.execution.regressionGate?.timeoutSeconds ?? 120;
  // Regression cycle shares the unified cap from execution.rectification (one
  // budget across semantic/adversarial/mechanical/regression strategies).
  const maxRectificationAttempts = config.execution.rectification.maxAttemptsTotal;
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
    const snapshots = options.storyMetrics ?? [];
    const passedById = new Map(passedStories.map((s) => [s.id, s]));

    for (const testFile of testFilesArray) {
      // Prefer transition attribution (causal: blames the story where the test
      // went pass -> fail). Fall back to the git-recency heuristic when no gate
      // snapshot maps the test to a *passed* story (e.g. single-session +
      // deferred has no per-story gate, so no snapshots exist).
      let responsibleStory: UserStory | undefined;
      const transitionId = findResponsibleStoryByTransition(testFile, snapshots);
      if (transitionId && passedById.has(transitionId)) {
        responsibleStory = passedById.get(transitionId);
        logger?.info("regression", "Mapped test to story via gate transition", {
          storyId: transitionId,
          testFile,
        });
      }
      if (!responsibleStory) {
        responsibleStory = await findResponsibleStory(testFile, workdir, passedStories);
      }
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

  // Emit regression:detected for each affected story
  for (const storyId of affectedStories) {
    pipelineEventBus.emit({
      type: "regression:detected",
      storyId,
      failedTests: testSummary.failed,
    });
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
    logger?.info("regression", `Rectifying story ${story.id}`, {
      storyId: story.id,
      maxRectificationAttempts,
    });

    const storyStartMs = Date.now();
    const initialFindings = testSummaryToFindings(_regressionDeps.parseTestOutput(currentTestOutput));
    const packageView = runtime.packages.repo();
    const cycleCtx: FixCycleContext = {
      runtime,
      packageView,
      packageDir: workdir,
      storyId: story.id,
      featureName: prd.feature,
      agentName: runtime.agentManager.getDefault() ?? "claude",
      story,
    };
    const cycle: FixCycle<Finding> = {
      findings: initialFindings,
      iterations: [],
      strategies: [makeFullSuiteRectifyStrategy(story, config)],
      config: { maxAttemptsTotal: maxRectificationAttempts, validatorRetries: 1 },
      validate: async (_cycleCtx, _opts) => {
        const verification = await _regressionDeps.runVerification(verifyOpts);
        if (verification.success) return [];
        if (verification.output) return testSummaryToFindings(_regressionDeps.parseTestOutput(verification.output));
        return initialFindings;
      },
    };

    const cycleResult = await _regressionDeps.runFixCycle(cycle, cycleCtx, "regression");
    const succeeded = cycleResult.exitReason === "resolved";
    const cost = cycleResult.costUsd ?? 0;
    const durationMs = Date.now() - storyStartMs;
    rectificationAttempts += cycleResult.iterations.length > 0 ? cycleResult.iterations.length : 1;

    // Accumulate telemetry regardless of whether the cycle succeeded (issue #679).
    // Story outcome is latched true once any cycle succeeds; default false otherwise.
    storyCostAccum[story.id] = (storyCostAccum[story.id] ?? 0) + cost;
    storyDurationAccum[story.id] = (storyDurationAccum[story.id] ?? 0) + durationMs;
    if (!storyOutcomeAccum[story.id]) {
      storyOutcomeAccum[story.id] = succeeded;
    }

    if (succeeded) {
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
