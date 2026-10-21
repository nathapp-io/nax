/**
 * The repair lines the approval advisor reads (US-008).
 *
 * A repair commits after the re-review, so its diff reaches the PR unreviewed. The advisor is told
 * that the code it is judging was never looked at again — the gate repair (nax#2548) and, since
 * US-008, the CI repair on the published PR.
 */
import type { WorkflowFeatureRecord } from "./types";

/** The repair lines of one record, gate repair first, then the CI repair. */
export function repairEvidence(record: WorkflowFeatureRecord): string[] {
  const lines: string[] = [];
  if (record.gateRepairRounds) {
    lines.push(
      `Gate repair: ${record.gateRepairRounds} round(s) after the final gates went red; the repair diff was not re-reviewed`,
    );
  }
  if (record.ciRepairRounds) {
    lines.push(
      `CI repair: ${record.ciRepairRounds} round(s) after CI failed on the PR; the repair diff was not re-reviewed`,
    );
  }
  return lines;
}
