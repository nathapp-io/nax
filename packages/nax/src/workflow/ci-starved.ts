import type { ForgeRunResult } from "../forge/types";

export const CI_STARVED_RERUN_LIMIT = 2;

/** The forge runner, declared here so this module needs no import from ci-wait.ts. */
export type CiRun = (cmd: string[], opts: { cwd: string }) => Promise<ForgeRunResult>;

export interface ActionsJob {
  readonly host: string;
  readonly repo: string;
  readonly jobId: string;
}

/** Returns undefined for links that are not GitHub Actions job URLs. */
export function actionsJobOf(link: string): ActionsJob | undefined {
  const match = /^https:\/\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[?#].*)?$/.exec(link);
  if (!match) return undefined;
  const [, host, owner, repository, jobId] = match;
  if (!host || !owner || !repository || !jobId) return undefined;
  return { host, repo: `${owner}/${repository}`, jobId };
}

/** True only for a cancelled job with no runner and no steps. */
export async function isStarvedJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean> {
  let reply: unknown;
  try {
    const result = await run(jobArgv(job), { cwd });
    if (result.exitCode !== 0) return false;
    reply = JSON.parse(result.stdout);
  } catch {
    // The job stays a failure if the API could not be read or parsed.
    return false;
  }
  return hasStarvedShape(reply);
}

function jobArgv(job: ActionsJob): string[] {
  return ["gh", "api", "--hostname", job.host, `repos/${job.repo}/actions/jobs/${job.jobId}`];
}

function hasStarvedShape(reply: unknown): boolean {
  if (typeof reply !== "object" || reply === null) return false;
  const job = reply as { conclusion?: unknown; runner_name?: unknown; steps?: unknown };
  return (
    job.conclusion === "cancelled" &&
    (job.runner_name === "" || job.runner_name === null) &&
    Array.isArray(job.steps) &&
    job.steps.length === 0
  );
}

/** True when the re-run request exited successfully. */
export async function rerunJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean> {
  try {
    const result = await run(
      ["gh", "api", "--hostname", job.host, "-X", "POST", `repos/${job.repo}/actions/jobs/${job.jobId}/rerun`],
      { cwd },
    );
    return result.exitCode === 0;
  } catch {
    // A failed command is a failed re-run request.
    return false;
  }
}
