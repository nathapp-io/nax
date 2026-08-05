import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applySectionBudget } from "@/context/rules/rule-budget";
import type { SectionBudgetResult } from "@/context/rules/rule-budget";
import { splitRuleIntoSections } from "@/context/rules/rule-sections";
import type { RuleSection } from "@/context/rules/rule-sections";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { StaticRulesProvider, _staticRulesDeps } from "../../../src/context/engine/providers/static-rules";
import type { ContextProviderResult, ContextRequest } from "../../../src/context/engine/types";
import { loadCanonicalRules } from "../../../src/context/rules/canonical-loader";
import type { CanonicalRule } from "../../../src/context/rules/canonical-loader";
import { estimateTokens } from "../../../src/optimizer/types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<CanonicalRule> & { fileName: string; content: string }): CanonicalRule {
  return {
    priority: 100,
    ...overrides,
  };
}

const THREE_SECTION_CONTENT = [
  "## First Heading",
  "content of first section",
  "",
  "## Second Heading",
  "content of second section",
  "",
  "## Third Heading",
  "content of third section",
].join("\n");

const TWO_SECTION_CONTENT = [
  "## First Heading",
  "content of first section",
  "",
  "## Second Heading",
  "content of second section",
].join("\n");

const REPO_ROOT = `${import.meta.dir}/../../..`;

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async (dir: string) => (dir === "/project" ? rules : []);
}

function makeSectionFixture(
  overrides: Partial<RuleSection> & { sectionId: string; tokens: number; priority: number; ordinal: number },
): RuleSection {
  return {
    ruleId: overrides.sectionId,
    fileName: `${overrides.sectionId}.md`,
    slug: overrides.sectionId,
    heading: undefined,
    content: "x".repeat(Math.max(1, overrides.tokens) * 4),
    ...overrides,
  } as unknown as RuleSection;
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001: splitRuleIntoSections (AC-1..AC-11)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: splitRuleIntoSections", () => {
  test("AC-1: rule-sections module exports splitRuleIntoSections as a Function", () => {
    expect(typeof splitRuleIntoSections).toBe("function");
  });

  test("AC-2: content with three '## ' headings returns an array of length exactly 3", () => {
    const rule = makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(3);
  });

  test("AC-3: sections returned in document order carry ordinal 0, 1, 2", () => {
    const rule = makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT });
    const sections = splitRuleIntoSections(rule);
    expect(sections[0]?.ordinal).toBe(0);
    expect(sections[1]?.ordinal).toBe(1);
    expect(sections[2]?.ordinal).toBe(2);
  });

  test("AC-4: preamble text before the first heading becomes ordinal 0 with heading undefined", () => {
    const rule = makeRule({ fileName: "a.md", content: "preamble text\n## Heading" });
    const sections = splitRuleIntoSections(rule);
    expect(sections[0]?.ordinal).toBe(0);
    expect(sections[0]?.heading).toBeUndefined();
    expect(sections[0]?.content.startsWith("preamble text")).toBe(true);
  });

  test("AC-5: content with no '## ' substring returns exactly one section whose content strictly equals the rule content", () => {
    const content = "plain rule body with no headings at all.";
    const rule = makeRule({ fileName: "a.md", content });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.content).toBe(content);
  });

  test("AC-6: every section inherits rule.priority", () => {
    const rule = makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT, priority: 45 });
    const sections = splitRuleIntoSections(rule);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.priority).toBe(45);
    }
  });

  test("AC-7: every section inherits rule.appliesTo and rule.stages", () => {
    const rule = makeRule({
      fileName: "a.md",
      content: THREE_SECTION_CONTENT,
      appliesTo: ["src/**"],
      stages: ["execution"],
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.appliesTo).toEqual(["src/**"]);
      expect(section.stages).toEqual(["execution"]);
    }
  });

  test("AC-8: heading '## Prompt Builder Convention' produces slug 'prompt-builder-convention'", () => {
    const rule = makeRule({ fileName: "a.md", content: "## Prompt Builder Convention\nbody text" });
    const sections = splitRuleIntoSections(rule);
    expect(sections[0]?.slug).toBe("prompt-builder-convention");
  });

  test("AC-9: two identical headings produce two sections with distinct slug values", () => {
    const rule = makeRule({
      fileName: "a.md",
      content: "## Same Heading\nfirst body\n\n## Same Heading\nsecond body",
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.slug).not.toBe(sections[1]?.slug);
  });

  test("AC-10: an H3 heading inside a section body stays inside that section's content", () => {
    const rule = makeRule({ fileName: "a.md", content: "## H2\n### H3 content" });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.content).toContain("### H3 content");
  });

  test("AC-11: every section's tokens equals the token estimate of its own content", () => {
    const rule = makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT });
    const sections = splitRuleIntoSections(rule);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.tokens).toBe(estimateTokens(section.content));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002: applySectionBudget (AC-12..AC-21)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002: applySectionBudget", () => {
  test("AC-12: rule-budget module exports applySectionBudget as a Function", () => {
    expect(typeof applySectionBudget).toBe("function");
  });

  test("AC-13: sections whose total tokens are below budgetTokens are all retained", () => {
    const sections = [
      makeSectionFixture({ sectionId: "a", tokens: 50, priority: 1, ordinal: 0 }),
      makeSectionFixture({ sectionId: "b", tokens: 50, priority: 1, ordinal: 1 }),
    ];
    const result = applySectionBudget(sections, 500);
    expect(result.retainedSections).toHaveLength(sections.length);
  });

  test("AC-14: retained sections are ordered by ascending priority, then ascending ordinal", () => {
    const sections = [
      makeSectionFixture({ sectionId: "hi-second", tokens: 10, priority: 2, ordinal: 1 }),
      makeSectionFixture({ sectionId: "lo-first", tokens: 10, priority: 1, ordinal: 0 }),
      makeSectionFixture({ sectionId: "hi-first", tokens: 10, priority: 2, ordinal: 0 }),
      makeSectionFixture({ sectionId: "lo-second", tokens: 10, priority: 1, ordinal: 1 }),
    ];
    const result = applySectionBudget(sections, 1_000);
    for (let i = 0; i < result.retainedSections.length - 1; i++) {
      const cur = result.retainedSections.at(i);
      const next = result.retainedSections.at(i + 1);
      expect(cur).toBeDefined();
      expect(next).toBeDefined();
      expect((cur?.priority ?? 0) <= (next?.priority ?? 0)).toBe(true);
      if (cur?.priority === next?.priority) {
        expect((cur?.ordinal ?? 0) <= (next?.ordinal ?? 0)).toBe(true);
      }
    }
  });

  test("AC-15: only the first two of four sections fit — the other two are dropped by id", () => {
    const sections = [
      makeSectionFixture({ sectionId: "first", tokens: 40, priority: 1, ordinal: 0 }),
      makeSectionFixture({ sectionId: "second", tokens: 40, priority: 1, ordinal: 1 }),
      makeSectionFixture({ sectionId: "third", tokens: 40, priority: 1, ordinal: 2 }),
      makeSectionFixture({ sectionId: "fourth", tokens: 40, priority: 1, ordinal: 3 }),
    ];
    const result = applySectionBudget(sections, 80);
    expect(result.retainedSections).toHaveLength(2);
    expect(result.retainedSections[0]?.sectionId).toBe("first");
    expect(result.retainedSections[1]?.sectionId).toBe("second");
    expect(result.droppedIds).toContain("third");
    expect(result.droppedIds).toContain("fourth");
  });

  test("AC-16: once budget is exhausted mid-rule, every lower-priority rule's sections are dropped even if one would fit", () => {
    const sections = [
      makeSectionFixture({ sectionId: "p1-a", tokens: 60, priority: 1, ordinal: 0 }),
      makeSectionFixture({ sectionId: "p1-b", tokens: 60, priority: 1, ordinal: 1 }),
      makeSectionFixture({ sectionId: "p2-a", tokens: 10, priority: 2, ordinal: 0 }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.droppedIds).toContain("p1-b");
    expect(result.droppedIds).toContain("p2-a");
    expect(result.retainedSections.some((s) => s.sectionId === "p2-a")).toBe(false);
  });

  test("AC-17: a single section exceeding the budget alone is admitted whole and reports positive overageTokens", () => {
    const section = makeSectionFixture({ sectionId: "solo", tokens: 500, priority: 1, ordinal: 0 });
    const budgetTokens = 100;
    const result = applySectionBudget([section], budgetTokens);
    expect(result.retainedSections).toHaveLength(1);
    expect(result.overageTokens).toBe(section.tokens - budgetTokens);
    expect(result.overageTokens).toBeGreaterThan(0);
  });

  test("AC-18: droppedIds contains exactly the omitted section ids, with no overlap with retained ids", () => {
    const sections = [
      makeSectionFixture({ sectionId: "keep-1", tokens: 30, priority: 1, ordinal: 0 }),
      makeSectionFixture({ sectionId: "keep-2", tokens: 30, priority: 1, ordinal: 1 }),
      makeSectionFixture({ sectionId: "drop-1", tokens: 30, priority: 2, ordinal: 0 }),
      makeSectionFixture({ sectionId: "drop-2", tokens: 30, priority: 3, ordinal: 0 }),
    ];
    const result = applySectionBudget(sections, 60);
    const retainedIds = new Set(result.retainedSections.map((s) => s.sectionId));
    const droppedIds = new Set(result.droppedIds);

    expect(droppedIds).toEqual(new Set(["drop-1", "drop-2"]));
    for (const id of droppedIds) {
      expect(retainedIds.has(id)).toBe(false);
    }
  });

  test("AC-19: an empty section array returns an empty retained list and zero overageTokens", () => {
    const result = applySectionBudget([], 1_000);
    expect(result.retainedSections).toHaveLength(0);
    expect(result.overageTokens).toBe(0);
  });

  test("AC-20: budgetTokens of 0 drops every section and reports overageTokens equal to the total", () => {
    const sections = [
      makeSectionFixture({ sectionId: "a", tokens: 30, priority: 1, ordinal: 0 }),
      makeSectionFixture({ sectionId: "b", tokens: 20, priority: 1, ordinal: 1 }),
    ];
    const result = applySectionBudget(sections, 0);
    expect(result.retainedSections).toHaveLength(0);
    expect(result.overageTokens).toBe(50);
  });

  test("AC-21: Infinity budgetTokens does not throw and returns a well-shaped result", () => {
    const sections = [makeSectionFixture({ sectionId: "a", tokens: 30, priority: 1, ordinal: 0 })];
    let result: SectionBudgetResult | undefined;
    expect(() => {
      result = applySectionBudget(sections, Number.POSITIVE_INFINITY);
    }).not.toThrow();
    expect(Array.isArray(result?.retainedSections)).toBe(true);
    expect(Array.isArray(result?.droppedIds)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: rulesShare / enforceBudget config + per-stage budget derivation (AC-22..AC-29)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: context.v2.rules.rulesShare / enforceBudget config", () => {
  function rulesConfig(rules: Record<string, unknown> | undefined) {
    const base = NaxConfigSchema.parse({}) as unknown as Record<string, unknown>;
    if (rules !== undefined) {
      const context = base.context as Record<string, unknown>;
      const v2 = { ...(context.v2 as Record<string, unknown>), rules };
      base.context = { ...context, v2 };
    }
    return base;
  }

  test("AC-22: rulesShare defaults to 0.4 when unset", () => {
    const parsed = NaxConfigSchema.parse(rulesConfig(undefined)) as unknown as {
      context: { v2: { rules: { rulesShare: number } } };
    };
    expect(parsed.context.v2.rules.rulesShare).toBe(0.4);
  });

  test("AC-23: enforceBudget defaults to true when unset", () => {
    const parsed = NaxConfigSchema.parse(rulesConfig(undefined)) as unknown as {
      context: { v2: { rules: { enforceBudget: boolean } } };
    };
    expect(parsed.context.v2.rules.enforceBudget).toBe(true);
  });

  test("AC-24: rulesShare of 1.5 is rejected by validation", () => {
    const result = NaxConfigSchema.safeParse(rulesConfig({ rulesShare: 1.5 }));
    expect(result.success).toBe(false);
  });

  test("AC-25: rulesShare of -0.1 is rejected by validation", () => {
    const result = NaxConfigSchema.safeParse(rulesConfig({ rulesShare: -0.1 }));
    expect(result.success).toBe(false);
  });
});

describe("US-003: StaticRulesProvider effective budget derivation", () => {
  let origApplySectionBudget: typeof _staticRulesDeps.applySectionBudget;
  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
  let capturedBudget: number | undefined;

  beforeEach(() => {
    origApplySectionBudget = _staticRulesDeps.applySectionBudget;
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
    capturedBudget = undefined;
    _staticRulesDeps.applySectionBudget = (sections: RuleSection[], budgetTokens: number) => {
      capturedBudget = budgetTokens;
      return { retainedSections: sections, droppedIds: [], totalTokens: 0, usedTokens: 0, overageTokens: 0 };
    };
  });

  afterEach(() => {
    _staticRulesDeps.applySectionBudget = origApplySectionBudget;
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("AC-26: min(rulesShare * requestBudget, providerBudget) = min(0.4*4000, 8192) = 1600", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: "some rule body" })]);
    const provider = new StaticRulesProvider({ rulesShare: 0.4, budgetTokens: 8_192, enforceBudget: true } as never);
    await provider.fetch({ ...BASE_REQUEST, budgetTokens: 4_000 });
    expect(capturedBudget).toBe(1_600);
  });

  test("AC-27: min(rulesShare * requestBudget, providerBudget) = min(0.9*12000, 8192) = 8192, not 10800", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: "some rule body" })]);
    const provider = new StaticRulesProvider({ rulesShare: 0.9, budgetTokens: 8_192, enforceBudget: true } as never);
    await provider.fetch({ ...BASE_REQUEST, budgetTokens: 12_000 });
    expect(capturedBudget).toBe(8_192);
    expect(capturedBudget).not.toBe(10_800);
  });

  test("AC-28: no .nax/rules/ directory returns an empty chunk list without throwing", async () => {
    _staticRulesDeps.applySectionBudget = origApplySectionBudget;
    const provider = new StaticRulesProvider();
    let result: ContextProviderResult | undefined;
    await expect(
      (async () => {
        result = await provider.fetch({ ...BASE_REQUEST, repoRoot: "/no-rules-here", packageDir: "/no-rules-here" });
      })(),
    ).resolves.toBeUndefined();
    expect(result?.chunks).toHaveLength(0);
  });

  test("AC-29: enforceBudget omitted (constructor default false) with a too-small budget still emits one chunk per rule", async () => {
    _staticRulesDeps.applySectionBudget = origApplySectionBudget;
    const rules = [
      makeRule({ fileName: "a.md", content: "plain body a with no headings" }),
      makeRule({ fileName: "b.md", content: "plain body b with no headings" }),
      makeRule({ fileName: "c.md", content: "plain body c with no headings" }),
    ];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 5 } as never);
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(rules.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004: section wiring + telemetry through StaticRulesProvider.fetch (AC-30..AC-40)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: StaticRulesProvider section wiring and telemetry", () => {
  let origSplit: typeof _staticRulesDeps.splitRuleIntoSections;
  let origBudget: typeof _staticRulesDeps.applySectionBudget;
  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

  beforeEach(() => {
    origSplit = _staticRulesDeps.splitRuleIntoSections;
    origBudget = _staticRulesDeps.applySectionBudget;
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  });

  afterEach(() => {
    _staticRulesDeps.splitRuleIntoSections = origSplit;
    _staticRulesDeps.applySectionBudget = origBudget;
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("AC-30: splitRuleIntoSections stub is called once per loaded canonical rule", async () => {
    const rules = [
      makeRule({ fileName: "a.md", content: "body a" }),
      makeRule({ fileName: "b.md", content: "body b" }),
    ];
    setupCanonical(rules);
    const calls: CanonicalRule[] = [];
    _staticRulesDeps.splitRuleIntoSections = (rule: CanonicalRule) => {
      calls.push(rule);
      return origSplit(rule);
    };
    await new StaticRulesProvider().fetch(BASE_REQUEST);
    expect(calls).toHaveLength(rules.length);
  });

  test("AC-31: applySectionBudget stub receives budgetTokens = requestBudget * 0.4", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: "body a" })]);
    let captured: number | undefined;
    _staticRulesDeps.applySectionBudget = (sections: RuleSection[], budgetTokens: number) => {
      captured = budgetTokens;
      return origBudget(sections, budgetTokens);
    };
    const provider = new StaticRulesProvider({ rulesShare: 0.4, budgetTokens: 100_000, enforceBudget: true } as never);
    await provider.fetch({ ...BASE_REQUEST, budgetTokens: 4_000 });
    expect(captured).toBe(1_600);
  });

  test("AC-32: two '## ' sections in one rule file produce two chunks with different ids", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: TWO_SECTION_CONTENT })]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.id).not.toBe(result.chunks[1]?.id);
  });

  test("AC-33: every chunk id incorporates the owning section's slug", async () => {
    const rule = makeRule({ fileName: "a.md", content: "## My Heading\nbody" });
    setupCanonical([rule]);
    const [expectedSection] = splitRuleIntoSections(rule);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.id).toContain(expectedSection?.slug);
    }
  });

  test("AC-34: every emitted chunk has kind 'static'", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT })]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.kind).toBe("static");
    }
  });

  test("AC-35: every emitted chunk has rawScore 1.0", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT })]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.rawScore).toBe(1.0);
    }
  });

  test("AC-36: budgetPressure.droppedCount equals the number of omitted sections", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT, priority: 1 })]);
    const provider = new StaticRulesProvider({ rulesShare: 1, budgetTokens: 30, enforceBudget: true } as never);
    const result = (await provider.fetch({ ...BASE_REQUEST, budgetTokens: 30 })) as ContextProviderResult & {
      budgetPressure?: { droppedCount: number };
    };
    const totalSections = splitRuleIntoSections(makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT })).length;
    expect(result.budgetPressure?.droppedCount).toBeGreaterThan(0);
    expect(result.chunks.length + (result.budgetPressure?.droppedCount ?? 0)).toBe(totalSections);
  });

  test("AC-37: budgetPressure.droppedTokens equals the summed tokens of omitted sections", async () => {
    setupCanonical([makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT, priority: 1 })]);
    const allSections = splitRuleIntoSections(makeRule({ fileName: "a.md", content: THREE_SECTION_CONTENT }));
    const provider = new StaticRulesProvider({ rulesShare: 1, budgetTokens: 30, enforceBudget: true } as never);
    const result = (await provider.fetch({ ...BASE_REQUEST, budgetTokens: 30 })) as ContextProviderResult & {
      budgetPressure?: { droppedCount: number; droppedTokens: number };
    };
    const droppedCount = result.budgetPressure?.droppedCount ?? 0;
    expect(droppedCount).toBeGreaterThan(0);
    const expectedDroppedTokens = allSections
      .slice(allSections.length - droppedCount)
      .reduce((sum, s) => sum + s.tokens, 0);
    expect(result.budgetPressure?.droppedTokens).toBe(expectedDroppedTokens);
  });

  test("AC-38: scopingReport.sectionCount equals the sections remaining after stage and appliesTo filtering", async () => {
    const included = makeRule({ fileName: "included.md", content: THREE_SECTION_CONTENT, stages: ["execution"] });
    const excluded = makeRule({ fileName: "excluded.md", content: "## Only Section\nbody", stages: ["verify"] });
    setupCanonical([included, excluded]);
    const provider = new StaticRulesProvider();
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & {
      scopingReport?: { sectionCount: number };
    };
    const includedSectionCount = splitRuleIntoSections(included).length;
    expect(result.scopingReport?.sectionCount).toBe(includedSectionCount);
  });

  test("AC-39: no chunk originates from a rule whose stages exclude request.stage", async () => {
    const included = makeRule({ fileName: "included.md", content: "## Section\nbody", stages: ["execution"] });
    const excluded = makeRule({ fileName: "excluded.md", content: "## Other\nbody", stages: ["verify"] });
    setupCanonical([included, excluded]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    for (const chunk of result.chunks) {
      expect(chunk.id.includes("excluded")).toBe(false);
    }
  });

  test("AC-40: applySectionBudget stub receives no section from a rule whose stages exclude request.stage", async () => {
    const included = makeRule({ fileName: "included.md", content: "## Section\nbody", stages: ["execution"] });
    const excluded = makeRule({ fileName: "excluded.md", content: "## Other\nbody", stages: ["verify"] });
    setupCanonical([included, excluded]);
    let capturedSections: RuleSection[] = [];
    _staticRulesDeps.applySectionBudget = (sections: RuleSection[], budgetTokens: number) => {
      capturedSections = sections;
      return origBudget(sections, budgetTokens);
    };
    await new StaticRulesProvider().fetch(BASE_REQUEST);
    expect(capturedSections.some((s) => s.fileName === "excluded.md")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005: corpus hygiene — forbidden-patterns split (AC-41, file-check)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005: forbidden-patterns corpus split", () => {
  test("AC-41: forbidden-patterns.md is replaced by source/tests files with valid priority frontmatter, and the loader reports exactly 2 entries", async () => {
    const sourceFile = Bun.file(`${REPO_ROOT}/.nax/rules/forbidden-patterns-source.md`);
    const testsFile = Bun.file(`${REPO_ROOT}/.nax/rules/forbidden-patterns-tests.md`);
    const originalFile = Bun.file(`${REPO_ROOT}/.nax/rules/forbidden-patterns.md`);

    expect(await sourceFile.exists()).toBe(true);
    expect(await testsFile.exists()).toBe(true);
    expect(await originalFile.exists()).toBe(false);

    const sourceContent = await sourceFile.text();
    const testsContent = await testsFile.text();
    expect(sourceContent).toMatch(/^---[\s\S]*priority:\s*\d+[\s\S]*---/m);
    expect(testsContent).toMatch(/^---[\s\S]*priority:\s*\d+[\s\S]*---/m);

    const rules = await loadCanonicalRules(REPO_ROOT);
    const matching = rules.filter((r) => {
      const id = r.id ?? r.fileName.replace(/\.md$/i, "");
      return id === "forbidden-patterns-source" || id === "forbidden-patterns-tests";
    });
    expect(matching).toHaveLength(2);
  });
});