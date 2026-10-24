/**
 * Bounded read of a GitHub Actions job's steps.
 *
 * A job stops at its first failing step, so every step after it never ran. The
 * pair of facts that follows — the step that failed, and the steps CI skipped
 * because of it — tells a repair agent what else to reproduce locally, which
 * the job name alone cannot. This module reads them from the Actions jobs API;
 * the CI workflow files are never parsed.
 *
 * The read is best effort. A failed command, an unparsable reply, a reply
 * without a `steps` array and a job with no step that failed each leave both
 * fields absent, and nothing else about the failed check changes. Only a GitHub
 * Actions job exposes a step list, so no other forge is asked.
 */

import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

/** The step that failed and the steps CI skipped after it; both absent when unknown. */
export interface JobSteps {
  readonly failedStep?: string;
  readonly skippedSteps?: readonly string[];
}

/** The conclusion of the step CI stopped at. */
const FAILED = "failure";
/** The conclusion of a step CI never ran. */
const SKIPPED = "skipped";

/** One step, as far as this module reads it: only a named step can be reported. */
interface JobStep {
  readonly name: string;
  readonly conclusion: string;
}

/** The steps of a reply, or null when the reply is not the shape the endpoint promises. */
function stepsOf(reply: unknown): readonly unknown[] | null {
  if (typeof reply !== "object" || reply === null) return null;
  const steps = (reply as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps : null;
}

/** One step of a reply, or null for an entry this module cannot name. */
function toStep(value: unknown): JobStep | null {
  if (typeof value !== "object" || value === null) return null;
  const step = value as { name?: unknown; conclusion?: unknown };
  if (typeof step.name !== "string" || step.name.length === 0) return null;
  return { name: step.name, conclusion: typeof step.conclusion === "string" ? step.conclusion : "" };
}

/** The failed step and the skipped steps after it; empty when no named step failed. */
function summarize(steps: readonly JobStep[]): JobSteps {
  const at = steps.findIndex((step) => step.conclusion === FAILED);
  const after = at === -1 ? [] : steps.slice(at);
  const failedStep = after[0]?.name;
  if (failedStep === undefined) return {};
  const skippedSteps = after
    .slice(1)
    .filter((step) => step.conclusion === SKIPPED)
    .map((step) => step.name);
  return { failedStep, ...(skippedSteps.length === 0 ? {} : { skippedSteps }) };
}

/** The argv of one job read: the log has its own endpoint and is read separately. */
function jobStepsArgv(ref: PrRef, jobId: string): string[] {
  return ["gh", "api", "--hostname", ref.host, `repos/${ref.repo}/actions/jobs/${jobId}`];
}

/** Read one Actions job's steps; every failure mode leaves both fields absent. */
export async function readJobSteps(ref: PrRef, jobId: string, deps: ForgeDeps, cwd: string): Promise<JobSteps> {
  let reply: unknown;
  try {
    const result = await deps.run(jobStepsArgv(ref, jobId), { cwd });
    if (result.exitCode !== 0) return {};
    reply = JSON.parse(result.stdout);
  } catch {
    // A command that never ran, and a reply that is not JSON, carry no steps.
    // The excerpt already came from the log, and the check is still reported.
    return {};
  }
  const steps = stepsOf(reply);
  if (steps === null) return {};
  return summarize(steps.map(toStep).filter((step): step is JobStep => step !== null));
}
