/**
 * Context Engine v2 — section-aware budget (US-002)
 *
 * Applies a token budget across a flat list of `RuleSection` values produced
 * by `splitRuleIntoSections`. Preserves the priority/ordinal ordering used by
 * `applyCanonicalRulesBudget`, with one refinement sections make possible: a
 * rule contributes a contiguous leading run of its sections instead of being
 * dropped whole.
 *
 * Sorting: ascending by `priority` (lower number = more important), then by
 * owning rule, then ascending by `ordinal` within that rule.
 *
 * The rule tiebreaker is load-bearing, not cosmetic. Without it, equal-priority
 * sections from different files sort ordinal-major and interleave — and since
 * `priority` defaults to `FRONTMATTER_PRIORITY_DEFAULT` for every rule that does
 * not declare one, that is the normal case, not an edge case. Truncation then
 * cuts every rule at the same ordinal instead of dropping one boundary file's
 * tail, so each rule arrives shredded and no rule is contiguous.
 *
 * Truncation: longest leading run whose cumulative tokens fit inside
 * `budgetTokens`. The first section is admitted whole even if it exceeds the
 * budget on its own (fail-open — a rule section is never gutted). A section
 * that would push the running total past the budget closes its owning rule:
 * that rule's remaining sections are dropped, and the walk continues with the
 * next rule's sections, which may still fit the tokens left over. Contiguous
 * within a rule; never a hole.
 *
 * Invalid budgets (zero, negative, or non-finite) return an empty section
 * list and an `overageTokens` that mirrors the supplied total so callers
 * can still report pressure.
 *
 * Scoring: `priorityToRawScore` maps an authored frontmatter `priority` to a
 * raw score in `(0, 1]`, pivoting at `FRONTMATTER_PRIORITY_DEFAULT` (100 →
 * 0.5). The mapping is bounded on purpose. An unbounded `DEFAULT / priority`
 * would preserve 1.0 at the default, but once floor chunks compete with
 * non-floor chunks an unbounded score lets a single high-priority rule
 * dominate every code chunk in the pool. Keeping rules inside `(0, 1]` lets
 * that rules-vs-code weighting be set explicitly via `KIND_WEIGHTS` instead
 * of being inherited from this mapping. The cost — all static scores halve
 * relative to today — is inert, because floor chunks are exempt from both
 * `minScore` and packing.
 *
 * See: docs/specs/SPEC-bounded-rules-floor.md §US-002
 */

import type { RuleSection } from "../rule-sections";
import { FRONTMATTER_PRIORITY_DEFAULT } from "../rules-frontmatter";

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

/**
 * Identity of the rule a section belongs to, for the sort tiebreaker.
 *
 * Matches the key `StaticRulesProvider` sorts its rules by, so the section
 * order this module produces agrees with the rule order the provider computed.
 */
function ownerIdentifier(section: RuleSection): string {
  return section.ruleId ?? section.rulePath ?? "";
}

function sectionIdentifier(section: RuleSection): string {
  // A caller may supply a precomputed stable id on the section; honour it when
  // present. Not declared on `RuleSection` because it is an optional caller
  // convention rather than part of the splitter's output contract — the
  // feature's AC-15/16/18 fixtures rely on this precedence.
  const sectionId = (section as { sectionId?: string }).sectionId;
  if (sectionId) return sectionId;
  const owner = section.ruleId ?? section.rulePath ?? "";
  return `${owner}#${section.slug}`;
}

/**
 * Map an authored rule `priority` to a bounded raw score in `(0, 1]`.
 *
 * Lower `priority` numbers mean "more important" and return higher scores.
 * `undefined`, non-finite, zero, and negative inputs fall back to
 * `FRONTMATTER_PRIORITY_DEFAULT`, so a rule that declares nothing scores as
 * though it declared the default. See the module docstring for why the
 * mapping is bounded rather than `DEFAULT / priority`.
 */
export function priorityToRawScore(priority?: number): number {
  const p = Number.isFinite(priority) && (priority as number) > 0 ? (priority as number) : FRONTMATTER_PRIORITY_DEFAULT;
  return FRONTMATTER_PRIORITY_DEFAULT / (FRONTMATTER_PRIORITY_DEFAULT + p);
}

/**
 * Apply a token budget to a priority-ordered list of rule sections.
 *
 * Sections are sorted ascending by `priority`, then ascending by `ordinal`
 * within a rule — matching the sort used by `loadCanonicalRules`. A section
 * that does not fit closes its owning rule; the walk then continues into the
 * next rule's sections rather than stopping outright.
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
      ownerIdentifier(a).localeCompare(ownerIdentifier(b)) ||
      a.ordinal - b.ordinal,
  );

  const kept: RuleSection[] = [];
  const droppedIds: string[] = [];
  const closedOwners = new Set<string>();
  let usedTokens = 0;

  for (const section of sorted) {
    const owner = ownerIdentifier(section);
    if (closedOwners.has(owner)) {
      droppedIds.push(sectionIdentifier(section));
      continue;
    }
    if (usedTokens + section.tokens <= budgetTokens) {
      kept.push(section);
      usedTokens += section.tokens;
    } else if (kept.length === 0) {
      // First section alone exceeds the budget — admit whole (fail-open) and
      // close its rule; nothing else can fit behind it.
      kept.push(section);
      usedTokens += section.tokens;
      closedOwners.add(owner);
    } else {
      droppedIds.push(sectionIdentifier(section));
      closedOwners.add(owner);
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
