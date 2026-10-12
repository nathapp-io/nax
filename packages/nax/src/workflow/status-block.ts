/** The status.json `workflow` block (spec §9, P4-R12). */
import type { WorkflowStatusBlock } from "@/execution";
import type { StorySummary, WorkflowFeatureRecord } from "./types";

export function workflowStatusBlock(
  stories: readonly StorySummary[],
  step: string,
  rec?: Pick<WorkflowFeatureRecord, "outcome" | "url">,
): WorkflowStatusBlock {
  return {
    step,
    stories: Object.fromEntries(stories.map((s) => [s.id, { state: s.state, round: s.rounds }])),
    ...(rec?.outcome ? { outcome: rec.outcome } : {}),
    ...(rec?.url ? { url: rec.url } : {}),
  };
}
