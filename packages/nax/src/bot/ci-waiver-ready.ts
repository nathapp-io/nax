/**
 * The durable CI-waiver ready step (spec ci-starved-checks US-007).
 *
 * A check no runner ever picked up has no verdict CI can reach on its own, so
 * `nax bot fix <pr> --waive-starved <reason>` is the one way a human accepts it — and only if that
 * acceptance is recorded where the next reader (and `nax workflow status`) can find it. The record
 * is posted before the PR is marked ready: a waiver nobody can read back is worse than a draft, so
 * a failed post becomes the `could not record the CI waiver:` hold and the PR stays a draft.
 *
 * Only a `starved` outcome is ever waived. `failed`, `pending`, `conflicting`, `no-checks` and
 * `unavailable` each have a verdict of their own and keep the draft.
 *
 * The comment write is injected (`post`) so the caller's own `_fixReportDeps` seam still observes
 * the post, and a test that stubs that seam sees the waiver exactly like the evidence comment.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { CiWaitResult } from "../workflow/ci-wait";
import { type CiWaiver, renderCiWaiver } from "../workflow/ci-waiver";
import type { BotFixEnv, BotFixState } from "./fix-steps";

/** The waiver a ready pass recorded; absent from the state when the pass waived nothing. */
export type CiWaiverRecord = NonNullable<BotFixState["ciWaived"]>;

/** The comment writer the caller hands in, so its `_fixReportDeps` seam still sees the post. */
export type CiWaiverPost = (
  ref: BotFixEnv["ref"],
  body: string,
  deps: BotFixEnv["forge"],
  cwd: string,
) => Promise<unknown>;

export interface CiWaiverReadyInput {
  readonly env: BotFixEnv;
  readonly state: Pick<BotFixState, "pushedSha">;
  readonly ci: CiWaitResult;
  readonly post: CiWaiverPost;
}

/** How the waiver step ended: a hold, or the record the ready pass carries into the state. */
export interface CiWaiverReady {
  readonly held?: string;
  readonly ciWaived?: CiWaiverRecord;
}

/**
 * Post the waiver of a starved CI, and report the record it wrote. The head is the exact execution
 * head and the checks are CI's own starved list, so the record names what nobody could judge.
 * Nothing is waived without a reason, and no other outcome is waived at all.
 */
export async function recordCiWaiver({ env, state, ci, post }: CiWaiverReadyInput): Promise<CiWaiverReady> {
  const reason = env.waiveStarved;
  if (reason === undefined || ci.outcome !== "starved") return {};
  const waiver: CiWaiver = { headSha: state.pushedSha ?? env.info.headSha, checks: ci.starvedChecks ?? [], reason };
  try {
    await post(env.ref, renderCiWaiver(waiver), env.forge, env.repoRoot);
  } catch (error) {
    return { held: `could not record the CI waiver: ${errorMessage(error)}` };
  }
  return { ciWaived: { checks: waiver.checks, reason: waiver.reason } };
}
