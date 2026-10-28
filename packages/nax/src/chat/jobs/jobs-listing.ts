/** Plain-text rows for the chat /jobs command. */
import type { ChatJob } from "./job-types";

const MAX_LISTED_JOBS = 20;

function jobLine(job: ChatJob): string {
  const target = job.kind === "bot_review" || job.kind === "bot_fix" ? `#${job.target}` : job.target;
  const parts = [`${job.id}  ${job.state}  ${job.kind} ${target}`];
  if (job.progress !== undefined) parts.push(`${job.progress.passed}/${job.progress.total}`);
  if (job.cost !== undefined) parts.push(`$${job.cost.toFixed(2)}`);
  parts.push(job.startedAt);
  return parts.join("  ");
}

export function formatJobsListing(jobs: readonly ChatJob[]): string {
  if (jobs.length === 0) return "(no jobs)";
  const newestFirst = [...jobs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const lines = newestFirst.slice(0, MAX_LISTED_JOBS).map(jobLine);
  if (jobs.length > MAX_LISTED_JOBS) lines.push(`+${jobs.length - MAX_LISTED_JOBS} more`);
  return lines.join("\n");
}
