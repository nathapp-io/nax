/**
 * rule-budget.ts — unit tests
 *
 * Covers applySectionBudget() — section-aware budget that preserves the
 * contiguous-tail contract while allowing the boundary file to contribute
 * its leading sections instead of being dropped whole.
 */

import { describe, expect, test } from "bun:test";
import type { RuleSection } from "@/context";
import { applySectionBudget, priorityToRawScore } from "@/context";
import { FRONTMATTER_PRIORITY_DEFAULT } from "@/context/rules/rules-frontmatter";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSection(overrides: Partial<RuleSection> & { slug: string; ordinal: number }): RuleSection {
  return {
    ruleId: overrides.ruleId ?? "rule-a",
    rulePath: overrides.rulePath ?? "rule-a.md",
    content: overrides.content ?? `Content for ${overrides.slug}`,
    tokens: overrides.tokens ?? 100,
    priority: overrides.priority ?? 1,
    paths: overrides.paths,
    appliesTo: overrides.appliesTo,
    stages: overrides.stages,
    ordinal: overrides.ordinal,
    heading: overrides.heading,
    slug: overrides.slug,
  };
}

function sectionId(section: RuleSection): string {
  return `${section.ruleId ?? ""}#${section.slug}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: Module surface
// ─────────────────────────────────────────────────────────────────────────────

describe("@/context/rules/rule-budget surface", () => {
  test("AC1: exports applySectionBudget from @/context/rules/rule-budget", async () => {
    const modulePath = "@/context/rules/rule-budget" as string;
    const mod = (await import(modulePath)) as { applySectionBudget?: unknown };
    expect(typeof mod.applySectionBudget).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: below-budget sections are kept verbatim
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — under budget", () => {
  test("AC2: returns every supplied section when total tokens are below budget", () => {
    const sections: RuleSection[] = [
      makeSection({ slug: "alpha", ordinal: 0, tokens: 50, priority: 1 }),
      makeSection({ slug: "beta", ordinal: 1, tokens: 50, priority: 1 }),
    ];
    const result = applySectionBudget(sections, 1_000);
    expect(result.retainedSections).toEqual(sections);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: ascending priority then ascending ordinal
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — ordering", () => {
  test("AC3: returns sections from two rules ordered by ascending priority and then ascending ordinal", () => {
    // Higher priority value = lower importance. Section order input is
    // intentionally scrambled to prove the function sorts by
    // (priority, ordinal), not by input position.
    const sections: RuleSection[] = [
      makeSection({ ruleId: "rule-b", slug: "b-second", ordinal: 1, tokens: 10, priority: 2 }),
      makeSection({ ruleId: "rule-a", slug: "a-second", ordinal: 1, tokens: 10, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a-first", ordinal: 0, tokens: 10, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b-first", ordinal: 0, tokens: 10, priority: 2 }),
    ];
    const result = applySectionBudget(sections, 1_000);
    expect(result.retainedSections.map((s) => sectionId(s))).toEqual([
      "rule-a#a-first",
      "rule-a#a-second",
      "rule-b#b-first",
      "rule-b#b-second",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: leading run within a single rule
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — leading-run within one rule", () => {
  test("AC4: when budget accommodates only the first two of a rule's four sections, returns those two and omits the rest", () => {
    const sections: RuleSection[] = [
      makeSection({ slug: "s0", ordinal: 0, tokens: 50, priority: 1 }),
      makeSection({ slug: "s1", ordinal: 1, tokens: 50, priority: 1 }),
      makeSection({ slug: "s2", ordinal: 2, tokens: 50, priority: 1 }),
      makeSection({ slug: "s3", ordinal: 3, tokens: 50, priority: 1 }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.retainedSections.map((s) => s.slug)).toEqual(["s0", "s1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: budget exhaustion closes one rule; lower-priority rules are still walked
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — exhausted budget closes one rule and continues", () => {
  test("AC5: when budget exhausts partway through the first rule, later rules whose sections fit the remaining budget are still admitted", () => {
    // Rule A (priority 1): 4 sections, each 40 tokens. Budget = 100.
    // a0 fits (40), a1 fits (80), a2 would push to 120 — rule A closes.
    // Rule B (priority 2) then gets its turn: b0 (90) and b1 (100) both fit.
    const sections: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a2", ordinal: 2, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a3", ordinal: 3, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b0", ordinal: 0, tokens: 10, priority: 2 }),
      makeSection({ ruleId: "rule-b", slug: "b1", ordinal: 1, tokens: 10, priority: 2 }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.retainedSections.map((s) => sectionId(s))).toEqual([
      "rule-a#a0",
      "rule-a#a1",
      "rule-b#b0",
      "rule-b#b1",
    ]);
    expect(result.droppedIds).toEqual(["rule-a#a2", "rule-a#a3"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-rule continuation: a closed rule is skipped, the walk moves on
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — per-rule continuation", () => {
  test("a later rule whose first section alone exceeds the budget does not block subsequent rules that still fit", () => {
    // rule-b's 500-token lead cannot be admitted at any point, but closing
    // rule-b must not end the walk: rule-c's 20 tokens still fit what remains.
    const sections: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a2", ordinal: 2, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b0", ordinal: 0, tokens: 500, priority: 2 }),
      makeSection({ ruleId: "rule-c", slug: "c0", ordinal: 0, tokens: 10, priority: 3 }),
      makeSection({ ruleId: "rule-c", slug: "c1", ordinal: 1, tokens: 10, priority: 3 }),
    ];
    const result = applySectionBudget(sections, 100);

    expect(result.retainedSections.map(sectionId)).toEqual(["rule-a#a0", "rule-a#a1", "rule-c#c0", "rule-c#c1"]);
    expect(result.droppedIds).toEqual(["rule-a#a2", "rule-b#b0"]);
    expect(result.usedTokens).toBe(100);
    expect(result.totalTokens).toBe(640);
    expect(result.overageTokens).toBe(640 - 100);
  });

  test("a rule cut short contributes a contiguous leading run, never a run with a hole", () => {
    // rule-a's a2/a3 (5 tokens each) would fit the 40 left after a0, but
    // admitting them would leave rule-a with a gap. They are dropped with a1
    // and the walk continues into rule-b.
    const sections: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 60, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 60, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a2", ordinal: 2, tokens: 5, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a3", ordinal: 3, tokens: 5, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b0", ordinal: 0, tokens: 10, priority: 2 }),
      makeSection({ ruleId: "rule-b", slug: "b1", ordinal: 1, tokens: 10, priority: 2 }),
    ];
    const result = applySectionBudget(sections, 100);

    expect(result.retainedSections.map(sectionId)).toEqual(["rule-a#a0", "rule-b#b0", "rule-b#b1"]);
    expect(result.droppedIds).toEqual(["rule-a#a1", "rule-a#a2", "rule-a#a3"]);

    const retainedOrdinals = new Map<string, number[]>();
    for (const section of result.retainedSections) {
      const owner = section.ruleId ?? "";
      retainedOrdinals.set(owner, [...(retainedOrdinals.get(owner) ?? []), section.ordinal]);
    }
    for (const ordinals of retainedOrdinals.values()) {
      const sorted = [...ordinals].sort((a, b) => a - b);
      expect(sorted).toEqual(sorted.map((_, index) => index));
    }
  });

  test("usedTokens stays within budget except through the documented fail-open", () => {
    const within: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b0", ordinal: 0, tokens: 40, priority: 2 }),
    ];
    const budget = 100;
    const result = applySectionBudget(within, budget);
    expect(result.usedTokens).toBeLessThanOrEqual(budget);
    expect(result.retainedSections.map(sectionId)).toEqual(["rule-a#a0", "rule-a#a1"]);

    const oversizedFirst: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 500, priority: 1 }),
    ];
    const failOpen = applySectionBudget(oversizedFirst, budget);
    expect(failOpen.usedTokens).toBeGreaterThan(budget);
    expect(failOpen.retainedSections).toEqual(oversizedFirst);
  });

  test("overageTokens remains max(0, totalTokens - budgetTokens)", () => {
    const under: RuleSection[] = [makeSection({ slug: "small", ordinal: 0, tokens: 10, priority: 1 })];
    expect(applySectionBudget(under, 100).overageTokens).toBe(0);

    const over: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b0", ordinal: 0, tokens: 500, priority: 2 }),
      makeSection({ ruleId: "rule-c", slug: "c0", ordinal: 0, tokens: 10, priority: 3 }),
    ];
    const result = applySectionBudget(over, 100);
    expect(result.totalTokens).toBe(590);
    expect(result.overageTokens).toBe(590 - 100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: single oversized section is kept and reported as overage
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — single oversized section", () => {
  test("AC6: when a single section exceeds the budget by itself, returns it and reports overageTokens greater than zero", () => {
    const sections: RuleSection[] = [makeSection({ slug: "big", ordinal: 0, tokens: 500, priority: 1 })];
    const result = applySectionBudget(sections, 100);
    expect(result.retainedSections).toEqual(sections);
    expect(result.overageTokens).toBeGreaterThan(0);
    expect(result.overageTokens).toBe(500 - 100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: droppedIds contains every omitted section identifier
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — droppedIds", () => {
  test("AC7: when sections do not all fit, returns droppedIds containing every omitted section identifier", () => {
    const sections: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 50, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 50, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a2", ordinal: 2, tokens: 50, priority: 1 }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.droppedIds).toEqual(["rule-a#a2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: empty section array
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — empty input", () => {
  test("AC8: returns an empty section list and overageTokens of zero when called with an empty section array", () => {
    const result = applySectionBudget([], 1_000);
    expect(result.retainedSections).toEqual([]);
    expect(result.overageTokens).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: zero budget
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — zero budget", () => {
  test("AC9: returns an empty section list and overageTokens equal to the supplied sections' total tokens when budgetTokens is zero", () => {
    const sections: RuleSection[] = [
      makeSection({ slug: "a", ordinal: 0, tokens: 50, priority: 1 }),
      makeSection({ slug: "b", ordinal: 1, tokens: 80, priority: 1 }),
    ];
    const result = applySectionBudget(sections, 0);
    expect(result.retainedSections).toEqual([]);
    expect(result.overageTokens).toBe(130);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: non-finite budget
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — non-finite budget", () => {
  test("AC10: returns an empty section list without throwing when budgetTokens is non-finite", () => {
    const sections: RuleSection[] = [makeSection({ slug: "a", ordinal: 0, tokens: 50, priority: 1 })];
    expect(() => applySectionBudget(sections, Number.NaN)).not.toThrow();
    expect(() => applySectionBudget(sections, Number.POSITIVE_INFINITY)).not.toThrow();
    expect(applySectionBudget(sections, Number.NaN).retainedSections).toEqual([]);
    expect(applySectionBudget(sections, Number.POSITIVE_INFINITY).retainedSections).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-rule ordering: equal-priority rules must stay contiguous
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — cross-rule ordering", () => {
  function sectionsFor(ruleId: string, priority: number): RuleSection[] {
    return ["preamble", "a", "b"].map((slug, ordinal) =>
      makeSection({ ruleId, rulePath: `${ruleId}.md`, slug, ordinal, tokens: 10, priority }),
    );
  }

  test("keeps each rule's sections contiguous instead of interleaving them by ordinal", () => {
    // Regression: with no rule tiebreaker, equal-priority sections sorted
    // ordinal-major — every rule's preamble first, then every rule's first
    // body section, and so on. Since `priority` defaults to the same value for
    // any rule that does not declare one, that was the normal case, and it
    // shredded every rule in the delivered output.
    const sections = [...sectionsFor("alpha", 100), ...sectionsFor("beta", 100)];
    const result = applySectionBudget(sections, 1000);

    expect(result.retainedSections.map(sectionId)).toEqual([
      "alpha#preamble",
      "alpha#a",
      "alpha#b",
      "beta#preamble",
      "beta#a",
      "beta#b",
    ]);
  });

  test("truncation drops one boundary rule's tail rather than every rule's tail", () => {
    const sections = [...sectionsFor("alpha", 100), ...sectionsFor("beta", 100)];
    // Room for four of the six 10-token sections.
    const result = applySectionBudget(sections, 40);

    // alpha survives whole; beta is the boundary rule and contributes its lead.
    expect(result.retainedSections.map(sectionId)).toEqual(["alpha#preamble", "alpha#a", "alpha#b", "beta#preamble"]);
    expect(result.droppedIds).toEqual(["beta#a", "beta#b"]);
  });

  test("priority still outranks rule identity", () => {
    const sections = [...sectionsFor("zulu", 1), ...sectionsFor("alpha", 100)];
    const result = applySectionBudget(sections, 1000);

    expect(result.retainedSections.map((s) => s.ruleId)).toEqual(["zulu", "zulu", "zulu", "alpha", "alpha", "alpha"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// priorityToRawScore: authored priority → bounded raw score
// ─────────────────────────────────────────────────────────────────────────────

describe("priorityToRawScore", () => {
  test("is strictly decreasing — a numerically lower priority returns a strictly higher score", () => {
    const scores = [1, 5, 20, 55, 100, 500].map((priority) => priorityToRawScore(priority));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  test("undefined matches FRONTMATTER_PRIORITY_DEFAULT so an undeclared priority reads as the default", () => {
    expect(FRONTMATTER_PRIORITY_DEFAULT).toBe(100);
    expect(priorityToRawScore(undefined)).toBe(priorityToRawScore(FRONTMATTER_PRIORITY_DEFAULT));
    expect(priorityToRawScore()).toBe(priorityToRawScore(FRONTMATTER_PRIORITY_DEFAULT));
  });

  test("always returns a score in (0, 1] — bounded, never zero, never negative", () => {
    const inputs = [undefined, 0, -100, 5, 100, 10_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const priority of inputs) {
      const score = priorityToRawScore(priority);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("zero and negative priorities clamp to the top of the range, matching the sort order", () => {
    // `priority: 0` / negatives are legal frontmatter and sort ABOVE priority
    // 1 (applySectionBudget compares authored values), so they must rank above
    // every positive priority here too — not at the default, which would
    // silently rank the most important rule as an undeclared one.
    expect(priorityToRawScore(0)).toBe(priorityToRawScore(1));
    expect(priorityToRawScore(-100)).toBe(priorityToRawScore(1));
    expect(priorityToRawScore(0)).toBeGreaterThan(priorityToRawScore(2));
    expect(priorityToRawScore(1)).toBeGreaterThan(priorityToRawScore(2));
  });

  test("non-finite priorities fall back to the default instead of producing Infinity/NaN", () => {
    const defaultScore = priorityToRawScore(FRONTMATTER_PRIORITY_DEFAULT);
    for (const priority of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const score = priorityToRawScore(priority);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBe(defaultScore);
    }
  });

  test("orders this repo's real corpus correctly — priority 5 outranks priority 55", () => {
    expect(priorityToRawScore(5)).toBeCloseTo(0.952, 3);
    expect(priorityToRawScore(55)).toBeCloseTo(0.645, 3);
    expect(priorityToRawScore(5)).toBeGreaterThan(priorityToRawScore(55));
  });
});
