/**
 * The run's metrics record is saved when `run:completed` fires, before the end phase (finish, or the
 * feature workflow) runs, so its duration is stories-only. This rewrites the record with the whole-run
 * duration and its two parts once the end phase is done (nax#2491 workflow mode, nax#2494 pipeline
 * mode). The `run:completed` event is NOT re-fired.
 */
import { withPathFileLock } from "@nathapp/nax-agent/internal";
import { saveJsonFile } from "../utils/json-file";
import { loadRunMetrics, metricsPathFor } from "./tracker";
import type { RunMetrics } from "./types";

export interface RunDurationPatch {
  readonly totalDurationMs: number;
  readonly storiesDurationMs: number;
  /** Workflow mode. */
  readonly featureWorkflowDurationMs?: number;
  /** Pipeline mode. */
  readonly endPhaseDurationMs?: number;
  /** Spend through the end of the end phase, as `run.complete` reports it. */
  readonly totalCost: number;
  readonly completedAt: string;
}

/** Returns false when no record for `runId` exists (e.g. the earlier save failed). */
export async function updateRunMetricsDuration(
  outputDir: string,
  runId: string,
  patch: RunDurationPatch,
): Promise<boolean> {
  const metricsPath = metricsPathFor(outputDir);
  return withPathFileLock(metricsPath, async () => {
    const runs = await loadRunMetrics(outputDir);
    const at = runs.map((r) => r.runId).lastIndexOf(runId);
    if (at < 0) return false;
    const next: RunMetrics[] = runs.map((r, i) => (i === at ? { ...r, ...patch } : r));
    await saveJsonFile(metricsPath, next, "metrics");
    return true;
  });
}
