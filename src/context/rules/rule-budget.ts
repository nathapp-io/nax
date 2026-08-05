/**
 * Context Engine v2 — section-aware budget (US-002)
 *
 * Applies a token budget across a flat list of `RuleSection` values produced
 * by `splitRuleIntoSections`. Preserves the priority/ordinal contiguous-tail
 * contract used by `applyCanonicalRulesBudget`, with one refinement sections
 * make possible: the boundary file contributes its leading sections instead
 * of being dropped whole.
 *
 * Sorting: ascending by `priority` (lower number = more important), then
 * ascending by `ordinal` within a rule.
 *
 * Truncation: longest leading run whose cumulative tokens fit inside
 * `budgetTokens`. The first section is admitted whole even if it exceeds the
 * budget on its own (fail-open — a rule section is never gutted). Any later
 * section that would push the running total past the budget starts a dropped
 * tail; every following section is dropped as well, even when it would fit
 * in the remaining space.
 *
 * Invalid budgets (zero, negative, or non-finite) return an empty section
 * list and an `overageTokens` that mirrors the supplied total so callers
 * can still report pressure.
 *
 * See: docs/specs/SPEC-bounded-rules-floor.md §US-002
 */

import type { RuleSection } from "./rule-sections";
import { FRONTMATTER_PRIORITY_DEFAULT } from "./rules-frontmatter";

export interface SectionBudgetResult {
  retainedSections: RuleSection[];
  totalTokens: number;
  usedTokens: number;
  /**
   * Stable identifiers (owning rule id + slug) of every omitted section,
   * in the order they were dropped. Empty when nothing was dropped.
   */
  droppedIds: string[];
  /**
   * `max(0, totalTokens - budgetTokens)` for valid thresholds. When the
   * budget is invalid (zero, negative, non-finite), `overageTokens`
   * mirrors `totalTokens` so callers can still report pressure without
   * treating the budget as a usable cap.
   */
  overageTokens: number;
}

function sectionIdentifier(section: RuleSection): string {
  const sectionId = (section as { sectionId?: string }).sectionId;
  if (sectionId) return sectionId;
  const owner = section.ruleId ?? section.rulePath ?? "";
  return `${owner}#${section.slug}`;
}

/**
 * Apply a token budget to a priority-ordered list of rule sections.
 *
 * Sections are sorted ascending by `priority`, then ascending by `ordinal`
 * within a rule — matching the sort used by `loadCanonicalRules`. The
 * returned list is the longest leading run of that sorted order whose
 * cumulative tokens fit inside `budgetTokens`.
 */
export function applySectionBudget(sections: RuleSection[], budgetTokens: number): SectionBudgetResult {
  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return {
      retainedSections: [],
      totalTokens,
      usedTokens: 0,
      droppedIds: sections.map(sectionIdentifier),
      overageTokens: totalTokens,
    };
  }

  const sorted = [...sections].sort(
    (a, b) =>
      (a.priority ?? FRONTMATTER_PRIORITY_DEFAULT) - (b.priority ?? FRONTMATTER_PRIORITY_DEFAULT) ||
      a.ordinal - b.ordinal,
  );

  const kept: RuleSection[] = [];
  const droppedIds: string[] = [];
  let usedTokens = 0;
  let stopped = false;

  for (const section of sorted) {
    if (stopped) {
      droppedIds.push(sectionIdentifier(section));
      continue;
    }
    if (usedTokens + section.tokens <= budgetTokens) {
      kept.push(section);
      usedTokens += section.tokens;
    } else if (kept.length === 0) {
      // First section alone exceeds the budget — admit whole (fail-open) and
      // stop; nothing else can fit behind it.
      kept.push(section);
      usedTokens += section.tokens;
      stopped = true;
    } else {
      droppedIds.push(sectionIdentifier(section));
      stopped = true;
    }
  }

  return {
    retainedSections: kept,
    totalTokens,
    usedTokens,
    droppedIds,
    overageTokens: Math.max(0, totalTokens - budgetTokens),
  };
}
