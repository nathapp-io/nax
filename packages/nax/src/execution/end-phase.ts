/** The end-of-run feature workflow and its verdict. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { pendingStoryIds } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import type { IterationCapStop, WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";
import type { RunnerCompletionOptions } from "./runner-completion";

export interface EndPhaseDeps {
  runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
  /** The run clock; Date.now when absent. */
  now?(): number;
}

/**
 * How the end phase closed the run.
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
 * The branch the feature workflow would open a PR from.
 *
 * There is no `currentBranch` helper in `@/utils/git` — an earlier draft of
 * this plan invented one. This is the idiom `runner.ts:344-348` already uses
 * to resolve the branch it hands `cleanupRun`, including the fail-closed
 * empty-string default: `isFeatureBranch("")` is false, so an unresolvable
 * branch makes the workflow stand down rather than guess.
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

/** nax#2706: the cap and the stories it left pending, when the loop ended on `max-iterations`. */
function iterationCapOf(options: RunnerCompletionOptions): { iterationCap?: IterationCapStop } {
  if (options.exitReason !== "max-iterations") return {};
  const pendingIds = pendingStoryIds(options.prd);
  if (pendingIds.length === 0) return {};
  return { iterationCap: { pendingIds } };
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
      ...iterationCapOf(options),
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
 * The feature workflow's verdict — whether it passed,
 * the PR url it produced and why it did not (P4-R13, US-001).
 */
export async function runEndPhase(options: RunnerCompletionOptions, deps: EndPhaseDeps): Promise<EndPhaseOutcome> {
  const branch = await _endPhaseDeps.resolveBranch(options.workdir);
  return runWorkflowEnd(options, deps, branch);
}
