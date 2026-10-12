/** Rulings a story's brief must carry (spec §6 step 1, §8): pre-flight rulings and carried instructions. */
import type { AdviceDecision } from "@/advisor";
import { describeTarget } from "@/advisor";

export function rulingsForStory(decisions: readonly AdviceDecision[], storyId: string): string[] {
  const lines: string[] = [];
  for (const d of decisions) {
    if (!d.appliesTo?.includes(storyId)) continue;
    if (d.kind === "preflight" && d.action.type === "supersede") {
      lines.push(`Pre-flight ${d.id}: ${describeTarget(d.action.target)} now reads: ${d.action.newText}`);
    } else if (d.kind === "preflight" && d.action.type === "hold") {
      lines.push(`Pre-flight ${d.id}: flagged for a human; run under this default: ${d.action.reason}`);
    } else if (d.action.type === "carry") {
      lines.push(`Carried from ${d.storyId ?? "an earlier story"} (${d.id}): ${d.action.instruction}`);
    }
  }
  return lines;
}
