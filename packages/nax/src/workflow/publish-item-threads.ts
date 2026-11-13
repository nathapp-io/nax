/** Best-effort durable PR items after publish; never changes the graph's publish result. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { FeatureEnv } from "./feature-machine";
import type { PublishOutcome } from "./finalize";
import type { ItemThreadsOutcome } from "./item-threads-post";
import { ledgerText } from "./ledger";
import type { WorkflowFeatureRecord } from "./types";

async function changedFiles(env: FeatureEnv, seed: string | null): Promise<readonly string[]> {
  if (!seed) return [];
  try {
    return await env.steps.changedFiles(seed);
  } catch (error) {
    getLogger()?.warn("item-threads", "[item-threads] Changed files unavailable; using no anchor", {
      error: errorMessage(error),
    });
    return [];
  }
}

/**
 * The note this step leaves in the ledger, best effort: it says what the publish posted, but it is
 * not the publish. A ledger failure is a warning, never a reason to discard the step's outcome —
 * that outcome is the only thing that says whether the settle-worthy index landed on the PR.
 */
async function noteItemThreads(env: FeatureEnv, feature: string, outcome: ItemThreadsOutcome): Promise<void> {
  try {
    await env.sink.ledger(
      ledgerText.note(
        `Item threads: posted=${outcome.posted}, closed=${outcome.closed}, skipped=${outcome.skipped}, failed=${outcome.failed}`,
      ),
      { mirror: false },
    );
  } catch (error) {
    getLogger()?.warn("item-threads", "[item-threads] Could not record the item-thread ledger note", {
      feature,
      error: errorMessage(error),
    });
  }
}

/**
 * Four arguments intentionally mirror the publish seam specified by the workflow contract.
 *
 * US-003: the step's outcome is returned, because only it says whether this publish left the PR with
 * an item index. `undefined` — the answer for every publish that posted nothing, and for a step that
 * threw — is not "no index": it is "nothing to report", and the record keeps what it already held.
 */
export async function postItemThreadsAfterPublish(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  out: PublishOutcome,
  head: string | undefined,
): Promise<ItemThreadsOutcome | undefined> {
  const post = env.steps.postItemThreads;
  if (!post || !out.url || (out.outcome !== "draft" && out.outcome !== "ready")) return;
  const identity = env.itemThreadsIdentity;
  if (!identity) {
    getLogger()?.warn("item-threads", "[item-threads] Missing run identity; posting nothing");
    return;
  }
  const record: WorkflowFeatureRecord = {
    ...rec,
    outcome: out.outcome,
    ci: out.ci,
    ciDetail: out.ciDetail,
    reasons: out.reasons,
    approval: out.approval,
    storyStates: env.facts.stories.map((s) => ({
      id: s.id,
      state: s.state,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    })),
  };
  let outcome: ItemThreadsOutcome;
  try {
    outcome = await post({
      ...identity,
      record,
      url: out.url,
      head,
      changedFiles: await changedFiles(env, rec.seed),
    });
  } catch (error) {
    getLogger()?.warn("item-threads", "[item-threads] Publish item-thread step failed", {
      feature: identity.feature,
      error: errorMessage(error),
    });
    return;
  }
  // Fix round 1 (F1): the note is written *after* the step's outcome is in hand, so its own failure
  // cannot turn a resolved outcome into "nothing to report".
  await noteItemThreads(env, identity.feature, outcome);
  return outcome;
}
