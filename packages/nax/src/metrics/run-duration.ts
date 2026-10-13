/**
 * Workflow mode: the run's metrics record is saved before the feature workflow runs, so its
 * duration is stories-only. This rewrites the record with the whole-run duration and its two
 * parts once the workflow is done (nax#2491). The `run:completed` event is NOT re-fired.
 */
import { withPathFileLock } from "@nathapp/nax-agent/internal";
import { saveJsonFile } from "../utils/json-file";
import { loadRunMetrics, metricsPathFor } from "./tracker";
import type { RunMetrics } from "./types";

export interface RunDurationPatch {
  readonly totalDurationMs: number;
  readonly storiesDurationMs: number;
  readonly featureWorkflowDurationMs: number;
  /** Spend through the end of the feature workflow, as `run.complete` reports it. */
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
