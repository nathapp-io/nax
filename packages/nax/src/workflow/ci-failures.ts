/**
 * The production CI-failure reader of the feature workflow (US-008).
 *
 * A published PR's URL names the pull request and the head sha names the commit whose CI failed.
 * Both forge reads go through the injected `_ciFailuresDeps`, so nothing here touches a real forge.
 */
import { NaxError } from "@/errors";
import { defaultForgeDeps, type FailedCheck, prNumberFromUrl, readFailedChecks, resolvePrRef } from "@/forge";
import type { FeatureContext } from "./feature-context";

/** The pull request and the commit whose failed checks are read. */
export interface CiFailuresInput {
  readonly url: string;
  readonly head: string;
}

/** Every forge call the reader makes, injected so a test can fake it. */
export const _ciFailuresDeps = {
  resolvePrRef,
  readFailedChecks,
  forge: defaultForgeDeps,
};

/**
 * The failed checks of the PR's head commit, each with a bounded excerpt of its log.
 *
 * A URL that names no pull request cannot be read: the number is the only thing that identifies the
 * PR, so the read fails with `WORKFLOW_CI_PR_URL` and the caller treats it as a read failure.
 */
export async function readCiFailuresFor(fc: FeatureContext, input: CiFailuresInput): Promise<readonly FailedCheck[]> {
  const number = prNumberFromUrl(input.url);
  if (number === null) {
    throw new NaxError(`[workflow] The PR URL carries no pull-request number: ${input.url}`, "WORKFLOW_CI_PR_URL", {
      stage: "workflow",
      storyId: "_run",
      url: input.url,
    });
  }
  const ref = await _ciFailuresDeps.resolvePrRef(number, _ciFailuresDeps.forge, fc.projectDir);
  return _ciFailuresDeps.readFailedChecks(ref, input.head, _ciFailuresDeps.forge, fc.projectDir);
}
