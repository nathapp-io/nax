/**
 * The commit path of the CI wait: when a branch has no pull request, read the check runs of
 * the expected commit (`gh api .../check-runs`) and classify them like a `gh pr checks` list.
 * `run` is passed in at call time so a replaced `_ciWaitDeps.run` still intercepts the call.
 */
import type { ForgeRunResult } from "@/forge";
import type { CiRun } from "./ci-starved";
import type { GhCheck, Poll } from "./ci-wait";
import { classifyChecks, cliError, isRecord, parseJson } from "./ci-wait-checks";

const NO_PR = /no pull requests found/i;
const UNPARSEABLE_LIMIT = 200;
const SHORT_SHA = 8;

const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

/** True when a `gh pr checks` answer says the branch has no pull request. */
export function isNoPullRequest(r: ForgeRunResult): boolean {
  return r.exitCode !== 0 && NO_PR.test(r.stderr);
}

function bucketOf(status: unknown, conclusion: unknown): string {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "pass";
  if (conclusion === "skipped" || conclusion === "neutral") return "skipping";
  if (conclusion === "cancelled") return "cancel";
  return typeof conclusion === "string" && FAIL_CONCLUSIONS.has(conclusion) ? "fail" : "pending";
}

function checkOf(value: unknown): GhCheck {
  const run = isRecord(value) ? value : {};
  const raw = run.status === "completed" ? run.conclusion : run.status;
  return {
    name: typeof run.name === "string" ? run.name : "",
    state: typeof raw === "string" ? raw.toUpperCase() : "",
    bucket: bucketOf(run.status, run.conclusion),
    ...(typeof run.html_url === "string" ? { link: run.html_url } : {}),
  };
}

function classifyRuns(r: ForgeRunResult, sha: string): Poll {
  if (r.exitCode !== 0) return cliError(r);
  const parsed = parseJson(r.stdout.trim());
  if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.check_runs)) {
    return { state: "error", detail: `unparseable gh output: ${r.stdout.trim().slice(0, UNPARSEABLE_LIMIT)}` };
  }
  const runs = parsed.value.check_runs;
  const total = parsed.value.total_count;
  if (typeof total === "number" && total > runs.length) {
    return {
      state: "error",
      detail: `commit ${sha.slice(0, SHORT_SHA)} has ${total} check runs; only the first ${runs.length} were read`,
    };
  }
  const poll = classifyChecks(runs.map(checkOf));
  return "detail" in poll ? poll : { ...poll, sha };
}

/** Read the commit's check runs and classify them; a spawn failure surfaces to the caller's catch. */
export async function commitChecksPoll(run: CiRun, sha: string, cwd: string): Promise<Poll> {
  const r = await run(["gh", "api", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`], { cwd });
  return classifyRuns(r, sha);
}
