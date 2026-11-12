/**
 * The repair lines the approval advisor reads (US-008, US-006).
 *
 * A repair commits after the re-review, so its diff reaches the PR outside the reviewed tree. The
 * advisor is told what became of each repair's diff: since US-006 a round whose diff WAS re-reviewed
 * says so — and its review's own lines follow the summaries, so the advisor can judge the repair by
 * what that review found. A round nothing reviewed (a skipped review, or a record written before the
 * field existed) keeps the unreviewed wording.
 */
import type { WorkflowFeatureRecord } from "./types";

/** The ` reviewed: ` marker every `repairReviews` entry of a completed review carries. */
const REVIEWED_MARK = " reviewed: ";

/** The two endings a round summary can take. */
const REVIEWED = "the repair diff was reviewed";
const NOT_REVIEWED = "the repair diff was not re-reviewed";

/** True when `reviews` holds a completed review of the `label` kind (a `review skipped` line is not one). */
function wasReviewed(reviews: readonly string[], label: string): boolean {
  return reviews.some((entry) => entry.startsWith(`${label} `) && entry.includes(REVIEWED_MARK));
}

/** One round summary: what the repair did, then whether its diff was re-reviewed. */
function roundLine(summary: string, label: string, reviews: readonly string[]): string {
  return `${summary}; ${wasReviewed(reviews, label) ? REVIEWED : NOT_REVIEWED}`;
}

/**
 * The repair lines of one record: the gate repair first, then the CI repair, then every review line
 * the repair rounds recorded, in the order the record stores them.
 */
export function repairEvidence(record: WorkflowFeatureRecord): string[] {
  const reviews = record.repairReviews ?? [];
  const lines: string[] = [];
  if (record.gateRepairRounds) {
    const summary = `Gate repair: ${record.gateRepairRounds} round(s) after the final gates went red`;
    lines.push(roundLine(summary, "gate repair", reviews));
  }
  if (record.ciRepairRounds) {
    const summary = `CI repair: ${record.ciRepairRounds} round(s) after CI failed on the PR`;
    lines.push(roundLine(summary, "CI repair", reviews));
  }
  return [...lines, ...reviews];
}
