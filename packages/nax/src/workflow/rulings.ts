/**
 * Rulings a story's brief must carry (spec §6 step 1, §8): pre-flight rulings, carried
 * instructions, and — US-001 — the story's own mid-loop answers and residual rulings.
 */
import type { AdviceDecision } from "@/advisor";
import { describeTarget } from "@/advisor";

/**
 * The line a pre-flight or carry decision contributes, when it applies to this story.
 * `appliesTo` already covers both: a pre-flight conflict names the stories it binds and a
 * carry names its `toStories`.
 */
function appliedRuling(d: AdviceDecision): string | null {
  if (d.kind === "preflight" && d.action.type === "supersede") {
    return `Pre-flight ${d.id}: ${describeTarget(d.action.target)} now reads: ${d.action.newText}`;
  }
  if (d.kind === "preflight" && d.action.type === "hold") {
    return `Pre-flight ${d.id}: flagged for a human; run under this default: ${d.action.reason}`;
  }
  if (d.action.type === "carry") {
    return `Carried from ${d.storyId ?? "an earlier story"} (${d.id}): ${d.action.instruction}`;
  }
  return null;
}

/**
 * US-001: what the advisor settled about this story mid-loop. An answer or a residual
 * `waive`/`defer` is settled; a residual `hold` is not — a human still decides it — so it
 * stays out of the brief the reviewer treats as authoritative.
 */
function settledRuling(d: AdviceDecision): string | null {
  if (d.kind === "implementer-question" && d.action.type === "answer") {
    return `Advisor answer ${d.id}: ${d.action.text}`;
  }
  if (d.kind === "residual" && (d.action.type === "waive" || d.action.type === "defer")) {
    return `Residual ruling ${d.id} (${d.action.type}): ${d.action.reason}`;
  }
  return null;
}

/** One decision's line for this story, or null when it carries nothing this story must see. */
function rulingLine(d: AdviceDecision, storyId: string): string | null {
  if (d.appliesTo?.includes(storyId)) {
    const applied = appliedRuling(d);
    if (applied !== null) return applied;
  }
  return d.storyId === storyId ? settledRuling(d) : null;
}

export function rulingsForStory(decisions: readonly AdviceDecision[], storyId: string): string[] {
  const lines: string[] = [];
  for (const d of decisions) {
    const line = rulingLine(d, storyId);
    if (line !== null) lines.push(line);
  }
  return lines;
}
