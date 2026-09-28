/**
 * Run completion — deferred regression gate phase.
 *
 * Extracted from run-completion.ts (complexity-drain batch A9). The gate is
 * the largest single phase of handleRunCompletion: run the deferred
 * regression gate (when configured and not skipped), surface its result
 * through the status writer and the pipeline event bus, mark affected
 * stories, fire the on-final-regression-fail hook, and fold rectification
 * costs and outcomes back into the run's story metrics (#679).
 *
 * The phase functions receive `_runCompletionDeps` BY REFERENCE as `deps`
 * (typed by `RegressionGateDeps`) and read `deps.X` at call time — the seam
 * object stays defined in run-completion.ts and is re-exported through the
 * lifecycle barrel for tests to mutate, so test reassignments keep landing.
 * This file imports run-completion.ts TYPE-ONLY; importing it at runtime
 * would cycle back to the seam (the A1 trap from complexity-drain §9.2).
 */

import { resolveDefaultAgent } from "@/agents";
import type { NaxConfig } from "@/config";
import type { fireHook } from "@/hooks";
import type { HooksConfig } from "@/hooks/types";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD } from "@/prd";
import type { StatusWriter } from "../status-writer";
import type { RunCompletionOptions } from "./run-completion";
import type { runDeferredRegression } from "./run-regression";

/**
 * The slice of `_runCompletionDeps` this phase calls. Members are read at
 * call time so tests that reassign `_runCompletionDeps.X` between
 * handleRunCompletion() and this phase keep landing.
 */
export interface RegressionGateDeps {
  runDeferredRegression: typeof runDeferredRegression;
  fireHook: typeof fireHook;
}

export interface RegressionGateInput {
  options: RunCompletionOptions;
  config: NaxConfig;
  prd: PRD;
  workdir: string;
  feature: string;
  allStoryMetrics: StoryMetrics[];
  statusWriter: StatusWriter;
  hooksConfig?: HooksConfig;
  deps: RegressionGateDeps;
}

export interface RegressionGateOutcome {
  regressionGateFailed: boolean;
}

interface RegressionExecution extends RegressionGateInput {
  regressionMode: "deferred" | "per-story" | "disabled" | undefined;
}

/**
 * Run the deferred regression gate before final metrics (run-completion
 * phase 1). Mutates `prd` (affected stories marked regression-failed) and
 * `allStoryMetrics` (rectification rows folded in) in place, exactly as the
 * original inline block did.
 */
export async function runRegressionGate(input: RegressionGateInput): Promise<RegressionGateOutcome> {
  const { options, config } = input;
  if (options.skipRegression) {
    // Regression phase already passed on a prior run — skip
    return { regressionGateFailed: false };
  }
  const regressionMode = config.execution.regressionGate?.mode;
  if (
    // nax#1809: under a dry run the regression gate would spawn the real
    // project suite (runDeferredRegression → fullSuite) — "Show plan without
    // executing" means no test run of any kind.
    !options.runtime?.dryRun &&
    // 'per-story' is a superset of 'deferred': the per-story full-suite gate runs
    // during the main loop AND the deferred regression runs once at end-of-run.
    (regressionMode === "deferred" || regressionMode === "per-story") &&
    config.quality.commands.test
  ) {
    const result = await executeRegressionGate({ ...input, regressionMode });
    // Back-fill or merge storyMetrics for stories rectified by the regression gate
    // (issue #679) — runs whether the gate passed or failed, still inside the gate.
    mergeRegressionStoryMetrics({ ...input, result });
    return { regressionGateFailed: result.gateFailed };
  }
  return { regressionGateFailed: false };
}

/**
 * Execute the configured gate: emit the postrun phase events, call
 * runDeferredRegression, and surface pass/fail. A thrown gate rethrows after
 * emitting the failed postrun:phase:completed so the phase never sticks in
 * "running" (post-impl-review quality finding).
 */
async function executeRegressionGate(
  input: RegressionExecution,
): Promise<{ gateFailed: boolean; regressionResult: Awaited<ReturnType<typeof runDeferredRegression>> }> {
  const logger = getSafeLogger();
  const { options, config, prd, workdir, feature, allStoryMetrics, statusWriter, hooksConfig, deps, regressionMode } =
    input;

  statusWriter.setPostRunPhase("regression", { status: "running" });
  const regressionStartTime = Date.now();
  pipelineEventBus.emit({ type: "postrun:phase:started", phase: "regression" });

  let regressionResult: Awaited<ReturnType<typeof deps.runDeferredRegression>>;
  try {
    regressionResult = await deps.runDeferredRegression({
      config,
      prd,
      workdir,
      runtime: options.runtime,
      // Shared with the per-story full-suite gate (via the story-orchestrator's
      // triage seam) so a test quarantined earlier in the run is relabeled here
      // without a second probe.
      quarantineMemo: options.runtime.quarantineMemo,
      interactionChain: options.interactionChain,
      // Per-story gate snapshots enable causal blame attribution (transition
      // pass -> fail). Sequential runs only: in parallel mode story completion
      // order (`completedAt`) is not causal and each story runs in an isolated
      // worktree, so a per-story snapshot does not reflect merged-repo state.
      //
      // Withholding them in parallel used to mean "fall back to the git-recency
      // heuristic". #1527 deleted that heuristic — blaming whichever story
      // committed most recently is not evidence — so withholding now means the
      // gate reports the regression and rectifies nothing. That is deliberate:
      // a parallel regression needs a human, not a guess. `isSequential` was
      // never forwarded from the runner until #1528's follow-up, so this branch
      // was dead and parallel runs were attributing from non-causal snapshots.
      storyMetrics:
        options.isSequential === false
          ? undefined
          : allStoryMetrics.map((m) => ({
              storyId: m.storyId,
              completedAt: m.completedAt,
              failingTestFiles: m.failingTestFiles,
            })),
    });
  } catch (err) {
    // A thrown error here would otherwise leave "regression" permanently
    // "running" in the TUI/status.json — no postrun:phase:completed ever
    // fires (post-impl-review quality finding).
    pipelineEventBus.emit({
      type: "postrun:phase:completed",
      phase: "regression",
      passed: false,
      durationMs: Date.now() - regressionStartTime,
    });
    throw err;
  }

  const lastRunAt = new Date().toISOString();

  logger?.info("regression", "Deferred regression gate completed", {
    success: regressionResult.success,
    failedTests: regressionResult.failedTests,
    affectedStories: regressionResult.affectedStories,
  });

  const regressionDurationMs = Date.now() - regressionStartTime;
  if (regressionResult.success) {
    statusWriter.setPostRunPhase("regression", { status: "passed", lastRunAt });
    pipelineEventBus.emit({
      type: "postrun:phase:completed",
      phase: "regression",
      passed: true,
      durationMs: regressionDurationMs,
      details: { mode: regressionMode, failedTests: 0 },
    });
    return { gateFailed: false, regressionResult };
  }

  statusWriter.setPostRunPhase("regression", {
    status: "failed",
    failedTests: regressionResult.failedTestFiles,
    affectedStories: regressionResult.affectedStories,
    lastRunAt,
  });
  pipelineEventBus.emit({
    type: "postrun:phase:completed",
    phase: "regression",
    passed: false,
    durationMs: regressionDurationMs,
    details: {
      mode: regressionMode,
      failedTests: regressionResult.failedTests,
    },
  });

  markRegressionFailedStories(prd, regressionResult.affectedStories);
  // Reflect regression gate failure in run status (RL-004)
  statusWriter.setRunStatus("failed");

  if (hooksConfig) {
    await deps.fireHook(
      hooksConfig as import("@/hooks").LoadedHooksConfig,
      "on-final-regression-fail",
      {
        event: "on-final-regression-fail",
        feature,
        status: "failed",
        failedTests: regressionResult.failedTests,
        affectedStories: regressionResult.affectedStories,
      },
      workdir,
    );
  }
  return { gateFailed: true, regressionResult };
}

/**
 * Mark affected stories as regression-failed in-memory for current-run event
 * counts (RL-004). Intentionally NOT saved to prd.json — rerun resume is
 * driven by status.json via setPostRunPhase("regression", { status: "failed" }).
 * On rerun, runner-completion.ts reads getPostRunStatus().regression.status from
 * status.json and re-runs the regression phase when it is not "passed". Saving
 * this to prd.json is unnecessary and would require prdPath to be threaded into
 * handleRunCompletion. See PR #254 / issue #250.
 */
function markRegressionFailedStories(prd: PRD, affectedStories: string[]): void {
  for (const storyId of affectedStories) {
    const story = prd.userStories.find((s) => s.id === storyId);
    if (story) {
      story.status = "regression-failed";
      // isComplete() checks `s.passes || s.status === "passed" || ...` — the `passes`
      // clause short-circuits before status, so it must be reset here too or a
      // regression-failed story still reads as complete (issue #1292).
      story.passes = false;
    }
  }
}

interface RegressionMergeInput {
  result: { regressionResult: Awaited<ReturnType<typeof runDeferredRegression>> };
  options: RunCompletionOptions;
  config: NaxConfig;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
}

/**
 * Back-fill or merge storyMetrics for stories rectified by the regression gate
 * (issue #679). Two cases:
 *   1. Story has no existing entry (prior run-resume or earlier execution batch): inject a
 *      synthetic "rectification" entry so cost and outcome show up in run.complete analytics.
 *   2. Story already has an entry (normal execution loop + regression-gate rectification in
 *      the same run): fold the rectification cost + duration into the existing entry so the
 *      regression-gate effort isn't silently dropped.
 */
function mergeRegressionStoryMetrics(input: RegressionMergeInput): void {
  const { regressionResult } = input.result;
  const { options, config, prd, allStoryMetrics } = input;
  const regressionStoryCosts = regressionResult.storyCosts ?? {};
  const regressionStoryDurations = regressionResult.storyDurations ?? {};
  const regressionStoryOutcomes = regressionResult.storyOutcomes ?? {};
  if (Object.keys(regressionStoryCosts).length > 0) {
    const existingIndex = new Map(allStoryMetrics.map((m, i) => [m.storyId, i]));
    const rectCompletedAt = new Date().toISOString();
    const defaultAgent = options.agentManager?.getDefault() ?? resolveDefaultAgent(config);
    for (const [storyId, storyCost] of Object.entries(regressionStoryCosts)) {
      const storyDuration = regressionStoryDurations[storyId] ?? 0;
      // Per-story outcome; fall back to the overall regression result only when missing
      // (e.g. older mocks emit storyCosts without storyOutcomes).
      const storySuccess = regressionStoryOutcomes[storyId] ?? regressionResult.success;
      const existingIdx = existingIndex.get(storyId);
      if (existingIdx === undefined) {
        const regrStory = prd.userStories.find((s) => s.id === storyId);
        allStoryMetrics.push({
          storyId,
          complexity: regrStory?.routing?.complexity ?? "medium",
          modelTier: "balanced",
          modelUsed: defaultAgent,
          attempts: 1,
          finalTier: "balanced",
          success: storySuccess,
          cost: storyCost,
          durationMs: storyDuration,
          firstPassSuccess: false,
          startedAt: rectCompletedAt,
          completedAt: rectCompletedAt,
          source: "rectification" as const,
          rectificationCost: storyCost,
          fullSuiteGatePassed: false,
          runtimeCrashes: 0,
        });
      } else {
        const existing = allStoryMetrics[existingIdx];
        allStoryMetrics[existingIdx] = {
          ...existing,
          cost: existing.cost + storyCost,
          durationMs: existing.durationMs + storyDuration,
          rectificationCost: (existing.rectificationCost ?? 0) + storyCost,
          // A story that needed regression-gate rectification was not a clean first pass.
          firstPassSuccess: false,
          // Preserve the normal-loop success flag unless the regression attempt actually failed.
          success: existing.success && storySuccess,
        };
      }
    }
  }
}
