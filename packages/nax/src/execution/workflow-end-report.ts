/**
 * Workflow mode: the end-of-run report (nax#2491 P5). Reads the run's result.json, logs one
 * summary line (stories vs feature-workflow time, branch findings, publish) and hands the
 * view to the headless footer. Fail-open: a report that cannot be built never fails a run.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { formatDurationSplit, type WorkflowSummaryView } from "@/log-format";
import { getSafeLogger } from "@/logger";
import { updateRunMetricsDuration } from "@/metrics";
import { totalSpendUsd } from "@/runtime";
import { type EndPhaseDeps, runEndPhase } from "./end-phase";
import type { RunFooterOptions } from "./lifecycle/headless-formatter";
import type { RunCompleteFinal, RunCompletionResult } from "./lifecycle/run-completion";
import type { RunnerCompletionOptions } from "./runner-completion";

export interface WorkflowRunTiming {
  readonly storiesDurationMs: number;
  readonly featureWorkflowDurationMs: number;
}

type ReportOptions = Pick<RunnerCompletionOptions, "workdir" | "feature" | "runId" | "runtime">;

export const _workflowEndReportDeps = {
  saveDuration: updateRunMetricsDuration,
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

/** The whole run's final figures, plus the summary view (absent when result.json is). */
export interface ClosedWorkflowRun {
  readonly final: RunCompleteFinal;
  readonly summary: WorkflowSummaryView | undefined;
}

/** Writes the held-back `run.complete` line at most once, whichever path reaches it first (nax#2491). */
export interface RunCompleteGate {
  log(final: RunCompleteFinal): void;
  /** The `finally` path: logs `fallback()` when nothing else did. */
  ensure(fallback: () => RunCompleteFinal): void;
}

export function createRunCompleteGate(write: ((final: RunCompleteFinal) => void) | undefined): RunCompleteGate {
  let logged = false;
  const log = (final: RunCompleteFinal): void => {
    if (logged) return;
    logged = true;
    write?.(final);
  };
  return { log, ensure: (fallback) => log(fallback()) };
}

async function saveWholeRunDuration(options: RunnerCompletionOptions, final: RunCompleteFinal): Promise<void> {
  try {
    await _workflowEndReportDeps.saveDuration(options.runtime.outputDir, options.runId, {
      totalDurationMs: final.durationMs,
      storiesDurationMs: final.storiesDurationMs,
      featureWorkflowDurationMs: final.featureWorkflowDurationMs,
    });
  } catch (err) {
    getSafeLogger()?.warn("run.complete", "Failed to update run metrics with the whole-run duration", {
      error: errorMessage(err),
    });
  }
}

/**
 * Called once the feature workflow is done: derives the whole-run duration (start to now) and the
 * feature-workflow part (end phase only), writes the held-back run.complete line, rewrites the
 * saved metrics record, and reports. `run:completed` (reporters, on-complete hook) has already
 * fired by now with the stories-only figures; it is deliberately not re-fired.
 */
async function closeWorkflowRun(
  options: RunnerCompletionOptions,
  input: {
    readonly gate: RunCompleteGate;
    readonly workflowPassed: boolean;
    readonly fallbackCost: number;
    readonly endStartedAt: number;
    readonly endedAt: number;
  },
): Promise<ClosedWorkflowRun> {
  const featureWorkflowDurationMs = input.endedAt - input.endStartedAt;
  const durationMs = input.endedAt - options.startTime;
  const final: RunCompleteFinal = {
    durationMs,
    storiesDurationMs: durationMs - featureWorkflowDurationMs,
    featureWorkflowDurationMs,
    totalCost: options.runtime ? totalSpendUsd(options.runtime.costAggregator.snapshot()) : input.fallbackCost,
    workflowPassed: input.workflowPassed,
  };
  input.gate.log(final);
  await saveWholeRunDuration(options, final);
  const summary = await reportWorkflowRun(options, final);
  return { final, summary };
}

export interface EndPhaseReport {
  /** undefined in pipeline mode. */
  readonly workflowPassed: boolean | undefined;
  /** The run's duration: through the end of the feature workflow in workflow mode, as completed otherwise. */
  readonly durationMs: number;
  /** Fields for the headless footer; empty in pipeline mode. */
  readonly footer: Pick<RunFooterOptions, "workflowTiming" | "workflowSummary">;
}

/**
 * runEndPhase, timed. In workflow mode it also closes the run (nax#2491): workflow Duration runs through
 * the end of the feature workflow. Pipeline Duration is unchanged and still EXCLUDES the end phase (finish),
 * because handleRunCompletion computes it before runEndPhase; that asymmetry is known and tracked separately.
 */
export async function runEndPhaseReported(
  options: RunnerCompletionOptions,
  deps: EndPhaseDeps,
  completion: Pick<RunCompletionResult, "durationMs" | "reportedTotal">,
  clock: { readonly now: () => number; readonly gate: RunCompleteGate },
): Promise<EndPhaseReport> {
  const endStartedAt = clock.now();
  const workflowPassed = await runEndPhase(options, deps);
  if (workflowPassed === undefined) return { workflowPassed, durationMs: completion.durationMs, footer: {} };
  const run = await closeWorkflowRun(options, {
    gate: clock.gate,
    workflowPassed,
    fallbackCost: completion.reportedTotal,
    endStartedAt,
    endedAt: clock.now(),
  });
  return {
    workflowPassed,
    durationMs: run.final.durationMs,
    footer: {
      workflowTiming: {
        storiesDurationMs: run.final.storiesDurationMs,
        featureWorkflowDurationMs: run.final.featureWorkflowDurationMs,
      },
      workflowSummary: run.summary,
    },
  };
}
