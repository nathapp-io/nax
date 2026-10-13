/**
 * Workflow mode: the end-of-run report (nax#2491 P5). Reads the run's result.json, logs one
 * summary line (stories vs feature-workflow time, branch findings, publish) and hands the
 * view to the headless footer. Fail-open: a report that cannot be built never fails a run.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { formatDurationSplit, type WorkflowSummaryView } from "@/log-format";
import { getSafeLogger } from "@/logger";
import { type EndPhaseDeps, runEndPhase } from "./end-phase";
import type { RunFooterOptions } from "./lifecycle/headless-formatter";
import type { RunCompleteTiming, RunCompletionResult } from "./lifecycle/run-completion";
import type { RunnerCompletionOptions } from "./runner-completion";

export interface WorkflowRunTiming {
  readonly storiesDurationMs: number;
  readonly featureWorkflowDurationMs: number;
}

type ReportOptions = Pick<RunnerCompletionOptions, "workdir" | "feature" | "runId" | "runtime">;

export const _workflowEndReportDeps = {
  async readSummary(options: ReportOptions, timing: WorkflowRunTiming): Promise<WorkflowSummaryView | null> {
    const { readWorkflowRunSummary } = await import("@/workflow");
    return readWorkflowRunSummary(options.workdir, options.feature, options.runtime?.runId ?? options.runId, timing);
  },
};

function summaryLine(view: WorkflowSummaryView): string {
  const parts = [formatDurationSplit(view.storiesDurationMs, view.featureWorkflowDurationMs)];
  if (view.branch) {
    const b = view.branch;
    parts.push(`branch findings ${b.found} found, ${b.fixed} fixed, ${b.left} left`);
  }
  if (view.publish) parts.push(`publish ${view.publish.outcome}`);
  return `Workflow summary: ${parts.join("; ")}`;
}

export async function reportWorkflowRun(
  options: ReportOptions,
  timing: WorkflowRunTiming,
): Promise<WorkflowSummaryView | undefined> {
  try {
    const view = await _workflowEndReportDeps.readSummary(options, timing);
    if (!view) return undefined;
    getSafeLogger()?.info("workflow", summaryLine(view), { storyId: "_run", ...view });
    return view;
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Workflow summary unavailable", { storyId: "_run", error: errorMessage(err) });
    return undefined;
  }
}

/** The whole run's duration with its two parts, plus the summary view (absent when result.json is). */
export interface ClosedWorkflowRun extends RunCompleteTiming {
  readonly summary: WorkflowSummaryView | undefined;
}

/**
 * Called once the feature workflow is done: derives the whole-run duration (start to now) and the
 * feature-workflow part (end phase only), writes the held-back run.complete line, and reports.
 */
async function closeWorkflowRun(
  options: RunnerCompletionOptions,
  logRunComplete: ((timing: RunCompleteTiming) => void) | undefined,
  clock: { readonly endStartedAt: number; readonly endedAt: number },
): Promise<ClosedWorkflowRun> {
  const { endStartedAt, endedAt } = clock;
  const featureWorkflowDurationMs = endedAt - endStartedAt;
  const durationMs = endedAt - options.startTime;
  const timing: RunCompleteTiming = {
    durationMs,
    storiesDurationMs: durationMs - featureWorkflowDurationMs,
    featureWorkflowDurationMs,
  };
  logRunComplete?.(timing);
  const summary = await reportWorkflowRun(options, timing);
  return { ...timing, summary };
}

export interface EndPhaseReport {
  /** undefined in pipeline mode. */
  readonly workflowPassed: boolean | undefined;
  /** The run's duration: through the end of the feature workflow in workflow mode, as completed otherwise. */
  readonly durationMs: number;
  /** Fields for the headless footer; empty in pipeline mode. */
  readonly footer: Pick<RunFooterOptions, "workflowTiming" | "workflowSummary">;
}

/** runEndPhase, timed: in workflow mode also closes the run (nax#2491). */
export async function runEndPhaseReported(
  options: RunnerCompletionOptions,
  deps: EndPhaseDeps,
  completion: Pick<RunCompletionResult, "durationMs" | "logRunComplete">,
  now: () => number,
): Promise<EndPhaseReport> {
  const endStartedAt = now();
  const workflowPassed = await runEndPhase(options, deps);
  if (workflowPassed === undefined) return { workflowPassed, durationMs: completion.durationMs, footer: {} };
  const run = await closeWorkflowRun(options, completion.logRunComplete, { endStartedAt, endedAt: now() });
  return {
    workflowPassed,
    durationMs: run.durationMs,
    footer: { workflowTiming: run, workflowSummary: run.summary },
  };
}
