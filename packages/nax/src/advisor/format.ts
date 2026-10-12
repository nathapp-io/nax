/** A1: text forms of advisor decisions for prompts and summaries. */
import type { AdviceDecision, SupersedeTarget } from "./types";

export function describeTarget(t: SupersedeTarget): string {
  return t.kind === "ac" ? `${t.storyId} ${t.acId}` : `spec § ${t.section}`;
}

function waivedSubject(d: AdviceDecision): string {
  const [, keyTitle, keyPath] = (d.dedupeKey ?? "").split("|");
  const title = keyTitle || d.rulingTitle;
  const path = keyPath || d.anchorFile;
  if (!title) return d.storyId ?? "finding";
  return path ? `${title} (${path})` : title;
}

const BLOCKING = new Set(["HIGH", "CRITICAL", "error", "critical"]);

/**
 * May this decision be handed to an agent (reviewer, implementer) as settled?
 * Not a waive of a blocking finding: those must be re-judged, never silently
 * suppressed. Shared by the review prompt and the context provider.
 */
export function isPromptSafe(d: AdviceDecision): boolean {
  return !(d.action.type === "waive" && BLOCKING.has(d.findingSeverity ?? ""));
}

/** Waive + supersede decisions, one line each — what a reviewer must not re-raise. Empty when none. */
export function formatDecisionsForPrompt(decisions: readonly AdviceDecision[]): string {
  const lines: string[] = [];
  for (const d of decisions) {
    if (d.action.type === "waive" && !BLOCKING.has(d.findingSeverity ?? ""))
      lines.push(`- ${d.id} waived: ${waivedSubject(d)} — ${d.action.reason}`);
    if (d.action.type === "supersede") {
      lines.push(`- ${d.id} superseded ${describeTarget(d.action.target)}: ${d.action.newText}`);
    }
  }
  return lines.join("\n");
}

/** Finish B 4.2: waive + supersede rulings a fixer must not undo, with the ids it may cite. */
export function formatRulingsForFix(decisions: readonly AdviceDecision[]): { text: string; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const d of decisions) {
    if (d.action.type === "waive" && !BLOCKING.has(d.findingSeverity ?? "")) {
      lines.push(`- ${d.id} waived: ${waivedSubject(d)} \u2014 ${d.action.reason}`);
      ids.push(d.id);
    }
    if (d.action.type === "supersede") {
      lines.push(`- ${d.id} superseded ${describeTarget(d.action.target)}: ${d.action.newText}`);
      ids.push(d.id);
    }
  }
  return { text: lines.join("\n"), ids };
}

export interface AdvisorSummary {
  decisions: number;
  flagged: number;
  byKind: Record<string, number>;
}

/** Run-summary counts (spec §4.11). */
export function summariseAdvisor(decisions: readonly AdviceDecision[]): AdvisorSummary {
  const byKind: Record<string, number> = {};
  for (const d of decisions) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  return { decisions: decisions.length, flagged: decisions.filter((d) => d.needsHumanConfirm).length, byKind };
}
