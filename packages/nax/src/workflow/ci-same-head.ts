/**
 * The same-head re-run's forge half (US-003). The CI wait decides *whether* to re-run a check that
 * passed elsewhere on the same commit (`ci-wait-same-head.ts`); this module is what the workflow's
 * own publish hands it to make that call: a read of the head commit's failed checks, and a re-run of
 * one of them — `gh` for an Actions job, `glab` for a GitLab job.
 *
 * Both forge calls go through the injected `_ciSameHeadDeps`, and the PR resolution through
 * `_ciFailuresDeps` (the reader's own seam), so no test touches a real forge.
 */
import type { PrRef } from "@/forge";
import { defaultForgeDeps, encodeProjectPath, type FailedCheck, type ForgeRunResult, prNumberFromUrl } from "@/forge";
import { _ciFailuresDeps, type CiFailuresInput, readCiFailuresFor } from "./ci-failures";
import { type CiRun, rerunJob } from "./ci-starved";
import type { SameHeadRerun } from "./ci-wait";
import type { FeatureContext } from "./feature-context";

/** Every forge call the adapter makes, injected so a test can fake it. */
export const _ciSameHeadDeps = {
  run: (cmd: string[], opts: { cwd: string }): Promise<ForgeRunResult> => defaultForgeDeps.run(cmd, opts),
  readCiFailures: readCiFailuresFor,
} satisfies { run: CiRun; readCiFailures: typeof readCiFailuresFor };

/**
 * The PR the re-run targets, resolved at most once per wait: every check of one head is on the same
 * PR, and a forge detect per check would be a second and third remote read for no new fact. A URL
 * that names no pull request has nothing to resolve, so it resolves to null rather than throwing.
 */
type RefResolver = () => Promise<PrRef | null>;

async function resolveRef(fc: FeatureContext, url: string): Promise<PrRef | null> {
  const number = prNumberFromUrl(url);
  if (number === null) return null;
  return await _ciFailuresDeps.resolvePrRef(number, _ciFailuresDeps.forge, fc.projectDir);
}

function refResolver(fc: FeatureContext, url: string): RefResolver {
  let cached: Promise<PrRef | null> | undefined;
  return () => {
    cached ??= resolveRef(fc, url);
    return cached;
  };
}

/** The GitLab retry request: one API POST, in the same `glab api --hostname <host>` form as the reads. */
function retryArgv(ref: PrRef, jobId: string): string[] {
  const job = `projects/${encodeProjectPath(ref.repo)}/jobs/${jobId}/retry`;
  return ["glab", "api", "--hostname", ref.host, "-X", "POST", job];
}

/** True when the forge accepted the request for this check; a check with no job id is not re-runnable. */
async function rerunCheck(check: FailedCheck, ref: RefResolver, cwd: string): Promise<boolean> {
  if (check.jobId === undefined) return false;
  try {
    const pr = await ref();
    if (pr === null) return false;
    if (pr.forge === "gitlab") {
      const result = await _ciSameHeadDeps.run(retryArgv(pr, check.jobId), { cwd });
      return result.exitCode === 0;
    }
    return await rerunJob({ host: pr.host, repo: pr.repo, jobId: check.jobId }, cwd, _ciSameHeadDeps.run);
  } catch {
    // An unresolvable PR or a forge call that threw is a refused request: the wait keeps its `failed`.
    return false;
  }
}

/**
 * The same-head re-run of the PR at `url`, whose head commit is `head`: the checks are read through
 * `readCiFailuresFor`, and a check is re-run on the forge the PR's origin names.
 */
export function sameHeadRerunFor(fc: FeatureContext, url: string, head: string): SameHeadRerun {
  const ref = refResolver(fc, url);
  const input: CiFailuresInput = { url, head };
  return {
    read: (): Promise<readonly FailedCheck[]> => _ciSameHeadDeps.readCiFailures(fc, input),
    rerun: (check) => rerunCheck(check, ref, fc.projectDir),
  };
}
