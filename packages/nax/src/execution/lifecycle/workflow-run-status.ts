/**
 * The workflow-mode run-status rule (spec §4, US-004).
 *
 * Workflow mode never writes `postRun.finish`, so a caller that reads `status.json`
 * the way it reads a pipeline run (koda's runner does) used to see a failed feature
 * workflow reported as `completed`. This decides the status the completion phase
 * persists once the end phase has run: a run that had reported `completed` and whose
 * feature workflow did not pass is downgraded to `failed`.
 *
 * A draft or local-only result with green gates still passes the workflow, and stays
 * `completed` — exactly as in pipeline mode, where a draft finish leaves
 * `run.status: "completed"` and the detail lives in `postRun.finish`.
 */
import type { RunStateSnapshot } from "../status-file";

/** The run-status union of `NaxStatusFile["run"]["status"]`. */
export type RunStatus = RunStateSnapshot["runStatus"];

/**
 * The run status to persist after the end phase.
 *
 * Only an explicit negative verdict (`false`) on a `completed` run downgrades it. A
 * missing verdict is pipeline mode and never a failure; every other current status —
 * a cost-limit stop, an abort, an already-failed run, or the `undefined` a mock
 * writer reports — is returned unchanged so the caller's `next !== current` guard
 * suppresses the redundant `setRunStatus` call.
 */
export function workflowFinalRunStatus(
  current: RunStatus | undefined,
  workflowPassed: boolean | undefined,
): RunStatus | undefined {
  if (current !== "completed" || workflowPassed === undefined) return current;
  return workflowPassed ? "completed" : "failed";
}
