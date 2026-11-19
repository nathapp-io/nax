/**
 * The footer's one-row ledger of work in flight: the nax jobs this chat started, and the background
 * tasks it owns — a shell command or a subagent run.
 *
 * Split out of `chat-status.ts`, which is at the source line cap; `chat-status.ts` re-exports this
 * module's names, so the footer and its tests reach it through one import site as before.
 */
import { singleRow } from "./layout-lines";
import type { Span } from "./styled-line";

const SEPARATOR = " · ";
const COST_DECIMALS = 2;
const JOB_TARGET_LIMIT = 16;
const JOB_STRIP_LIMIT = 2;

export interface FooterJob {
  readonly kind: "run" | "plan" | "publish" | "bot_review" | "bot_fix";
  readonly target: string;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly cost?: number;
}

/** A running host-owned background task — a shell command or a subagent run — as the footer strip needs it. */
export interface FooterTask {
  readonly command: string;
  /** Absent for a shell command; "agent" for a background subagent run. */
  readonly kind?: "agent";
}

function jobPart(job: FooterJob): string {
  const target = singleRow(job.target);
  if (job.kind === "bot_review" || job.kind === "bot_fix") return `${job.kind} #${target}`;
  const feature = target.length > JOB_TARGET_LIMIT ? `${target.slice(0, JOB_TARGET_LIMIT - 1)}…` : target;
  let part = `${job.kind} ${feature}`;
  if (job.kind === "run" || job.kind === "publish") {
    if (job.progress !== undefined) part += ` ${job.progress.passed}/${job.progress.total}`;
    if (job.cost !== undefined) part += ` $${job.cost.toFixed(COST_DECIMALS)}`;
  }
  return part;
}

/** `1 shell`, `2 agents`. */
function countPart(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The task counts as at most two parts, shells first; a kind with no running task contributes none. */
function taskParts(tasks: readonly FooterTask[]): string[] {
  const shells = tasks.filter((task) => task.kind !== "agent").length;
  const agents = tasks.length - shells;
  const parts: string[] = [];
  if (shells > 0) parts.push(countPart(shells, "shell"));
  if (agents > 0) parts.push(countPart(agents, "agent"));
  return parts;
}

/**
 * The strip's span: the accent colour and an underline, because the strip is the one footer part
 * a left click opens (the jobs list, or the lone shell's output). Its text is the caller's, so the
 * measuring the click geometry uses is unchanged.
 */
export function stripSpan(text: string): Span {
  return { text, color: "accent", underline: true };
}

/**
 * Compact, independent ledger of jobs then background tasks for the one-row footer: the first `JOB_STRIP_LIMIT` jobs,
 * the jobs they hid, and — when tasks run — one part per kind counting them, since a few shells or agents would crowd
 * the row.
 */
export function formatJobStrip(jobs: readonly FooterJob[], tasks: readonly FooterTask[] = []): string {
  const hidden = jobs.length - JOB_STRIP_LIMIT;
  const strip = jobs.slice(0, JOB_STRIP_LIMIT).map(jobPart).join(SEPARATOR);
  const counted = hidden > 0 ? `${strip} +${hidden}` : strip;
  const parts = taskParts(tasks);
  if (parts.length === 0) return counted;
  return counted === "" ? parts.join(SEPARATOR) : `${counted}${SEPARATOR}${parts.join(SEPARATOR)}`;
}
