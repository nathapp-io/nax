/** Best-effort durable PR items after publish; never changes the graph's publish result. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { FeatureEnv } from "./feature-machine";
import type { PublishOutcome } from "./finalize";
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

/** Four arguments intentionally mirror the publish seam specified by the workflow contract. */
export async function postItemThreadsAfterPublish(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  out: PublishOutcome,
  head: string | undefined,
): Promise<void> {
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
  try {
    const outcome = await post({
      ...identity,
      record,
      url: out.url,
      head,
      changedFiles: await changedFiles(env, rec.seed),
    });
    await env.sink.ledger(
      ledgerText.note(
        `Item threads: posted=${outcome.posted}, closed=${outcome.closed}, skipped=${outcome.skipped}, failed=${outcome.failed}`,
      ),
      { mirror: false },
    );
  } catch (error) {
    getLogger()?.warn("item-threads", "[item-threads] Publish item-thread step failed", {
      feature: identity.feature,
      error: errorMessage(error),
    });
  }
}
