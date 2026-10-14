/** The status.json `workflow` block (spec §9, P4-R12). */
import type { WorkflowStatusBlock } from "@/execution";
import type { StorySummary, WorkflowFeatureRecord } from "./types";

export function workflowStatusBlock(
  stories: readonly StorySummary[],
  step: string,
  rec?: Pick<WorkflowFeatureRecord, "outcome" | "url" | "passed" | "flaggedDecisions">,
): WorkflowStatusBlock {
  return {
    step,
    stories: Object.fromEntries(stories.map((s) => [s.id, { state: s.state, round: s.rounds }])),
    ...(rec?.outcome ? { outcome: rec.outcome } : {}),
    ...(rec?.url ? { url: rec.url } : {}),
    // US-004: the workflow's own verdict. `false` is a real verdict and must be
    // projected, so this is an undefined check, never a truthiness check.
    ...(rec?.passed !== undefined ? { passed: rec.passed } : {}),
    // US-005: the rulings a human still has to confirm. An empty list says nothing
    // the missing key does not, so only a non-empty one is projected.
    ...(rec?.flaggedDecisions && rec.flaggedDecisions.length > 0 ? { flagged: [...rec.flaggedDecisions] } : {}),
  };
}
