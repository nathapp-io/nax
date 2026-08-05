/**
 * rule-budget.ts — unit tests
 *
 * Covers applySectionBudget() — section-aware budget that preserves the
 * contiguous-tail contract while allowing the boundary file to contribute
 * its leading sections instead of being dropped whole.
 */

import { describe, expect, test } from "bun:test";
import { applySectionBudget } from "@/context";
import type { RuleSection } from "@/context";

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
    expect(result.sections).toEqual(sections);
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
    expect(result.sections.map((s) => sectionId(s))).toEqual([
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
    expect(result.sections.map((s) => s.slug)).toEqual(["s0", "s1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: exhausted-budget stops at lower-priority rules
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — exhausted budget drops lower-priority rules", () => {
  test("AC5: when budget exhausts partway through the first rule, drops every section of every lower-priority rule even if one would fit", () => {
    // Rule A (priority 1): 4 sections, each 40 tokens. Budget = 100.
    // s0 fits (40), s1 fits (80), s2 would push to 120 — stop.
    // Rule B (priority 2) sections would fit in the remaining 20 tokens but
    // must be dropped because the budget is exhausted partway through rule A.
    const sections: RuleSection[] = [
      makeSection({ ruleId: "rule-a", slug: "a0", ordinal: 0, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a1", ordinal: 1, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a2", ordinal: 2, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-a", slug: "a3", ordinal: 3, tokens: 40, priority: 1 }),
      makeSection({ ruleId: "rule-b", slug: "b0", ordinal: 0, tokens: 10, priority: 2 }),
      makeSection({ ruleId: "rule-b", slug: "b1", ordinal: 1, tokens: 10, priority: 2 }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.sections.map((s) => sectionId(s))).toEqual(["rule-a#a0", "rule-a#a1"]);
    expect(result.droppedIds).toEqual([
      "rule-a#a2",
      "rule-a#a3",
      "rule-b#b0",
      "rule-b#b1",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: single oversized section is kept and reported as overage
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — single oversized section", () => {
  test("AC6: when a single section exceeds the budget by itself, returns it and reports overageTokens greater than zero", () => {
    const sections: RuleSection[] = [
      makeSection({ slug: "big", ordinal: 0, tokens: 500, priority: 1 }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.sections).toEqual(sections);
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
    expect(result.sections).toEqual([]);
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
    expect(result.sections).toEqual([]);
    expect(result.overageTokens).toBe(130);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: non-finite budget
// ─────────────────────────────────────────────────────────────────────────────

describe("applySectionBudget — non-finite budget", () => {
  test("AC10: returns an empty section list without throwing when budgetTokens is non-finite", () => {
    const sections: RuleSection[] = [
      makeSection({ slug: "a", ordinal: 0, tokens: 50, priority: 1 }),
    ];
    expect(() => applySectionBudget(sections, Number.NaN)).not.toThrow();
    expect(() => applySectionBudget(sections, Number.POSITIVE_INFINITY)).not.toThrow();
    expect(applySectionBudget(sections, Number.NaN).sections).toEqual([]);
    expect(applySectionBudget(sections, Number.POSITIVE_INFINITY).sections).toEqual([]);
  });
});
