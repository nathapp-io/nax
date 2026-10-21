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
import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

/** One failed CI check, with a bounded excerpt of its log. */
export interface FailedCheck {
  readonly name: string;
  /** Where the check lives, when the forge reports it. */
  readonly url?: string;
  readonly excerpt: string;
}

/** How many failed checks one read returns. */
export const MAX_FAILED_CHECKS = 5;
/** How many log lines one excerpt keeps. */
export const CI_EXCERPT_LINES = 200;
/** How many characters one excerpt keeps. */
export const CI_EXCERPT_CHARS = 8_000;

/** ANSI CSI sequences: ESC `[`, parameter and intermediate bytes, one final byte. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC (0x1b) control byte is the point — ANSI colour codes must be stripped
const ANSI_CSI = /\u001b\[[\x20-\x3f]*[\x40-\x7e]/g;

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
 * A bounded excerpt of a CI log: ANSI colour codes removed, the last
 * `CI_EXCERPT_LINES` lines kept, the last `CI_EXCERPT_CHARS` characters of
 * those kept, and every secret in the result redacted.
 */
export function ciExcerpt(log: string): string {
  const plain = log.replace(ANSI_CSI, "");
  const lines = plain.split("\n");
  const kept = lines.slice(Math.max(0, lines.length - CI_EXCERPT_LINES)).join("\n");
  const bounded = kept.length > CI_EXCERPT_CHARS ? kept.slice(-CI_EXCERPT_CHARS) : kept;
  return redactSecrets(bounded);
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

function asRecord(value: unknown): Record<string, unknown> | null {
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
async function readCiListing(cmd: string[], deps: ForgeDeps, cwd: string, context: CiReadContext): Promise<unknown> {
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
  if (!Array.isArray(runs)) {
    throw new NaxError("[forge] Invalid check-runs response", "FORGE_CI_READ_FAILED", {
      stage: "forge",
      ...context,
    });
  }
  return runs.map(toCheckRun).filter((run): run is GithubCheckRun => run !== null);
}

/**
 * The excerpt of one failed check: the job log for a GitHub Actions run, the
 * check-run output for every other app.
 */
async function readExcerpt(run: GithubCheckRun, ref: PrRef, deps: ForgeDeps, cwd: string): Promise<string> {
  const jobId = run.app?.slug === "github-actions" ? run.id : undefined;
  if (jobId === undefined) return ciExcerpt(outputText(run));
  // A GitHub Actions check run carries the job id, so `gh run view` reads that
  // job's failed log. The "(log unavailable)" excerpt of a failed read lands
  // with the rest of the error handling.
  const result = await deps.run(
    ["gh", "run", "view", "--job", String(jobId), "--log-failed", "-R", `${ref.host}/${ref.repo}`],
    { cwd },
  );
  return ciExcerpt(result.stdout);
}

/** One failed check, with its bounded excerpt. */
async function toFailedCheck(run: GithubCheckRun, ref: PrRef, deps: ForgeDeps, cwd: string): Promise<FailedCheck> {
  const excerpt = await readExcerpt(run, ref, deps, cwd);
  const url = run.html_url && run.html_url.length > 0 ? run.html_url : undefined;
  return { name: run.name ?? "", ...(url === undefined ? {} : { url }), excerpt };
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
  // GitLab joins the reader with the GitLab half of the forge support.
  return [];
}
