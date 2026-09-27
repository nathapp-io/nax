/**
 * Deferred Regression Gate
 *
 * Runs full test suite once after all stories complete, then attempts
 * targeted rectification per responsible story. Handles edge cases:
 * - Partial completion: only check stories marked passed
 * - Regression attribution: use per-story gate transitions
 * - Unmapped tests: fail safely without rectifying an unrelated story
 *
 * The gate's phases (setup resolution, initial suite + guard exits,
 * attribution, the rectification loop, final verification) live in
 * ./run-regression-phases; this file is the sequencer plus the per-story
 * cycle factory. The factory stays here so the `FixCycleContext` construction
 * site and the `_regressionDeps` seam it reads remain in the file that
 * `check-bash-dispatch-ask`'s test pins for #2201.
 */

import type { NaxConfig } from "@/config";
import type { Finding, FixCycle, FixCycleContext, FixCycleResult } from "@/findings";
import { runFixCycle } from "@/findings";
import { buildRunDispatchAskWiring, type InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import { makeFullSuiteRectifyStrategy } from "@/operations";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import { parseTestOutput } from "@/test-runners";
import { storyPackageDir } from "@/utils/path-frame";
import {
  type FlakeQuarantineReport,
  fullSuite,
  type QuarantineMemo,
  resolveFlakeBaselineDiff,
  triageFlakyFindings,
} from "@/verification";
import {
  attributeAffectedStories,
  buildRegressionFindings,
  initialRectificationState,
  type RegressionFrame,
  resolveRegressionSetup,
  runFinalVerification,
  runInitialSuite,
  runRectificationLoop,
  type StoryCycleHandle,
} from "./run-regression-phases";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _regressionDeps = {
  runVerification: fullSuite,
  runFixCycle: (cycle: FixCycle<Finding>, ctx: FixCycleContext, name: string): Promise<FixCycleResult<Finding>> =>
    runFixCycle(cycle, ctx, name),
  parseTestOutput,
  triageFlakyFindings: triageFlakyFindings as (
    input: Parameters<typeof triageFlakyFindings>[0],
  ) => ReturnType<typeof triageFlakyFindings>,
  resolveFlakeBaselineDiff,
  buildRunDispatchAskWiring,
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
   * (`failingTestFiles`). Regression blame is attributed only when a gate
   * transition identifies a passed story.
   */
  storyMetrics?: readonly StorySnapshot[];
  /**
   * Shared run-scoped quarantine memo. Earlier gates in the same run can
   * pre-seed this so the regression gate relabels (not re-probes) tests
   * already judged flaky. Optional — defaults to a no-op memo when omitted.
   */
  quarantineMemo?: QuarantineMemo;
  /** The run's interaction chain — the human link of the rectifier's ask resolver (#2201). */
  interactionChain?: InteractionChain | null;
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
  /**
   * Quarantine report from the deferred-regression triage. Lists each test
   * key that was relabeled to `flaky-test` and the human-readable reason
   * (memo hit, probe verdict, etc.). Present whenever triage ran and produced
   * at least one quarantine entry; otherwise undefined.
   */
  quarantineReport?: FlakeQuarantineReport;
}

/**
 * Attribute a failing test file to the story that introduced the regression,
 * using per-story gate snapshots.
 *
 * A snapshot records the tests failing AFTER each story's full-suite gate. The
 * earliest story (chronologically, by `completedAt`) whose snapshot contains
 * the failing test is treated as where it transitioned pass -> fail — i.e. the
 * story responsible for the regression. This follows the failing test rather
 * than guessing from unrelated story commits.
 *
 * Assumptions / limitations:
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

  const setup = resolveRegressionSetup({ config, prd, workdir, logger });
  if (setup.kind === "early") return setup.result;

  // #2201: fullSuiteRectifyOp declares Bash, so the cycle context carries the
  // ask resolver + command shadow. Built per story (like the execution stage)
  // and disposed once that story's cycle settles.
  // ADR-031: a whole-feature op uses root config, including root's permissions map.
  const buildStoryCycle = async (story: UserStory, initialFindings: Finding[]): Promise<StoryCycleHandle> => {
    const packageView = runtime.packages.repo();
    const dispatchAsk = await _regressionDeps.buildRunDispatchAskWiring({
      config,
      rootConfig: config,
      projectDir: workdir,
      packageDirs: prd.userStories.map(storyPackageDir),
      interaction: options.interactionChain,
      outputDir: runtime.outputDir,
      runId: runtime.runId,
      repoRoot: workdir,
      featureName: prd.feature,
      storyId: story.id,
      abortSignal: runtime.signal,
      // US-005: the deferred regression gate runs after review — label its
      // approval prompts "review", not the execution default.
      stage: "review",
    });
    const cycleCtx: FixCycleContext = {
      runtime,
      packageView,
      packageDir: workdir,
      storyId: story.id,
      featureName: prd.feature,
      agentName: runtime.agentManager.getDefault() ?? "claude",
      story,
      askResolver: dispatchAsk.askResolver,
      ...(dispatchAsk.commandShadow ? { commandShadow: dispatchAsk.commandShadow } : {}),
    };
    const cycle: FixCycle<Finding> = {
      findings: initialFindings,
      iterations: [],
      strategies: [makeFullSuiteRectifyStrategy(story, config)],
      config: { maxAttemptsTotal: setup.maxRectificationAttempts, validatorRetries: 1 },
      validate: async (_cycleCtx, _opts) => {
        const verification = await _regressionDeps.runVerification(setup.verifyOpts);
        if (verification.success) return [];
        // Suite still failing — never return an empty finding set here, or the
        // cycle would falsely conclude "resolved" (see buildRegressionFindings).
        if (verification.output)
          return buildRegressionFindings(_regressionDeps.parseTestOutput(verification.output), verification.output);
        return initialFindings;
      },
    };
    return { cycle, cycleCtx, dispose: () => dispatchAsk.dispose() };
  };

  const frame: RegressionFrame = {
    logger,
    options,
    config,
    prd,
    workdir,
    runtime,
    testCommand: setup.testCommand,
    verifyOpts: setup.verifyOpts,
    maxRectificationAttempts: setup.maxRectificationAttempts,
    acceptOnTimeout: setup.acceptOnTimeout,
    passedStories: setup.passedStories,
    counts: setup.counts,
    deps: _regressionDeps,
    findTransition: findResponsibleStoryByTransition,
    buildStoryCycle,
  };

  const gates = await runInitialSuite(frame);
  if (gates.kind === "early") return gates.result;

  const affected = attributeAffectedStories(frame, gates);
  if (affected.kind === "early") return affected.result;

  // Emit regression:detected for each affected story
  for (const storyId of affected.outcome.affectedStories) {
    pipelineEventBus.emit({
      type: "regression:detected",
      storyId,
      failedTests: gates.testSummary.failed,
    });
  }

  // Step 3: Attempt rectification per story, with early-exit after each success
  const state = initialRectificationState(gates.rawOutput);
  const earlyExit = await runRectificationLoop(frame, state, affected.outcome);
  if (earlyExit) return earlyExit;

  // Step 4: Re-run full suite to confirm (reached only when no early exit fired)
  return runFinalVerification(frame, state, affected.outcome);
}
