/**
 * The chat job panel's view model (chat-job-panel US-001): a pure projection over the
 * artifacts a job leaves behind, plus a fail-soft reader that gathers them. Every source
 * is diagnostics, so a missing or unreadable one contributes its empty value and the panel
 * still renders. Display and host behaviour only — nothing here reaches an agent's context.
 */
import { join } from "node:path";
import { type AdviceDecision, decisionBody, readDecisions } from "@/advisor";
import { featureDir } from "@/config";
import type { NaxStatusFile } from "@/execution/status-file";
import { loadPRD, type PRD, type StoryStatus } from "@/prd";
import { readJobStatus } from "./job-outcome";
import type { ChatJobs } from "./job-runner";
import { type ChatJob, type ChatJobKind, type ChatJobState, isRunJobKind } from "./job-types";

/** Log lines the panel keeps. Fixed: the panel is a glance, not a log viewer. */
export const JOB_PANEL_LOG_LINES = 12;
/**
 * The log bytes one panel refresh may scan. The panel is a two-second glance, and an unbounded
 * scan of a single huge record cost the refresh the whole record; 64 KiB keeps a typical tail
 * inside one read while a longer line arrives marked as cut.
 */
export const JOB_PANEL_TAIL_SCAN_BYTES = 64 * 1024;

export interface JobPanelStory {
  readonly id: string;
  readonly title: string;
  readonly status: StoryStatus;
  readonly current: boolean;
}

export interface JobPanelDecision {
  readonly line: string;
  readonly flagged: boolean;
}

export interface JobPanelView {
  readonly jobId: string;
  readonly kind: ChatJobKind;
  readonly target: string;
  readonly state: ChatJobState;
  readonly elapsedMs: number;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly current?: { readonly storyId: string; readonly phase: string };
  readonly stories: readonly JobPanelStory[];
  /** Flagged first, then newest first. */
  readonly decisions: readonly JobPanelDecision[];
  readonly logTail: readonly string[];
}

export interface JobPanelSources {
  readonly job: ChatJob;
  readonly now: Date;
  readonly status: NaxStatusFile | null;
  readonly stories: readonly { readonly id: string; readonly title: string; readonly status: StoryStatus }[];
  readonly decisions: readonly AdviceDecision[];
  readonly logTail: string;
}

/** A timestamp in epoch ms, or undefined when absent or unparseable. */
function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function elapsedOf(job: ChatJob, now: Date): number {
  const start = parseTime(job.startedAt);
  if (start === undefined) return 0;
  const end = job.endedAt === undefined ? now.getTime() : (parseTime(job.endedAt) ?? now.getTime());
  return Math.max(0, end - start);
}

/** The live story comes from the run record, and only while the job is still running. */
function currentOf(job: ChatJob, status: NaxStatusFile | null): JobPanelView["current"] {
  if (job.state !== "running" || !status?.current) return undefined;
  return { storyId: status.current.storyId, phase: status.current.phase };
}

function costOf(job: ChatJob, status: NaxStatusFile | null): number | undefined {
  return status ? status.cost.spent : job.cost;
}

function progressOf(job: ChatJob, status: NaxStatusFile | null): JobPanelView["progress"] {
  if (status) return { passed: status.progress.passed, total: status.progress.total };
  return job.progress ? { passed: job.progress.passed, total: job.progress.total } : undefined;
}

function storiesOf(stories: JobPanelSources["stories"], current: JobPanelView["current"]): readonly JobPanelStory[] {
  return stories.map((story) => ({
    id: story.id,
    title: story.title,
    status: story.status,
    current: current !== undefined && story.id === current.storyId,
  }));
}

/** Decisions this job could have produced, flagged first, then newest first. */
function decisionsOf(decisions: readonly AdviceDecision[], startedAt: string): readonly JobPanelDecision[] {
  const since = parseTime(startedAt);
  const kept = decisions.flatMap((decision) => {
    const at = parseTime(decision.decidedAt);
    if (at === undefined || (since !== undefined && at < since)) return [];
    return [{ at, line: decisionBody(decision), flagged: decision.needsHumanConfirm === true }];
  });
  kept.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.at - a.at);
  return kept.map(({ line, flagged }) => ({ line, flagged }));
}

function logLinesOf(logTail: string): readonly string[] {
  return logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-JOB_PANEL_LOG_LINES);
}

export function buildJobPanelView(sources: JobPanelSources): JobPanelView {
  const { job, status } = sources;
  const current = currentOf(job, status);
  return {
    jobId: job.id,
    kind: job.kind,
    target: job.target,
    state: job.state,
    elapsedMs: elapsedOf(job, sources.now),
    cost: costOf(job, status),
    progress: progressOf(job, status),
    current,
    stories: storiesOf(sources.stories, current),
    decisions: decisionsOf(sources.decisions, job.startedAt),
    logTail: logLinesOf(sources.logTail),
  };
}

/** Everything the panel reads from disk, injectable for tests. */
export const _jobPanelDeps: {
  readJobStatus: (job: ChatJob, repoRoot: string) => Promise<NaxStatusFile | null>;
  loadPRD: (path: string) => Promise<PRD>;
  readDecisions: (repoRoot: string, feature: string) => Promise<AdviceDecision[]>;
  exists: (path: string) => Promise<boolean>;
} = {
  readJobStatus,
  loadPRD,
  readDecisions,
  exists: (path: string) => Bun.file(path).exists(),
};

async function statusSource(job: ChatJob): Promise<NaxStatusFile | null> {
  try {
    return await _jobPanelDeps.readJobStatus(job, job.cwd);
  } catch {
    // A missing or unreadable run record is expected; the job record's own figures stand in.
    return null;
  }
}

async function storiesSource(job: ChatJob): Promise<JobPanelSources["stories"]> {
  const path = join(featureDir(job.cwd, job.target), "prd.json");
  try {
    if (!(await _jobPanelDeps.exists(path))) return [];
    const prd = await _jobPanelDeps.loadPRD(path);
    return prd.userStories.map(({ id, title, status }) => ({ id, title, status }));
  } catch {
    // A plan may not have written a PRD yet, and a torn one is not worth failing the panel for.
    return [];
  }
}

async function decisionsSource(job: ChatJob): Promise<readonly AdviceDecision[]> {
  try {
    return await _jobPanelDeps.readDecisions(job.cwd, job.target);
  } catch {
    // An unreadable ledger means no rulings to show, not a broken panel.
    return [];
  }
}

async function logTailSource(job: ChatJob, jobs: Pick<ChatJobs, "logTail">): Promise<string> {
  try {
    return await jobs.logTail(job.id, JOB_PANEL_LOG_LINES, {
      nonEmpty: true,
      maxBytes: JOB_PANEL_TAIL_SCAN_BYTES,
    });
  } catch {
    // The log file can be gone with the process; the rest of the panel still renders.
    return "";
  }
}

/**
 * Gathers the artifacts of `job`. Only `run` and `publish` jobs write a run record and a
 * feature PRD; a `plan` job has no run record yet and a bot job owns no feature at all.
 */
export async function readJobPanelView(
  job: ChatJob,
  jobs: Pick<ChatJobs, "logTail">,
  now: Date,
): Promise<JobPanelView> {
  const featureScoped = isRunJobKind(job.kind);
  const [status, stories, decisions, logTail] = await Promise.all([
    featureScoped ? statusSource(job) : null,
    featureScoped ? storiesSource(job) : [],
    featureScoped ? decisionsSource(job) : [],
    logTailSource(job, jobs),
  ]);
  return buildJobPanelView({ job, now, status, stories, decisions, logTail });
}
