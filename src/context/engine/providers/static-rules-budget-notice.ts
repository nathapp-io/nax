/**
 * Context Engine v2 — StaticRulesProvider budget-drop notice (#1610)
 *
 * `applySectionBudget` (rule-budget.ts) drops rule sections silently — the
 * surviving chunks carry no marker distinguishing a truncated ruleset from
 * a complete one. `CodeNeighborProvider` already surfaces its own capped
 * scan via a prompt-visible note (code-neighbor-chunk.ts); this module gives
 * `StaticRulesProvider` the same treatment so a drop is never reachable
 * without the consumer being told.
 */

import type { RuleSection, SectionBudgetResult } from "@/context";
import { estimateTokens } from "@/optimizer";
import type { ProviderBudgetPressure } from "../manifest-types";
import type { RawChunk } from "../types";

/**
 * Build a `ProviderBudgetPressure` from the section budget result, or
 * return `null` when there is no overage and nothing was dropped.
 */
export function buildSectionBudgetPressure(
  allSections: RuleSection[],
  budgetResult: SectionBudgetResult,
): ProviderBudgetPressure | null {
  const { droppedIds, overageTokens } = budgetResult;
  const droppedCount = droppedIds.length;
  if (droppedCount === 0 && overageTokens <= 0) return null;

  const kept = new Set(budgetResult.retainedSections);
  let droppedTokens = 0;
  for (const section of allSections) {
    if (!kept.has(section)) {
      droppedTokens += section.tokens;
    }
  }

  return { overageTokens, droppedCount, droppedTokens, droppedIds };
}

/**
 * A budget overrun can drop tens-to-hundreds of sections; listing every id
 * would make the notice itself a meaningful chunk of the (already exceeded)
 * budget. Cap the visible list and summarize the remainder.
 */
const MAX_LISTED_DROPPED_IDS = 10;

/** Prompt-visible sentence describing a budget-driven section drop. */
export function budgetNoticeText(droppedCount: number, droppedIds?: string[]): string {
  let detail = "";
  if (droppedIds && droppedIds.length > 0) {
    const shown = droppedIds.slice(0, MAX_LISTED_DROPPED_IDS);
    const remainder = droppedIds.length - shown.length;
    detail = ` (${shown.join(", ")}${remainder > 0 ? `, +${remainder} more` : ""})`;
  }
  return `Note: rule budget exceeded — ${droppedCount} lower-priority section(s) dropped${detail}. Increase \`context.v2.rules.rulesShare\` / \`context.v2.rules.budgetTokens\`, or set \`context.v2.rules.enforceBudget: false\`, to see the full ruleset.`;
}

/**
 * Standalone notice chunk carrying the budget-drop notice. Used for BOTH the
 * partial-drop case and the all-sections-dropped case (US-003 empty-chunks
 * branch) — a standalone chunk, rather than text spliced into the last rule
 * chunk's content, survives `dedupeChunks` independently of whatever rule
 * section happens to be last (#1610).
 */
export function buildBudgetNoticeChunk(storyId: string, droppedCount: number, droppedIds?: string[]): RawChunk {
  const content = `> ${budgetNoticeText(droppedCount, droppedIds)}`;
  return {
    id: `static-rules:__budget-notice__:${storyId}`,
    kind: "static" as const,
    scope: "project" as const,
    role: ["all"] as ["all"],
    content,
    tokens: estimateTokens(content),
    rawScore: 1.0,
  };
}
