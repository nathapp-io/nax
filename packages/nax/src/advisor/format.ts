/** A1: text forms of advisor decisions for prompts and summaries. */
import type { AdviceDecision, SupersedeTarget } from "./types";

export function describeTarget(t: SupersedeTarget): string {
  return t.kind === "ac" ? `${t.storyId} ${t.acId}` : `spec § ${t.section}`;
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
