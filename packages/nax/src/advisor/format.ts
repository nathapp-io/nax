/** A1: text forms of advisor decisions for prompts and summaries. */
import type { AdviceDecision, SupersedeTarget } from "./types";

export function describeTarget(t: SupersedeTarget): string {
  return t.kind === "ac" ? `${t.storyId} ${t.acId}` : `spec § ${t.section}`;
}

function waivedSubject(d: AdviceDecision): string {
  const [, title, path] = (d.dedupeKey ?? "").split("|");
  if (!title) return d.storyId ?? "finding";
  return path ? `${title} (${path})` : title;
}

/** Waive + supersede decisions, one line each — what a reviewer must not re-raise. Empty when none. */
export function formatDecisionsForPrompt(decisions: readonly AdviceDecision[]): string {
  const lines: string[] = [];
  for (const d of decisions) {
    if (d.action.type === "waive") lines.push(`- ${d.id} waived: ${waivedSubject(d)} — ${d.action.reason}`);
    if (d.action.type === "supersede") {
      lines.push(`- ${d.id} superseded ${describeTarget(d.action.target)}: ${d.action.newText}`);
    }
  }
  return lines.join("\n");
}
