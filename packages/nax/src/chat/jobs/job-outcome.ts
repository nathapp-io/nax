/** Repo-scoped job outcomes from the command's own artifacts. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { featureDir } from "@/config";
import type { NaxStatusFile } from "@/execution/status-file";
import { heldItemList, heldItemNoun } from "@/prompts";
// biome-ignore lint/style/noRestrictedImports: leaf reader avoids the execution barrel's runtime graph (US-003).
import { readStatusFile } from "../../execution/status-file-read";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { loadRunVerdict } from "../../workflow/run-verdict";
import { targetOutputDir } from "../target-repo";
import { type ChatJob, type ChatJobState, type HeldDraft, isRunJobKind } from "./job-types";

export interface JobOutcome {
  readonly state: Exclude<ChatJobState, "running">;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly note?: string;
  /** US-003: the draft PR this run or publish left, and the open items holding it. */
  readonly held?: HeldDraft;
}

type RunProgress = {
  readonly cost: number;
  readonly progress: { readonly passed: number; readonly total: number };
};

export const _jobOutcomeDeps = {
  readStatusFile,
  stat: (path: string) => Bun.file(path).stat(),
  loadRunVerdict,
  /** Where the run's verdict supplements live; the chat's own resolution of a nax project's output. */
  resolveOutputDir: targetOutputDir,
};

function projectProgress(status: NaxStatusFile): RunProgress {
  return {
    cost: status.cost.spent,
    progress: { passed: status.progress.passed, total: status.progress.total },
  };
}

/** The feature's run record, but only when it names this job's pid. */
export async function readJobStatus(job: ChatJob, repoRoot: string): Promise<NaxStatusFile | null> {
  const status = await _jobOutcomeDeps.readStatusFile(featureDir(repoRoot, job.target));
  return status?.run.pid === job.pid ? status : null;
}

/** Only a PID-matched run record may contribute cost or progress. */
export async function readRunProgress(job: ChatJob, repoRoot: string): Promise<RunProgress | null> {
  if (!isRunJobKind(job.kind)) return null;
  const status = await readJobStatus(job, repoRoot);
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

/**
 * #2819, US-003: a run or publish job's note names what the publish produced; a cancelled job
 * or one with no workflow block names nothing.
 */
function publishNote(status: NaxStatusFile | null, outcome: JobOutcome): string | undefined {
  const workflow = status?.workflow;
  if (outcome.state === "cancelled" || workflow?.outcome === undefined) return undefined;
  return `publish ${workflow.outcome}${workflow.url ? ` ${workflow.url}` : ""}`;
}

/** What reading the draft's open items produced: the held record, and the note segment it adds. */
interface HeldRead {
  readonly held: HeldDraft;
  /** Absent for a known-empty draft, which adds no segment at all. */
  readonly segment?: string;
}

/** US-003: the held record for a draft PR, with the note segment that names its open items. */
async function readHeld(url: string | undefined, repoRoot: string, feature: string): Promise<HeldRead> {
  const withUrl = (items: HeldDraft["items"], unreadable?: true): HeldDraft => ({
    ...(url === undefined ? {} : { url }),
    items,
    ...(unreadable === true ? { unreadable } : {}),
  });
  try {
    const verdict = await _jobOutcomeDeps.loadRunVerdict(repoRoot, feature, _jobOutcomeDeps.resolveOutputDir);
    const items = verdict.openItems.map(({ id, kind }) => ({ id, kind }));
    const held = withUrl(items);
    if (items.length === 0) return { held };
    const list = heldItemList(items, { withKinds: true });
    return { held, segment: `held by ${items.length} open ${heldItemNoun(items.length)}: ${list}` };
  } catch (error) {
    return { held: withUrl([], true), segment: `open items unreadable: ${errorMessage(error)}` };
  }
}

/**
 * US-003: a `run` or `publish` job's outcome, named by what the publish produced and — for a
 * draft PR — by the open items it is held by. Every existing note follows those segments.
 */
async function publicationOutcome(
  status: NaxStatusFile | null,
  job: ChatJob,
  repoRoot: string,
  exitCode?: number,
): Promise<JobOutcome> {
  const outcome = runOutcome(status, job, exitCode);
  const published = publishNote(status, outcome);
  if (published === undefined) return outcome;
  const draft = outcome.state === "succeeded" && status?.workflow?.outcome === "draft";
  const heldRead = draft ? await readHeld(status?.workflow?.url, repoRoot, job.target) : undefined;
  const segments = [published, heldRead?.segment, outcome.note].filter(Boolean).join("; ");
  return { ...outcome, ...(heldRead === undefined ? {} : { held: heldRead.held }), note: segments };
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
  if (job.kind === "run" || job.kind === "publish") {
    return publicationOutcome(await readJobStatus(job, repoRoot), job, repoRoot, exit.exitCode);
  }
  if (job.cancelRequested) return { state: "cancelled" };
  if (job.kind === "plan") return planOutcome(job, repoRoot);
  if (exit.exitCode === 0) return { state: "succeeded" };
  if (exit.exitCode !== undefined) return { state: "failed", note: `exit code ${exit.exitCode}` };
  return { state: "lost", note: "outcome unknown: exit code not observed" };
}
