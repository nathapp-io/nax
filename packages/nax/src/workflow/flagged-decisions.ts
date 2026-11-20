/**
 * US-002/US-005: the flagged advisor decisions one publish records — the read, and the one place its
 * single list is split into the record's ids and its id-to-summary map.
 *
 * Branch fix B2: a read that failed and a read that succeeded and found nothing are not the same
 * answer, and this module is what tells them apart. An empty list is a *fact* — this publish flagged
 * nothing, so the map is cleared as an earlier publish's stale summary must be — while `undefined`
 * says only that the ledger could not be consulted, so the record keeps what the last good read
 * recorded. Reading both as an empty list let a transient ledger error drop an earlier publish's ids
 * and summaries, which took the advisor items out of the item-thread input: the index writer then
 * closed the advisor threads it already held, though no decision had settled.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { FeatureSteps } from "./feature-machine";
import type { FlaggedDecision, WorkflowFeatureRecord } from "./types";

/**
 * The trusted ledger decisions a human still has to confirm, or `undefined` when the read is
 * unavailable — no step wired, or the step threw. Best effort by design: an unreadable ledger is a
 * warning, never a failed publish.
 */
export async function readFlaggedDecisions(steps: FeatureSteps): Promise<readonly FlaggedDecision[] | undefined> {
  const step = steps.flaggedDecisions;
  if (!step) return undefined;
  try {
    return await step();
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Flagged advisor decisions unavailable", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return undefined;
  }
}

/** The two places one read is carried: the publish patch, and the record the item threads read. */
export interface FlaggedDecisionsCarried {
  /**
   * Patch keys for this publish, or `undefined` when the read was unavailable — an absent patch is
   * what keeps the ids and summaries an earlier publish recorded on the record.
   */
  readonly patch?: Partial<WorkflowFeatureRecord>;
  /** The record `postItemThreadsAfterPublish` derives the open items — and their keys — from. */
  readonly record: WorkflowFeatureRecord;
  /**
   * B2: the read was unavailable, so this record is *not* evidence that nothing is flagged. A record
   * an earlier run wrote still carries its own ids; a fresh one carries none, and the item threads
   * then have to keep whatever the PR index already lists. `postItemThreadsAfterPublish` needs the
   * difference, and cannot read it off the record — an empty list and no list look the same there.
   */
  readonly ledgerUnread: boolean;
}

/**
 * Split the one read into the ids the record already carried and the id-to-summary map an open item
 * names its decision by. An unavailable read returns the record untouched and patches nothing.
 */
export function carryFlaggedDecisions(
  rec: WorkflowFeatureRecord,
  decisions: readonly FlaggedDecision[] | undefined,
): FlaggedDecisionsCarried {
  if (decisions === undefined) return { record: rec, ledgerUnread: true };
  const ids = decisions.map((d) => d.id);
  const summaries = Object.fromEntries(decisions.map((d) => [d.id, d.summary]));
  return {
    ledgerUnread: false,
    patch: {
      ...(ids.length > 0 || rec.flaggedDecisions !== undefined ? { flaggedDecisions: ids } : {}),
      // US-002: the map is this read's fact, so it is stated unconditionally — a re-publish that
      // flags nothing *clears* what an earlier one recorded (the runner deletes a key stated as
      // `undefined`) instead of leaving a stale summary beside `flaggedDecisions: []`. A record
      // written before this field existed reads no key at all, which is the same answer.
      flaggedDecisionSummaries: ids.length > 0 ? summaries : undefined,
    },
    record: { ...rec, flaggedDecisions: ids, flaggedDecisionSummaries: summaries },
  };
}
