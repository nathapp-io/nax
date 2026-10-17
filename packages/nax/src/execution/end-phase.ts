/**
 * The end-of-run phase (spec §5.3, P4-R16): finish in pipeline mode, the A5 feature
 * workflow in workflow mode. Finish is fail-open (a throw is logged and the run is
 * unaffected); a feature workflow throw marks the run unsuccessful. Split out of
 * runner-completion.ts to keep it under the file-size limit.
 *
 * Workflow mode returns an `EndPhaseOutcome` — the verdict, the PR url and the reasons
 * behind it — rather than a bare boolean, so a caller can report *why* the run did not
 * pass (US-001). Pipeline mode has no verdict and still returns `undefined`.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { isWorkflowMode } from "@/config";
import { NaxError } from "@/errors";
import type { FinishPhaseContext, FinishResult } from "@/finish";
import { getSafeLogger } from "@/logger";
import { countStories, isComplete } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import { storyPackageDir } from "@/utils/path-frame";
import type { WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";
import type { RunnerCompletionOptions } from "./runner-completion";

export interface EndPhaseDeps {
  runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null>;
  runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
  /** The run clock; Date.now when absent. */
  now?(): number;
}

/**
 * How the end phase closed the run. Workflow mode only — pipeline mode has no
 * verdict to report, so `runEndPhase` returns `undefined` there.
 *
 * `reasons` is always set once the end phase is closed (`[]` on a pass), so a
 * consumer can report "passed, for no stated reason" without guessing. `url` is
 * present only when the end phase produced one.
 */
export interface EndPhaseOutcome {
  passed: boolean;
  url?: string;
  reasons: readonly string[];
}

/**
 * The three counts `shouldRunFinish` gates on, in the shape the plugin's own
 * gate read them.
 *
 * `completed` is `options.storiesCompleted` — **not** `countStories(prd).passed`
 * — for every run that actually executed a story. `buildPostRunContext`
 * (`src/execution/lifecycle/run-cleanup.ts:151-156`) builds
 * `PostRunContext.storySummary.completed` from the runner's `storiesCompleted`
 * counter and takes only `failed`/`skipped`/`paused` from `countStories`.
 * Substituting `passed` here would silently change the gate the native phase
 * inherits.
 *
 * The one narrow exception (#1671): a *resumed* run whose PRD is already
 * fully complete executes no story at all, so `storiesCompleted` stays 0 even
 * though the completion phase just did real work (deferred review, cleanup).
 * `unified-executor.ts:171` takes that exact "all stories already complete"
 * branch behind `isComplete(prd)` — the same predicate used below — so when
 * `storiesCompleted === 0` and `isComplete(prd)` is true, the fallback reports
 * `counts.passed` instead. `isComplete` rather than `counts.passed > 0`
 * because it additionally rules out any `pending`/`blocked` story; a run that
 * merely has one passed story among others still unstarted must not look
 * complete to `shouldRunFinish`. Any run that executed at least one story
 * keeps its own `storiesCompleted` count untouched.
 *
 * `countStories().failed` already folds in `regression-failed`, matching the
 * classification the deferred regression gate uses.
 */
export function finishStorySummary(options: RunnerCompletionOptions): {
  completed: number;
  failed: number;
  paused: number;
} {
  const counts = countStories(options.prd);
  const completed =
    options.storiesCompleted === 0 && isComplete(options.prd) ? counts.passed : options.storiesCompleted;
  return { completed, failed: counts.failed, paused: counts.paused };
}

/**
 * The branch finish would open a PR from.
 *
 * There is no `currentBranch` helper in `@/utils/git` — an earlier draft of
 * this plan invented one. This is the idiom `runner.ts:344-348` already uses
 * to resolve the branch it hands `cleanupRun`, including the fail-closed
 * empty-string default: `isFeatureBranch("")` is false, so an unresolvable
 * branch makes finish stand down rather than guess.
 */
async function resolveBranch(workdir: string): Promise<string> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(["branch", "--show-current"], workdir);
    return exitCode === 0 ? stdout.trim() : "";
  } catch {
    return "";
  }
}

export const _endPhaseDeps = { resolveBranch };

/** The one reason every "the workflow never ran, or was cut short" arm reports (US-001). */
const ABORTED_REASON = "run aborted";

async function runFinish(options: RunnerCompletionOptions, deps: EndPhaseDeps, branch: string): Promise<void> {
  try {
    await deps.runFinishPhase({
      runtime: options.runtime,
      config: options.config,
      feature: options.feature,
      workdir: options.workdir,
      branch,
      runId: options.runId,
      agentName: options.agentManager.getDefault(),
      abortSignal: options.abortSignal,
      storySummary: finishStorySummary(options),
      statusWriter: options.statusWriter,
      interactionChain: options.interactionChain,
      packageDirs: options.prd.userStories.map(storyPackageDir),
    });
  } catch (err) {
    getSafeLogger()?.warn("finish", "Finish phase failed; the run is unaffected", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
}

async function runWorkflowEnd(
  options: RunnerCompletionOptions,
  deps: EndPhaseDeps,
  branch: string,
): Promise<EndPhaseOutcome> {
  if (options.exitReason === "aborted" || options.abortSignal?.aborted) {
    getSafeLogger()?.info("workflow", "Feature workflow skipped — the run was aborted", { storyId: "_run" });
    // nax#2550: the workflow did not run, so it cannot be reported as passed.
    return { passed: false, reasons: [ABORTED_REASON] };
  }
  try {
    const result = await deps.runWorkflowFeature({
      runtime: options.runtime,
      config: options.config,
      prd: options.prd,
      feature: options.feature,
      workdir: options.workdir,
      branch,
      runId: options.runId,
      agentName: options.agentManager.getDefault(),
      abortSignal: options.abortSignal,
      interactionChain: options.interactionChain,
      statusWriter: options.statusWriter,
      storiesDurationMs: (deps.now ?? Date.now)() - options.startTime,
    });
    return {
      passed: result?.passed ?? true,
      ...(result?.url !== undefined ? { url: result.url } : {}),
      reasons: result?.reasons ?? [],
    };
  } catch (err) {
    if (err instanceof NaxError && err.code === "WORKFLOW_ABORTED") {
      getSafeLogger()?.info("workflow", "Feature workflow aborted — run marked unsuccessful", {
        storyId: "_run",
        error: errorMessage(err),
      });
      return { passed: false, reasons: [ABORTED_REASON] };
    }
    getSafeLogger()?.warn("workflow", "Feature workflow failed — run marked unsuccessful", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return { passed: false, reasons: [`feature workflow failed: ${errorMessage(err)}`] };
  }
}

/**
 * undefined in pipeline mode; workflow mode: the feature workflow's verdict — whether it passed,
 * the PR url it produced and why it did not (P4-R13, US-001).
 */
export async function runEndPhase(
  options: RunnerCompletionOptions,
  deps: EndPhaseDeps,
): Promise<EndPhaseOutcome | undefined> {
  const branch = await _endPhaseDeps.resolveBranch(options.workdir);
  if (isWorkflowMode(options.config)) return runWorkflowEnd(options, deps, branch);
  await runFinish(options, deps, branch);
  return undefined;
}
