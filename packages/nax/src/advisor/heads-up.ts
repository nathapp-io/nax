/** A1 heads-up (spec §4.10, §12.4): one non-blocking message per flagged decision. */
import type { AdviceDecision, AdviceQuestion } from "./types";

export type HeadsUpChannel = (text: string) => Promise<{ sent: boolean; reason?: string }>;

export function formatHeadsUp(d: AdviceDecision, q: AdviceQuestion): string {
  return [
    `nax advisor ${d.id} (needs your confirmation, ${d.confidence} confidence)`,
    `Feature: ${q.feature}${q.storyId ? ` · Story: ${q.storyId}` : ""}`,
    `Question: ${q.summary}`,
    `Chose: ${d.action.type}`,
    `Why: ${d.rationale}`,
    "The run continues. Stop it (Ctrl-C / queue ABORT) if this is wrong.",
  ].join("\n");
}
