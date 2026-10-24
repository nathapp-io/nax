/**
 * Bounded CI failure reader.
 *
 * Reads the failed checks of one commit through the forge CLI and returns a
 * short, redacted excerpt per check, so a repair agent can act on a failure
 * without pulling a whole CI log into its context.
 *
 * Every subprocess call goes through the injected `ForgeDeps`; nothing in this
 * module touches a real forge.
 */

import { NaxError } from "@/errors";
import { redactSecrets } from "@/logger";
import type { JobLogRead } from "./job-log";
import { CI_ANNOTATION_CHARS, CI_ANNOTATION_LINES, CI_EXCERPT_CHARS, readJobLog, stripAnsi } from "./job-log";
import type { JobSteps } from "./job-steps";
import { readJobSteps } from "./job-steps";
import { encodeProjectPath } from "./pr-read";
import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

export { CI_EXCERPT_CHARS } from "./job-log";

/** One failed CI check, with a bounded excerpt of its log. */
export interface FailedCheck {
  readonly name: string;
  /** Where the check lives, when the forge reports it. */
  readonly url?: string;
  readonly excerpt: string;
  readonly logUnavailable?: true;
  /** The step that failed, when the forge reports the job's steps. */
  readonly failedStep?: string;
  /** The steps CI skipped after the failed step, in job order. */
  readonly skippedSteps?: readonly string[];
}

/** How many failed checks one read returns. */
export const MAX_FAILED_CHECKS = 5;
/** How many log lines one excerpt keeps. */
export const CI_EXCERPT_LINES = 200;
/** The pull-request number in a forge URL: `/pull/<n>` (GitHub) or `/merge_requests/<n>` (GitLab). */
const PR_NUMBER = /\/(?:pull|merge_requests)\/(\d+)(?=[/?#]|$)/;

/** Conclusions that mean "this check did not fail". */
const PASSED_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** The pull-request number in a GitHub or GitLab URL; null when the URL carries none. */
export function prNumberFromUrl(url: string): number | null {
  const match = PR_NUMBER.exec(url);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * A bounded excerpt of a CI log: ANSI colour codes removed, every secret in
 * the log redacted, the last `CI_EXCERPT_LINES` lines kept and the last
 * `CI_EXCERPT_CHARS` characters of those kept.
 *
 * The redaction runs over the whole log, before the bounds. A bound that cuts
 * a credential's closing delimiter — the `@` of a `postgres://user:pass@host`
 * URL — leaves the matcher without the signal it needs, and the password
 * would reach the excerpt, and from there the repair prompt, in cleartext.
 */
export function ciExcerpt(log: string): string {
  const redacted = redactSecrets(stripAnsi(log));
  const lines = redacted.split("\n");
  const kept = lines.slice(Math.max(0, lines.length - CI_EXCERPT_LINES)).join("\n");
  return kept.length > CI_EXCERPT_CHARS ? kept.slice(-CI_EXCERPT_CHARS) : kept;
}

const ANNOTATION_HEADER = "GitHub Actions error annotations:";
const LOG_TAIL_SEPARATOR = "\n\nLog tail:\n";

/** Select a bounded prefix of annotation lines from an already sanitized log. */
function annotationBlock(log: string): string | null {
  let block = ANNOTATION_HEADER;
  let count = 0;
  for (const line of log.split("\n")) {
    if (!line.includes("##[error]")) continue;
    const next = `${block}\n${line}`;
    if (next.length > CI_ANNOTATION_CHARS) {
      if (count === 0) return next.slice(0, CI_ANNOTATION_CHARS);
      break;
    }
    block = next;
    if (++count === CI_ANNOTATION_LINES) break;
  }
  return count === 0 ? null : block;
}

/** Lead with Actions errors while spending the remaining budget on the log's end. */
function actionsExcerpt(log: string): string {
  const annotations = annotationBlock(log);
  const tail = ciExcerpt(log);
  if (annotations === null) return tail;
  const prefix = `${annotations}${LOG_TAIL_SEPARATOR}`;
  return prefix + tail.slice(-(CI_EXCERPT_CHARS - prefix.length));
}

/** Preserve unreadability as metadata, not just human-facing text. */
function logExcerpt(result: JobLogRead, actions = false): Pick<FailedCheck, "excerpt" | "logUnavailable"> {
  return result.ok
    ? { excerpt: actions ? actionsExcerpt(result.text) : ciExcerpt(result.text) }
    : { excerpt: `(log unavailable: ${result.reason})`, logUnavailable: true };
}

/** One check run as the GitHub check-runs API reports it. */
interface GithubCheckRun {
  readonly id?: number;
  readonly name?: string;
  /** Null while the check is still running. */
  readonly conclusion: string | null;
  readonly html_url?: string;
  readonly app?: { readonly slug?: string };
  readonly output?: {
    readonly title?: string;
    readonly summary?: string;
    readonly text?: string;
  };
}

/** The pull request and commit a CI read belongs to. */
interface CiReadContext {
  readonly ref: PrRef;
  readonly headSha: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Normalize one check run, dropping the fields the reply does not carry. */
function toCheckRun(value: unknown): GithubCheckRun | null {
  const run = asRecord(value);
  if (!run) return null;
  const app = asRecord(run.app);
  const output = asRecord(run.output);
  return {
    id: typeof run.id === "number" ? run.id : undefined,
    name: typeof run.name === "string" ? run.name : undefined,
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    html_url: typeof run.html_url === "string" ? run.html_url : undefined,
    app: { slug: typeof app?.slug === "string" ? app.slug : undefined },
    output: {
      title: typeof output?.title === "string" ? output.title : undefined,
      summary: typeof output?.summary === "string" ? output.summary : undefined,
      text: typeof output?.text === "string" ? output.text : undefined,
    },
  };
}

/** A check run failed when it concluded anything but success, skipped or neutral. */
function isFailedCheckRun(run: GithubCheckRun): boolean {
  return run.conclusion !== null && !PASSED_CONCLUSIONS.has(run.conclusion);
}

/** The check-run output, with the empty parts left out. */
function outputText(run: GithubCheckRun): string {
  const parts = [run.output?.title, run.output?.summary, run.output?.text].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join("\n") : "(no output)";
}

/** Read one CI listing from the forge CLI; a failed or unparseable reply is an error. */
export async function readCiListing(
  cmd: string[],
  deps: ForgeDeps,
  cwd: string,
  context: CiReadContext,
): Promise<unknown> {
  const result = await deps.run(cmd, { cwd });
  if (result.exitCode !== 0) {
    throw new NaxError(`[forge] Cannot read the CI checks: ${result.stderr.trim()}`, "FORGE_CI_READ_FAILED", {
      stage: "forge",
      ...context,
      exitCode: result.exitCode,
    });
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new NaxError("[forge] Cannot parse the CI check response", "FORGE_CI_READ_FAILED", {
      stage: "forge",
      ...context,
      cause,
    });
  }
}

/** The check runs of a reply, in reply order. */
function parseCheckRuns(reply: unknown, context: CiReadContext): GithubCheckRun[] {
  const runs = asRecord(reply)?.check_runs;
  if (!Array.isArray(runs)) throw invalidReply("check-runs", context);
  return runs.map(toCheckRun).filter((run): run is GithubCheckRun => run !== null);
}

/** A reply that is not the shape the endpoint promises. */
function invalidReply(what: string, context: CiReadContext): NaxError {
  return new NaxError(`[forge] Invalid ${what} response`, "FORGE_CI_READ_FAILED", {
    stage: "forge",
    ...context,
  });
}

/** The app slug of a GitHub Actions check run, the only app with a job endpoint. */
const ACTIONS_APP = "github-actions";

/** The Actions job id of a check run; undefined for every other app and for a run without an id. */
function actionsJobId(run: GithubCheckRun): string | undefined {
  if (run.app?.slug !== ACTIONS_APP) return undefined;
  return run.id === undefined ? undefined : String(run.id);
}

/**
 * The excerpt of one failed check: the job log for a GitHub Actions run, the
 * check-run output for every other app.
 */
async function readExcerpt(
  run: GithubCheckRun,
  ref: PrRef,
  deps: ForgeDeps,
  cwd: string,
): Promise<Pick<FailedCheck, "excerpt" | "logUnavailable">> {
  const jobId = actionsJobId(run);
  if (jobId === undefined) return { excerpt: ciExcerpt(outputText(run)) };
  return logExcerpt(await readJobLog(ref, jobId, deps, cwd), true);
}

/**
 * The steps of an Actions job, read after its log. Best effort and GitHub-only:
 * a GitLab job exposes no step list, so it is never asked for one.
 */
async function readSteps(run: GithubCheckRun, ref: PrRef, deps: ForgeDeps, cwd: string): Promise<JobSteps> {
  const jobId = actionsJobId(run);
  return jobId === undefined ? {} : readJobSteps(ref, jobId, deps, cwd);
}

/** One failed check, with its bounded excerpt and, for Actions, its job's steps. */
async function toFailedCheck(run: GithubCheckRun, ref: PrRef, deps: ForgeDeps, cwd: string): Promise<FailedCheck> {
  const log = await readExcerpt(run, ref, deps, cwd);
  const steps = await readSteps(run, ref, deps, cwd);
  const url = run.html_url && run.html_url.length > 0 ? run.html_url : undefined;
  return { name: run.name ?? "", ...(url === undefined ? {} : { url }), ...log, ...steps };
}

/** The failed checks of one GitHub commit, in reply order. */
async function readGithubFailedChecks(
  ref: PrRef,
  headSha: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<readonly FailedCheck[]> {
  const endpoint = `repos/${ref.repo}/commits/${headSha}/check-runs?per_page=100&filter=latest`;
  const context = { ref, headSha };
  const reply = await readCiListing(["gh", "api", "--hostname", ref.host, endpoint], deps, cwd, context);
  const failed = parseCheckRuns(reply, context).filter(isFailedCheckRun).slice(0, MAX_FAILED_CHECKS);
  return Promise.all(failed.map((run) => toFailedCheck(run, ref, deps, cwd)));
}

/** One GitLab pipeline, as the pipelines API reports it. */
interface GitlabPipeline {
  readonly id?: number;
  readonly sha?: string;
}

/** One GitLab job, as the jobs API reports it. */
interface GitlabJob {
  readonly id?: number;
  readonly name?: string;
  readonly web_url?: string;
  readonly allow_failure?: boolean;
}

/** Normalize one pipeline, dropping the fields the reply does not carry. */
function toGitlabPipeline(value: unknown): GitlabPipeline | null {
  const pipeline = asRecord(value);
  if (!pipeline) return null;
  return {
    id: typeof pipeline.id === "number" ? pipeline.id : undefined,
    sha: typeof pipeline.sha === "string" ? pipeline.sha : undefined,
  };
}

/** Normalize one job, dropping the fields the reply does not carry. */
function toGitlabJob(value: unknown): GitlabJob | null {
  const job = asRecord(value);
  if (!job) return null;
  return {
    id: typeof job.id === "number" ? job.id : undefined,
    name: typeof job.name === "string" ? job.name : undefined,
    web_url: typeof job.web_url === "string" ? job.web_url : undefined,
    allow_failure: job.allow_failure === true,
  };
}

/** The pipelines of a reply, in reply order. */
function parsePipelines(reply: unknown, context: CiReadContext): GitlabPipeline[] {
  if (!Array.isArray(reply)) throw invalidReply("pipelines", context);
  return reply.map(toGitlabPipeline).filter((pipeline): pipeline is GitlabPipeline => pipeline !== null);
}

/** The jobs of a reply, in reply order. */
function parseJobs(reply: unknown, context: CiReadContext): GitlabJob[] {
  if (!Array.isArray(reply)) throw invalidReply("jobs", context);
  return reply.map(toGitlabJob).filter((job): job is GitlabJob => job !== null);
}

/** A job whose log can be read: only a job with an id has a trace to fetch. */
function hasJobId(job: GitlabJob): job is GitlabJob & { readonly id: number } {
  return typeof job.id === "number";
}

/** The pipeline of the requested head, when the merge request has one. */
function findPipeline(pipelines: readonly GitlabPipeline[], headSha: string): GitlabPipeline | null {
  return pipelines.find((pipeline) => pipeline.sha === headSha) ?? null;
}

/** One failed GitLab job, with its bounded excerpt. */
async function toGitlabFailedCheck(
  job: GitlabJob & { readonly id: number },
  ref: PrRef,
  deps: ForgeDeps,
  cwd: string,
): Promise<FailedCheck> {
  const log = logExcerpt(await readJobLog(ref, String(job.id), deps, cwd));
  const url = job.web_url && job.web_url.length > 0 ? job.web_url : undefined;
  return { name: job.name ?? "", ...(url === undefined ? {} : { url }), ...log };
}

/**
 * The failed jobs of the pipeline of the head commit.
 *
 * The merge request's pipelines are read first, and the first one whose sha is
 * the head is the pipeline of this commit. A merge request without a pipeline
 * for the head has no failed check to report.
 */
async function readGitlabFailedChecks(
  ref: PrRef,
  headSha: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<readonly FailedCheck[]> {
  const context = { ref, headSha };
  const project = encodeProjectPath(ref.repo);
  const pipelinesReply = await readCiListing(
    ["glab", "api", "--hostname", ref.host, `projects/${project}/merge_requests/${ref.number}/pipelines?per_page=20`],
    deps,
    cwd,
    context,
  );
  const pipeline = findPipeline(parsePipelines(pipelinesReply, context), headSha);
  // A pipeline without a numeric id cannot be read: the jobs call needs it. The reply is malformed,
  // so it fails like every other malformed reply instead of reading as "no pipeline for this head".
  if (!pipeline) return [];
  if (pipeline.id === undefined) throw invalidReply("pipelines", context);
  const jobsReply = await readCiListing(
    [
      "glab",
      "api",
      "--hostname",
      ref.host,
      `projects/${project}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=100`,
    ],
    deps,
    cwd,
    context,
  );
  const jobs = parseJobs(jobsReply, context)
    .filter((job) => !job.allow_failure)
    .filter(hasJobId)
    .slice(0, MAX_FAILED_CHECKS);
  return Promise.all(jobs.map((job) => toGitlabFailedCheck(job, ref, deps, cwd)));
}

/**
 * The failed checks of one commit, with a bounded excerpt of each.
 *
 * Only the first page of check runs is read, and at most `MAX_FAILED_CHECKS`
 * failed checks are returned.
 */
export async function readFailedChecks(
  ref: PrRef,
  headSha: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<readonly FailedCheck[]> {
  if (ref.forge === "github") return readGithubFailedChecks(ref, headSha, deps, cwd);
  return readGitlabFailedChecks(ref, headSha, deps, cwd);
}
