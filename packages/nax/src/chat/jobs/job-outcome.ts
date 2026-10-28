/** Repo-scoped job outcomes from the command's own artifacts. */
import { join } from "node:path";
import { featureDir } from "@/config";
import type { NaxStatusFile } from "@/execution/status-file";
// biome-ignore lint/style/noRestrictedImports: leaf reader avoids the execution barrel's runtime graph (US-003).
import { readStatusFile } from "../../execution/status-file-read";
import type { ChatJob, ChatJobState } from "./job-types";

export interface JobOutcome {
  readonly state: Exclude<ChatJobState, "running">;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly note?: string;
}

type RunProgress = {
  readonly cost: number;
  readonly progress: { readonly passed: number; readonly total: number };
};

export const _jobOutcomeDeps = {
  readStatusFile,
  stat: (path: string) => Bun.file(path).stat(),
};

function projectProgress(status: NaxStatusFile): RunProgress {
  return {
    cost: status.cost.spent,
    progress: { passed: status.progress.passed, total: status.progress.total },
  };
}

async function matchingStatus(job: ChatJob, repoRoot: string): Promise<NaxStatusFile | null> {
  const status = await _jobOutcomeDeps.readStatusFile(featureDir(repoRoot, job.target));
  return status?.run.pid === job.pid ? status : null;
}

/** Only a PID-matched run record may contribute cost or progress. */
export async function readRunProgress(job: ChatJob, repoRoot: string): Promise<RunProgress | null> {
  if (job.kind !== "run") return null;
  const status = await matchingStatus(job, repoRoot);
  return status ? projectProgress(status) : null;
}

function runOutcome(status: NaxStatusFile | null, job: ChatJob, exitCode?: number): JobOutcome {
  const metrics = status ? projectProgress(status) : {};
  if (job.cancelRequested) return { state: "cancelled", ...metrics };
  if (!status) {
    const suffix = exitCode === undefined ? "" : `; exit code ${exitCode}`;
    return { state: "failed", note: `no run record for pid ${job.pid}${suffix}` };
  }
  if (status.run.status === "completed") {
    const note =
      exitCode !== undefined && exitCode !== 0 ? { note: `exit code ${exitCode} disagrees with the run record` } : {};
    return { state: "succeeded", ...metrics, ...note };
  }
  if (status.run.status === "aborted") return { state: "cancelled", ...metrics };
  return { state: "failed", ...metrics, note: `run status ${status.run.status}` };
}

async function planOutcome(job: ChatJob, repoRoot: string): Promise<JobOutcome> {
  try {
    const record = await _jobOutcomeDeps.stat(join(featureDir(repoRoot, job.target), "prd.json"));
    if (record.mtimeMs >= Date.parse(job.startedAt)) return { state: "succeeded" };
  } catch (error) {
    // Missing artifacts are expected; other I/O failures must remain visible to the caller.
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { state: "failed", note: "plan wrote no prd.json" };
}

/** Cancellation takes precedence; command records outrank observed exit codes. */
export async function resolveJobOutcome(
  job: ChatJob,
  exit: { readonly exitCode?: number },
  repoRoot: string,
): Promise<JobOutcome> {
  if (job.kind === "run") return runOutcome(await matchingStatus(job, repoRoot), job, exit.exitCode);
  if (job.cancelRequested) return { state: "cancelled" };
  if (job.kind === "plan") return planOutcome(job, repoRoot);
  if (exit.exitCode === 0) return { state: "succeeded" };
  if (exit.exitCode !== undefined) return { state: "failed", note: `exit code ${exit.exitCode}` };
  return { state: "lost", note: "outcome unknown: exit code not observed" };
}
