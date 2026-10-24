/**
 * The end-of-run report. Workflow mode (nax#2491 P5): reads the run's result.json, logs one
 * summary line (stories vs feature-workflow time, branch findings, publish) and hands the
 * view to the headless footer. Both modes (nax#2494): closes the run once its end phase is done,
 * which writes the held-back `run.complete` line and rewrites the saved metrics record with the
 * whole-run duration. Fail-open: a report that cannot be built never fails a run.
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
    const rounds = b.fixRounds ? ` over ${b.fixRounds} fix round${b.fixRounds === 1 ? "" : "s"}` : "";
    parts.push(`branch findings ${b.found} found, ${b.fixed} fixed, ${b.left} left${rounds}`);
  }
  if (view.gateRepairRounds) parts.push(`gate repair rounds ${view.gateRepairRounds}`);
  // US-008: a CI repair is a repair like any other, so its rounds are named at run end too.
  if (view.ciRepairRounds) parts.push(`CI repair rounds ${view.ciRepairRounds}`);
  // US-006: the checks the repair rounds did not turn green must not read as "CI failed, done".
  if (view.ciRemaining && view.ciRemaining.length > 0) parts.push(`CI still failing: ${view.ciRemaining.join(", ")}`);
  // US-005: a repair whose reply admitted it could not check something must not read as done.
  if (view.ciRepairConcerns && view.ciRepairConcerns.length > 0)
    parts.push(`CI repair concerns: ${view.ciRepairConcerns.join("; ")}`);
  if (view.publish) parts.push(`publish ${view.publish.outcome}`);
  // US-005: a ruling that changed an acceptance criterion must not go unnoticed at run end.
  if (view.flagged) parts.push(`flagged ${view.flagged.ids.length} (${view.flagged.hint})`);
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

/** Writes the held-back `run.complete` line and `run:completed` event at most once, whichever path reaches it first (nax#2491). */
export interface RunCompleteGate {
  log(final: RunCompleteFinal): void;
  /**
   * The `finally` path: logs `fallback()` when nothing else did. A fault here is logged at warn and
   * swallowed, so it cannot mask the rejection that brought us to the `finally`.
   * Known and accepted: on SIGINT crash-signals may also write a `run.complete` ("terminated") line;
   * `nax runs` reads the first one, so the second is harmless.
   */
  ensureSafely(fallback: () => RunCompleteFinal): void;
}

export function createRunCompleteGate(write: ((final: RunCompleteFinal) => void) | undefined): RunCompleteGate {
  let logged = false;
  const log = (final: RunCompleteFinal): void => {
    if (logged) return;
    logged = true;
    write?.(final);
  };
  const ensureSafely = (fallback: () => RunCompleteFinal): void => {
    try {
      log(fallback());
    } catch (err) {
      getSafeLogger()?.warn("run.complete", "Could not write the fallback run.complete line", {
        error: errorMessage(err),
      });
    }
  };
  return { log, ensureSafely };
}

async function saveWholeRunDuration(options: RunnerCompletionOptions, final: RunCompleteFinal): Promise<void> {
  try {
    if (!options.runtime) {
      getSafeLogger()?.warn("run.complete", "No runtime to locate the run metrics; whole-run duration not saved");
      return;
    }
    const saved = await _workflowEndReportDeps.saveDuration(options.runtime.outputDir, options.runId, {
      totalDurationMs: final.durationMs,
      storiesDurationMs: final.storiesDurationMs,
      ...(final.featureWorkflowDurationMs !== undefined
        ? { featureWorkflowDurationMs: final.featureWorkflowDurationMs }
        : {}),
      ...(final.endPhaseDurationMs !== undefined ? { endPhaseDurationMs: final.endPhaseDurationMs } : {}),
      totalCost: final.totalCost,
      completedAt: new Date().toISOString(),
    });
    if (!saved) {
      getSafeLogger()?.warn("run.complete", "No saved run metrics to update with the whole-run duration", {
        runId: options.runId,
      });
    }
  } catch (err) {
    getSafeLogger()?.warn("run.complete", "Failed to update run metrics with the whole-run duration", {
      error: errorMessage(err),
    });
  }
}

/** The whole run's final figures, as `run.complete` and the saved metrics record report them. */
function wholeRunFinal(
  options: RunnerCompletionOptions,
  input: {
    readonly split: Pick<RunCompleteFinal, "featureWorkflowDurationMs" | "endPhaseDurationMs">;
    readonly workflowPassed: boolean;
    readonly url?: string;
    readonly reasons: readonly string[];
    readonly fallbackCost: number;
    readonly endStartedAt: number;
    readonly endedAt: number;
  },
): RunCompleteFinal {
  const durationMs = input.endedAt - options.startTime;
  return {
    durationMs,
    storiesDurationMs: durationMs - (input.endedAt - input.endStartedAt),
    ...input.split,
    totalCost: options.runtime ? totalSpendUsd(options.runtime.costAggregator.snapshot()) : input.fallbackCost,
    workflowPassed: input.workflowPassed,
    ...(input.url !== undefined ? { url: input.url } : {}),
    reasons: input.reasons,
  };
}

interface CloseInput {
  readonly gate: RunCompleteGate;
  readonly workflowPassed: boolean;
  readonly url?: string;
  readonly reasons: readonly string[];
  readonly fallbackCost: number;
  readonly endStartedAt: number;
  readonly endedAt: number;
}

/**
 * Called once the end phase is done: derives the whole-run duration (start to now) and the end-phase
 * part, writes the held-back run.complete line, rewrites the saved metrics record, and (workflow mode)
 * reports. The gate's write also emits the deferred `run:completed` (reporters, on-complete hook),
 * so that event carries these whole-run figures and fires once, in either mode.
 */
async function closeWorkflowRun(options: RunnerCompletionOptions, input: CloseInput): Promise<ClosedWorkflowRun> {
  const featureWorkflowDurationMs = input.endedAt - input.endStartedAt;
  const final = wholeRunFinal(options, { ...input, split: { featureWorkflowDurationMs } });
  input.gate.log(final);
  await saveWholeRunDuration(options, final);
  const summary = await reportWorkflowRun(options, {
    storiesDurationMs: final.storiesDurationMs,
    featureWorkflowDurationMs,
  });
  return { final, summary };
}

/** Pipeline mode: the same close, split into stories and end phase (finish, ...), with no workflow summary. */
async function closePipelineRun(options: RunnerCompletionOptions, input: CloseInput): Promise<ClosedWorkflowRun> {
  const endPhaseDurationMs = input.endedAt - input.endStartedAt;
  const final = wholeRunFinal(options, { ...input, split: { endPhaseDurationMs } });
  input.gate.log(final);
  await saveWholeRunDuration(options, final);
  return { final, summary: undefined };
}

/** Below this the end phase is not worth a `+ end phase` split in the footer. */
const MIN_SPLIT_END_PHASE_MS = 1_000;

export interface EndPhaseReport {
  /** undefined in pipeline mode. */
  readonly workflowPassed: boolean | undefined;
  /** The run's duration: through the end of the end phase (finish / feature workflow) in both modes. */
  readonly durationMs: number;
  /** Fields for the headless footer: the split in both modes, the workflow block in workflow mode. */
  readonly footer: Pick<RunFooterOptions, "workflowTiming" | "workflowSummary" | "endPhaseTiming">;
}

/**
 * runEndPhase, timed. It also closes the run in both modes (nax#2491, nax#2494): Duration runs through
 * the end of the end phase (finish in pipeline mode, the feature workflow in workflow mode), `run.complete`
 * is written once with the split, and the saved metrics record is rewritten.
 * `run:completed` (reporters, the on-complete hook) is deferred to the same gate write, so it fires
 * after the end phase with the whole-run duration and cost, the verdict, the PR url and the reasons.
 */
export async function runEndPhaseReported(
  options: RunnerCompletionOptions,
  deps: EndPhaseDeps,
  completion: Pick<RunCompletionResult, "durationMs" | "reportedTotal">,
  clock: { readonly now: () => number; readonly gate: RunCompleteGate },
): Promise<EndPhaseReport> {
  const endStartedAt = clock.now();
  const outcome = await runEndPhase(options, deps);
  const workflowPassed = outcome?.passed;
  const input: CloseInput = {
    gate: clock.gate,
    workflowPassed: workflowPassed ?? true,
    ...(outcome?.url !== undefined ? { url: outcome.url } : {}),
    reasons: outcome?.reasons ?? [],
    fallbackCost: completion.reportedTotal,
    endStartedAt,
    endedAt: clock.now(),
  };
  if (workflowPassed === undefined) {
    const run = await closePipelineRun(options, input);
    const endPhaseDurationMs = run.final.endPhaseDurationMs ?? 0;
    // A finish that did not run (or took no time) has nothing to split out: the footer stays plain.
    return {
      workflowPassed,
      durationMs: run.final.durationMs,
      footer:
        endPhaseDurationMs >= MIN_SPLIT_END_PHASE_MS
          ? { endPhaseTiming: { storiesDurationMs: run.final.storiesDurationMs, endPhaseDurationMs } }
          : {},
    };
  }
  const run = await closeWorkflowRun(options, input);
  return {
    workflowPassed,
    durationMs: run.final.durationMs,
    footer: {
      workflowTiming: {
        storiesDurationMs: run.final.storiesDurationMs,
        featureWorkflowDurationMs: run.final.featureWorkflowDurationMs ?? 0,
      },
      workflowSummary: run.summary,
    },
  };
}
